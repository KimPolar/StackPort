use super::{
    catalog::{get, ident, type_display},
    query_error, Manager,
};
use crate::{
    sql_file::{validate_definition, MAX_BYTES},
    Result,
};
use serde::Deserialize;
use std::fmt::Write as _;

const TABLE_METADATA: &str = include_str!("table_definition.sql");
const CREATE_SETTINGS: &str = concat!(
    "SET ANSI_NULLS ON;\n",
    "SET ANSI_PADDING ON;\n",
    "SET ANSI_WARNINGS ON;\n",
    "SET ARITHABORT ON;\n",
    "SET CONCAT_NULL_YIELDS_NULL ON;\n",
    "SET QUOTED_IDENTIFIER ON;\n",
    "SET NUMERIC_ROUNDABORT OFF;\n\n",
);
const MISSING_METADATA: &str =
    "SQL Server 테이블을 생성하는 데 필요한 메타데이터를 읽을 수 없습니다.";
const HIDDEN_REFERENCE: &str =
    "외래 키 대상 테이블 또는 열이 현재 계정에 공개되지 않아 완전한 생성 SQL을 구성할 수 없습니다.";

#[derive(Deserialize)]
struct TableDefinition {
    schema: String,
    name: String,
    filegroup: Option<String>,
    storage_kind: Option<String>,
    lob_filegroup: Option<String>,
    heap_compression: Option<String>,
    flags: TableFlags,
    columns: Vec<ColumnDefinition>,
    #[serde(default)]
    checks: Vec<Check>,
    #[serde(default)]
    indexes: Vec<IndexDefinition>,
    #[serde(default)]
    foreign_keys: Vec<ForeignKey>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TableFlags {
    is_memory_optimized: bool,
    is_filetable: bool,
    is_external: bool,
    is_node: bool,
    is_edge: bool,
    is_remote_data_archive_enabled: bool,
    is_data_deletion_filter_enabled: bool,
    temporal_type: u8,
    ledger_type: u8,
    filestream_data_space_id: Option<i32>,
}

#[derive(Deserialize)]
struct ColumnDefinition {
    name: String,
    type_name: Option<String>,
    type_schema: Option<String>,
    user_defined: Option<bool>,
    length: i16,
    precision: u8,
    scale: u8,
    collation: Option<String>,
    nullable: bool,
    identity: bool,
    seed: Option<String>,
    increment: Option<String>,
    identity_not_for_replication: Option<bool>,
    computed: bool,
    calculation: Option<String>,
    persisted: Option<bool>,
    rowguid: bool,
    sparse: bool,
    masked: bool,
    masking_function: Option<String>,
    column_set: bool,
    hidden: bool,
    filestream: bool,
    generated: u8,
    encryption: Option<u8>,
    bound_rule: i32,
    default_id: i32,
    default_name: Option<String>,
    default_expression: Option<String>,
    xml_collection_id: i32,
    xml_collection: Option<String>,
    xml_schema: Option<String>,
    xml_document: bool,
}

#[derive(Deserialize)]
struct Check {
    name: String,
    expression: Option<String>,
    disabled: bool,
    untrusted: bool,
    not_for_replication: bool,
}

#[derive(Deserialize)]
struct IndexDefinition {
    name: Option<String>,
    index_type: u8,
    method: String,
    unique: bool,
    has_constraint: bool,
    constraint_name: Option<String>,
    constraint_kind: Option<String>,
    disabled: bool,
    hypothetical: bool,
    has_filter: bool,
    filter: Option<String>,
    filegroup: Option<String>,
    storage_kind: Option<String>,
    compression: Option<String>,
    fill_factor: u8,
    padded: bool,
    ignore_duplicates: bool,
    allow_row_locks: bool,
    allow_page_locks: bool,
    #[serde(default)]
    columns: Vec<IndexColumn>,
}

#[derive(Deserialize)]
struct IndexColumn {
    name: String,
    key_position: u8,
    descending: bool,
    included: bool,
}

#[derive(Deserialize)]
struct ForeignKey {
    name: String,
    target_schema: Option<String>,
    target_table: Option<String>,
    on_update: u8,
    on_delete: u8,
    disabled: bool,
    untrusted: bool,
    not_for_replication: bool,
    #[serde(default)]
    columns: Vec<ForeignColumn>,
}

#[derive(Deserialize)]
struct ForeignColumn {
    source: Option<String>,
    target: Option<String>,
}

impl Manager {
    pub(super) async fn table_definition(&self, id: &str, object: i32) -> Result<String> {
        let wire_limit = (MAX_BYTES * 8) as i64;
        let rows = self
            .rows(id, TABLE_METADATA, &[&object, &wire_limit])
            .await?;
        let row = rows.first().ok_or(
            "SQL Server 테이블 생성 SQL을 보려면 현재 객체에 VIEW DEFINITION 권한이 필요합니다.",
        )?;
        if get::<i64>(row, 1)? > wire_limit {
            return Err(
                "SQL Server 테이블의 정의 메타데이터가 조회 크기 한도를 초과했습니다.".into(),
            );
        }
        let metadata = row
            .try_get::<&str, _>(0)
            .map_err(query_error)?
            .ok_or(MISSING_METADATA)?;
        let table: TableDefinition =
            serde_json::from_str(metadata).map_err(|_| MISSING_METADATA)?;
        table.render()
    }
}

impl TableDefinition {
    fn render(self) -> Result<String> {
        self.flags.validate()?;
        if self.storage_kind.as_deref() != Some("FG") {
            return Err("파티션 구성 또는 특수 저장 구조가 있는 SQL Server 테이블의 생성 SQL은 지원되지 않습니다.".into());
        }
        if self.columns.is_empty() {
            return Err(MISSING_METADATA.into());
        }
        let table = qualified(&self.schema, &self.name);
        let mut entries = self
            .columns
            .iter()
            .map(ColumnDefinition::render)
            .collect::<Result<Vec<_>>>()?;
        let mut indexes = Vec::with_capacity(self.indexes.len());
        for index in &self.indexes {
            let script = index.render(&table)?;
            if index.has_constraint {
                entries.push(script);
            } else {
                indexes.push(script);
            }
        }
        let filegroup = required(&self.filegroup)?;
        let mut script = CREATE_SETTINGS.to_owned();
        write!(
            script,
            "CREATE TABLE {table} (\n    {}\n) ON {}",
            entries.join(",\n    "),
            ident(filegroup),
        )
        .unwrap();
        if let Some(lob_space) = self.lob_filegroup.as_deref() {
            write!(script, " TEXTIMAGE_ON {}", ident(lob_space)).unwrap();
        }
        if let Some(option) = compression(self.heap_compression.as_deref())? {
            write!(script, " WITH ({option})").unwrap();
        }
        script.push_str(";\n");
        for check in &self.checks {
            script.push_str(&check.render(&table)?);
        }
        for index in &indexes {
            writeln!(script, "\n{index};").unwrap();
        }
        for key in &self.foreign_keys {
            script.push_str(&key.render(&table)?);
        }
        // Disabling a clustered index can disable other indexes and prevent table access.
        for index_type in [2, 1] {
            for index in self
                .indexes
                .iter()
                .filter(|index| index.index_type == index_type && index.disabled)
            {
                writeln!(
                    script,
                    "\nALTER INDEX {} ON {table} DISABLE;",
                    ident(required(&index.name)?)
                )
                .unwrap();
            }
        }
        validate_definition(&script)?;
        Ok(script)
    }
}

impl TableFlags {
    fn validate(&self) -> Result<()> {
        if self.is_memory_optimized
            || self.is_filetable
            || self.is_external
            || self.is_node
            || self.is_edge
            || self.is_remote_data_archive_enabled
            || self.is_data_deletion_filter_enabled
            || self.temporal_type != 0
            || self.ledger_type != 0
            || self
                .filestream_data_space_id
                .is_some_and(|space| space != 0)
        {
            return Err("시스템 버전 관리, Ledger, 그래프, FILESTREAM 또는 특수 저장 방식의 테이블은 생성 SQL 구성을 지원하지 않습니다.".into());
        }
        Ok(())
    }
}

impl ColumnDefinition {
    fn render(&self) -> Result<String> {
        if self.hidden
            || self.generated != 0
            || self.filestream
            || self.column_set
            || self.encryption.is_some()
            || self.bound_rule != 0
        {
            return Err("시스템 생성 열, 암호화, FILESTREAM, 열 집합 또는 바인딩된 규칙이 있는 테이블은 생성 SQL 구성을 지원하지 않습니다.".into());
        }
        let name = ident(&self.name);
        if self.computed {
            let expression = required(&self.calculation)?;
            let suffix = match (self.persisted.ok_or(MISSING_METADATA)?, self.nullable) {
                (false, _) => "",
                (true, true) => " PERSISTED",
                (true, false) => " PERSISTED NOT NULL",
            };
            return Ok(format!("{name} AS {expression}{suffix}"));
        }
        let mut ddl = format!("{name} {}", self.data_type()?);
        if let Some(collation) = self.collation.as_deref() {
            if !collation
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'_')
            {
                return Err(MISSING_METADATA.into());
            }
            write!(ddl, " COLLATE {collation}").unwrap();
        }
        if self.sparse {
            ddl.push_str(" SPARSE");
        }
        if self.masked {
            let function = required(&self.masking_function)?.replace('\'', "''");
            write!(ddl, " MASKED WITH (FUNCTION = '{function}')").unwrap();
        }
        if self.identity {
            let seed = identity_number(required(&self.seed)?)?;
            let increment = identity_number(required(&self.increment)?)?;
            write!(ddl, " IDENTITY({seed}, {increment})").unwrap();
            if self.identity_not_for_replication.ok_or(MISSING_METADATA)? {
                ddl.push_str(" NOT FOR REPLICATION");
            }
        }
        if self.rowguid {
            ddl.push_str(" ROWGUIDCOL");
        }
        ddl.push_str(if self.nullable { " NULL" } else { " NOT NULL" });
        if self.default_id != 0 {
            let constraint = required(&self.default_name)
                .map_err(|_| "현재 메타데이터에서 바인딩된 DEFAULT 정의를 읽을 수 없습니다.")?;
            write!(
                ddl,
                " CONSTRAINT {} DEFAULT {}",
                ident(constraint),
                required(&self.default_expression)?
            )
            .unwrap();
        }
        Ok(ddl)
    }

