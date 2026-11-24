use crate::Result;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
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
    extension: Option<&str>,
    prefix: &str,
    bytes: &[u8],
) -> Result<usize> {
    let mut file = NewFile::stage(destination, extension, prefix)?;
    file.file
        .write_all(bytes)
        .map_err(|error| format!("파일을 기록할 수 없습니다: {error}"))?;
    file.publish()?;
    Ok(bytes.len())
}

pub(crate) struct NewFile {
    destination: PathBuf,
    file: tempfile::NamedTempFile,
}

impl NewFile {
    pub(crate) fn stage(destination: &str, extension: Option<&str>, prefix: &str) -> Result<Self> {
        let path = Path::new(destination.trim());
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("저장할 파일 이름을 입력하세요.")?;
        let extension_matches = extension.is_none_or(|extension| {
            path.extension()
                .and_then(|suffix| suffix.to_str())
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(extension))
        });
        if !path.is_absolute() || !valid_filename(name) || !extension_matches {
            return Err(match extension {
                Some(extension) => {
                    format!(".{extension} 확장자를 가진 새 파일의 절대 경로를 입력하세요.")
                }
                None => "새 파일의 절대 경로를 입력하세요.".into(),
            });
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
        let file = tempfile::Builder::new()
            .prefix(prefix)
            .tempfile_in(parent)
            .map_err(|error| format!("임시 파일을 만들 수 없습니다: {error}"))?;
        Ok(Self { destination, file })
    }

    pub(crate) fn writer(&self) -> Result<fs::File> {
        self.file
            .as_file()
            .try_clone()
            .map_err(|error| format!("임시 파일을 열 수 없습니다: {error}"))
    }

    pub(crate) fn publish(self) -> Result<()> {
        self.file
            .as_file()
            .sync_all()
            .map_err(|error| format!("파일을 기록할 수 없습니다: {error}"))?;
        self.file
            .persist_noclobber(self.destination)
            .map_err(|error| {
                if error.error.kind() == io::ErrorKind::AlreadyExists {
                    "같은 이름의 파일이 있습니다. 새 경로를 선택하세요.".into()
                } else {
                    format!("새 파일을 저장할 수 없습니다: {}", error.error)
                }
            })?;
        Ok(())
    }
}
