use super::{
    db_error, insert_audit, local_file::write_new_file, open_schema_db, AuditRecord, ObjectDetails,
    Result, Store,
};
use serde::{Deserialize, Serialize};
use std::{
    fmt::{self, Write},
    path::Path,
};
use uuid::Uuid;

const MAX_OBJECTS: usize = 512;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const TOO_LARGE: &str = "데이터 사전이 16 MiB를 초과했습니다. 객체 한 개를 선택해 다시 저장하세요.";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaDocumentFormat {
    Markdown,
    Html,
}

impl SchemaDocumentFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Html => "html",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SchemaDocumentReport {
    pub objects: usize,
    pub size_bytes: usize,
    pub audit_warning: Option<String>,
}

impl Store {
    pub fn export_schema_document(
        &self,
        profile_id: &str,
        object: Option<&str>,
        format: SchemaDocumentFormat,
        destination: &str,
    ) -> Result<SchemaDocumentReport> {
        let profile = self.profile(profile_id)?;
        let correlation = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation,
            operation: "sqlite.schema.export",
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.environment),
            object_name: None,
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let result = (|| {
            let db = open_schema_db(Path::new(&profile.path))?;
            let names = Self::schema_object_names(&db, true, object, MAX_OBJECTS + 1)?;
            if object.is_some() && names.is_empty() {
                return Err("문서로 저장할 테이블 또는 뷰를 찾을 수 없습니다.".into());
            }
            if names.len() > MAX_OBJECTS {
                return Err(format!("데이터 사전은 최대 {MAX_OBJECTS}개 객체까지 저장할 수 있습니다. 객체 한 개를 선택하세요."));
            }
            let mut document =
                Document::new(format, &profile.name, &profile.environment, names.len())
                    .map_err(|_| TOO_LARGE)?;
            let mut definitions = db
                .prepare(
                    "SELECT type, name, sql FROM main.sqlite_schema
                 WHERE tbl_name = ?1 AND type IN ('index', 'trigger') AND sql IS NOT NULL
                 ORDER BY type, name COLLATE NOCASE",
                )
                .map_err(db_error)?;
            for name in &names {
                let details = Self::describe_object_on(&db, name)
                    .map_err(|error| format!("{name} 구조를 읽을 수 없습니다. {error}"))?;
                document.object(&details).map_err(|_| TOO_LARGE)?;
                let definitions = definitions
                    .query_map([name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(db_error)?;
                for definition in definitions {
                    let (kind, name, sql) = definition.map_err(db_error)?;
                    let label = if kind == "index" {
                        "인덱스"
                    } else {
                        "트리거"
                    };
                    document
                        .definition(&format!("{label} {name}"), &sql)
                        .map_err(|_| TOO_LARGE)?;
                }
            }
            drop(definitions);
            drop(db);
            let text = document.finish().map_err(|_| TOO_LARGE)?;
            let size_bytes = write_new_file(
                destination,
                Some(format.extension()),
                ".stackport-schema-",
                text.as_bytes(),
            )?;
            Ok(SchemaDocumentReport {
                objects: names.len(),
                size_bytes,
                audit_warning: None,
            })
        })();
        let outcome = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let count = result.as_ref().ok().map(|report| report.objects as i64);
        let record = self
            .connect()
            .and_then(|db| insert_audit(&db, audit(outcome, count)));
        match (result, record) {
            (Ok(mut report), Err(_)) => {
                report.audit_warning =
                    Some("파일을 저장했지만 완료 작업 기록을 저장하지 못했습니다.".into());
                Ok(report)
            }
            (Err(error), Err(_)) => Err(format!("{error} 완료 작업 기록도 저장하지 못했습니다.")),
            (result, Ok(())) => result,
        }
    }
}

#[derive(Default)]
struct DocumentText(String);

impl Write for DocumentText {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        if text.len() > MAX_BYTES - self.0.len() {
            return Err(fmt::Error);
        }
        self.0.push_str(text);
        Ok(())
    }
}

struct Document {
    format: SchemaDocumentFormat,
    text: DocumentText,
}

