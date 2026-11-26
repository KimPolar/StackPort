use crate::{json_import::Properties, Result};
use bson::{doc, raw::RawDocumentBuf, Bson, Document};
use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::value::RawValue;

const MAX_BYTES: usize = 64 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_VALUES: usize = 512;
const INVALID: &str = "MongoDB 문서는 64 KiB 이하의 Extended JSON 객체여야 합니다.";

pub(super) fn parse_document(text: &str) -> Result<Document> {
    if text.len() > MAX_BYTES {
        return Err(INVALID.into());
    }
    validate_json_keys::<MAX_VALUES>(text, 0, MAX_DEPTH + 4)?;
    let document: Document = serde_json::from_str(text).map_err(|_| INVALID)?;
    validate_document(&document)?;
    Ok(document)
}

pub(super) fn snapshot(raw: RawDocumentBuf) -> Result<Document> {
    if raw.as_bytes().len() > MAX_BYTES {
        return Err(INVALID.into());
    }
    let document = Document::try_from(&raw).map_err(|_| INVALID)?;
    validate_document(&document)?;
    let normalized = canonical(&document)?;
    let round_trip = parse_document(&normalized)?;
    if as_raw(&round_trip)?.as_bytes() != raw.as_bytes() {
        return Err("이 문서의 BSON 표현은 Extended JSON으로 손실 없이 편집할 수 없습니다.".into());
    }
    Ok(document)
}

pub(super) fn canonical(document: &Document) -> Result<String> {
    canonical_pretty(&Bson::Document(document.clone()))
}

pub(super) fn canonical_pretty(value: &Bson) -> Result<String> {
    let text = serde_json::to_string_pretty(&Canonical(value)).map_err(|_| INVALID)?;
    if text.len() > MAX_BYTES {
        return Err(INVALID.into());
    }
    Ok(text)
}

pub(super) fn canonical_id(id: &Bson) -> Option<String> {
    canonical_value(id).ok().filter(|text| text.len() <= 256)
}

struct Canonical<'a>(&'a Bson);

pub(super) fn canonical_value(value: &Bson) -> Result<String> {
    serde_json::to_string(&Canonical(value)).map_err(|_| INVALID.into())
}

pub(super) fn parse_value(text: &str) -> Result<Bson> {
    if text.len() > MAX_BYTES {
        return Err(INVALID.into());
    }
    validate_json_keys::<MAX_VALUES>(text, 0, MAX_DEPTH + 4)?;
    serde_json::from_str(text).map_err(|_| "올바른 Extended JSON 값을 입력하세요.".into())
}

impl Serialize for Canonical<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self.0 {
            Bson::Document(document) => {
                let mut map = serializer.serialize_map(Some(document.len()))?;
                for (key, value) in document {
                    map.serialize_entry(key, &Canonical(value))?;
                }
                map.end()
            }
            Bson::Array(values) => serializer.collect_seq(values.iter().map(Canonical)),
            value => value.clone().into_canonical_extjson().serialize(serializer),
        }
    }
}

pub(super) fn same_document(first: &Document, second: &Document) -> Result<bool> {
    Ok(as_raw(first)?.as_bytes() == as_raw(second)?.as_bytes())
}

pub(super) fn parse_id(text: &str) -> Result<Bson> {
    if text.len() > 256 {
        return Err("MongoDB 문서의 _id를 확인하세요.".into());
    }
    validate_json_keys::<MAX_VALUES>(text, 0, MAX_DEPTH + 4)?;
    serde_json::from_str::<Bson>(text).map_err(|_| "MongoDB 문서의 _id를 확인하세요.".into())
}

pub(super) fn validate_json_keys<const FIELDS: usize>(text: &str, depth: usize, max_depth: usize) -> Result<()> {
    if depth > max_depth {
        return Err("문서 JSON이 너무 깊게 중첩되어 있습니다.".into());
    }
    let text = text.trim();
    if text.starts_with('{') {
        let Properties(fields) = serde_json::from_str::<Properties<'_, FIELDS>>(text)
            .map_err(|_| "Extended JSON 객체의 문법과 중복 필드 이름을 확인하세요.")?;
        if fields.len() > 1 && fields.iter().any(|(key, _)| is_extended_type_key(key))
            && !(fields.len() == 2 && fields.iter().all(|(key, _)| matches!(key.as_str(), "$code" | "$scope")))
        {
            return Err("Extended JSON 타입을 나타내는 객체에 일반 필드를 섞을 수 없습니다.".into());
        }
        for (_, child) in fields {
            validate_json_keys::<FIELDS>(child.get(), depth + 1, max_depth)?;
        }
    } else if text.starts_with('[') {
        let values: Vec<&RawValue> = serde_json::from_str(text).map_err(|_| INVALID)?;
        for child in values {
            validate_json_keys::<FIELDS>(child.get(), depth + 1, max_depth)?;
        }
    }
    Ok(())
}

