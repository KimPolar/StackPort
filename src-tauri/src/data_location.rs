use serde::Serialize;
use std::{env, io, path::PathBuf};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataMode {
    Standard,
    Custom,
    Portable,
}

pub struct DataLocation {
    pub mode: DataMode,
    pub directory: PathBuf,
}

#[derive(Serialize)]
pub struct RuntimeInfo {
    pub version: &'static str,
    pub data_mode: DataMode,
    pub data_directory: String,
}

impl DataLocation {
    pub fn resolve(standard: impl FnOnce() -> io::Result<PathBuf>) -> io::Result<Self> {
        let portable = env::args_os().skip(1).any(|arg| arg == "--portable");
        if let Some(directory) = env::var_os("STACKPORT_DATA_DIR") {
            if portable {
                return Err(io::Error::other(
                    "--portable과 STACKPORT_DATA_DIR 중 하나만 지정하세요.",
                ));
            }
            if directory.is_empty() {
                return Err(io::Error::other(
                    "STACKPORT_DATA_DIR에 데이터 폴더를 지정하세요.",
                ));
            }
            let path = PathBuf::from(directory);
            return Ok(Self {
                mode: DataMode::Custom,
                directory: if path.is_absolute() {
                    path
                } else {
                    env::current_dir()?.join(path)
                },
            });
        }
        let program = env::current_exe()?;
        let folder = program
            .parent()
            .ok_or_else(|| io::Error::other("실행 파일의 폴더를 찾을 수 없습니다."))?;
        if portable || folder.join("StackPort.portable").is_file() {
            Ok(Self {
                mode: DataMode::Portable,
                directory: folder.join("StackPort-data"),
            })
        } else {
            Ok(Self {
                mode: DataMode::Standard,
                directory: standard()?,
            })
        }
    }

    pub fn info(&self) -> RuntimeInfo {
        RuntimeInfo {
            version: env!("CARGO_PKG_VERSION"),
            data_mode: self.mode,
            data_directory: self.directory.to_string_lossy().into_owned(),
        }
    }
}
