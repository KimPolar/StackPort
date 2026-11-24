//! An explicit, atomic export of a rendered terminal buffer.

use crate::{local_file::write_new_file, Result};
use serde::Deserialize;

const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalOutputFormat {
    Txt,
    Ansi,
}

pub fn save_terminal_output(
    destination: &str,
    format: TerminalOutputFormat,
    text: &str,
) -> Result<usize> {
    let extension = match format {
        TerminalOutputFormat::Txt => "txt",
        TerminalOutputFormat::Ansi => "ansi",
    };
    if text.is_empty() || text.len() > MAX_OUTPUT_BYTES {
        return Err("비어 있지 않은 16 MiB 이하의 터미널 출력만 저장할 수 있습니다.".into());
    }
    write_new_file(
        destination,
        extension,
        ".stackport-terminal-",
        text.as_bytes(),
    )
}