    fn data_type(&self) -> Result<String> {
        let name = required(&self.type_name)?;
        if self.user_defined.ok_or(MISSING_METADATA)? {
            return Ok(qualified(required(&self.type_schema)?, name));
        }
        if self.xml_collection_id != 0 {
            let collection =
                qualified(required(&self.xml_schema)?, required(&self.xml_collection)?);
            return Ok(format!(
                "xml({} {collection})",
                if self.xml_document {
                    "DOCUMENT"
                } else {
                    "CONTENT"
                }
            ));
        }
        match name {
            "float" => Ok(format!("float({})", self.precision)),
            "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" | "decimal"
            | "numeric" | "time" | "datetime2" | "datetimeoffset" | "bit" | "tinyint"
            | "smallint" | "int" | "bigint" | "real" | "money" | "smallmoney" | "date"
            | "datetime" | "smalldatetime" | "text" | "ntext" | "image" | "uniqueidentifier"
            | "xml" | "timestamp" | "rowversion" | "sql_variant" | "sysname" | "hierarchyid"
            | "geometry" | "geography" | "json" => {
                Ok(type_display(name, self.length, self.precision, self.scale))
            }
            _ => Err(format!(
                "SQL Server의 {name} 열 타입은 생성 SQL 구성을 지원하지 않습니다."
            )),
        }
    }
}

