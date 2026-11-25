use crate::{
    local_file::{valid_filename, write_new_file},
    text_draft::{encode_text, UTF8_BOM},
    Result, TextLineEnding,
};
use encoding_rs::{EncoderResult, Encoding, EUC_KR, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, fs::File, io::Read, path::Path};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const TOO_LARGE: &str = "편집기에서 열거나 저장하는 SQL 파일은 1 MiB 이하여야 합니다.";
pub(crate) const DEFINITION_TOO_LARGE: &str =
    "1 MiB를 초과하는 정의 SQL은 표시하거나 저장할 수 없습니다.";
const UTF16_LE_BOM: &[u8] = b"\xff\xfe";
const UTF16_BE_BOM: &[u8] = b"\xfe\xff";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub enum SqlFileEncoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "euc-kr")]
    EucKr,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

impl SqlFileEncoding {
    fn codec(self) -> &'static Encoding {
        match self {
            Self::Utf8 => UTF_8,
            Self::Utf16Le => UTF_16LE,
            Self::Utf16Be => UTF_16BE,
            Self::EucKr => EUC_KR,
            Self::Windows1252 => WINDOWS_1252,
        }
    }

    fn bom(self) -> Option<&'static [u8]> {
        match self {
            Self::Utf8 => Some(UTF8_BOM),
            Self::Utf16Le => Some(UTF16_LE_BOM),
            Self::Utf16Be => Some(UTF16_BE_BOM),
            Self::EucKr | Self::Windows1252 => None,
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct SqlDocument {
    pub text: String,
    pub line_ending: TextLineEnding,
    pub bom: bool,
    #[serde(default)]
    pub encoding: SqlFileEncoding,
}

pub fn open_sql_file(source: &str) -> Result<SqlDocument> {
    open_sql_file_with_encoding(source, None)
}

pub fn open_sql_file_with_encoding(
    source: &str,
    choice: Option<SqlFileEncoding>,
) -> Result<SqlDocument> {
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
    if bytes.starts_with(b"\xff\xfe\0\0") || bytes.starts_with(b"\0\0\xfe\xff") {
        return Err("UTF-32 SQL 파일을 열려면 UTF-8 또는 UTF-16으로 변환하세요.".into());
    }
    let signature = Encoding::for_bom(&bytes);
    let encoding = choice
        .or_else(|| {
            signature.map(|(codec, _)| {
                if codec == UTF_16LE {
                    SqlFileEncoding::Utf16Le
                } else if codec == UTF_16BE {
                    SqlFileEncoding::Utf16Be
                } else {
                    SqlFileEncoding::Utf8
                }
            })
        })
        .unwrap_or_default();
    let codec = encoding.codec();
    let offset = if let Some((detected, offset)) = signature {
        if detected != codec {
            return Err(format!(
                "파일 BOM은 {}입니다. 파일 인코딩을 확인하세요.",
                detected.name()
            ));
        }
        offset
    } else {
        0
    };
    let source = codec
        .decode_without_bom_handling_and_without_replacement(&bytes[offset..])
        .ok_or_else(|| {
            format!(
                "{} SQL 파일로 읽을 수 없습니다. 파일 인코딩을 확인하세요.",
                codec.name()
            )
        })?;
    let crlf = source.contains("\r\n");
    let text = source.replace("\r\n", "\n");
    if text.contains('\0') {
        return Err("SQL 파일에 NUL 문자가 있습니다. 파일 인코딩과 내용을 확인하세요.".into());
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
        bom: signature.is_some(),
        encoding,
    })
}

pub fn save_sql_file(destination: &str, document: &SqlDocument) -> Result<usize> {
    if document.text.contains(['\0', '\r']) {
        return Err("SQL 편집기에서 사용할 수 없는 제어 문자가 있습니다.".into());
    }
    let bytes = if document.encoding == SqlFileEncoding::Utf8 {
        encode_text(
            &document.text,
            document.line_ending,
            document.bom,
            MAX_BYTES,
        )
        .ok_or(TOO_LARGE)?
    } else {
        encode_non_utf8(document)?
    };
    write_new_file(destination, Some("sql"), ".stackport-sql-", &bytes)
}

fn encode_non_utf8(document: &SqlDocument) -> Result<Vec<u8>> {
    if document.text.encode_utf16().take(MAX_BYTES + 1).count() > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    let text = match document.line_ending {
        TextLineEnding::Lf => Cow::Borrowed(document.text.as_str()),
        TextLineEnding::Crlf => Cow::Owned(document.text.replace('\n', "\r\n")),
    };
    let encoding = document.encoding;
    let prefix = if document.bom {
        encoding
            .bom()
            .ok_or("선택한 파일 인코딩에서는 BOM을 사용할 수 없습니다.")?
    } else {
        &[]
    };
    match encoding {
        SqlFileEncoding::Utf16Le | SqlFileEncoding::Utf16Be => {
            let size = prefix.len() + text.encode_utf16().count() * 2;
            if size > MAX_BYTES {
                return Err(TOO_LARGE.into());
            }
            let to_bytes: fn(u16) -> [u8; 2] = if encoding == SqlFileEncoding::Utf16Le {
                u16::to_le_bytes
            } else {
                u16::to_be_bytes
            };
            let mut bytes = Vec::with_capacity(size);
            bytes.extend_from_slice(prefix);
            bytes.extend(text.encode_utf16().flat_map(to_bytes));
            Ok(bytes)
        }
        _ => {
            let codec = encoding.codec();
            let mut encoder = codec.new_encoder();
            let capacity = encoder
                .max_buffer_length_from_utf8_without_replacement(text.len())
                .ok_or(TOO_LARGE)?;
            let mut bytes = Vec::with_capacity(capacity);
            let (result, _) =
                encoder.encode_from_utf8_to_vec_without_replacement(&text, &mut bytes, true);
            match result {
                EncoderResult::InputEmpty if bytes.len() <= MAX_BYTES => Ok(bytes),
                EncoderResult::Unmappable(_) => Err(format!(
                    "{}로 표현할 수 없는 문자가 있습니다. 내용을 보존하려면 UTF-8 또는 UTF-16을 선택하세요.",
                    codec.name()
                )),
                _ => Err(TOO_LARGE.into()),
            }
        }
    }
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
