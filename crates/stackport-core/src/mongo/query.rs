use super::{message, validate_namespace, MongoManager, READ_TIMEOUT, SERVER_TIME};
use crate::Result;
use bson::{doc, raw::RawDocumentBuf, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::Cursor;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;

pub(super) const PAGE_SIZE: usize = 20;
const DOCUMENT_LIMIT: usize = 64 * 1024;
const PAGE_BYTES: usize = 384 * 1024;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MongoQuery {
    filter: String,
    projection: String,
    sort_field: String,
    descending: bool,
    page: u32,
}

#[derive(Serialize)]
pub struct MongoDocumentPage {
    items: Vec<DocumentPreview>,
    has_next: bool,
}

#[derive(Serialize)]
struct DocumentPreview {
    id: Option<String>,
    bson_bytes: usize,
    json: Option<String>,
}

impl MongoManager {
    pub async fn documents(
        &self,
        id: &str,
        database: &str,
        collection: &str,
        query: MongoQuery,
    ) -> Result<MongoDocumentPage> {
        validate_namespace(database, collection)?;
        let MongoQuery {
            filter,
            projection,
            sort_field,
            descending,
            page,
        } = query;
        let filter = read_document(&filter, "필터")?;
        let mut nodes = 0;
        validate_filter(&Bson::Document(filter.clone()), 0, &mut nodes)?;
        let projection = read_document(&projection, "표시 필드")?;
        if projection.len() > 64
            || projection.iter().any(|(name, value)| {
                !valid_field(name)
                    || !matches!(
                        value,
                        Bson::Boolean(_) | Bson::Int32(0 | 1) | Bson::Int64(0 | 1)
                    )
            })
        {
            return Err("표시 필드는 최대 64개이며 각 값은 0 또는 1로 지정하세요.".into());
        }
        let sort_field = sort_field.trim();
        let sort_field = if sort_field.is_empty() {
            "_id"
        } else {
            sort_field
        };
        if !valid_field(sort_field) {
            return Err("MongoDB 정렬 필드 이름을 확인하세요.".into());
        }
        let mut sort = doc! { sort_field: if descending { -1 } else { 1 } };
        if sort_field != "_id" {
            sort.insert("_id", 1);
        }
        let client = self.client(id)?;
        let collection = client
            .database(database)
            .collection::<RawDocumentBuf>(collection);
        timeout(READ_TIMEOUT, async {
            let cursor = collection
                .find(filter)
                .projection(projection)
                .sort(sort)
                .skip(u64::from(page) * PAGE_SIZE as u64)
                .limit(PAGE_SIZE as i64 + 1)
                .batch_size(4)
                .max_time(SERVER_TIME)
                .await
                .map_err(message)?;
            read_document_page(cursor).await
        })
        .await
        .map_err(|_| "MongoDB 문서 조회 시간이 초과되었습니다.")?
    }
}

pub(super) async fn read_document_page(
    mut cursor: Cursor<RawDocumentBuf>,
) -> Result<MongoDocumentPage> {
    let mut items = Vec::new();
    let mut remaining = PAGE_BYTES;
    let mut has_next = false;
    while let Some(raw) = cursor.try_next().await.map_err(message)? {
        if items.len() == PAGE_SIZE {
            has_next = true;
            break;
        }
        let bytes = raw.as_bytes().len();
        let mut item = DocumentPreview {
            id: None,
            bson_bytes: bytes,
            json: None,
        };
        if bytes <= DOCUMENT_LIMIT && bytes <= remaining {
            let document =
                Document::try_from(raw).map_err(|_| "MongoDB BSON 문서를 읽을 수 없습니다.")?;
            item.id = document
                .get("_id")
                .map(|value| value.clone().into_canonical_extjson().to_string())
                .filter(|id| id.len() <= 256);
            let json = Bson::Document(document).into_canonical_extjson();
            if let Ok(serialized) = serde_json::to_string_pretty(&json) {
                if serialized.len() <= DOCUMENT_LIMIT && serialized.len() <= remaining {
                    remaining -= serialized.len();
                    item.json = Some(serialized);
                }
            }
        }
        items.push(item);
    }
    Ok(MongoDocumentPage { items, has_next })
}

fn read_document(text: &str, label: &str) -> Result<Document> {
    if text.len() > 32 * 1024 {
        return Err(format!("MongoDB {label} JSON은 32 KiB 이하여야 합니다."));
    }
    if text.trim().is_empty() {
        return Ok(doc! {});
    }
    serde_json::from_str(text).map_err(|_| format!("MongoDB {label}에 JSON 객체를 입력하세요."))
}

fn valid_field(name: &str) -> bool {
    name.len() <= 256
        && !name.contains('\0')
        && name
            .split('.')
            .all(|part| !part.is_empty() && !part.starts_with('$'))
}

fn validate_filter(value: &Bson, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > 16 || *nodes > 512 {
        return Err("MongoDB 필터의 중첩 깊이 또는 항목 수가 너무 큽니다.".into());
    }
    match value {
        Bson::Document(document) => {
            for (field, child) in document {
                if !valid_field(field)
                    && !matches!(
                        field.as_str(),
                        "$and"
                            | "$or"
                            | "$nor"
                            | "$not"
                            | "$eq"
                            | "$ne"
                            | "$lt"
                            | "$lte"
                            | "$gt"
                            | "$gte"
                            | "$in"
                            | "$nin"
                            | "$exists"
                            | "$type"
                            | "$size"
                            | "$all"
                            | "$elemMatch"
                    )
                {
                    return Err(
                        "MongoDB 필터에는 조회 조건 연산자와 필드 이름만 사용할 수 있습니다."
                            .into(),
                    );
                }
                validate_filter(child, depth + 1, nodes)?;
            }
        }
        Bson::Array(items) => {
            for child in items {
                validate_filter(child, depth + 1, nodes)?;
            }
        }
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) | Bson::RegularExpression(_) => {
            return Err("MongoDB 필터에는 JavaScript와 정규식을 사용할 수 없습니다.".into());
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_bson_filters_and_rejects_server_code() {
        let document = read_document(r#"{"z":{"$numberLong":"9223372036854775807"},"a":{"$oid":"507f1f77bcf86cd799439011"}}"#, "필터").unwrap();
        assert!(matches!(document.get("z"), Some(Bson::Int64(i64::MAX))));
        assert!(matches!(document.get("a"), Some(Bson::ObjectId(_))));
        validate_filter(&Bson::Document(document), 0, &mut 0).unwrap();
        for input in [
            r#"{"$where":"this.x"}"#,
            r#"{"x":{"$code":"function() {}"}}"#,
            r#"{"n":{"$regularExpression":{"pattern":".*","options":"i"}}}"#,
        ] {
            let document = read_document(input, "필터").unwrap();
            assert!(validate_filter(&Bson::Document(document), 0, &mut 0).is_err());
        }
    }
}