impl IndexDefinition {
    fn render(&self, table: &str) -> Result<String> {
        let method = match self.index_type {
            1 => "CLUSTERED",
            2 => "NONCLUSTERED",
            _ => {
                return Err(format!(
                    "{} 인덱스가 있는 테이블은 생성 SQL 구성을 지원하지 않습니다.",
                    self.method
                ))
            }
        };
        if self.hypothetical || self.storage_kind.as_deref() != Some("FG") {
            return Err(
                "가상 인덱스 또는 파티션 인덱스가 있는 테이블은 생성 SQL 구성을 지원하지 않습니다."
                    .into(),
            );
        }
        let keys = self
            .columns
            .iter()
            .filter(|column| column.key_position != 0)
            .map(|column| {
                format!(
                    "{} {}",
                    ident(&column.name),
                    if column.descending { "DESC" } else { "ASC" }
                )
            })
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err(MISSING_METADATA.into());
        }
        let included = self
            .columns
            .iter()
            .filter(|column| column.included)
            .map(|column| ident(&column.name))
            .collect::<Vec<_>>();
        let columns = keys.join(", ");
        let mut ddl = if self.has_constraint {
            let kind = match self.constraint_kind.as_deref() {
                Some("PK") => "PRIMARY KEY",
                Some("UQ") => "UNIQUE",
                _ => return Err(MISSING_METADATA.into()),
            };
            if !included.is_empty() || self.has_filter {
                return Err(MISSING_METADATA.into());
            }
            format!(
                "CONSTRAINT {} {kind} {method} ({columns})",
                ident(required(&self.constraint_name)?)
            )
        } else {
            let unique = if self.unique { "UNIQUE " } else { "" };
            format!(
                "CREATE {unique}{method} INDEX {} ON {table} ({columns})",
                ident(required(&self.name)?)
            )
        };
        if !included.is_empty() {
            write!(ddl, " INCLUDE ({})", included.join(", ")).unwrap();
        }
        if self.has_filter {
            write!(ddl, " WHERE {}", required(&self.filter)?).unwrap();
        }
        let mut options = Vec::new();
        if self.fill_factor > 0 {
            options.push(format!("FILLFACTOR = {}", self.fill_factor));
        }
        for (enabled, option) in [
            (self.padded, "PAD_INDEX = ON"),
            (self.ignore_duplicates, "IGNORE_DUP_KEY = ON"),
            (!self.allow_row_locks, "ALLOW_ROW_LOCKS = OFF"),
            (!self.allow_page_locks, "ALLOW_PAGE_LOCKS = OFF"),
        ] {
            if enabled {
                options.push(option.into());
            }
        }
        options.extend(compression(self.compression.as_deref())?.map(str::to_owned));
        if !options.is_empty() {
            write!(ddl, " WITH ({})", options.join(", ")).unwrap();
        }
        write!(ddl, " ON {}", ident(required(&self.filegroup)?)).unwrap();
        Ok(ddl)
    }
}

