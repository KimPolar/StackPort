//! Streaming SQLite result files that are only published after completion.

use super::{Result, SqlParameterValue, TableQuery};
use rusqlite::{types::ValueRef, Row};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportQuery {
    Sql {
        sql: String,
        parameters: Option<Vec<SqlParameterValue>>,
    },
    Table {
        request: TableQuery,
    },
}

#[derive(Deserialize)]
pub struct CsvOptions {
    pub destination: String,
    pub include_header: bool,
    pub spreadsheet_safe: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportReport {
    pub format: &'static str,
    pub path: String,
    pub rows: u64,
    pub size_bytes: u64,
    pub protected_fields: u64,
    pub audit_warning: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) enum ExportFormat {
    Csv {
        include_header: bool,
        spreadsheet_safe: bool,
    },
    Json,
}

impl ExportFormat {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Csv { .. } => "CSV",
            Self::Json => "JSON",
        }
    }

    pub(crate) fn audit_operation(self) -> &'static str {
        match self {
            Self::Csv { .. } => "sqlite.export.csv",
            Self::Json => "sqlite.export.json",
        }
    }

    fn io(self, error: impl std::fmt::Display) -> String {
        format!("{} 파일에 기록할 수 없습니다: {error}", self.label())
    }
}

pub(crate) struct ExportFile {
    target: PathBuf,
    file: BufWriter<NamedTempFile>,
    format: ExportFormat,
    protected_fields: u64,
}

impl ExportFile {
    pub(crate) fn create(
        destination: &str,
        format: ExportFormat,
        columns: &[String],
    ) -> Result<Self> {
        let mut output = Self::open(destination, format)?;
        output.write_header(
            "stackport.sqlite-results",
            columns,
            columns.iter().map(String::as_str),
        )?;
        Ok(output)
    }

    pub(crate) fn create_postgres(
        destination: &str,
        format: ExportFormat,
        columns: &[PostgresExportColumn],
    ) -> Result<Self> {
        let mut output = Self::open(destination, format)?;
        output.write_header(
            "stackport.postgres-results",
            columns,
            columns.iter().map(|column| column.name.as_str()),
        )?;
        Ok(output)
    }

    fn open(destination: &str, format: ExportFormat) -> Result<Self> {
        let label = format.label();
        let target = Path::new(destination.trim());
        let name = target
            .file_name()
            .ok_or_else(|| format!("{label} 파일 이름을 입력하세요."))?;
        if !target.is_absolute()
            || !target
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case(label))
            || (cfg!(windows) && name.to_string_lossy().contains(':'))
        {
            return Err(format!("새 {label} 파일의 절대 경로를 입력하세요."));
        }
        let folder = target
            .parent()
            .ok_or_else(|| format!("{label} 파일을 저장할 폴더를 지정하세요."))?
            .canonicalize()
            .map_err(|_| format!("{label} 파일을 저장할 폴더를 열 수 없습니다."))?;
        if !folder.is_dir() {
            return Err(format!("{label} 파일을 저장할 폴더를 지정하세요."));
        }
        let target = folder.join(name);
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                return Err(format!(
                    "같은 이름의 파일이 이미 있습니다. 새 {label} 경로를 선택하세요."
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(format!("{label} 파일을 저장할 경로에 접근할 수 없습니다.")),
        }
        let prefix = format!(".stackport-{}-", label.to_ascii_lowercase());
        let file = tempfile::Builder::new()
            .prefix(&prefix)
            .tempfile_in(folder)
            .map_err(|error| format!("{label} 임시 파일을 만들 수 없습니다: {error}"))?;
        Ok(Self {
            target,
            file: BufWriter::with_capacity(64 * 1024, file),
            format,
            protected_fields: 0,
        })
    }

