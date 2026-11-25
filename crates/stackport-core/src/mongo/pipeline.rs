use super::{
    message,
    query::{read_document_page, PAGE_SIZE},
    validate_namespace, MongoDocumentPage, MongoManager, READ_TIMEOUT, SERVER_TIME,
};
use crate::Result;
use bson::{doc, raw::RawDocumentBuf, Bson, Document};
use serde::{Deserialize, Serialize};
use tokio::time::timeout;

const MAX_STAGES: usize = 24;
const MAX_STAGE_BYTES: usize = 16 * 1024;
const MAX_PIPELINE_BYTES: usize = 128 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MongoPipelineStage {
    operator: String,
    expression: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoPipelinePreview {
    stages: Vec<MongoPipelineStage>,
    through: Option<usize>,
}

impl MongoManager {
    pub async fn preview_pipeline(
        &self,
        id: &str,
        database: &str,
        collection: &str,
        request: MongoPipelinePreview,
    ) -> Result<MongoDocumentPage> {
        validate_namespace(database, collection)?;
        let mut pipeline = prepare(&request.stages, request.through)?;
        pipeline.push(doc! { "$limit": (PAGE_SIZE + 1) as i64 });
        let collection = self
            .client(id)?
            .database(database)
            .collection::<Document>(collection);
        timeout(READ_TIMEOUT, async {
            let cursor = collection
                .aggregate(pipeline)
                .with_type::<RawDocumentBuf>()
                .allow_disk_use(false)
                .batch_size(4)
                .max_time(SERVER_TIME)
                .await
                .map_err(message)?;
            read_document_page(cursor).await
        })
        .await
        .map_err(|_| "MongoDB 집계 미리보기 시간이 초과되었습니다.")?
    }
}

pub(super) fn validate_draft(stages: &[MongoPipelineStage]) -> Result<()> {
    if !(1..=MAX_STAGES).contains(&stages.len()) {
        return Err("MongoDB 파이프라인은 1~24단계여야 합니다.".into());
    }
    if stages
        .iter()
        .map(|stage| stage.expression.len())
        .sum::<usize>()
        > MAX_PIPELINE_BYTES
    {
        return Err("MongoDB 파이프라인 JSON 합계는 128 KiB 이하여야 합니다.".into());
    }
    for (index, stage) in stages.iter().enumerate() {
        if !allowed_operator(&stage.operator) || stage.expression.len() > MAX_STAGE_BYTES {
            return Err(format!(
                "{}단계의 연산자와 JSON 크기(최대 16 KiB)를 확인하세요.",
                index + 1
            ));
        }
    }
    Ok(())
}

fn prepare(stages: &[MongoPipelineStage], through: Option<usize>) -> Result<Vec<Document>> {
    validate_draft(stages)?;
    let count = through.unwrap_or(stages.len());
    let stages = stages
        .get(..count)
        .ok_or("집계 미리보기의 마지막 단계를 확인하세요.")?;
    let mut pipeline = Vec::with_capacity(stages.len());
    let mut remaining = MAX_STAGES;
    for (index, stage) in stages.iter().enumerate().filter(|(_, stage)| stage.enabled) {
        let value: Bson = serde_json::from_str(&stage.expression)
            .map_err(|_| format!("{}단계에 올바른 Extended JSON 값을 입력하세요.", index + 1))?;
        validate_expression(&value, 0).map_err(|error| format!("{}단계 · {error}", index + 1))?;
        validate_stage(&stage.operator, &value, &mut remaining)
            .map_err(|error| format!("{}단계 · {error}", index + 1))?;
        pipeline.push(doc! { &stage.operator: value });
    }
    if pipeline.is_empty() {
        return Err("미리 볼 범위에서 집계 단계를 하나 이상 활성화하세요.".into());
    }
    Ok(pipeline)
}

fn allowed_operator(operator: &str) -> bool {
    matches!(
        operator,
        "$match"
            | "$project"
            | "$group"
            | "$sort"
            | "$limit"
            | "$skip"
            | "$count"
            | "$unwind"
            | "$addFields"
            | "$set"
            | "$unset"
            | "$replaceRoot"
            | "$replaceWith"
            | "$sample"
            | "$sortByCount"
            | "$bucket"
            | "$bucketAuto"
            | "$setWindowFields"
            | "$lookup"
            | "$facet"
            | "$unionWith"
    )
}

fn validate_stage(operator: &str, value: &Bson, remaining: &mut usize) -> Result<()> {
    if !allowed_operator(operator) {
        return Err("지원하는 읽기 전용 집계 단계만 사용할 수 있습니다.".into());
    }
    *remaining = remaining
        .checked_sub(1)
        .ok_or("중첩 파이프라인을 포함해 최대 24단계까지 실행할 수 있습니다.")?;
    if operator == "$facet" {
        let branches = value
            .as_document()
            .ok_or("$facet에 이름별 파이프라인을 입력하세요.")?;
        for branch in branches.values() {
            validate_nested_pipeline(branch, remaining)?;
        }
    } else if matches!(operator, "$lookup" | "$unionWith") {
        if let Some(branch) = value
            .as_document()
            .and_then(|document| document.get("pipeline"))
        {
            validate_nested_pipeline(branch, remaining)?;
        }
    }
    Ok(())
}

fn validate_nested_pipeline(value: &Bson, remaining: &mut usize) -> Result<()> {
    let stages = value
        .as_array()
        .ok_or("중첩 파이프라인은 단계 배열이어야 합니다.")?;
    for stage in stages {
        let Some(document) = stage.as_document().filter(|document| document.len() == 1) else {
            return Err("중첩 파이프라인의 각 단계에는 연산자 하나가 필요합니다.".into());
        };
        let (operator, expression) = document.iter().next().expect("validated nonempty stage");
        validate_stage(operator, expression, remaining)?;
    }
    Ok(())
}

pub(super) fn validate_view_pipeline(value: &Bson) -> Result<()> {
    validate_expression(value, 0)?;
    let mut remaining = MAX_STAGES;
    validate_nested_pipeline(value, &mut remaining)
}

pub(super) fn validate_expression(value: &Bson, depth: usize) -> Result<()> {
    const SCRIPTING: &str = "서버 JavaScript를 사용할 수 없습니다.";
    if depth > 20 {
        return Err("MongoDB JSON이 너무 깊게 중첩되어 있습니다.".into());
    }
    match value {
        Bson::Document(document) => {
            for (field, child) in document {
                if matches!(field.as_str(), "$where" | "$function" | "$accumulator") {
                    return Err(SCRIPTING.into());
                }
                validate_expression(child, depth + 1)?;
            }
        }
        Bson::Array(items) => {
            for child in items {
                validate_expression(child, depth + 1)?;
            }
        }
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => return Err(SCRIPTING.into()),
        _ => {}
    }
    Ok(())
}
