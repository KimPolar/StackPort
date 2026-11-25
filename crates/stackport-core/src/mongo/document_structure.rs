use super::{
    document_snapshot::{
        canonical, canonical_value, parse_document, parse_value, same_document, validate_document,
    },
    schema::type_name,
};
use crate::Result;
use bson::Bson;
use serde::{Deserialize, Serialize};

const MISSING: &str = "선택한 필드나 배열 항목을 찾을 수 없습니다.";

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PathPart {
    Field { name: String },
    Index { index: usize },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Direction {
    Up,
    Down,
}

#[derive(Deserialize)]
#[serde(transparent)]
pub struct MongoDraftChange(Operation);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    AddField {
        parent: Vec<PathPart>,
        name: String,
        input: String,
    },
    Append {
        parent: Vec<PathPart>,
        input: String,
    },
    Replace {
        at: Vec<PathPart>,
        input: String,
    },
    Rename {
        at: Vec<PathPart>,
        name: String,
    },
    Remove {
        at: Vec<PathPart>,
    },
    Move {
        at: Vec<PathPart>,
        direction: Direction,
    },
}

impl Operation {
    fn path(&self) -> &[PathPart] {
        match self {
            Self::AddField { parent, .. } | Self::Append { parent, .. } => parent,
            Self::Replace { at, .. }
            | Self::Rename { at, .. }
            | Self::Remove { at }
            | Self::Move { at, .. } => at,
        }
    }
}

#[derive(Serialize)]
pub struct MongoDraftStructure {
    text: String,
    root: Node,
}

#[derive(Serialize)]
struct Node {
    bson_type: &'static str,
    value: Option<String>,
    children: Option<Vec<Child>>,
}

#[derive(Serialize)]
struct Child {
    part: PathPart,
    node: Node,
}

pub fn edit_mongo_document_draft(
    input: &str,
    change: Option<MongoDraftChange>,
    keep_id: bool,
) -> Result<MongoDraftStructure> {
    let mut root = Bson::Document(parse_document(input)?);
    if let Some(MongoDraftChange(operation)) = change {
        if keep_id
            && matches!(operation.path().first(), Some(PathPart::Field { name }) if name == "_id")
        {
            return Err("기존 문서의 _id를 유지하세요.".into());
        }
        apply(&mut root, operation)?;
    }
    let document = root
        .as_document()
        .ok_or("문서는 Extended JSON 객체여야 합니다.")?;
    validate_document(document)?;
    let text = canonical(document)?;
    if !same_document(document, &parse_document(&text)?)? {
        return Err("이 값은 Extended JSON으로 손실 없이 표현할 수 없습니다.".into());
    }
    Ok(MongoDraftStructure {
        text,
        root: describe(&root)?,
    })
}

fn apply(root: &mut Bson, operation: Operation) -> Result<()> {
    match operation {
        Operation::AddField {
            parent,
            name,
            input,
        } => {
            let fields = find(root, &parent)?
                .as_document_mut()
                .ok_or("객체를 선택하세요.")?;
            if fields.contains_key(&name) {
                return Err("같은 이름의 필드가 이미 있습니다.".into());
            }
            fields.insert(name, parse_value(&input)?);
        }
        Operation::Append { parent, input } => {
            let items = find(root, &parent)?
                .as_array_mut()
                .ok_or("배열을 선택하세요.")?;
            items.push(parse_value(&input)?);
        }
        Operation::Replace { at, input } => {
            if at.is_empty() {
                return Err("값을 바꿀 필드나 배열 항목을 선택하세요.".into());
            }
            *find(root, &at)? = parse_value(&input)?;
        }
        Operation::Rename { at, name } => {
            let (part, parent) = at.split_last().ok_or(MISSING)?;
            let PathPart::Field { name: original } = part else {
                return Err("이름을 바꿀 필드를 선택하세요.".into());
            };
            let fields = find(root, parent)?
                .as_document_mut()
                .filter(|fields| fields.contains_key(original))
                .ok_or(MISSING)?;
            if &name == original {
                return Ok(());
            }
            if fields.contains_key(&name) {
                return Err("같은 이름의 필드가 이미 있습니다.".into());
            }
            *fields = std::mem::take(fields)
                .into_iter()
                .map(|(key, value)| (if &key == original { name.clone() } else { key }, value))
                .collect();
        }
        Operation::Remove { at } => {
            let (part, parent) = at.split_last().ok_or(MISSING)?;
            match (find(root, parent)?, part) {
                (Bson::Document(fields), PathPart::Field { name }) => {
                    fields.remove(name).ok_or(MISSING)?;
                }
                (Bson::Array(items), PathPart::Index { index }) if *index < items.len() => {
                    items.remove(*index);
                }
                _ => return Err(MISSING.into()),
            }
        }
        Operation::Move { at, direction } => {
            let (part, parent) = at.split_last().ok_or(MISSING)?;
            let PathPart::Index { index } = part else {
                return Err("이동할 배열 항목을 선택하세요.".into());
            };
            let items = find(root, parent)?
                .as_array_mut()
                .filter(|items| *index < items.len())
                .ok_or(MISSING)?;
            let offset = match direction {
                Direction::Up => -1,
                Direction::Down => 1,
            };
            let next = index
                .checked_add_signed(offset)
                .filter(|target| *target < items.len())
                .ok_or("배열 항목을 이 위치로 이동할 수 없습니다.")?;
            items.swap(*index, next);
        }
    }
    Ok(())
}

