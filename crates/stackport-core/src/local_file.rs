use crate::Result;
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

pub(crate) fn valid_filename(name: &str) -> bool {
    if !cfg!(windows) {
        return !name.contains('\0');
    }
    if name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let number_device = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|value| {
            matches!(
                value,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    !number_device
        && !matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
}

pub(crate) fn write_new_file(
    destination: &str,
    extension: &str,
    prefix: &str,
    bytes: &[u8],
) -> Result<usize> {
    let path = Path::new(destination.trim());
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("저장할 파일 이름을 입력하세요.")?;
    if !path.is_absolute()
        || !valid_filename(name)
        || !path
            .extension()
            .and_then(|suffix| suffix.to_str())
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(extension))
    {
        return Err(format!(
            ".{extension} 확장자를 가진 새 파일의 절대 경로를 입력하세요."
        ));
    }
    let parent = path
        .parent()
        .ok_or("저장할 폴더를 지정하세요.")?
        .canonicalize()
        .map_err(|_| "저장할 폴더를 열 수 없습니다.")?;
    if !parent.is_dir() {
        return Err("파일을 저장할 폴더를 선택하세요.".into());
    }
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err("같은 이름의 파일이 있습니다. 새 경로를 선택하세요.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("저장할 경로에 접근할 수 없습니다.".into()),
    }
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .tempfile_in(parent)
        .map_err(|error| format!("임시 파일을 만들 수 없습니다: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| format!("파일을 기록할 수 없습니다: {error}"))?;
    file.persist_noclobber(destination).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            "같은 이름의 파일이 있습니다. 새 경로를 선택하세요.".into()
        } else {
            format!("새 파일을 저장할 수 없습니다: {}", error.error)
        }
    })?;
    Ok(bytes.len())
}
