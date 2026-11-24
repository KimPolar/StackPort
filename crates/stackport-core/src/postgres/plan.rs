use crate::Result;
use serde::{Deserialize, Serialize};
use tokio_postgres::{
    types::{FromSql, Type},
    Row,
};

const MAX_PLAN_BYTES: usize = 2 * 1024 * 1024;
const MAX_STEPS: usize = 200;
const MAX_DEPTH: usize = 24;
const INVALID_PLAN: &str = "PostgreSQL 실행 계획 형식을 확인할 수 없습니다.";

#[derive(Serialize)]
pub(super) struct Plan {
    analyzed: bool,
    planning_ms: Option<f64>,
    execution_ms: Option<f64>,
    steps: Vec<Step>,
    truncated: bool,
}

#[derive(Deserialize)]
struct Document {
    #[serde(rename = "Plan")]
    root: Step,
    #[serde(rename = "Planning Time")]
    planning_ms: Option<f64>,
    #[serde(rename = "Execution Time")]
    execution_ms: Option<f64>,
}

#[derive(Deserialize, Serialize)]
struct Step {
    #[serde(skip_deserializing)]
    depth: usize,
    #[serde(skip_deserializing)]
    leaf: bool,
    #[serde(rename(deserialize = "Node Type"))]
    operation: String,
    #[serde(rename(deserialize = "Parent Relationship"))]
    parent_role: Option<String>,
    #[serde(rename(deserialize = "Relation Name"))]
    relation: Option<String>,
    #[serde(rename(deserialize = "Schema"))]
    schema: Option<String>,
    #[serde(rename(deserialize = "Index Name"))]
    index: Option<String>,
    #[serde(rename(deserialize = "Join Type"))]
    join_type: Option<String>,
    #[serde(rename(deserialize = "Sort Method"))]
    sort_method: Option<String>,
    #[serde(rename(deserialize = "Sort Space Type"))]
    sort_space: Option<String>,
    #[serde(rename(deserialize = "Startup Cost"))]
    startup_cost: Option<f64>,
    #[serde(rename(deserialize = "Total Cost"))]
    total_cost: Option<f64>,
    #[serde(rename(deserialize = "Plan Rows"))]
    estimated_rows: Option<f64>,
    #[serde(rename(deserialize = "Actual Rows"))]
    actual_rows: Option<f64>,
    #[serde(rename(deserialize = "Actual Loops"))]
    loops: Option<u64>,
    #[serde(rename(deserialize = "Actual Total Time"))]
    actual_ms: Option<f64>,
    #[serde(rename(deserialize = "Shared Hit Blocks"))]
    shared_hits: Option<u64>,
    #[serde(rename(deserialize = "Shared Read Blocks"))]
    shared_reads: Option<u64>,
    #[serde(rename(deserialize = "Temp Read Blocks"))]
    temp_reads: Option<u64>,
    #[serde(rename(deserialize = "Temp Written Blocks"))]
    temp_writes: Option<u64>,
    #[serde(default, rename(deserialize = "Plans"), skip_serializing)]
    children: Vec<Self>,
}

// EXPLAIN's JSON column is a single wire value. Check its size before
// deserialization and only decode the plan fields the UI presents.
struct PlanBytes<'a>(&'a [u8]);

impl<'a> FromSql<'a> for PlanBytes<'a> {
    fn from_sql(
        _: &Type,
        raw: &'a [u8],
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Self(raw))
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::JSON || *ty == Type::TEXT
    }
}

pub(super) fn read(rows: &[Row], analyzed: bool) -> Result<Plan> {
    let [row] = rows else {
        return Err(INVALID_PLAN.into());
    };
    let PlanBytes(bytes) = row.try_get(0).map_err(|_| INVALID_PLAN)?;
    decode(bytes, analyzed)
}

fn decode(bytes: &[u8], analyzed: bool) -> Result<Plan> {
    if bytes.len() > MAX_PLAN_BYTES {
        return Err("PostgreSQL 실행 계획이 2 MiB를 초과합니다.".into());
    }
    let [document]: [Document; 1] = serde_json::from_slice(bytes).map_err(|_| INVALID_PLAN)?;
    let mut plan = Plan {
        analyzed,
        planning_ms: document.planning_ms,
        execution_ms: document.execution_ms,
        steps: Vec::new(),
        truncated: false,
    };
    append(document.root, 0, &mut plan);
    Ok(plan)
}

fn append(mut step: Step, depth: usize, plan: &mut Plan) {
    if depth > MAX_DEPTH || plan.steps.len() == MAX_STEPS {
        plan.truncated = true;
        return;
    }
    let children = std::mem::take(&mut step.children);
    step.depth = depth;
    step.leaf = children.is_empty();
    plan.steps.push(step);
    for child in children {
        append(child, depth + 1, plan);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_tree_metrics_without_returning_sql_expressions() {
        let json = br#"[{"Plan":{"Node Type":"Nested Loop","Plan Rows":2,"Plans":[
            {"Node Type":"Index Scan","Relation Name":"orders","Index Name":"orders_pk",
            "Actual Rows":2.25,"Actual Loops":4,"Actual Total Time":2.5,
            "Filter":"account = 'fixture-secret'","Shared Hit Blocks":3}]},
            "Planning Time":1.23,"Execution Time":10.55}]"#;
        let plan = decode(json, true).unwrap();
        assert_eq!(plan.execution_ms, Some(10.55));
        assert!(!plan.steps[0].leaf);
        let step = &plan.steps[1];
        assert_eq!(step.depth, 1);
        assert!(step.leaf);
        assert_eq!(step.actual_rows, Some(2.25));
        assert_eq!(step.loops, Some(4));
        assert_eq!(step.shared_hits, Some(3));
        let serialized = serde_json::to_string(&plan).unwrap();
        assert!(!serialized.contains("fixture-secret"));
        assert!(!serialized.contains("children"));
    }

    #[test]
    fn bounds_plan_bytes_and_tree_size() {
        assert!(decode(&vec![b' '; MAX_PLAN_BYTES + 1], false).is_err());
        assert!(decode(b"[]", false).is_err());
        let children = vec![json!({"Node Type":"Result"}); MAX_STEPS];
        let input = json!([{"Plan":{"Node Type":"Append","Plans":children}}]);
        let plan = decode(&serde_json::to_vec(&input).unwrap(), false).unwrap();
        assert_eq!(plan.steps.len(), MAX_STEPS);
        assert!(plan.truncated);
    }
}