    fn write_header<'a>(
        &mut self,
        format_name: &str,
        columns: &(impl Serialize + ?Sized),
        names: impl IntoIterator<Item = &'a str>,
    ) -> Result<()> {
        match self.format {
            ExportFormat::Csv {
                include_header: true,
                ..
            } => self
                .write_csv_header(names)
                .map_err(|error| self.format.io(error))?,
            ExportFormat::Csv { .. } => {}
            ExportFormat::Json => self.write_json_header(format_name, columns)?,
        }
        Ok(())
    }

    fn write_csv_header<'a>(
        &mut self,
        columns: impl IntoIterator<Item = &'a str>,
    ) -> io::Result<()> {
        for (index, name) in columns.into_iter().enumerate() {
            self.delimiter(index)?;
            self.write_csv_text(name)?;
        }
        self.file.write_all(b"\r\n")
    }

    pub(crate) fn write_row(&mut self, row: &Row<'_>, previous_rows: u64) -> Result<()> {
        match self.format {
            ExportFormat::Csv { .. } => self.write_csv_row(row),
            ExportFormat::Json => self.write_json_row(row, previous_rows),
        }
    }

    fn write_csv_row(&mut self, row: &Row<'_>) -> Result<()> {
        let format = self.format;
        for index in 0..row.as_ref().column_count() {
            self.delimiter(index).map_err(|error| format.io(error))?;
            let value = row.get_ref(index).map_err(super::db_error)?;
            let written = match value {
                ValueRef::Null => self.file.write_all(b"\\N"),
                ValueRef::Integer(value) => write!(self.file, "{value}"),
                ValueRef::Real(value) => write!(self.file, "{value}"),
                ValueRef::Text(value) => {
                    let text = valid_text(value, format)?;
                    self.write_csv_text(text)
                }
                ValueRef::Blob(value) => self.write_blob(value, b"\"X'", b"'\""),
            };
            written.map_err(|error| format.io(error))?;
        }
        self.file
            .write_all(b"\r\n")
            .map_err(|error| format.io(error))
    }

    fn write_json_header(
        &mut self,
        format_name: &str,
        columns: &(impl Serialize + ?Sized),
    ) -> Result<()> {
        let io = |error| ExportFormat::Json.io(error);
        write!(
            self.file,
            "{{\"format\":\"{format_name}\",\"version\":1,\"columns\":"
        )
        .map_err(io)?;
        serde_json::to_writer(&mut self.file, columns)
            .map_err(|error| ExportFormat::Json.io(error))?;
        self.file.write_all(b",\"rows\":[").map_err(io)
    }

    pub(crate) fn write_postgres_row(
        &mut self,
        row: &[Option<&str>],
        columns: &[PostgresExportColumn],
        previous_rows: u64,
    ) -> Result<()> {
        let format = self.format;
        let io = |error| format.io(error);
        match format {
            ExportFormat::Json => {
                if previous_rows > 0 {
                    self.file.write_all(b",").map_err(io)?;
                }
                self.file.write_all(b"\n").map_err(io)?;
                serde_json::to_writer(&mut self.file, row).map_err(|error| format.io(error))
            }
            ExportFormat::Csv { .. } => {
                for (index, (value, column)) in row.iter().zip(columns).enumerate() {
                    self.delimiter(index).map_err(io)?;
                    match value {
                        None => self.file.write_all(b"\\N"),
                        Some(value)
                            if column.numeric
                                && value.parse::<f64>().is_ok()
                                && value.bytes().all(|byte| {
                                    matches!(byte, b'0'..=b'9' | b'.' | b'+' | b'-' | b'e' | b'E')
                                }) =>
                        {
                            self.file.write_all(value.as_bytes())
                        }
                        Some(value) => self.write_csv_text(value),
                    }
                    .map_err(io)?;
                }
                self.file.write_all(b"\r\n").map_err(io)
            }
        }
    }

    fn write_json_row(&mut self, row: &Row<'_>, previous_rows: u64) -> Result<()> {
        let io = |error| ExportFormat::Json.io(error);
        if previous_rows > 0 {
            self.file.write_all(b",").map_err(io)?;
        }
        self.file.write_all(b"\n[").map_err(io)?;
        for index in 0..row.as_ref().column_count() {
            self.delimiter(index).map_err(io)?;
            let written = match row.get_ref(index).map_err(super::db_error)? {
                ValueRef::Null => self.file.write_all(b"null"),
                ValueRef::Integer(value) => write!(self.file, "{{\"integer\":\"{value}\"}}"),
                ValueRef::Real(value) => write!(self.file, "{{\"real\":\"{value:?}\"}}"),
                ValueRef::Text(value) => {
                    let text = valid_text(value, ExportFormat::Json)?;
                    serde_json::to_writer(&mut self.file, text)
                        .map_err(|error| ExportFormat::Json.io(error))?;
                    continue;
                }
                ValueRef::Blob(value) => self.write_blob(value, b"{\"blob_hex\":\"", b"\"}"),
            };
            written.map_err(io)?;
        }
        self.file.write_all(b"]").map_err(io)
    }

    fn delimiter(&mut self, index: usize) -> io::Result<()> {
        if index > 0 {
            self.file.write_all(b",")?;
        }
        Ok(())
    }

    fn write_csv_text(&mut self, value: &str) -> io::Result<()> {
        self.file.write_all(b"\"")?;
        if matches!(
            self.format,
            ExportFormat::Csv {
                spreadsheet_safe: true,
                ..
            }
        ) && formula_prefix(value)
        {
            self.file.write_all(b"'")?;
            self.protected_fields += 1;
        }
        for (index, segment) in value.split('"').enumerate() {
            if index > 0 {
                self.file.write_all(b"\"\"")?;
            }
            self.file.write_all(segment.as_bytes())?;
        }
        self.file.write_all(b"\"")
    }

    fn write_blob(&mut self, value: &[u8], prefix: &[u8], suffix: &[u8]) -> io::Result<()> {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        self.file.write_all(prefix)?;
        let mut output = [0; 2048];
        for block in value.chunks(output.len() / 2) {
            for (index, byte) in block.iter().enumerate() {
                output[index * 2] = HEX[(byte >> 4) as usize];
                output[index * 2 + 1] = HEX[(byte & 15) as usize];
            }
            self.file.write_all(&output[..block.len() * 2])?;
        }
        self.file.write_all(suffix)
    }

    /// Flush both output buffers before the caller accepts the final publish.
    pub(crate) fn finish(mut self) -> Result<ReadyExport> {
        let format = self.format;
        if matches!(format, ExportFormat::Json) {
            self.file
                .write_all(b"\n]}\n")
                .map_err(|error| format.io(error))?;
        }
        let file = self
            .file
            .into_inner()
            .map_err(|error| format.io(error.into_error()))?;
        let handle: &File = file.as_file();
        handle.sync_all().map_err(|error| format.io(error))?;
        let size_bytes = handle.metadata().map_err(|error| format.io(error))?.len();
        Ok(ReadyExport {
            target: self.target,
            file,
            format,
            size_bytes,
            protected_fields: self.protected_fields,
        })
    }
}

