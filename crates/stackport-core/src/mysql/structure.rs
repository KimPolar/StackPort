use super::{
    query, quoted, require_identifier, Conn, Error, MysqlCatalogPage, MysqlManager, MysqlObject,
    Params, Queryable, ReadError, ReadResult, Row, Value, CATALOG_LIMIT,
};
use crate::Result;
use mysql_async::prelude::FromValue;
use serde::{Deserialize, Serialize};

const EXPRESSION_LIMIT: usize = 4096;
const DEFINITION_LIMIT: usize = 262_144;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MysqlStructureSection {
    Indexes,
    Constraints,
    References,
    Definition,
}

#[derive(Serialize)]
#[serde(tag = "section", rename_all = "snake_case")]
pub enum MysqlStructure {
    Indexes {
        #[serde(flatten)]
        page: MysqlCatalogPage<MysqlIndex>,
    },
    Constraints {
        #[serde(flatten)]
        page: MysqlCatalogPage<MysqlConstraint>,
    },
    References {
        #[serde(flatten)]
        page: MysqlCatalogPage<MysqlIncomingReference>,
    },
    Definition {
        definition: MysqlDefinition,
    },
}

#[derive(Serialize)]
pub struct MysqlDefinition {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
pub struct MysqlIndex {
    name: String,
    method: String,
    unique: bool,
    visible: Option<bool>,
    parts: Vec<MysqlIndexPart>,
}

#[derive(Serialize)]
struct MysqlIndexPart {
    column: Option<String>,
    expression: Option<MysqlDefinition>,
    order: Option<String>,
    prefix: Option<u64>,
    cardinality: Option<String>,
}

#[derive(Serialize)]
pub struct MysqlConstraint {
    name: String,
    kind: String,
    columns: Vec<MysqlKeyColumn>,
    reference: Option<MysqlRelation>,
    on_update: Option<String>,
    on_delete: Option<String>,
    expression: Option<MysqlDefinition>,
    enforced: Option<bool>,
}

#[derive(Serialize)]
pub struct MysqlIncomingReference {
    name: String,
    source: MysqlRelation,
    columns: Vec<MysqlKeyColumn>,
    on_update: Option<String>,
    on_delete: Option<String>,
}

#[derive(Serialize)]
struct MysqlKeyColumn {
    local: String,
    referenced: Option<String>,
}

#[derive(Serialize)]
struct MysqlRelation {
    database: String,
    name: String,
    object: Option<MysqlObject>,
}

impl MysqlManager {
    pub async fn structure(
        &self,
        id: &str,
        database: String,
        table: String,
        section: MysqlStructureSection,
        page: u32,
    ) -> Result<MysqlStructure> {
        require_identifier(&database)?;
        require_identifier(&table)?;
        let offset = u64::from(page) * CATALOG_LIMIT as u64;
        self.read(id, |connection| {
            Box::pin(async move {
                let kind = object_kind(connection, &database, &table).await?;
                match section {
                    MysqlStructureSection::Indexes => Ok(MysqlStructure::Indexes {
                        page: indexes(connection, &database, &table, offset).await?,
                    }),
                    MysqlStructureSection::Constraints => Ok(MysqlStructure::Constraints {
                        page: constraints(connection, &database, &table, offset).await?,
                    }),
                    MysqlStructureSection::References => Ok(MysqlStructure::References {
                        page: incoming(connection, &database, &table, offset).await?,
                    }),
                    MysqlStructureSection::Definition => Ok(MysqlStructure::Definition {
                        definition: definition(connection, &database, &table, &kind).await?,
                    }),
                }
            })
        })
        .await
    }
}

async fn object_kind(connection: &mut Conn, database: &str, table: &str) -> ReadResult<String> {
    let row = connection
        .exec_first::<Row, _, _>(
            "SELECT TABLE_TYPE AS object_kind FROM information_schema.TABLES
             WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
               AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)
               AND TABLE_TYPE IN ('BASE TABLE','VIEW','SYSTEM VIEW','SYSTEM VERSIONED')",
            (database, table),
        )
        .await?
        .ok_or(ReadError::Missing)?;
    field(&row, "object_kind")
}

