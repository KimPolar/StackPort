use super::super::{backup::release_series, quoted, require_identifier};
use crate::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{BufRead, BufReader, Write},
    path::Path,
};

const LINE_BYTES: usize = 4096;
const FORMAT: &str = "같은 제품의 단일 DB 네이티브 SQL 백업을 선택하세요. 표준 백업 머리글과 완료 기록이 필요합니다.";

#[derive(Clone, Serialize)]
pub(super) struct FileInfo {
    path: String,
    size_bytes: u64,
    pub(super) sha256: String,
    server_version: String,
}

#[derive(Default)]
pub(super) struct Scope {
    pub(super) database: String,
    pub(super) tables: BTreeSet<String>,
    pub(super) views: BTreeSet<String>,
    pub(super) data: BTreeSet<String>,
    defaults: Option<String>,
    used_database: bool,
    header: bool,
    footer: bool,
    routine_body: bool,
    server_version: String,
}

pub(super) struct Dump {
    pub(super) info: FileInfo,
    pub(super) scope: Scope,
}

impl Scope {
    pub(super) fn database_options(&self, target: &str) -> Result<&str> {
        match self.defaults.as_ref() {
            Some(_) if self.database != target => Err(format!(
                "전체 DB SQL에는 원본 이름 ‘{}’이 들어 있습니다. 다른 서버에서 이 이름을 새 DB로 선택하세요.",
                self.database
            )),
            Some(defaults) => Ok(defaults),
            None => Ok(""),
        }
    }

    pub(super) fn data_only(&self) -> bool {
        !self.data.is_empty()
            && self.tables.is_empty()
            && self.views.is_empty()
            && self.defaults.is_none()
    }

    fn inspect(&mut self, bytes: &[u8], maria: bool) -> Result<()> {
        if self.footer && bytes.iter().any(|byte| !byte.is_ascii_whitespace()) {
            return Err(FORMAT.into());
        }
        let line = match std::str::from_utf8(bytes) {
            Ok(line) => line.trim_end_matches(['\r', '\n']),
            Err(_) => return Ok(()),
        };
        if let Some(delimiter) = line.strip_prefix("DELIMITER ") {
            self.routine_body = delimiter.trim() != ";";
            return Ok(());
        }
        if self.routine_body {
            return Ok(());
        }
        if line.starts_with("-- MySQL dump ") || line.starts_with("-- MariaDB dump ") {
            if self.header || line.starts_with("-- MariaDB dump ") != maria {
                return Err(FORMAT.into());
            }
            self.header = true;
        } else if let Some((_, database)) = line
            .strip_prefix("-- Host: ")
            .and_then(|line| line.rsplit_once("Database: "))
        {
            if !self.header || !self.database.is_empty() {
                return Err(FORMAT.into());
            }
            require_identifier(database)?;
            if database.chars().any(char::is_control) {
                return Err(FORMAT.into());
            }
            self.database = database.to_owned();
        } else if let Some(version) = line.strip_prefix("-- Server version") {
            let version = version.trim();
            if !self.header
                || !self.server_version.is_empty()
                || version.len() > 128
                || !version.is_ascii()
                || release_series(version).is_none()
                || version.to_ascii_lowercase().contains("mariadb") != maria
            {
                return Err(FORMAT.into());
            }
            self.server_version = version.to_owned();
        } else if let Some(ddl) = line.strip_prefix("CREATE DATABASE ") {
            if self.defaults.is_some() || self.used_database || self.database.is_empty() {
                return Err(FORMAT.into());
            }
            self.defaults = Some(database_defaults(ddl, &self.database)?);
        } else if let Some(name) = line.strip_prefix("USE ") {
            if self.defaults.is_none() || name != format!("{};", quoted(&self.database)) {
                return Err(FORMAT.into());
            }
            self.used_database = true;
        } else if let Some(name) = line.strip_prefix("-- Current Database: ") {
            if self.database.is_empty() || name != quoted(&self.database) {
                return Err(FORMAT.into());
            }
        } else if let Some(name) = line.strip_prefix("-- Table structure for table ") {
            self.tables.insert(object_name(name)?);
        } else if let Some(name) = line.strip_prefix("-- Final view structure for view ") {
            self.views.insert(object_name(name)?);
        } else if let Some(name) = line.strip_prefix("-- Dumping data for table ") {
            self.data.insert(object_name(name)?);
        } else if line.starts_with("-- Dump completed on ") {
            self.footer = true;
        }
        Ok(())
    }
}

