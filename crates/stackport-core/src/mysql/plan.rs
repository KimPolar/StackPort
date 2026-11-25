use super::{
    sql::{prepare_query, sql_error},
    Conn, Params, Queryable, Value,
};
use crate::Result;
use serde::Serialize;
use serde_json::Value as Json;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_STEPS: usize = 200;
const MAX_DEPTH: usize = 24;

#[derive(Serialize)]
pub struct MysqlPlan {
    analyzed: bool,
    time_per_loop: bool,
    steps: Vec<Step>,
    truncated: bool,
}

#[derive(Default, Serialize)]
struct Step {
    depth: usize,
    operation: &'static str,
    relation: Option<String>,
    index: Option<String>,
    cost: Option<f64>,
    estimated_rows: Option<f64>,
    actual_rows: Option<f64>,
    loops: Option<f64>,
    time_ms: Option<f64>,
}

pub(super) async fn execute(
    connection: &mut Conn,
    sql: &str,
    values: Vec<Value>,
    engine: &str,
    analyzed: bool,
) -> Result<MysqlPlan> {
    let maria = engine == "MariaDB";
    let prefix = match (maria, analyzed) {
        (true, true) => "ANALYZE FORMAT=JSON",
        (true, false) => "EXPLAIN FORMAT=JSON",
        (false, true) => "EXPLAIN ANALYZE FORMAT=TREE",
        (false, false) => "EXPLAIN FORMAT=TREE",
    };
    let statement = prepare_query(connection, sql, values.len(), Some(prefix)).await?;
    let (bytes,): (Vec<u8>,) = connection
        .exec_first(statement, Params::Positional(values))
        .await
        .map_err(sql_error)?
        .ok_or("MySQL 실행 계획을 받지 못했습니다.")?;
    connection.query_drop("ROLLBACK").await.map_err(sql_error)?;
    decode(&bytes, maria, analyzed)
}

fn decode(bytes: &[u8], maria: bool, analyzed: bool) -> Result<MysqlPlan> {
    if bytes.len() > MAX_BYTES {
        return Err("MySQL 실행 계획이 2 MiB를 초과합니다.".into());
    }
    let mut plan = MysqlPlan {
        analyzed,
        time_per_loop: !maria,
        steps: Vec::new(),
        truncated: false,
    };
    if maria {
        let document: Json = serde_json::from_slice(bytes)
            .map_err(|_| "MariaDB 실행 계획 형식을 읽을 수 없습니다.")?;
        append_json("root", &document, 0, &mut plan);
    } else {
        let document =
            std::str::from_utf8(bytes).map_err(|_| "MySQL 실행 계획 형식을 읽을 수 없습니다.")?;
        for line in document.lines() {
            let text = line.trim_start();
            let Some(text) = text.strip_prefix("-> ") else {
                continue;
            };
            let depth = (line.len() - line.trim_start().len()) / 4;
            if plan.steps.len() == MAX_STEPS {
                plan.truncated = true;
                break;
            }
            if depth > MAX_DEPTH {
                plan.truncated = true;
                continue;
            }
            plan.steps.push(tree_step(text.trim_end(), depth));
        }
    }
    if plan.steps.is_empty() {
        return Err("실행 계획에 표시할 단계가 없습니다.".into());
    }
    Ok(plan)
}

fn tree_step(line: &str, depth: usize) -> Step {
    // Keep known operator names and metrics. Server expressions can contain bound values.
    let skipped = line.strip_suffix(" (never executed)");
    let line = skipped.unwrap_or(line);
    let (description, actual) = trailing_group(line, " (actual time=");
    let (description, estimate) = trailing_group(description, " (cost=");
    let (operation, target) = description.split_once(" on ").unwrap_or((description, ""));
    let (relation, index) = target.split_once(" using ").unwrap_or((target, ""));
    let operation = [
        "Covering index range scan",
        "Covering index lookup",
        "Covering index scan",
        "Single-row index lookup",
        "Index range scan",
        "Index lookup",
        "Index scan",
        "Table scan",
        "Table function",
        "Nested loop",
        "Inner hash join",
        "Left hash join",
        "Hash join",
        "Filter",
        "Sort",
        "Group aggregate",
        "Aggregate",
        "Limit",
        "Materialize",
        "Stream results",
        "Append",
        "Window aggregate",
        "Rows fetched before execution",
        "Zero rows",
    ]
    .into_iter()
    .find(|prefix| operation.starts_with(prefix))
    .unwrap_or("Iterator");
    Step {
        depth,
        operation,
        relation: (operation.contains("scan") || operation.contains("lookup"))
            .then(|| simple_identifier(relation))
            .flatten(),
        index: (operation.starts_with("Index") || operation.contains("index"))
            .then(|| simple_identifier(index))
            .flatten(),
        cost: estimate
            .and_then(|metrics| metrics.split_ascii_whitespace().next())
            .and_then(number),
        estimated_rows: estimate.and_then(|metrics| metric(metrics, "rows=")),
        actual_rows: actual.and_then(|metrics| metric(metrics, "rows=")),
        loops: actual
            .and_then(|metrics| metric(metrics, "loops="))
            .or_else(|| skipped.map(|_| 0.0)),
        time_ms: actual
            .and_then(|metrics| metrics.split_ascii_whitespace().next())
            .and_then(|times| times.split_once(".."))
            .and_then(|(_, elapsed)| number(elapsed)),
    }
}