impl Document {
    fn new(
        format: SchemaDocumentFormat,
        connection: &str,
        environment: &str,
        objects: usize,
    ) -> std::result::Result<Self, fmt::Error> {
        let mut document = Self {
            format,
            text: DocumentText::default(),
        };
        if matches!(format, SchemaDocumentFormat::Html) {
            document.text.write_str(concat!(
                "<!doctype html>\n<html lang=\"ko\"><head><meta charset=\"utf-8\">\n",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n",
                "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">\n",
                "<title>SQLite 데이터 사전</title>\n",
                "<style>:root{color-scheme:light dark}body{margin:2rem auto;padding:0 1rem;max-width:76rem;font:1rem/1.5 system-ui,sans-serif}",
                "table{border-collapse:collapse;width:100%;margin-block:1rem}th,td{border:1px solid GrayText;padding:.4rem;vertical-align:top;text-align:start;overflow-wrap:anywhere}",
                "pre{border:1px solid GrayText;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere}h2{border-top:1px solid GrayText;padding-top:1rem}</style>\n",
                "</head><body><main>\n",
            ))?;
        }
        document.heading(1, "SQLite 데이터 사전")?;
        document.paragraph(&format!(
            "{connection} · {environment} · main · 객체 {objects}개"
        ))?;
        Ok(document)
    }

    fn finish(mut self) -> std::result::Result<String, fmt::Error> {
        if matches!(self.format, SchemaDocumentFormat::Html) {
            self.text.write_str("</main></body></html>\n")?;
        }
        Ok(self.text.0)
    }

