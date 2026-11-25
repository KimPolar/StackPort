use super::{
    document_snapshot::{canonical, parse_value, same_document},
    query::{read_filter, valid_field, QUERY_JSON_LIMIT},
};
use crate::Result;
use bson::{doc, Bson, Document};
use serde::Deserialize;

const MAX_DEPTH: usize = 4;
const MAX_NODES: usize = 64;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MongoFindNode {
    Group {
        mode: MatchMode,
        children: Vec<MongoFindNode>,
    },
    Predicate {
        field: String,
        operator: Operator,
        value: InputValue,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    All,
    Any,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    Exists,
}

#[derive(Deserialize)]
#[serde(
    tag = "format",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum InputValue {
    Text(String),
    Json(String),
    Boolean(bool),
}

pub fn build_mongo_find_filter(node: MongoFindNode, base: &str) -> Result<String> {
    let filter = compile(node, 0, &mut 0, &mut 0)?;
    let base = read_filter(base)?;
    let filter = if base.is_empty() {
        filter
    } else {
        doc! { "$and": [base, filter] }
    };
    let text = canonical(&filter)?;
    if !same_document(&filter, &read_filter(&text)?)? {
        return Err("찾기 조건을 Extended JSON으로 손실 없이 표시할 수 없습니다.".into());
    }
    Ok(text)
}

fn compile(
    node: MongoFindNode,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> Result<Document> {
    *nodes += 1;
    if depth > MAX_DEPTH || *nodes > MAX_NODES {
        return Err("MongoDB 찾기 조건의 중첩 깊이 또는 개수가 너무 큽니다.".into());
    }
    match node {
        MongoFindNode::Group { mode, children } => {
            let mut children = children
                .into_iter()
                .map(|child| compile(child, depth + 1, nodes, bytes))
                .collect::<Result<Vec<_>>>()?;
            match children.len() {
                0 => Err("조건 그룹에 조건을 하나 이상 추가하세요.".into()),
                1 => Ok(children.remove(0)),
                _ => {
                    let operator = match mode {
                        MatchMode::All => "$and",
                        MatchMode::Any => "$or",
                    };
                    Ok(doc! { operator: children })
                }
            }
        }
        MongoFindNode::Predicate {
            field,
            operator,
            value,
        } => {
            if !valid_field(&field) {
                return Err("찾기 조건의 필드 이름을 확인하세요.".into());
            }
            let value = operand(operator, value, bytes)?;
            let operator = operator.name();
            Ok(doc! { field: { operator: value } })
        }
    }
}

fn operand(operator: Operator, value: InputValue, bytes: &mut usize) -> Result<Bson> {
    *bytes += match &value {
        InputValue::Text(text) | InputValue::Json(text) => text.len(),
        InputValue::Boolean(_) => 0,
    };
    if *bytes > QUERY_JSON_LIMIT {
        return Err("MongoDB 찾기 조건의 값은 합계 32 KiB 이하여야 합니다.".into());
    }
    let value = match value {
        InputValue::Text(text) => Bson::String(text),
        InputValue::Json(text) => parse_value(&text)
            .map_err(|error| format!("찾기 조건의 Extended JSON 값 오류 · {error}"))?,
        InputValue::Boolean(value) => Bson::Boolean(value),
    };
    match (operator, &value) {
        (Operator::In | Operator::Nin, value) if !matches!(value, Bson::Array(_)) => {
            Err("목록 조건에는 Extended JSON 배열을 입력하세요.".into())
        }
        (Operator::Exists, value) if !matches!(value, Bson::Boolean(_)) => {
            Err("필드 존재 조건에는 참 또는 거짓을 선택하세요.".into())
        }
        _ => Ok(value),
    }
}

impl Operator {
    fn name(self) -> &'static str {
        match self {
            Self::Eq => "$eq",
            Self::Ne => "$ne",
            Self::Gt => "$gt",
            Self::Gte => "$gte",
            Self::Lt => "$lt",
            Self::Lte => "$lte",
            Self::In => "$in",
            Self::Nin => "$nin",
            Self::Exists => "$exists",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn combines_nested_groups_and_preserves_typed_operands_and_field_order() {
        let input = json!({"kind":"group","mode":"any","children":[
            {"kind":"predicate","field":"_id","operator":"eq","value":{"format":"json","value":"{\"$numberLong\":\"9007199254740993\"}"}},
            {"kind":"group","mode":"all","children":[
                {"kind":"predicate","field":"payload","operator":"eq","value":{"format":"json","value":"{\"z\":1,\"a\":2}"}},
                {"kind":"predicate","field":"archived","operator":"exists","value":{"format":"boolean","value":false}}
            ]}
        ]});
        let text =
            build_mongo_find_filter(serde_json::from_value(input).unwrap(), r#"{"active":true}"#)
                .unwrap();
        let expected = doc! { "$and": [
            {"active": true},
            {"$or": [
                {"_id": {"$eq": 9007199254740993_i64}},
                {"$and": [
                    {"payload": {"$eq": {"z": 1, "a": 2}}},
                    {"archived": {"$exists": false}}
                ]}
            ]}
        ] };
        assert!(same_document(&read_filter(&text).unwrap(), &expected).unwrap());
    }

    #[test]
    fn rejects_bad_operands_invalid_field_paths_and_disallowed_base_filters() {
        for (field, operator, value, base) in [
            ("name", "in", json!({"format":"text","value":"서울"}), ""),
            ("name", "exists", json!({"format":"json","value":"123"}), ""),
            (
                "metadata.$role",
                "eq",
                json!({"format":"text","value":"x"}),
                "",
            ),
            (
                "name",
                "eq",
                json!({"format":"text","value":"x"}),
                r#"{"$where":"code"}"#,
            ),
            (
                "name",
                "eq",
                json!({"format":"json","value":"{\"$code\":\"code\"}"}),
                "",
            ),
        ] {
            let node = serde_json::from_value(
                json!({"kind":"predicate","field":field,"operator":operator,"value":value}),
            )
            .unwrap();
            assert!(build_mongo_find_filter(node, base).is_err());
        }
    }
}