fn trailing_group<'a>(line: &'a str, start: &str) -> (&'a str, Option<&'a str>) {
    if let Some((description, values)) = line.rsplit_once(start) {
        if let Some(values) = values.strip_suffix(')') {
            if !values.contains(['(', ')']) {
                return (description, Some(values));
            }
        }
    }
    (line, None)
}

fn simple_identifier(text: &str) -> Option<String> {
    let token = text.split_ascii_whitespace().next()?;
    (!token.is_empty()
        && token.len() <= 128
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | b'.' | b'`')))
    .then(|| token.to_owned())
}

fn metric(text: &str, key: &str) -> Option<f64> {
    text.split_ascii_whitespace()
        .find_map(|part| part.strip_prefix(key).and_then(number))
}

fn number(text: &str) -> Option<f64> {
    text.parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0)
}

fn append_json(key: &str, value: &Json, depth: usize, plan: &mut MysqlPlan) {
    if !value.is_object() && !value.is_array() {
        return;
    }
    if depth > MAX_DEPTH || plan.steps.len() == MAX_STEPS {
        plan.truncated = true;
        return;
    }
    if let Some(items) = value.as_array() {
        for item in items {
            append_json(key, item, depth, plan);
        }
        return;
    }
    let read = |key| {
        value
            .get(key)
            .and_then(Json::as_f64)
            .filter(|number| number.is_finite() && *number >= 0.0)
    };
    let name = |key| {
        value.get(key).and_then(Json::as_str).map(|text| {
            text.chars()
                .filter(|character| !character.is_control())
                .take(128)
                .collect()
        })
    };
    let operation = match key {
        "query_block" => "Query block",
        "table" => match value.get("access_type").and_then(Json::as_str) {
            Some("ALL") => "Table scan",
            Some("index") => "Index scan",
            Some("range" | "index_merge") => "Index range scan",
            Some(
                "const" | "system" | "eq_ref" | "ref" | "ref_or_null" | "unique_subquery"
                | "index_subquery",
            ) => "Index lookup",
            _ => "Table access",
        },
        "nested_loop" if value.get("table").is_none() && value.get("block-nl-join").is_none() => {
            "Join input"
        }
        "block-nl-join" => "Block nested-loop join",
        "filesort" => "Sort",
        "temporary_table" => "Temporary table",
        "materialized" => "Materialize",
        "union_result" => "Union",
        "window_functions_computation" => "Window computation",
        _ => "",
    };
    let next_depth = if operation.is_empty() {
        depth
    } else {
        plan.steps.push(Step {
            depth,
            operation,
            relation: name("table_name"),
            index: name("key"),
            estimated_rows: read("rows"),
            actual_rows: read("r_rows"),
            loops: read("r_loops"),
            time_ms: read("r_total_time_ms").or_else(|| {
                let table = read("r_table_time_ms");
                let other = read("r_other_time_ms");
                (table.is_some() || other.is_some())
                    .then(|| table.unwrap_or(0.0) + other.unwrap_or(0.0))
            }),
            ..Step::default()
        });
        depth + 1
    };
    if let Some(fields) = value.as_object() {
        for (key, child) in fields {
            if matches!(
                key.as_str(),
                "query_block"
                    | "table"
                    | "nested_loop"
                    | "block-nl-join"
                    | "filesort"
                    | "read_sorted_file"
                    | "temporary_table"
                    | "materialized"
                    | "union_result"
                    | "query_specifications"
                    | "window_functions_computation"
                    | "subqueries"
                    | "expression_cache"
                    | "duplicates_removal"
                    | "ordering_operation"
                    | "grouping_operation"
                    | "sorts"
            ) {
                append_json(key, child, next_depth, plan);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_estimates_for_iterators_that_never_ran() {
        let plan = decode(
            b"-> Filter: (account = 'bound value') (cost=2 rows=1) (actual time=0.02..0.03 rows=0 loops=1)\n    -> Covering index scan on records using owner_idx (cost=1 rows=52) (never executed)\n",
            false,
            true,
        ).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].actual_rows, Some(0.0));
        assert_eq!(plan.steps[0].time_ms, Some(0.03));
        let child = &plan.steps[1];
        assert_eq!(child.depth, 1);
        assert_eq!(child.index.as_deref(), Some("owner_idx"));
        assert_eq!(child.estimated_rows, Some(52.0));
        assert_eq!(child.loops, Some(0.0));
        assert_eq!(child.time_ms, None);
        assert!(!serde_json::to_string(&plan)
            .unwrap()
            .contains("bound value"));
    }
}