fn is_extended_type_key(key: &str) -> bool {
    matches!(key, "$oid" | "$symbol" | "$numberInt" | "$numberLong" | "$numberDouble" | "$binary"
        | "$uuid" | "$code" | "$scope" | "$timestamp" | "$regularExpression" | "$dbPointer" | "$date"
        | "$maxKey" | "$minKey" | "$undefined" | "$numberDecimal" | "$numberDecimalBytes")
}

fn as_raw(document: &Document) -> Result<RawDocumentBuf> {
    RawDocumentBuf::try_from(document).map_err(|_| INVALID.into())
}

pub(super) fn validate_document(document: &Document) -> Result<()> {
    validate_value(&Bson::Document(document.clone()), 0, &mut 0)?;
    if as_raw(document)?.as_bytes().len() > MAX_BYTES {
        return Err(INVALID.into());
    }
    Ok(())
}

fn validate_value(value: &Bson, depth: usize, count: &mut usize) -> Result<()> {
    *count += 1;
    if depth > MAX_DEPTH || *count > MAX_VALUES {
        return Err("문서를 편집하려면 중첩 깊이가 12 이하이고 값은 최대 512개여야 합니다.".into());
    }
    match value {
        Bson::Document(fields) => {
            for (key, child) in fields {
                if key.contains('\0') {
                    return Err("MongoDB 필드 이름에 NUL 문자를 사용할 수 없습니다.".into());
                }
                validate_value(child, depth + 1, count)?;
            }
        }
        Bson::Array(values) => {
            for child in values {
                validate_value(child, depth + 1, count)?;
            }
        }
        Bson::Timestamp(value) if value.time == 0 && value.increment == 0 => {
            return Err("서버가 값을 자동 채우는 빈 BSON 타임스탬프는 편집할 수 없습니다.".into());
        }
        Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_)
        | Bson::Symbol(_)
        | Bson::DbPointer(_)
        | Bson::Undefined => {
            return Err("문서 편집에서 지원하지 않는 BSON 값이 있습니다.".into());
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn unchanged_filter(id: &Bson, before: &Document) -> Document {
    let snapshot = Bson::Document(before.clone());
    doc! {
        "_id": { "$eq": id.clone() },
        "$expr": { "$and": [
            { "$eq": ["$$ROOT", { "$literal": snapshot.clone() }] },
            same_types(&snapshot, Bson::String("$$ROOT".into())),
        ] },
    }
}

fn same_types(snapshot: &Bson, current: Bson) -> Document {
    let name = match snapshot {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        _ => return doc! { "$literal": false },
    };
    let checks: Vec<_> = match snapshot {
        Bson::Document(fields) => fields
            .iter()
            .map(|(key, child)| {
                same_types(
                    child,
                    Bson::Document(
                        doc! { "$getField": { "field": { "$literal": key }, "input": "$$node" } },
                    ),
                )
            })
            .collect(),
        Bson::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, child)| {
                same_types(
                    child,
                    Bson::Document(doc! { "$arrayElemAt": ["$$node", index as i32] }),
                )
            })
            .collect(),
        Bson::Decimal128(_) | Bson::Double(_) => vec![doc! { "$eq": [
            { "$toString": "$$node" }, { "$toString": { "$literal": snapshot.clone() } },
        ] }],
        _ => Vec::new(),
    };
    if checks.is_empty() {
        return doc! { "$eq": [{ "$type": current }, name] };
    }
    doc! { "$let": {
        "vars": { "node": current },
        "in": { "$cond": [
            { "$eq": [{ "$type": "$$node" }, name] },
            { "$and": checks }, false,
        ] },
    } }
}
