use crate::{
    local_file::{valid_filename, write_new_file},
    text_draft::{encode_text, UTF8_BOM},
    Result, TextLineEnding,
};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const TOO_LARGE: &str = "편집기에서 열거나 저장하는 SQL 파일은 1 MiB 이하여야 합니다.";
pub(crate) const DEFINITION_TOO_LARGE: &str =
    "1 MiB를 초과하는 정의 SQL은 표시하거나 저장할 수 없습니다.";

#[derive(Deserialize, Serialize)]
pub struct SqlDocument {
    pub text: String,
    pub line_ending: TextLineEnding,
    pub bom: bool,
}

pub fn open_sql_file(source: &str) -> Result<SqlDocument> {
    let path = Path::new(source.trim());
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(valid_filename)
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("sql"))
    {
        return Err(".sql 파일의 절대 경로를 입력하세요.".into());
    }
    if !path.is_file() {
        return Err("SQL 파일을 열 수 없습니다.".into());
    }
    let file = File::open(path).map_err(|_| "SQL 파일을 열 수 없습니다.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "SQL 파일 정보를 읽을 수 없습니다.")?;
    if !metadata.is_file() {
        return Err("일반 SQL 파일을 선택하세요.".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SQL 파일을 읽을 수 없습니다.")?;
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    let bom = bytes.starts_with(UTF8_BOM);
    let source = std::str::from_utf8(bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes))
        .map_err(|_| "UTF-8 SQL 파일만 열 수 있습니다.")?;
    let crlf = source.contains("\r\n");
    let text = source.replace("\r\n", "\n");
    if text.contains('\0') {
        return Err("NUL 문자가 있는 SQL 파일은 열 수 없습니다.".into());
    }
    if text.contains('\r')
        || (crlf
            && source
                .split_inclusive('\n')
                .any(|line| line.ends_with('\n') && !line.ends_with("\r\n")))
    {
        return Err("LF 또는 CRLF 한 종류의 줄바꿈을 사용하는 SQL 파일을 선택하세요.".into());
    }
    let line_ending = if crlf {
        TextLineEnding::Crlf
    } else {
        TextLineEnding::Lf
    };
    Ok(SqlDocument {
        text,
        line_ending,
        bom,
    })
}

pub fn save_sql_file(destination: &str, document: &SqlDocument) -> Result<usize> {
    if document.text.contains(['\0', '\r']) {
        return Err("SQL 편집기에서 사용할 수 없는 제어 문자가 있습니다.".into());
    }
    let bytes = encode_text(
        &document.text,
        document.line_ending,
        document.bom,
        MAX_BYTES,
    )
    .ok_or(TOO_LARGE)?;
    write_new_file(destination, Some("sql"), ".stackport-sql-", &bytes)
}

pub(crate) fn validate_definition(text: &str) -> Result<()> {
    if text.len() > MAX_BYTES {
        return Err(DEFINITION_TOO_LARGE.into());
    }
    if text.trim().is_empty() || text.contains('\0') {
        return Err("유효한 정의 SQL이 없습니다.".into());
    }
    Ok(())
}

pub fn save_sql_definition(destination: &str, text: &str) -> Result<usize> {
    validate_definition(text)?;
    write_new_file(destination, Some("sql"), ".stackport-sql-", text.as_bytes())
}