    fn object(&mut self, details: &ObjectDetails) -> fmt::Result {
        let kind = if details.object.kind == "view" {
            "뷰"
        } else {
            "테이블"
        };
        self.heading(2, &format!("{kind} {}", details.object.name))?;
        self.heading(3, "열")?;
        self.table(
            ["이름", "선언 타입", "NOT NULL 선언", "기본값", "키 및 특성"],
            details.columns.iter().map(|column| {
                let mut flags = Vec::new();
                if column.primary_key_position > 0 {
                    flags.push(format!("PK {}", column.primary_key_position));
                }
                let feature = match column.hidden {
                    1 => "숨김 열",
                    2 => "가상 생성 열",
                    3 => "저장 생성 열",
                    _ => "",
                };
                if !feature.is_empty() {
                    flags.push(feature.into());
                }
                [
                    column.name.clone(),
                    column.declared_type.clone(),
                    yes_no(column.not_null).into(),
                    column.default_value.clone().unwrap_or_default(),
                    flags.join(" · "),
                ]
            }),
        )?;
        if !details.indexes.is_empty() {
            self.heading(3, "인덱스")?;
            self.table(
                ["이름", "유형", "고유", "부분", "키 열"],
                details.indexes.iter().map(|index| {
                    let origin = match index.origin.as_str() {
                        "pk" => "기본 키",
                        "u" => "고유 제약",
                        _ => "인덱스",
                    };
                    let columns = index
                        .columns
                        .iter()
                        .map(|column| {
                            let name = column.name.as_deref().unwrap_or("(표현식 또는 rowid)");
                            let order = if column.descending { "DESC" } else { "ASC" };
                            match &column.collation {
                                Some(collation) => format!("{name} {order} COLLATE {collation}"),
                                None => format!("{name} {order}"),
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    [
                        index.name.clone(),
                        origin.into(),
                        yes_no(index.unique).into(),
                        yes_no(index.partial).into(),
                        columns,
                    ]
                }),
            )?;
        }
        if !details.foreign_keys.is_empty() {
            self.heading(3, "외래 키")?;
            self.table(
                [
                    "그룹",
                    "순서",
                    "원본 열",
                    "참조 테이블",
                    "참조 열",
                    "수정",
                    "삭제",
                ],
                details.foreign_keys.iter().map(|key| {
                    [
                        key.id.to_string(),
                        (key.sequence + 1).to_string(),
                        key.from_column.clone(),
                        key.target_table.clone(),
                        key.to_column
                            .clone()
                            .unwrap_or_else(|| format!("기본 키 {}번째 열", key.sequence + 1)),
                        key.on_update.clone(),
                        key.on_delete.clone(),
                    ]
                }),
            )?;
        }
        if let Some(sql) = &details.object.ddl {
            self.definition("생성 SQL", sql)?;
        }
        Ok(())
    }

    fn heading(&mut self, level: usize, value: &str) -> fmt::Result {
        match self.format {
            SchemaDocumentFormat::Markdown => write!(self.text, "{} ", "#".repeat(level))?,
            SchemaDocumentFormat::Html => write!(self.text, "<h{level}>")?,
        }
        self.value(value)?;
        match self.format {
            SchemaDocumentFormat::Markdown => self.text.write_str("\n\n"),
            SchemaDocumentFormat::Html => writeln!(self.text, "</h{level}>"),
        }
    }

    fn paragraph(&mut self, value: &str) -> fmt::Result {
        if matches!(self.format, SchemaDocumentFormat::Html) {
            self.text.write_str("<p>")?;
        }
        self.value(value)?;
        match self.format {
            SchemaDocumentFormat::Markdown => self.text.write_str("\n\n"),
            SchemaDocumentFormat::Html => self.text.write_str("</p>\n"),
        }
    }

    fn definition(&mut self, title: &str, sql: &str) -> fmt::Result {
        self.heading(3, title)?;
        match self.format {
            SchemaDocumentFormat::Markdown => {
                for line in sql.lines().flat_map(|line| line.split('\r')) {
                    writeln!(self.text, "    {line}")?;
                }
                self.text.write_char('\n')
            }
            SchemaDocumentFormat::Html => {
                self.text.write_str("<pre><code>")?;
                html_text(&mut self.text, sql)?;
                self.text.write_str("</code></pre>\n")
            }
        }
    }

    fn table<const N: usize>(
        &mut self,
        columns: [&str; N],
        rows: impl IntoIterator<Item = [String; N]>,
    ) -> fmt::Result {
        let mut rows = rows.into_iter().peekable();
        if rows.peek().is_none() {
            return self.paragraph("열 정보가 없습니다.");
        }
        if matches!(self.format, SchemaDocumentFormat::Html) {
            self.text.write_str("<table><thead>\n")?;
        }
        self.row(columns, true)?;
        match self.format {
            SchemaDocumentFormat::Markdown => {
                for _ in 0..N {
                    self.text.write_str("| --- ")?;
                }
                self.text.write_str("|\n")?;
            }
            SchemaDocumentFormat::Html => self.text.write_str("</thead><tbody>\n")?,
        }
        for row in rows {
            self.row(row.iter().map(String::as_str), false)?;
        }
        match self.format {
            SchemaDocumentFormat::Markdown => self.text.write_char('\n'),
            SchemaDocumentFormat::Html => self.text.write_str("</tbody></table>\n"),
        }
    }

    fn row<'a>(&mut self, values: impl IntoIterator<Item = &'a str>, header: bool) -> fmt::Result {
        if matches!(self.format, SchemaDocumentFormat::Html) {
            self.text.write_str("<tr>")?;
        }
        let tag = if header { "th" } else { "td" };
        for value in values {
            match self.format {
                SchemaDocumentFormat::Markdown => self.text.write_str("| ")?,
                SchemaDocumentFormat::Html if header => {
                    self.text.write_str("<th scope=\"col\">")?
                }
                SchemaDocumentFormat::Html => self.text.write_str("<td>")?,
            }
            self.value(if value.is_empty() { "—" } else { value })?;
            match self.format {
                SchemaDocumentFormat::Markdown => self.text.write_char(' ')?,
                SchemaDocumentFormat::Html => write!(self.text, "</{tag}>")?,
            }
        }
        self.text.write_str(match self.format {
            SchemaDocumentFormat::Markdown => "|\n",
            SchemaDocumentFormat::Html => "</tr>\n",
        })
    }

    fn value(&mut self, value: &str) -> fmt::Result {
        for character in value.chars() {
            if character.is_control() {
                write!(self.text, "⟦U+{:04X}⟧", u32::from(character))?;
            } else if matches!(self.format, SchemaDocumentFormat::Markdown) {
                if character.is_ascii_punctuation() {
                    self.text.write_char('\\')?;
                }
                self.text.write_char(character)?;
            } else {
                html_char(&mut self.text, character)?;
            }
        }
        Ok(())
    }
}

fn html_text(output: &mut DocumentText, text: &str) -> fmt::Result {
    for character in text.chars() {
        html_char(output, character)?;
    }
    Ok(())
}

fn html_char(output: &mut DocumentText, character: char) -> fmt::Result {
    match character {
        '&' => output.write_str("&amp;"),
        '<' => output.write_str("&lt;"),
        '>' => output.write_str("&gt;"),
        _ => output.write_char(character),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "예"
    } else {
        "—"
    }
}
