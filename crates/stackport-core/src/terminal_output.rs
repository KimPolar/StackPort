//! An explicit, atomic export of a rendered terminal buffer.

use crate::Result;
use serde::Deserialize;
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

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
    let path = Path::new(destination.trim());
    let name = path.file_name().ok_or("저장할 파일 이름을 입력하세요.")?;
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|suffix| suffix.to_str())
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(extension))
        || (cfg!(windows) && name.to_string_lossy().contains(':'))
    {
        return Err(format!(
            ".{extension} 확장자를 가진 새 파일의 절대 경로를 입력하세요."
        ));
    }
    let parent = path
        .parent()
        .ok_or("출력을 저장할 폴더를 지정하세요.")?
        .canonicalize()
        .map_err(|_| "출력을 저장할 폴더를 열 수 없습니다.")?;
    if !parent.is_dir() {
        return Err("출력을 저장할 폴더를 선택하세요.".into());
    }
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err("같은 이름의 파일이 있습니다. 새 경로를 선택하세요.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("출력을 저장할 경로에 접근할 수 없습니다.".into()),
    }
    let mut file = tempfile::Builder::new()
        .prefix(".stackport-terminal-")
        .tempfile_in(parent)
        .map_err(|error| format!("출력 임시 파일을 만들 수 없습니다: {error}"))?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| format!("터미널 출력을 기록할 수 없습니다: {error}"))?;
    file.persist_noclobber(destination)
        .map_err(|error| format!("새 출력 파일을 저장할 수 없습니다: {}", error.error))?;
    Ok(text.len())
}
