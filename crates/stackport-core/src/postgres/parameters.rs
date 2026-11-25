use super::session::secret;
use crate::Result;
use bytes::BytesMut;
use serde::{Deserialize, Serialize};
use std::fmt;
use tokio_postgres::types::{to_sql_checked, Format, IsNull, Kind, ToSql, Type};
use zeroize::Zeroizing;

pub(super) const MAX_PARAMETERS: usize = 32;
const MAX_VALUE_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresSqlBindings {
    types: Vec<u32>,
    pub(super) values: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Value {
    Null,
    Text {
        #[serde(deserialize_with = "secret")]
        value: Zeroizing<String>,
    },
}

#[derive(Serialize)]
pub(super) struct Parameter {
    index: usize,
    oid: u32,
    data_type: String,
}

pub(super) fn metadata(types: &[Type]) -> Vec<Parameter> {
    types
        .iter()
        .enumerate()
        .map(|(index, ty)| Parameter {
            index: index + 1,
            oid: ty.oid(),
            data_type: type_label(ty),
        })
        .collect()
}

pub(super) fn scope_key(sql: &str, parameters: &[Parameter]) -> String {
    let signatures: Vec<_> = parameters
        .iter()
        .map(|item| format!("{}:{}", item.oid, item.data_type))
        .collect();
    crate::sql_parameter_sets::fingerprint(
        std::iter::once(sql.as_bytes()).chain(signatures.iter().map(|item| item.as_bytes())),
    )
}

pub(super) fn type_label(ty: &Type) -> String {
    if let Kind::Array(element) = ty.kind() {
        return format!("{}[]", type_label(element));
    }
    if ty.schema() == "pg_catalog" {
        ty.name().into()
    } else {
        format!("{}.{}", ty.schema(), ty.name())
    }
}

impl PostgresSqlBindings {
    pub(super) fn validate(&self) -> Result<()> {
        if self.types.len() != self.values.len() || self.values.len() > MAX_PARAMETERS {
            return Err("PostgreSQL 매개변수의 개수와 형식을 확인하세요.".into());
        }
        for (index, value) in self.values.iter().enumerate() {
            value.validate(index + 1)?;
        }
        Ok(())
    }

    pub(super) fn matches(&self, types: &[Type]) -> bool {
        self.types.iter().copied().eq(types.iter().map(Type::oid))
    }
}

impl Value {
    pub(super) fn validate(&self, index: usize) -> Result<()> {
        if let Self::Text { value } = self {
            if value.len() > MAX_VALUE_BYTES || value.contains('\0') {
                return Err(format!(
                    "매개변수 {index}의 값은 NUL 문자 없이 16 KiB 이하여야 합니다."
                ));
            }
        }
        Ok(())
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PostgresParameter(<redacted>)")
    }
}

impl ToSql for Value {
    fn to_sql(
        &self,
        _: &Type,
        output: &mut BytesMut,
    ) -> std::result::Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self {
            Self::Null => Ok(IsNull::Yes),
            Self::Text { value } => {
                output.extend_from_slice(value.as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_: &Type) -> bool {
        true
    }

    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }

    to_sql_checked!();
}
