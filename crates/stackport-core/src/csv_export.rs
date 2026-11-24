//! A streaming CSV writer that only publishes completed files.

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
pub enum CsvQuery {
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
pub struct CsvReport {
    pub path: String,
    pub rows: u64,
    pub size_bytes: u64,
    pub protected_fields: u64,
    pub audit_warning: Option<String>,
}

pub(crate) struct CsvFile {
    target: PathBuf,
    file: BufWriter<NamedTempFile>,
    spreadsheet_safe: bool,
    protected_fields: u64,
}

impl CsvFile {
    pub(crate) fn create(options: &CsvOptions) -> Result<Self> {
        let target = Path::new(options.destination.trim());
        let name = target.file_name().ok_or("CSV 파일 이름을 입력하세요.")?;
        if !target.is_absolute()
            || !target
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
            || (cfg!(windows) && name.to_string_lossy().contains(':'))
        {
            return Err("새 CSV 파일의 절대 경로를 입력하세요.".into());
        }
        let folder = target
            .parent()
            .ok_or("CSV 파일을 저장할 폴더를 지정하세요.")?
            .canonicalize()
            .map_err(|_| "CSV 파일을 저장할 폴더를 열 수 없습니다.")?;
        if !folder.is_dir() {
            return Err("CSV 파일을 저장할 폴더를 지정하세요.".into());
        }
        let target = folder.join(name);
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                return Err("같은 이름의 파일이 이미 있습니다. 새 CSV 경로를 선택하세요.".into())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("CSV 파일을 저장할 경로에 접근할 수 없습니다.".into()),
        }
        let file = tempfile::Builder::new()
            .prefix(".stackport-csv-")
            .tempfile_in(folder)
            .map_err(|error| format!("CSV 임시 파일을 만들 수 없습니다: {error}"))?;
        Ok(Self {
            target,
            file: BufWriter::with_capacity(64 * 1024, file),
            spreadsheet_safe: options.spreadsheet_safe,
            protected_fields: 0,
        })
    }

    pub(crate) fn write_header(&mut self, columns: &[String]) -> Result<()> {
        for (index, name) in columns.iter().enumerate() {
            self.delimiter(index).map_err(csv_io)?;
            self.write_text(name).map_err(csv_io)?;
        }
        self.file.write_all(b"\r\n").map_err(csv_io)
    }

    pub(crate) fn write_row(&mut self, row: &Row<'_>) -> Result<()> {
        for index in 0..row.as_ref().column_count() {
            self.delimiter(index).map_err(csv_io)?;
            let value = row.get_ref(index).map_err(super::db_error)?;
            match value {
                ValueRef::Null => self.file.write_all(b"\\N").map_err(csv_io)?,
                ValueRef::Integer(value) => write!(self.file, "{value}").map_err(csv_io)?,
                ValueRef::Real(value) => write!(self.file, "{value}").map_err(csv_io)?,
                ValueRef::Text(value) => {
                    let text = std::str::from_utf8(value).map_err(|_| {
                        "UTF-8이 아닌 SQLite 텍스트가 있어 CSV에 저장할 수 없습니다."
                    })?;
                    self.write_text(text).map_err(csv_io)?;
                }
                ValueRef::Blob(value) => self.write_blob(value).map_err(csv_io)?,
            }
        }
        self.file.write_all(b"\r\n").map_err(csv_io)
    }

    fn delimiter(&mut self, index: usize) -> io::Result<()> {
        if index > 0 {
            self.file.write_all(b",")?;
        }
        Ok(())
    }

    fn write_text(&mut self, value: &str) -> io::Result<()> {
        self.file.write_all(b"\"")?;
        if self.spreadsheet_safe && formula_prefix(value) {
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

    fn write_blob(&mut self, value: &[u8]) -> io::Result<()> {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        self.file.write_all(b"\"X'")?;
        let mut output = [0; 2048];
        for block in value.chunks(output.len() / 2) {
            for (index, byte) in block.iter().enumerate() {
                output[index * 2] = HEX[(byte >> 4) as usize];
                output[index * 2 + 1] = HEX[(byte & 15) as usize];
            }
            self.file.write_all(&output[..block.len() * 2])?;
        }
        self.file.write_all(b"'\"")
    }

    /// Flush both output buffers before the caller accepts the final publish.
    pub(crate) fn finish(self) -> Result<ReadyCsv> {
        let file = self
            .file
            .into_inner()
            .map_err(|error| csv_io(error.into_error()))?;
        let handle: &File = file.as_file();
        handle.sync_all().map_err(csv_io)?;
        let size_bytes = handle.metadata().map_err(csv_io)?.len();
        Ok(ReadyCsv {
            target: self.target,
            file,
            size_bytes,
            protected_fields: self.protected_fields,
        })
    }
}

pub(crate) struct ReadyCsv {
    target: PathBuf,
    file: NamedTempFile,
    size_bytes: u64,
    protected_fields: u64,
}

impl ReadyCsv {
    pub(crate) fn publish(self, rows: u64) -> Result<CsvReport> {
        self.file.persist_noclobber(&self.target).map_err(|error| {
            format!(
                "CSV 파일을 저장할 수 없습니다. 기존 파일은 덮어쓰지 않습니다: {}",
                error.error
            )
        })?;
        Ok(CsvReport {
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

fn csv_io(error: io::Error) -> String {
    format!("CSV를 디스크에 기록할 수 없습니다: {error}")
}
