use super::document_snapshot::{canonical_value, validate_json_keys};
use crate::Result;
use bson::{doc, oid::ObjectId, raw::RawDocumentBuf, Bson, Document};
use serde::{
    de::{Error, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{fmt, fs::File, io::Read, path::Path};

const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_DOCUMENT: usize = 16 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 1_000;
const BATCH_DOCUMENTS: usize = 100;
const BATCH_BYTES: usize = 4 * 1024 * 1024;
const PREVIEW_BYTES: usize = 4_096;
const FILE_LIMIT: &str = "32 MiB 이하의 MongoDB JSON 파일을 선택하세요.";

pub(super) struct ImportFile {
    pub(super) bytes: usize,
    pub(super) digest: [u8; 32],
    pub(super) documents: usize,
    pub(super) sample: Vec<ImportSample>,
    pub(super) batches: Vec<Vec<Document>>,
}

#[derive(Serialize)]
pub(super) struct ImportSample {
    json: String,
    truncated: bool,
}

pub(super) fn read_bytes(path: &str) -> Result<Vec<u8>> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("MongoDB JSON 파일의 절대 경로를 선택하세요.".into());
    }
    let file = File::open(path).map_err(|_| "MongoDB JSON 파일을 열 수 없습니다.")?;
    let info = file
        .metadata()
        .map_err(|_| "MongoDB JSON 파일을 확인할 수 없습니다.")?;
    if !info.is_file() || info.len() > MAX_FILE {
        return Err(FILE_LIMIT.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "MongoDB JSON 파일을 읽을 수 없습니다.")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(FILE_LIMIT.into());
    }
    Ok(bytes)
}

pub(super) fn fingerprint(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(super) fn read_import(path: &str) -> Result<ImportFile> {
    decode(&read_bytes(path)?)
}

fn decode(bytes: &[u8]) -> Result<ImportFile> {
    let content = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(content)
        .map_err(|_| "MongoDB JSON 파일을 UTF-8로 저장하세요.")?
        .trim();
    let records = if text.starts_with('[') {
        serde_json::from_str::<Records<'_>>(text)
            .map_err(|error| {
                format!(
                    "최대 {MAX_DOCUMENTS}개의 문서를 담은 JSON 배열인지 확인하세요. {}줄 {}열",
                    error.line(),
                    error.column()
                )
            })?
            .0
    } else if let Ok(document) = serde_json::from_str::<&RawValue>(text) {
        vec![document]
    } else {
        let mut records = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            if records.len() == MAX_DOCUMENTS {
                return Err(format!("문서를 {MAX_DOCUMENTS}개 이하의 파일로 나누세요."));
            }
            let document = serde_json::from_str::<&RawValue>(line)
                .map_err(|_| format!("{}줄의 JSON 문서를 확인하세요.", index + 1))?;
            records.push(document);
        }
        records
    };
    if records.is_empty() {
        return Err("가져올 MongoDB 문서가 없습니다.".into());
    }
    let mut result = ImportFile {
        bytes: bytes.len(),
        digest: fingerprint(bytes),
        documents: records.len(),
        sample: Vec::new(),
        batches: vec![Vec::new()],
    };
    let mut batch_bytes = 0;
    for (index, record) in records.into_iter().enumerate() {
        let (document, size) =
            parse_record(record.get()).map_err(|error| format!("문서 {}: {error}", index + 1))?;
        if index < 3 {
            let mut json = canonical_value(&Bson::Document(document.clone()))?;
            let truncated = json.len() > PREVIEW_BYTES;
            if truncated {
                json.truncate(json.floor_char_boundary(PREVIEW_BYTES));
            }
            result.sample.push(ImportSample { json, truncated });
        }
        let batch = result.batches.last_mut().expect("there is always a batch");
        if batch.len() == BATCH_DOCUMENTS || (!batch.is_empty() && batch_bytes + size > BATCH_BYTES)
        {
            result.batches.push(vec![document]);
            batch_bytes = size;
        } else {
            batch.push(document);
            batch_bytes += size;
        }
    }
    Ok(result)
}

