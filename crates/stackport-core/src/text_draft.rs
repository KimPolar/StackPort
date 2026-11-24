use crate::{local_file::write_new_file, Result};
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TextLineEnding {
    Lf,
    Crlf,
}

pub fn save_text_draft(
    destination: &str,
    text: &str,
    line_ending: TextLineEnding,
    bom: bool,
) -> Result<usize> {
    let bytes = encode_text(text, line_ending, bom, MAX_BYTES)
        .ok_or("로컬 초안은 16 MiB 이하여야 합니다.")?;
    write_new_file(destination, Some("txt"), ".stackport-draft-", &bytes)
}

pub(crate) fn encode_text(
    text: &str,
    line_ending: TextLineEnding,
    bom: bool,
    limit: usize,
) -> Option<Vec<u8>> {
    if text.len() > limit {
        return None;
    }
    let extra = match line_ending {
        TextLineEnding::Lf => 0,
        TextLineEnding::Crlf => text.bytes().filter(|byte| *byte == b'\n').count(),
    };
    let size = text.len() + extra + if bom { UTF8_BOM.len() } else { 0 };
    if size > limit {
        return None;
    }
    let mut bytes = Vec::with_capacity(size);
    if bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    match line_ending {
        TextLineEnding::Lf => bytes.extend_from_slice(text.as_bytes()),
        TextLineEnding::Crlf => {
            for (index, line) in text.split('\n').enumerate() {
                if index != 0 {
                    bytes.extend_from_slice(b"\r\n");
                }
                bytes.extend_from_slice(line.as_bytes());
            }
        }
    }
    Some(bytes)
}