async fn catalog_columns(connection: &mut Conn, table: &str) -> ReadResult<Vec<String>> {
    let columns: Vec<(String,)> = query(
        connection,
        "SELECT UPPER(COLUMN_NAME) FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = 'information_schema' AND UPPER(TABLE_NAME) = ?",
        (table,),
    )
    .await?;
    Ok(columns.into_iter().map(|(name,)| name).collect())
}

async fn indexes(
    connection: &mut Conn,
    database: &str,
    table: &str,
    offset: u64,
) -> ReadResult<MysqlCatalogPage<MysqlIndex>> {
    let fields = catalog_columns(connection, "STATISTICS").await?;
    let has = |name| fields.iter().any(|column| column == name);
    let expression = if has("EXPRESSION") {
        "s.EXPRESSION"
    } else {
        "NULL"
    };
    let visible = if has("IS_VISIBLE") {
        "s.IS_VISIBLE = 'YES'"
    } else if has("IGNORED") {
        "s.IGNORED = 'NO'"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT s.INDEX_NAME AS index_name, s.INDEX_TYPE AS method, s.NON_UNIQUE = 0 AS unique_key,
                s.COLUMN_NAME AS column_name, s.COLLATION AS sort_order, s.SUB_PART AS prefix_length,
                CAST(s.CARDINALITY AS CHAR) AS cardinality,
                LEFT({expression}, {EXPRESSION_LIMIT}) AS expression_text,
                COALESCE(CHAR_LENGTH({expression}) > {EXPRESSION_LIMIT}, 0) AS expression_cut,
                {visible} AS visible
         FROM information_schema.STATISTICS s
         JOIN (
           SELECT DISTINCT CAST(INDEX_NAME AS BINARY) AS index_key FROM information_schema.STATISTICS
           WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
             AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)
           ORDER BY index_key LIMIT 101 OFFSET ?
         ) page ON page.index_key = CAST(s.INDEX_NAME AS BINARY)
         WHERE CAST(s.TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
           AND CAST(s.TABLE_NAME AS BINARY) = CAST(? AS BINARY)
         ORDER BY page.index_key, s.SEQ_IN_INDEX"
    );
    let rows = connection
        .exec::<Row, _, _>(sql, (database, table, offset, database, table))
        .await?;
    let mut output: Vec<MysqlIndex> = Vec::new();
    for row in rows {
        let name: String = field(&row, "index_name")?;
        if output.last().is_none_or(|index| index.name != name) {
            output.push(MysqlIndex {
                name,
                method: field(&row, "method")?,
                unique: field(&row, "unique_key")?,
                visible: field(&row, "visible")?,
                parts: Vec::new(),
            });
        }
        output
            .last_mut()
            .ok_or(ReadError::Shape)?
            .parts
            .push(MysqlIndexPart {
                column: field(&row, "column_name")?,
                expression: expression_fragment(&row)?,
                order: field(&row, "sort_order")?,
                prefix: field(&row, "prefix_length")?,
                cardinality: field(&row, "cardinality")?,
            });
    }
    Ok(MysqlCatalogPage::new(output))
}