pub(crate) struct ReadyExport {
    target: PathBuf,
    file: NamedTempFile,
    format: ExportFormat,
    size_bytes: u64,
    protected_fields: u64,
}

#[derive(Serialize)]
pub(crate) struct PostgresExportColumn {
    pub(crate) name: String,
    pub(crate) data_type: String,
    #[serde(skip)]
    pub(crate) numeric: bool,
}

impl ReadyExport {
    pub(crate) fn publish(self, rows: u64) -> Result<ExportReport> {
        let format = self.format.label();
        self.file.persist_noclobber(&self.target).map_err(|error| {
            format!(
                "{format} 파일을 저장할 수 없습니다. 기존 파일은 덮어쓰지 않습니다: {}",
                error.error
            )
        })?;
        Ok(ExportReport {
            format,
            path: self.target.to_string_lossy().into_owned(),
            rows,
            size_bytes: self.size_bytes,
            protected_fields: self.protected_fields,
            audit_warning: None,
        })
    }
}

fn formula_prefix(value: &str) -> bool {
    value.starts_with(['\t', '\r', '\n'])
        || value
            .trim_start_matches(|character: char| {
                character.is_whitespace() || character == '\u{feff}'
            })
            .starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
}

fn valid_text(value: &[u8], format: ExportFormat) -> Result<&str> {
    std::str::from_utf8(value).map_err(|_| {
        format!(
            "UTF-8이 아닌 SQLite 텍스트가 있어 {}에 저장할 수 없습니다.",
            format.label()
        )
    })
}