fn parse_record(text: &str) -> Result<(Document, usize)> {
    if !text.starts_with('{') {
        return Err("Extended JSON 객체를 입력하세요.".into());
    }
    validate_json_keys::<{ usize::MAX }>(text, 0, 104)?;
    let mut source: Document =
        serde_json::from_str(text).map_err(|_| "올바른 Extended JSON 객체인지 확인하세요.")?;
    let id = source
        .remove("_id")
        .unwrap_or_else(|| Bson::ObjectId(ObjectId::new()));
    let mut document = doc! { "_id": id };
    document.extend(source);
    if document.values().any(zero_timestamp) {
        return Err("서버가 자동으로 값을 채우는 빈 BSON 타임스탬프는 가져올 수 없습니다.".into());
    }
    let raw =
        RawDocumentBuf::try_from(&document).map_err(|_| "문서를 BSON으로 변환할 수 없습니다.")?;
    if raw.as_bytes().len() > MAX_DOCUMENT {
        return Err("BSON 문서 하나는 16 MiB 이하여야 합니다.".into());
    }
    Ok((document, raw.as_bytes().len()))
}

fn zero_timestamp(value: &Bson) -> bool {
    match value {
        Bson::Timestamp(value) => value.time == 0 && value.increment == 0,
        Bson::Document(value) => value.values().any(zero_timestamp),
        Bson::Array(value) => value.iter().any(zero_timestamp),
        Bson::JavaScriptCodeWithScope(value) => value.scope.values().any(zero_timestamp),
        _ => false,
    }
}

struct Records<'a>(Vec<&'a RawValue>);

impl<'de> Deserialize<'de> for Records<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct RecordVisitor;
        impl<'de> Visitor<'de> for RecordVisitor {
            type Value = Records<'de>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a bounded array of MongoDB documents")
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut documents = Vec::new();
                while let Some(document) = seq.next_element()? {
                    if documents.len() == MAX_DOCUMENTS {
                        return Err(A::Error::custom("too many documents"));
                    }
                    documents.push(document);
                }
                Ok(Records(documents))
            }
        }
        deserializer.deserialize_seq(RecordVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bson_extended_values_and_documents_larger_than_the_editor_limit() {
        let text = format!(
            r#"[{{"title":"{}","x":{{"$numberLong":"9223372036854775807"}}}}]"#,
            "한".repeat(25_000)
        );
        let source = decode(text.as_bytes()).unwrap();
        let document = &source.batches[0][0];
        assert_eq!(document.get_i64("x").unwrap(), i64::MAX);
        assert_eq!(document.get_str("title").unwrap().len(), 75_000);
        assert_eq!(document.iter().next().unwrap().0, "_id");
        assert!(source.sample[0].truncated);
    }

    #[test]
    fn checks_duplicate_keys_and_document_count_before_writing() {
        assert!(decode(br#"[{"x":{"n":1,"n":2}}]"#).is_err());
        assert!(decode(br#"[{"value":{"other":1,"$numberLong":"3"}}]"#).is_err());
        assert!(decode(br#"[{"value":{"$timestamp":{"t":0,"i":0}}}]"#).is_err());
        assert!(decode(b"[]").is_err());
        assert!(decode(format!("[{}{{}}]", "{},".repeat(MAX_DOCUMENTS)).as_bytes()).is_err());
    }

    #[test]
    fn reads_line_delimited_json_and_separates_batches() {
        let text = "{\"x\": 1}\n".repeat(BATCH_DOCUMENTS + 1);
        let source = decode(text.as_bytes()).unwrap();
        assert_eq!(source.documents, BATCH_DOCUMENTS + 1);
        assert_eq!(
            source.batches.iter().map(Vec::len).collect::<Vec<_>>(),
            [BATCH_DOCUMENTS, 1]
        );
    }
}