async fn constraints(
    connection: &mut Conn,
    database: &str,
    table: &str,
    offset: u64,
) -> ReadResult<MysqlCatalogPage<MysqlConstraint>> {
    let fields = catalog_columns(connection, "CHECK_CONSTRAINTS").await?;
    let table_scoped_checks = fields.iter().any(|name| name == "TABLE_NAME");
    let check_table = if table_scoped_checks {
        "AND CAST(ch.TABLE_NAME AS BINARY) = CAST(c.TABLE_NAME AS BINARY)"
    } else {
        ""
    };
    let check_join = if fields.is_empty() {
        String::new()
    } else {
        format!(
            "LEFT JOIN information_schema.CHECK_CONSTRAINTS ch ON c.CONSTRAINT_TYPE = 'CHECK'
             AND CAST(ch.CONSTRAINT_SCHEMA AS BINARY) = CAST(c.CONSTRAINT_SCHEMA AS BINARY)
             AND CAST(ch.CONSTRAINT_NAME AS BINARY) = CAST(c.CONSTRAINT_NAME AS BINARY) {check_table}"
        )
    };
    let expression = if fields.is_empty() {
        "NULL"
    } else {
        "ch.CHECK_CLAUSE"
    };
    let enforced = if catalog_columns(connection, "TABLE_CONSTRAINTS")
        .await?
        .iter()
        .any(|name| name == "ENFORCED")
    {
        "CASE WHEN CONSTRAINT_TYPE = 'CHECK' THEN ENFORCED = 'YES' END"
    } else {
        "NULL"
    };
    // MariaDB can make KEY_COLUMN_USAGE and table-scoped CHECK_CONSTRAINTS
    // visible to a read-only account while hiding rows from TABLE_CONSTRAINTS.
    let check_candidates = if table_scoped_checks {
        "UNION ALL
         SELECT CONSTRAINT_SCHEMA, CONSTRAINT_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, 'CHECK', NULL
         FROM information_schema.CHECK_CONSTRAINTS
         WHERE CAST(CONSTRAINT_SCHEMA AS BINARY) = CAST(? AS BINARY)
           AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT c.CONSTRAINT_NAME AS constraint_name, c.CONSTRAINT_TYPE AS constraint_kind, c.enforced_check,
                k.COLUMN_NAME AS local_column, k.REFERENCED_COLUMN_NAME AS referenced_column,
                k.REFERENCED_TABLE_SCHEMA AS link_database, k.REFERENCED_TABLE_NAME AS link_name,
                link_info.TABLE_TYPE AS link_type, link_info.ENGINE AS link_engine,
                r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule,
                LEFT({expression}, {EXPRESSION_LIMIT}) AS expression_text,
                COALESCE(CHAR_LENGTH({expression}) > {EXPRESSION_LIMIT}, 0) AS expression_cut
         FROM (
           SELECT CONSTRAINT_SCHEMA, TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE,
                  MAX(enforced_check) AS enforced_check
           FROM (
             SELECT CAST(CONSTRAINT_SCHEMA AS BINARY) AS CONSTRAINT_SCHEMA,
                    CAST(TABLE_SCHEMA AS BINARY) AS TABLE_SCHEMA, CAST(TABLE_NAME AS BINARY) AS TABLE_NAME,
                    CAST(CONSTRAINT_NAME AS BINARY) AS CONSTRAINT_NAME, CONSTRAINT_TYPE,
                    {enforced} AS enforced_check
             FROM information_schema.TABLE_CONSTRAINTS
             WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
               AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)
             UNION ALL
             SELECT CONSTRAINT_SCHEMA, TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME,
                    CASE WHEN REFERENCED_TABLE_NAME IS NOT NULL THEN 'FOREIGN KEY'
                         WHEN CONSTRAINT_NAME = 'PRIMARY' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END,
                    NULL
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
               AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)
             {check_candidates}
           ) candidates
           GROUP BY CONSTRAINT_SCHEMA, TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
           ORDER BY CONSTRAINT_NAME, CONSTRAINT_TYPE LIMIT 101 OFFSET ?
         ) c
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k
           ON CAST(k.TABLE_SCHEMA AS BINARY) = CAST(c.TABLE_SCHEMA AS BINARY)
           AND CAST(k.TABLE_NAME AS BINARY) = CAST(c.TABLE_NAME AS BINARY)
           AND CAST(k.CONSTRAINT_NAME AS BINARY) = CAST(c.CONSTRAINT_NAME AS BINARY)
           AND ((c.CONSTRAINT_TYPE = 'FOREIGN KEY' AND k.REFERENCED_TABLE_NAME IS NOT NULL)
             OR (c.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE') AND k.REFERENCED_TABLE_NAME IS NULL))
         {check_join}
         {RULE_JOIN}
         LEFT JOIN information_schema.TABLES link_info
           ON CAST(link_info.TABLE_SCHEMA AS BINARY) = CAST(k.REFERENCED_TABLE_SCHEMA AS BINARY)
           AND CAST(link_info.TABLE_NAME AS BINARY) = CAST(k.REFERENCED_TABLE_NAME AS BINARY)
         ORDER BY CAST(c.CONSTRAINT_NAME AS BINARY), c.CONSTRAINT_TYPE, k.ORDINAL_POSITION"
    );
    let mut parameters: Vec<_> = [database, table, database, table]
        .into_iter()
        .map(Value::from)
        .collect();
    if table_scoped_checks {
        parameters.extend([Value::from(database), Value::from(table)]);
    }
    parameters.push(Value::UInt(offset));
    let rows = connection
        .exec::<Row, _, _>(sql, Params::Positional(parameters))
        .await?;
    let mut output: Vec<MysqlConstraint> = Vec::new();
    for row in rows {
        let name: String = field(&row, "constraint_name")?;
        let kind: String = field(&row, "constraint_kind")?;
        if output
            .last()
            .is_none_or(|item| item.name != name || item.kind != kind)
        {
            output.push(MysqlConstraint {
                name,
                kind,
                columns: Vec::new(),
                reference: relation(&row)?,
                on_update: field(&row, "update_rule")?,
                on_delete: field(&row, "delete_rule")?,
                expression: expression_fragment(&row)?,
                enforced: field(&row, "enforced_check")?,
            });
        }
        if let Some(column) = key_column(&row)? {
            output
                .last_mut()
                .ok_or(ReadError::Shape)?
                .columns
                .push(column);
        }
    }
    Ok(MysqlCatalogPage::new(output))
}