impl Check {
    fn render(&self, table: &str) -> Result<String> {
        let constraint = ident(&self.name);
        let trust = trust_clause(self.disabled, self.untrusted);
        let replication = if self.not_for_replication {
            " NOT FOR REPLICATION"
        } else {
            ""
        };
        let mut ddl = format!("\nALTER TABLE {table} WITH {trust} ADD CONSTRAINT {constraint} CHECK{replication} {};\n",
            required(&self.expression)?);
        disable_constraint(&mut ddl, table, &constraint, self.disabled);
        Ok(ddl)
    }
}

impl ForeignKey {
    fn render(&self, table: &str) -> Result<String> {
        let target = qualified(
            required(&self.target_schema).map_err(|_| HIDDEN_REFERENCE)?,
            required(&self.target_table).map_err(|_| HIDDEN_REFERENCE)?,
        );
        if self.columns.is_empty() {
            return Err(HIDDEN_REFERENCE.into());
        }
        let source_columns = self
            .columns
            .iter()
            .map(|column| required(&column.source).map(ident))
            .collect::<Result<Vec<_>>>()?;
        let target_columns = self
            .columns
            .iter()
            .map(|column| required(&column.target).map(ident))
            .collect::<Result<Vec<_>>>()
            .map_err(|_| HIDDEN_REFERENCE)?;
        let constraint = ident(&self.name);
        let trust = trust_clause(self.disabled, self.untrusted);
        let delete = action(self.on_delete)?;
        let update = action(self.on_update)?;
        let replication = if self.not_for_replication {
            " NOT FOR REPLICATION"
        } else {
            ""
        };
        let mut ddl = format!("\nALTER TABLE {table} WITH {trust} ADD CONSTRAINT {constraint} FOREIGN KEY ({})\n    REFERENCES {target} ({}) ON DELETE {delete} ON UPDATE {update}{replication};\n",
            source_columns.join(", "), target_columns.join(", "));
        disable_constraint(&mut ddl, table, &constraint, self.disabled);
        Ok(ddl)
    }
}

fn required(value: &Option<String>) -> Result<&str> {
    value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| MISSING_METADATA.into())
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}

fn identity_number(value: &str) -> Result<&str> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|value| value.is_ascii_digit()) {
        return Err(MISSING_METADATA.into());
    }
    Ok(value)
}

fn compression(value: Option<&str>) -> Result<Option<&'static str>> {
    match value {
        None | Some("NONE") => Ok(None),
        Some("ROW") => Ok(Some("DATA_COMPRESSION = ROW")),
        Some("PAGE") => Ok(Some("DATA_COMPRESSION = PAGE")),
        _ => Err("SQL Server 압축 형식의 생성 SQL을 구성할 수 없습니다.".into()),
    }
}

fn trust_clause(disabled: bool, untrusted: bool) -> &'static str {
    if disabled || untrusted {
        "NOCHECK"
    } else {
        "CHECK"
    }
}

fn disable_constraint(ddl: &mut String, table: &str, constraint: &str, disabled: bool) {
    if disabled {
        writeln!(ddl, "ALTER TABLE {table} NOCHECK CONSTRAINT {constraint};").unwrap();
    }
}

fn action(value: u8) -> Result<&'static str> {
    match value {
        0 => Ok("NO ACTION"),
        1 => Ok("CASCADE"),
        2 => Ok("SET NULL"),
        3 => Ok("SET DEFAULT"),
        _ => Err(MISSING_METADATA.into()),
    }
}