fn find<'a>(mut value: &'a mut Bson, path: &[PathPart]) -> Result<&'a mut Bson> {
    for part in path {
        value = match (value, part) {
            (Bson::Document(fields), PathPart::Field { name }) => fields.get_mut(name),
            (Bson::Array(items), PathPart::Index { index }) => items.get_mut(*index),
            _ => None,
        }
        .ok_or(MISSING)?;
    }
    Ok(value)
}

fn describe(value: &Bson) -> Result<Node> {
    let children = match value {
        Bson::Document(fields) => Some(
            fields
                .iter()
                .map(|(name, value)| {
                    Ok(Child {
                        part: PathPart::Field { name: name.clone() },
                        node: describe(value)?,
                    })
                })
                .collect::<Result<_>>()?,
        ),
        Bson::Array(items) => Some(
            items
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    Ok(Child {
                        part: PathPart::Index { index },
                        node: describe(value)?,
                    })
                })
                .collect::<Result<_>>()?,
        ),
        _ => None,
    };
    let value_text = if children.is_some() {
        None
    } else {
        Some(canonical_value(value)?)
    };
    Ok(Node {
        bson_type: type_name(value.element_type()),
        value: value_text,
        children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn change(input: &str, operation: Value) -> Result<MongoDraftStructure> {
        edit_mongo_document_draft(
            input,
            Some(serde_json::from_value(operation).unwrap()),
            true,
        )
    }

    #[test]
    fn structured_edits_preserve_literal_paths_field_order_and_exact_bson_types() {
        let source = r#"{"_id":{"n":{"$numberLong":"7"},"a":"zone"},"10":"first","2":"second","meta.with.dot":{"items":[{"$numberLong":"9223372036854775807"},"old"]}}"#;
        let field = |name| json!({ "kind": "field", "name": name });
        let index = |index| json!({ "kind": "index", "index": index });
        let nested = [field("meta.with.dot"), field("items")];
        let renamed = change(
            source,
            json!({ "kind": "rename", "at": [field("2")], "name": "02" }),
        )
        .unwrap();
        let appended = change(&renamed.text, json!({ "kind": "append", "parent": nested, "input": r#"{"$numberDecimal":"1.2300"}"# })).unwrap();
        let moved = change(
            &appended.text,
            json!({ "kind": "move", "at": [nested[0], nested[1], index(2)], "direction": "up" }),
        )
        .unwrap();
        let removed = change(
            &moved.text,
            json!({ "kind": "remove", "at": [nested[0], nested[1], index(2)] }),
        )
        .unwrap();
        let read = parse_document(&removed.text).unwrap();
        assert_eq!(
            read.keys().map(|key| key.as_str()).collect::<Vec<_>>(),
            ["_id", "10", "02", "meta.with.dot"]
        );
        let id = read.get_document("_id").unwrap();
        assert_eq!(
            id.keys().map(|key| key.as_str()).collect::<Vec<_>>(),
            ["n", "a"]
        );
        let items = read
            .get_document("meta.with.dot")
            .unwrap()
            .get_array("items")
            .unwrap();
        assert!(matches!(
            items.as_slice(),
            [Bson::Int64(i64::MAX), Bson::Decimal128(_)]
        ));
        assert!(removed.text.contains("1.2300"));
        let node = &removed.root.children.as_ref().unwrap()[3]
            .node
            .children
            .as_ref()
            .unwrap()[0]
            .node;
        assert_eq!(node.bson_type, "Array");
        assert_eq!(
            node.children.as_ref().unwrap()[0].node.value.as_deref(),
            Some(r#"{"$numberLong":"9223372036854775807"}"#)
        );
    }

    #[test]
    fn rejects_protected_and_ambiguous_values_without_rewriting_the_draft() {
        let source = r#"{"_id":{"n":1},"nested":{}}"#;
        let part = |name| json!({ "kind": "field", "name": name });
        let protected = change(
            source,
            json!({ "kind": "replace", "at": [part("_id"),part("n")], "input": "2" }),
        )
        .err()
        .unwrap();
        assert!(protected.contains("_id"));
        assert!(change(
            source,
            json!({ "kind": "add_field", "parent": [], "name": "nested", "input": "null" })
        )
        .is_err());
        assert!(change(
            source,
            json!({ "kind": "replace", "at": [part("nested")], "input": "{\"x\":1,\"x\":2}" })
        )
        .is_err());
        assert!(change(source, json!({ "kind": "add_field", "parent": [part("nested")], "name": "$numberLong", "input": "\"7\"" })).is_err());
        let added = change(source, json!({ "kind": "add_field", "parent": [part("nested")], "name": "literal.a", "input": "true" })).unwrap();
        assert!(parse_document(&added.text)
            .unwrap()
            .get_document("nested")
            .unwrap()
            .get_bool("literal.a")
            .unwrap());
    }
}