pub(super) fn append(
    source: &str,
    replay: &mut File,
    maria: bool,
    target_version: &str,
    check: &impl Fn() -> Result<()>,
) -> Result<Dump> {
    let path = Path::new(source.trim());
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
        || !fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
    {
        return Err("로컬 SQL 백업 파일의 절대 경로를 선택하세요.".into());
    }
    let file = File::open(path).map_err(|_| "SQL 백업을 열 수 없습니다.")?;
    let mut input = BufReader::with_capacity(128 * 1024, file);
    let mut hash = Sha256::new();
    let mut size_bytes = 0u64;
    let mut scope = Scope::default();
    let mut line = Vec::with_capacity(LINE_BYTES);
    let mut truncated = false;
    loop {
        check()?;
        let chunk = input
            .fill_buf()
            .map_err(|_| "SQL 백업을 읽을 수 없습니다.")?;
        if chunk.is_empty() {
            break;
        }
        if chunk.contains(&0) {
            return Err(FORMAT.into());
        }
        replay
            .write_all(chunk)
            .map_err(|_| "복원 임시 사본을 기록할 수 없습니다.")?;
        hash.update(chunk);
        size_bytes += chunk.len() as u64;
        let consumed = chunk.len();
        for section in chunk.split_inclusive(|byte| *byte == b'\n') {
            if line.len() + section.len() > LINE_BYTES {
                truncated = true;
            }
            if !truncated {
                line.extend_from_slice(section);
            } else if scope.footer {
                return Err(FORMAT.into());
            }
            if section.ends_with(b"\n") {
                if !truncated {
                    scope.inspect(&line, maria)?;
                }
                line.clear();
                truncated = false;
            }
        }
        input.consume(consumed);
    }
    if !truncated && !line.is_empty() {
        scope.inspect(&line, maria)?;
    }
    if scope.routine_body
        || !scope.header
        || !scope.footer
        || scope.database.is_empty()
        || scope.server_version.is_empty()
        || scope.defaults.is_some() != scope.used_database
        || (scope.defaults.is_none()
            && scope.tables.is_empty()
            && scope.views.is_empty()
            && scope.data.is_empty())
    {
        return Err(FORMAT.into());
    }
    if release_series(&scope.server_version) != release_series(target_version) {
        return Err("SQL 백업과 복원 서버의 주·부 버전이 일치해야 합니다.".into());
    }
    replay
        .write_all(b"\n")
        .map_err(|_| "복원 임시 사본을 기록할 수 없습니다.")?;
    Ok(Dump {
        info: FileInfo {
            path: source.trim().to_owned(),
            size_bytes,
            sha256: format!("{:x}", hash.finalize()),
            server_version: scope.server_version.clone(),
        },
        scope,
    })
}

fn object_name(name: &str) -> Result<String> {
    let name = name
        .trim()
        .strip_prefix('`')
        .and_then(|name| name.strip_suffix('`'))
        .ok_or(FORMAT)?;
    let name = name.replace("``", "`");
    require_identifier(&name)?;
    Ok(name)
}

fn database_defaults(ddl: &str, database: &str) -> Result<String> {
    let ddl = ddl.strip_prefix("/*!32312 IF NOT EXISTS*/ ").unwrap_or(ddl);
    let name = quoted(database);
    let mut rest = ddl
        .strip_prefix(&name)
        .and_then(|ddl| ddl.strip_suffix(';'))
        .ok_or(FORMAT)?
        .trim();
    let mut options = String::new();
    if let Some(charset) = rest.strip_prefix("/*!40100 DEFAULT CHARACTER SET ") {
        let (charset, after) = charset.split_once(" */").ok_or(FORMAT)?;
        match charset
            .split_ascii_whitespace()
            .collect::<Vec<_>>()
            .as_slice()
        {
            [charset] if keyword(charset) => options = format!(" DEFAULT CHARACTER SET {charset}"),
            [charset, "COLLATE", collation] if keyword(charset) && keyword(collation) => {
                options = format!(" DEFAULT CHARACTER SET {charset} COLLATE {collation}");
            }
            _ => return Err(FORMAT.into()),
        }
        rest = after.trim_start();
    }
    match rest {
        "" => {}
        "/*!80016 DEFAULT ENCRYPTION='N' */" | "/*!80016 DEFAULT ENCRYPTION='Y' */" => {
            options.push(' ');
            options.push_str(rest);
        }
        _ => return Err(FORMAT.into()),
    }
    Ok(options)
}

fn keyword(word: &str) -> bool {
    !word.is_empty()
        && word.len() <= 64
        && word
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