const RULE_JOIN: &str = "LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON CAST(r.CONSTRAINT_SCHEMA AS BINARY) = CAST(k.CONSTRAINT_SCHEMA AS BINARY)
    AND CAST(r.TABLE_NAME AS BINARY) = CAST(k.TABLE_NAME AS BINARY)
    AND CAST(r.CONSTRAINT_NAME AS BINARY) = CAST(k.CONSTRAINT_NAME AS BINARY)
    AND k.REFERENCED_TABLE_NAME IS NOT NULL";

async fn incoming(
    connection: &mut Conn,
    database: &str,
    table: &str,
    offset: u64,
) -> ReadResult<MysqlCatalogPage<MysqlIncomingReference>> {
    let sql = format!(
        "SELECT k.CONSTRAINT_NAME AS constraint_name, k.COLUMN_NAME AS local_column,
                k.REFERENCED_COLUMN_NAME AS referenced_column,
                k.TABLE_SCHEMA AS link_database, k.TABLE_NAME AS link_name,
                link_info.TABLE_TYPE AS link_type, link_info.ENGINE AS link_engine,
                r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule
         FROM (
           SELECT DISTINCT CAST(TABLE_SCHEMA AS BINARY) AS schema_key, CAST(TABLE_NAME AS BINARY) AS table_key,
                           CAST(CONSTRAINT_NAME AS BINARY) AS constraint_key
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE CAST(REFERENCED_TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
             AND CAST(REFERENCED_TABLE_NAME AS BINARY) = CAST(? AS BINARY)
           ORDER BY schema_key, table_key, constraint_key LIMIT 101 OFFSET ?
         ) page
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON CAST(k.TABLE_SCHEMA AS BINARY) = page.schema_key
           AND CAST(k.TABLE_NAME AS BINARY) = page.table_key
           AND CAST(k.CONSTRAINT_NAME AS BINARY) = page.constraint_key
           AND k.REFERENCED_TABLE_NAME IS NOT NULL
         {RULE_JOIN}
         LEFT JOIN information_schema.TABLES link_info
           ON CAST(link_info.TABLE_SCHEMA AS BINARY) = page.schema_key
           AND CAST(link_info.TABLE_NAME AS BINARY) = page.table_key
         ORDER BY page.schema_key, page.table_key, page.constraint_key, k.ORDINAL_POSITION"
    );
    let rows = connection
        .exec::<Row, _, _>(sql, (database, table, offset))
        .await?;
    let mut output: Vec<MysqlIncomingReference> = Vec::new();
    for row in rows {
        let name: String = field(&row, "constraint_name")?;
        let source = relation(&row)?.ok_or(ReadError::Shape)?;
        if output.last().is_none_or(|item| {
            item.name != name
                || item.source.database != source.database
                || item.source.name != source.name
        }) {
            output.push(MysqlIncomingReference {
                name,
                source,
                columns: Vec::new(),
                on_update: field(&row, "update_rule")?,
                on_delete: field(&row, "delete_rule")?,
            });
        }
        let column = key_column(&row)?.ok_or(ReadError::Shape)?;
        output
            .last_mut()
            .ok_or(ReadError::Shape)?
            .columns
            .push(column);
    }
    Ok(MysqlCatalogPage::new(output))
}

async fn definition(
    connection: &mut Conn,
    database: &str,
    table: &str,
    kind: &str,
) -> ReadResult<MysqlDefinition> {
    let view = kind.ends_with("VIEW");
    let object_type = if view { "VIEW" } else { "TABLE" };
    let sql = format!(
        "SHOW CREATE {object_type} {}.{}",
        quoted(database),
        quoted(table)
    );
    let row = connection
        .query_first::<Row, _>(sql)
        .await
        .map_err(|error| match &error {
            Error::Server(error) if view && matches!(error.code, 1044 | 1142 | 1143 | 1227) => {
                ReadError::InvalidQuery(
                    "뷰의 생성 SQL을 읽으려면 해당 뷰의 SHOW VIEW 권한이 필요합니다.".into(),
                )
            }
            _ => ReadError::Server(error),
        })?
        .ok_or(ReadError::Missing)?;
    let mut text = row
        .get_opt::<String, _>(1)
        .ok_or(ReadError::Shape)?
        .map_err(|_| ReadError::Shape)?;
    let boundary = text
        .char_indices()
        .nth(DEFINITION_LIMIT)
        .map(|(index, _)| index);
    if let Some(index) = boundary {
        text.truncate(index);
    }
    Ok(MysqlDefinition {
        text,
        truncated: boundary.is_some(),
    })
}

fn field<T: FromValue>(row: &Row, name: &str) -> ReadResult<T> {
    row.get_opt(name)
        .ok_or(ReadError::Shape)?
        .map_err(|_| ReadError::Shape)
}

fn expression_fragment(row: &Row) -> ReadResult<Option<MysqlDefinition>> {
    let Some(text) = field::<Option<String>>(row, "expression_text")? else {
        return Ok(None);
    };
    Ok(Some(MysqlDefinition {
        text,
        truncated: field(row, "expression_cut")?,
    }))
}

fn key_column(row: &Row) -> ReadResult<Option<MysqlKeyColumn>> {
    let Some(local) = field::<Option<String>>(row, "local_column")? else {
        return Ok(None);
    };
    Ok(Some(MysqlKeyColumn {
        local,
        referenced: field(row, "referenced_column")?,
    }))
}

fn relation(row: &Row) -> ReadResult<Option<MysqlRelation>> {
    let (Some(database), Some(name)) = (
        field::<Option<String>>(row, "link_database")?,
        field::<Option<String>>(row, "link_name")?,
    ) else {
        return Ok(None);
    };
    let object = match field::<Option<String>>(row, "link_type")? {
        Some(kind) => Some(MysqlObject {
            name: name.clone(),
            kind,
            engine: field(row, "link_engine")?,
        }),
        None => None,
    };
    Ok(Some(MysqlRelation {
        database,
        name,
        object,
    }))
}
