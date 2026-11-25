use crate::Result;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationalObjectSearch {
    pub(crate) schema: Option<String>,
    pub(crate) field: SearchField,
    pub(crate) kind: Option<ObjectKind>,
    pub(crate) term: String,
    pub(crate) page: u32,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SearchField {
    Name,
    Column,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObjectKind {
    Table,
    View,
    MaterializedView,
}

impl RelationalObjectSearch {
    pub(crate) fn in_schema(schema: String, term: String, page: u32) -> Self {
        Self {
            schema: Some(schema),
            field: SearchField::Name,
            kind: None,
            term,
            page,
        }
    }

    pub(crate) fn validate_scope(&self, valid_schema: impl Fn(&str) -> bool) -> Result<()> {
        if self
            .schema
            .as_deref()
            .is_some_and(|schema| !valid_schema(schema))
        {
            return Err("검색할 스키마 이름을 확인하세요.".into());
        }
        if self.term.trim().is_empty()
            && (matches!(self.field, SearchField::Column)
                || (self.schema.is_none() && self.kind.is_none()))
        {
            return Err("검색어를 입력하세요.".into());
        }
        Ok(())
    }
}
