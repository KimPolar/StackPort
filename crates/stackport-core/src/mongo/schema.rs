use super::{message, validate_namespace, MongoManager, READ_TIMEOUT, SERVER_TIME};
use crate::Result;
use bson::{
    doc,
    raw::{RawBsonRef, RawDocument, RawDocumentBuf},
    spec::ElementType,
    Document,
};
use futures_util::TryStreamExt;
use serde::Serialize;
use std::collections::BTreeMap;
use tokio::time::timeout;

const MAX_SAMPLE_SIZE: u32 = 100;
const MAX_DOCUMENT_BYTES: usize = 64 * 1024;
const MAX_FIELDS: usize = 512;
const MAX_DEPTH: usize = 8;
const MAX_FIELD_NAME_BYTES: usize = 256;
const INVALID_BSON: &str = "MongoDB 표본의 BSON 구조를 읽을 수 없습니다.";

#[derive(Serialize)]
pub struct MongoSchemaSample {
    documents: u32,
    oversized: u32,
    structure_limited: bool,
    fields: Vec<SchemaField>,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
enum Segment {
    Field(String),
    ArrayItem,
}

#[derive(Serialize)]
struct SchemaField {
    path: Vec<Segment>,
    documents: u32,
    types: BTreeMap<&'static str, u32>,
}

#[derive(Default)]
struct DocumentCount {
    last_document: u32,
    count: u32,
}

impl DocumentCount {
    fn add(&mut self, document: u32) {
        if self.last_document != document {
            self.last_document = document;
            self.count += 1;
        }
    }
}

#[derive(Default)]
struct FieldCounts {
    documents: DocumentCount,
    types: BTreeMap<&'static str, DocumentCount>,
}

#[derive(Default)]
struct Sample {
    documents: u32,
    oversized: u32,
    structure_limited: bool,
    fields: BTreeMap<Vec<Segment>, FieldCounts>,
}

impl Sample {
    fn add(&mut self, document: &RawDocument) -> Result<()> {
        if document.as_bytes().len() > MAX_DOCUMENT_BYTES {
            self.oversized += 1;
            return Ok(());
        }
        self.documents += 1;
        self.document(document, &mut Vec::new())
    }

    fn document(&mut self, document: &RawDocument, path: &mut Vec<Segment>) -> Result<()> {
        for field in document {
            let (name, value) = field.map_err(|_| INVALID_BSON)?;
            if name.len() > MAX_FIELD_NAME_BYTES {
                self.structure_limited = true;
                continue;
            }
            path.push(Segment::Field(name.as_str().into()));
            self.value(value, path)?;
            path.pop();
        }
        Ok(())
    }

    fn value(&mut self, value: RawBsonRef<'_>, path: &mut Vec<Segment>) -> Result<()> {
        if path.len() > MAX_DEPTH {
            self.structure_limited = true;
            return Ok(());
        }
        let full = self.fields.len() >= MAX_FIELDS;
        let counts = match self.fields.get_mut(path.as_slice()) {
            Some(counts) => counts,
            None if full => {
                self.structure_limited = true;
                return Ok(());
            }
            None => self.fields.entry(path.clone()).or_default(),
        };
        counts.documents.add(self.documents);
        counts
            .types
            .entry(type_name(value.element_type()))
            .or_default()
            .add(self.documents);
        match value {
            RawBsonRef::Document(document) => self.document(document, path)?,
            RawBsonRef::Array(array) => {
                path.push(Segment::ArrayItem);
                for item in array {
                    self.value(item.map_err(|_| INVALID_BSON)?, path)?;
                }
                path.pop();
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> MongoSchemaSample {
        MongoSchemaSample {
            documents: self.documents,
            oversized: self.oversized,
            structure_limited: self.structure_limited,
            fields: self
                .fields
                .into_iter()
                .map(|(path, counts)| SchemaField {
                    path,
                    documents: counts.documents.count,
                    types: counts
                        .types
                        .into_iter()
                        .map(|(name, count)| (name, count.count))
                        .collect(),
                })
                .collect(),
        }
    }
}

fn type_name(kind: ElementType) -> &'static str {
    match kind {
        ElementType::Double => "Double",
        ElementType::String => "String",
        ElementType::EmbeddedDocument => "Document",
        ElementType::Array => "Array",
        ElementType::Binary => "Binary",
        ElementType::Undefined => "Undefined",
        ElementType::ObjectId => "ObjectId",
        ElementType::Boolean => "Boolean",
        ElementType::DateTime => "DateTime",
        ElementType::Null => "Null",
        ElementType::RegularExpression => "RegularExpression",
        ElementType::DbPointer => "DBPointer",
        ElementType::JavaScriptCode => "JavaScript",
        ElementType::Symbol => "Symbol",
        ElementType::JavaScriptCodeWithScope => "JavaScriptWithScope",
        ElementType::Int32 => "Int32",
        ElementType::Timestamp => "Timestamp",
        ElementType::Int64 => "Int64",
        ElementType::Decimal128 => "Decimal128",
        ElementType::MaxKey => "MaxKey",
        ElementType::MinKey => "MinKey",
    }
}

impl MongoManager {
    pub async fn schema_sample(
        &self,
        id: &str,
        database: &str,
        collection: &str,
        sample_size: u32,
    ) -> Result<MongoSchemaSample> {
        validate_namespace(database, collection)?;
        if !(1..=MAX_SAMPLE_SIZE).contains(&sample_size) {
            return Err("MongoDB 표본 크기는 1~100개여야 합니다.".into());
        }
        let collection = self
            .client(id)?
            .database(database)
            .collection::<Document>(collection);
        timeout(READ_TIMEOUT, async {
            let mut cursor = collection
                .aggregate([doc! { "$sample": { "size": sample_size as i32 } }])
                .with_type::<RawDocumentBuf>()
                .allow_disk_use(false)
                .batch_size(1)
                .max_time(SERVER_TIME)
                .await
                .map_err(message)?;
            let mut sample = Sample::default();
            for _ in 0..sample_size {
                let Some(document) = cursor.try_next().await.map_err(message)? else {
                    break;
                };
                sample.add(&document)?;
            }
            Ok(sample.finish())
        })
        .await
        .map_err(|_| "MongoDB 문서 스키마 분석 시간이 초과되었습니다.")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_fields_and_depth_while_counting_known_paths_in_every_document() {
        let mut deep = doc! { "leaf": 1 };
        for _ in 0..MAX_DEPTH {
            deep = doc! { "child": deep };
        }
        let mut first = doc! { "known": 1, "nested": deep };
        for index in 0..MAX_FIELDS {
            first.insert(format!("field_{index}"), index as i32);
        }
        let mut sample = Sample::default();
        sample
            .add(&RawDocumentBuf::try_from(first).unwrap())
            .unwrap();
        sample
            .add(&RawDocumentBuf::try_from(doc! { "known": "two", "omitted": true }).unwrap())
            .unwrap();

        assert!(sample.structure_limited);
        assert_eq!(sample.fields.len(), MAX_FIELDS);
        assert!(sample.fields.keys().all(|path| path.len() <= MAX_DEPTH));
        let known = &sample.fields[&vec![Segment::Field("known".into())]];
        assert_eq!(known.documents.count, 2);
        assert_eq!(known.types["Int32"].count, 1);
        assert_eq!(known.types["String"].count, 1);
    }
}
