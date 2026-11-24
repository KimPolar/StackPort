//! Explicit SSH host-key verification before invoking the system OpenSSH client.

use crate::{db_error, Result, TerminalInfo, TerminalManager};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use portable_pty::CommandBuilder;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const TRUST_VERSION: i64 = 1;
const TRUST_APPLICATION_ID: i64 = 0x5350484b; // "SPHK"
const PROBE_LIFETIME: Duration = Duration::from_secs(300);
const SCAN_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SCAN_BYTES: u64 = 65536;
const MAX_IDENTITIES: usize = 8;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuthentication {
    Automatic,
    KeyFile { path: String },
    KeyFiles { paths: Vec<String> },
    Password,
    KeyboardInteractive,
}

enum OpenSshAuthentication<'a> {
    Automatic,
    KeyFiles(&'a [String]),
    Password,
    KeyboardInteractive,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshKeyInfo {
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct SshHostInfo {
    pub status: &'static str,
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub keys: Vec<SshKeyInfo>,
    pub previous: Option<SshKeyInfo>,
}

#[derive(Debug, Serialize)]
pub struct SshTrustEvent {
    pub sequence: i64,
    pub id: String,
    pub host: String,
    pub port: u16,
    pub action: String,
    pub previous_fingerprint: Option<String>,
    pub fingerprint: String,
    pub occurred_at: String,
}

#[derive(Debug, Serialize)]
pub struct SshTrustPage {
    pub events: Vec<SshTrustEvent>,
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostKey {
    algorithm: String,
    public_key: String,
    fingerprint: String,
}

impl HostKey {
    fn info(&self) -> SshKeyInfo {
        SshKeyInfo {
            algorithm: self.algorithm.clone(),
            fingerprint: self.fingerprint.clone(),
        }
    }
}

struct PendingProbe {
    host: String,
    port: u16,
    keys: Vec<HostKey>,
    previous: Option<HostKey>,
    created: Instant,
}

pub struct SshManager {
    directory: PathBuf,
    pending: Mutex<HashMap<String, PendingProbe>>,
}

impl SshManager {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        Self {
            directory: directory.as_ref().to_owned(),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Existing pins are returned without network access. An unknown host is
    /// scanned but cannot be used until a user accepts one specific fingerprint.
    pub fn inspect(&self, host: &str, port: u16) -> Result<SshHostInfo> {
        let host = normalize_host(host)?;
        validate_port(port)?;
        if let Some(key) = self.lookup(&host, port)? {
            return Ok(SshHostInfo {
                status: "trusted",
                host,
                port,
                token: None,
                keys: vec![key.info()],
                previous: None,
            });
        }
        self.probe(host, port, None)
    }

    /// Re-scan only on request. Replacing a pin later requires that this exact
    /// previously trusted key still be present in the database.
    pub fn reinspect(&self, host: &str, port: u16) -> Result<SshHostInfo> {
        let host = normalize_host(host)?;
        validate_port(port)?;
        let previous = self
            .lookup(&host, port)?
            .ok_or("저장된 호스트 키가 없습니다. 먼저 지문을 확인하세요.")?;
        self.probe(host, port, Some(previous))
    }

    fn probe(&self, host: String, port: u16, previous: Option<HostKey>) -> Result<SshHostInfo> {
        let keys = scan_host(&host, port)?;
        let token = Uuid::new_v4().to_string();
        let result = SshHostInfo {
            status: if previous.is_some() {
                "replacement"
            } else {
                "unknown"
            },
            host: host.clone(),
            port,
            token: Some(token.clone()),
            keys: keys.iter().map(HostKey::info).collect(),
            previous: previous.as_ref().map(HostKey::info),
        };
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "호스트 키 확인 상태를 사용할 수 없습니다.")?;
        pending.retain(|_, item| item.created.elapsed() < PROBE_LIFETIME);
        pending.insert(
            token,
            PendingProbe {
                host,
                port,
                keys,
                previous,
                created: Instant::now(),
            },
        );
        Ok(result)
    }

    /// A probe is single use. Replacement requires a separate confirmation and
    /// an atomic comparison against the key shown before the new scan.
    pub fn trust(&self, token: &str, fingerprint: &str, confirmation: &str) -> Result<SshHostInfo> {
        let probe = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "호스트 키 확인 상태를 사용할 수 없습니다.")?;
            let item = pending
                .get(token)
                .ok_or("호스트 키 확인이 없거나 만료되었습니다. 다시 확인하세요.")?;
            if item.created.elapsed() >= PROBE_LIFETIME {
                pending.remove(token);
                return Err("호스트 키 확인이 만료되었습니다. 다시 확인하세요.".into());
            }
            if item.previous.is_some() && confirmation != "교체" {
                return Err("기존 호스트 키를 바꾸려면 교체를 입력하세요.".into());
            }
            if !item.keys.iter().any(|key| key.fingerprint == fingerprint) {
                return Err("확인한 지문과 선택한 지문이 일치하지 않습니다.".into());
            }
            pending.remove(token).expect("checked pending probe")
        };
        let key = probe
            .keys
            .into_iter()
            .find(|item| item.fingerprint == fingerprint)
            .ok_or("확인한 지문과 선택한 지문이 일치하지 않습니다.")?;
        self.save(&probe.host, probe.port, &key, probe.previous.as_ref())?;
        Ok(SshHostInfo {
            status: "trusted",
            host: probe.host,
            port: probe.port,
            token: None,
            keys: vec![key.info()],
            previous: None,
        })
    }

    pub fn open(
        &self,
        terminals: &TerminalManager,
        host: &str,
        port: u16,
        username: &str,
        rows: u16,
        cols: u16,
    ) -> Result<TerminalInfo> {
        self.open_internal(
            terminals,
            host,
            port,
            username,
            rows,
            cols,
            OpenSshAuthentication::Automatic,
        )
    }

    /// Select one identity for this session without storing its path or passphrase.
    pub fn open_with_identity(
        &self,
        terminals: &TerminalManager,
        host: &str,
        port: u16,
        username: &str,
        rows: u16,
        cols: u16,
        identity_path: &str,
    ) -> Result<TerminalInfo> {
        let identity = identity_file(identity_path)?;
        self.open_internal(
            terminals,
            host,
            port,
            username,
            rows,
            cols,
            OpenSshAuthentication::KeyFiles(std::slice::from_ref(&identity)),
        )
    }

    pub fn open_with_authentication(
        &self,
        terminals: &TerminalManager,
        host: &str,
        port: u16,
        username: &str,
        rows: u16,
        cols: u16,
        authentication: SshAuthentication,
    ) -> Result<TerminalInfo> {
        let method = match authentication {
            SshAuthentication::Automatic => OpenSshAuthentication::Automatic,
            SshAuthentication::Password => OpenSshAuthentication::Password,
            SshAuthentication::KeyboardInteractive => OpenSshAuthentication::KeyboardInteractive,
            SshAuthentication::KeyFile { path } => {
                return self.open_with_identity(terminals, host, port, username, rows, cols, &path);
            }
            SshAuthentication::KeyFiles { paths } => {
                if paths.is_empty() || paths.len() > MAX_IDENTITIES {
                    return Err("SSH 키 파일을 1개에서 8개까지 지정할 수 있습니다.".into());
                }
                let mut identities = Vec::with_capacity(paths.len());
                for path in paths {
                    let identity = identity_file(&path)?;
                    if identities.contains(&identity) {
                        return Err("같은 SSH 키 파일을 두 번 지정할 수 없습니다.".into());
                    }
                    identities.push(identity);
                }
                return self.open_internal(
                    terminals,
                    host,
                    port,
                    username,
                    rows,
                    cols,
                    OpenSshAuthentication::KeyFiles(&identities),
                );
            }
        };
        self.open_internal(terminals, host, port, username, rows, cols, method)
    }

    fn open_internal(
        &self,
        terminals: &TerminalManager,
        host: &str,
        port: u16,
        username: &str,
        rows: u16,
        cols: u16,
        authentication: OpenSshAuthentication<'_>,
    ) -> Result<TerminalInfo> {
        let host = normalize_host(host)?;
        validate_port(port)?;
        let username = normalize_username(username)?;
        let key = self
            .lookup(&host, port)?
            .ok_or("먼저 서버의 호스트 키 지문을 확인하고 신뢰해야 합니다.")?;
        let known_hosts = self.pin_file(&host, port, &key)?;
        let command = ssh_command(
            &host,
            port,
            &username,
            &key.algorithm,
            known_hosts.as_ref(),
            authentication,
        )?;
        let address = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        terminals.open_command(
            "ssh",
            Some(format!("{username}@{address}:{port}")),
            command,
            rows,
            cols,
            Some(known_hosts),
        )
    }

    pub fn history(&self, before: Option<i64>) -> Result<SshTrustPage> {
        if before.is_some_and(|cursor| cursor <= 0) {
            return Err("유효하지 않은 기록 위치입니다.".into());
        }
        let Some(db) = self.database(false)? else {
            return Ok(SshTrustPage {
                events: Vec::new(),
                next_cursor: None,
            });
        };
        let mut statement = db.prepare("SELECT rowid, id, host, port, action, previous_fingerprint, fingerprint, occurred_at FROM trust_events WHERE (?1 IS NULL OR rowid < ?1) ORDER BY rowid DESC LIMIT ?2").map_err(db_error)?;
        let mut events = statement
            .query_map(params![before, (crate::PAGE_SIZE + 1) as i64], |row| {
                Ok(SshTrustEvent {
                    sequence: row.get(0)?,
                    id: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    action: row.get(4)?,
                    previous_fingerprint: row.get(5)?,
                    fingerprint: row.get(6)?,
                    occurred_at: row.get(7)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        let next_cursor = if events.len() > crate::PAGE_SIZE {
            events.pop();
            events.last().map(|event| event.sequence)
        } else {
            None
        };
        Ok(SshTrustPage {
            events,
            next_cursor,
        })
    }

    fn lookup(&self, host: &str, port: u16) -> Result<Option<HostKey>> {
        let Some(db) = self.database(false)? else {
            return Ok(None);
        };
        let stored: Option<(String, String, String)> = db.query_row(
            "SELECT algorithm, public_key, fingerprint FROM host_keys WHERE host=?1 AND port=?2",
            params![host, port], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?;
        stored
            .map(|(algorithm, public_key, fingerprint)| {
                let key = parse_key(&algorithm, &public_key)?;
                if key.fingerprint != fingerprint {
                    return Err("저장된 호스트 키가 손상되었습니다. 연결하지 않았습니다.".into());
                }
                Ok(key)
            })
            .transpose()
    }

    fn save(&self, host: &str, port: u16, key: &HostKey, expected: Option<&HostKey>) -> Result<()> {
        let mut db = self
            .database(true)?
            .ok_or("호스트 키 저장소를 열 수 없습니다.")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current: Option<(String, String, String)> = tx.query_row(
            "SELECT algorithm, public_key, fingerprint FROM host_keys WHERE host=?1 AND port=?2",
            params![host, port], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?;
        let key_values = |item: &HostKey| {
            (
                item.algorithm.clone(),
                item.public_key.clone(),
                item.fingerprint.clone(),
            )
        };
        let action = match (current, expected) {
            (None, None) => {
                tx.execute("INSERT INTO host_keys(host, port, algorithm, public_key, fingerprint) VALUES (?1, ?2, ?3, ?4, ?5)", params![host, port, key.algorithm, key.public_key, key.fingerprint]).map_err(db_error)?;
                Some("accepted")
            }
            (Some(current), None) if current == key_values(key) => None,
            (Some(current), Some(previous)) if current == key_values(previous) && key != previous => {
                tx.execute("UPDATE host_keys SET algorithm=?3, public_key=?4, fingerprint=?5, trusted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE host=?1 AND port=?2", params![host, port, key.algorithm, key.public_key, key.fingerprint]).map_err(db_error)?;
                Some("replaced")
            }
            _ => return Err("저장된 호스트 키가 변경되었거나 선택한 키가 같아 적용하지 않았습니다. 다시 확인하세요.".into()),
        };
        let stored: (String, String, String) = tx.query_row(
            "SELECT algorithm, public_key, fingerprint FROM host_keys WHERE host=?1 AND port=?2",
            params![host, port], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(db_error)?;
        if stored != key_values(key) {
            return Err("호스트 키 저장 결과가 달라 변경을 취소했습니다.".into());
        }
        if let Some(action) = action {
            tx.execute("INSERT INTO trust_events(id, host, port, action, previous_fingerprint, fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![Uuid::new_v4().to_string(), host, port, action, expected.map(|item| item.fingerprint.as_str()), key.fingerprint]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }

    fn database(&self, create: bool) -> Result<Option<Connection>> {
        let path = self.directory.join("ssh-trust.sqlite");
        let mut created = false;
        if !path.exists() {
            if !create {
                return Ok(None);
            }
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => created = true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("호스트 키 저장소를 만들 수 없습니다: {error}")),
            }
        }
        let mut db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(db_error)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
        db.pragma_update(None, "trusted_schema", false)
            .map_err(db_error)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if version == 0 && created {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let objects: i64 = tx
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if objects != 0 {
                return Err("초기화되지 않은 호스트 키 저장소를 보존했습니다.".into());
            }
            tx.execute_batch("CREATE TABLE host_keys (host TEXT NOT NULL, port INTEGER NOT NULL, algorithm TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, trusted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY(host, port)); CREATE TABLE trust_events (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('accepted', 'replaced')), previous_fingerprint TEXT, fingerprint TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));").map_err(db_error)?;
            tx.pragma_update(None, "application_id", TRUST_APPLICATION_ID)
                .map_err(db_error)?;
            tx.pragma_update(None, "user_version", TRUST_VERSION)
                .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        } else if version != TRUST_VERSION {
            return Err(format!("지원하지 않거나 초기화되지 않은 호스트 키 저장소입니다 (버전 {version}). 원본을 보존했습니다."));
        }
        let application_id: i64 = db
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(db_error)?;
        if application_id != TRUST_APPLICATION_ID {
            return Err("StackPort 호스트 키 저장소가 아니어서 연결하지 않았습니다. 원본 파일을 보존했습니다.".into());
        }
        for query in [
            "SELECT host, port, algorithm, public_key, fingerprint, trusted_at FROM host_keys LIMIT 0",
            "SELECT id, host, port, action, previous_fingerprint, fingerprint, occurred_at FROM trust_events LIMIT 0",
        ] {
            db.prepare(query).map_err(|_| "호스트 키 저장소 구조가 손상되어 연결하지 않았습니다. 원본 파일을 보존했습니다.")?;
        }
        Ok(Some(db))
    }

    fn pin_file(&self, host: &str, port: u16, key: &HostKey) -> Result<tempfile::TempPath> {
        let mut temporary = tempfile::Builder::new()
            .prefix(".stackport-known-hosts-")
            .tempfile_in(&self.directory)
            .map_err(|error| format!("호스트 키 확인 파일을 만들 수 없습니다: {error}"))?;
        writeln!(
            temporary,
            "{} {} {}",
            host_pattern(host, port),
            key.algorithm,
            key.public_key
        )
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("호스트 키 확인 파일을 저장할 수 없습니다: {error}"))?;
        Ok(temporary.into_temp_path())
    }
}

pub(crate) fn normalize_host(value: &str) -> Result<String> {
    let host = value.trim();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    if host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return Err("호스트 이름 또는 IP 주소를 확인하세요.".into());
    }
    let hostname = host.strip_suffix('.').unwrap_or(host);
    if hostname.split('.').any(|part| {
        part.is_empty()
            || part.len() > 63
            || !part.as_bytes()[0].is_ascii_alphanumeric()
            || !part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
            || !part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) {
        return Err("호스트 이름 또는 IP 주소를 확인하세요.".into());
    }
    Ok(host.to_ascii_lowercase())
}

pub(crate) fn normalize_username(value: &str) -> Result<String> {
    let username = value.trim();
    if username.is_empty()
        || username.len() > 128
        || !username.is_ascii()
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        || username.starts_with('-')
    {
        return Err(
            "SSH 사용자 이름을 확인하세요. 영문, 숫자, '.', '_'와 '-'를 사용할 수 있습니다.".into(),
        );
    }
    Ok(username.into())
}

pub(crate) fn validate_port(port: u16) -> Result<()> {
    if port == 0 {
        Err("SSH 포트는 1부터 65535까지 지정하세요.".into())
    } else {
        Ok(())
    }
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.into()
    } else {
        format!("[{host}]:{port}")
    }
}

fn parse_key(algorithm: &str, public_key: &str) -> Result<HostKey> {
    if !matches!(
        algorithm,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    ) {
        return Err("지원하지 않는 호스트 키 형식입니다.".into());
    }
    let bytes = STANDARD
        .decode(public_key)
        .map_err(|_| "유효하지 않은 호스트 키입니다.")?;
    if bytes.len() < 8 || bytes.len() > 16384 {
        return Err("유효하지 않은 호스트 키 길이입니다.".into());
    }
    let length = u32::from_be_bytes(bytes[..4].try_into().expect("four bytes")) as usize;
    if length > bytes.len() - 4 || &bytes[4..4 + length] != algorithm.as_bytes() {
        return Err("호스트 키 형식이 일치하지 않습니다.".into());
    }
    Ok(HostKey {
        algorithm: algorithm.into(),
        public_key: public_key.into(),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&bytes))),
    })
}

#[cfg(windows)]
fn system_ssh_program(name: &str) -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot").ok_or("Windows 시스템 경로를 찾을 수 없습니다.")?;
    let path = PathBuf::from(root)
        .join("System32")
        .join("OpenSSH")
        .join(name);
    if !path.is_file() {
        return Err(format!("Windows OpenSSH의 {name}을 찾을 수 없습니다."));
    }
    Ok(path)
}

#[cfg(not(windows))]
fn system_ssh_program(_name: &str) -> Result<PathBuf> {
    Err("SSH 연결은 현재 Windows에서만 지원합니다.".into())
}

fn scan_host(host: &str, port: u16) -> Result<Vec<HostKey>> {
    let program = system_ssh_program("ssh-keyscan.exe")?;
    let mut command = Command::new(program);
    command
        .args([
            "-T",
            "5",
            "-p",
            &port.to_string(),
            "-t",
            "ed25519,ecdsa,rsa",
            host,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("호스트 키 조회를 시작할 수 없습니다: {error}"))?;
    let output = child
        .stdout
        .take()
        .ok_or("호스트 키 조회 출력을 열 수 없습니다.")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output
            .take(MAX_SCAN_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SCAN_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("호스트 키 조회 시간이 초과되었습니다.".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("호스트 키 조회를 완료할 수 없습니다: {error}"));
            }
        }
    }
    let bytes = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "호스트 키 조회 출력을 읽을 수 없습니다.")?
        .map_err(|error| format!("호스트 키 조회 출력을 읽을 수 없습니다: {error}"))?;
    if bytes.len() as u64 > MAX_SCAN_BYTES {
        return Err("호스트 키 조회 결과가 너무 큽니다.".into());
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "호스트 키 조회 결과의 형식이 잘못되었습니다.")?;
    parse_scan(host, port, text)
}

fn parse_scan(host: &str, port: u16, text: &str) -> Result<Vec<HostKey>> {
    let expected = host_pattern(host, port);
    let mut keys: Vec<HostKey> = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() != 3 || fields[0] != expected {
            continue;
        }
        if let Ok(key) = parse_key(fields[1], fields[2]) {
            if !keys.iter().any(|item| item.fingerprint == key.fingerprint) {
                keys.push(key);
            }
        }
    }
    if keys.is_empty() {
        return Err(
            "서버에서 지원되는 호스트 키를 받지 못했습니다. 주소·포트와 네트워크를 확인하세요."
                .into(),
        );
    }
    Ok(keys)
}

fn ssh_command(
    host: &str,
    port: u16,
    username: &str,
    algorithm: &str,
    known_hosts: &Path,
    authentication: OpenSshAuthentication<'_>,
) -> Result<CommandBuilder> {
    let program = system_ssh_program("ssh.exe")?;
    let path = known_hosts
        .to_str()
        .ok_or("호스트 키 확인 경로를 읽을 수 없습니다.")?
        .replace('\\', "/");
    if path.contains("${") || path.contains(['"', '\r', '\n']) {
        return Err("호스트 키 확인 경로에 지원하지 않는 문자가 있습니다.".into());
    }
    let path = path.replace('%', "%%");
    let algorithms = match algorithm {
        "ssh-rsa" => "rsa-sha2-512,rsa-sha2-256",
        "ssh-ed25519" => "ssh-ed25519",
        "ecdsa-sha2-nistp256" => "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384" => "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521" => "ecdsa-sha2-nistp521",
        _ => return Err("지원하지 않는 호스트 키 형식입니다.".into()),
    };
    let mut command = CommandBuilder::new(program);
    command.args(["-F", "none", "-tt"]);
    let preferred = match authentication {
        OpenSshAuthentication::Automatic => "publickey,keyboard-interactive,password",
        OpenSshAuthentication::KeyFiles(_) => "publickey",
        OpenSshAuthentication::Password => "password",
        OpenSshAuthentication::KeyboardInteractive => "keyboard-interactive",
    };
    for option in [
        "StrictHostKeyChecking=yes".to_owned(),
        format!("UserKnownHostsFile=\"{path}\""),
        "GlobalKnownHostsFile=none".into(),
        "UpdateHostKeys=no".into(),
        "VerifyHostKeyDNS=no".into(),
        "CheckHostIP=no".into(),
        "CanonicalizeHostname=no".into(),
        "KnownHostsCommand=none".into(),
        "ProxyCommand=none".into(),
        "ProxyJump=none".into(),
        "ClearAllForwardings=yes".into(),
        "ForwardAgent=no".into(),
        "ForwardX11=no".into(),
        "BatchMode=no".into(),
        "NumberOfPasswordPrompts=1".into(),
        "ConnectTimeout=10".into(),
        format!("PreferredAuthentications={preferred}"),
        format!("HostKeyAlgorithms={algorithms}"),
    ] {
        command.arg("-o");
        command.arg(option);
    }
    if let OpenSshAuthentication::KeyFiles(identities) = authentication {
        // `none` prevents OpenSSH from falling back to default identity files if
        // the selected file disappears before the child process starts.
        command.args(["-o", "IdentityFile=none", "-o", "IdentitiesOnly=yes"]);
        for path in identities {
            command.args(["-i", path]);
        }
    }
    command.arg("-p");
    command.arg(port.to_string());
    command.arg("-l");
    command.arg(username);
    command.arg("--");
    command.arg(host);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    Ok(command)
}

fn identity_file(value: &str) -> Result<String> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return Err("SSH 키 파일의 절대 경로를 지정하세요.".into());
    }
    let resolved =
        std::fs::canonicalize(path).map_err(|_| "SSH 키 파일을 찾거나 접근할 수 없습니다.")?;
    if !resolved.is_file() {
        return Err("SSH 키는 일반 파일이어야 합니다.".into());
    }
    let text = resolved
        .to_str()
        .ok_or("SSH 키 파일 경로를 읽을 수 없습니다.")?;
    #[cfg(windows)]
    let text = if let Some(path) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{path}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
    };
    #[cfg(not(windows))]
    let text = text.to_owned();
    // IdentityFile expands OpenSSH %-tokens and, on supported versions,
    // environment references. Reject them instead of changing the target.
    if text.contains('%') || text.contains("${") || text.contains(['\r', '\n']) {
        return Err("SSH 키 파일 경로에 지원하지 않는 문자가 있습니다 (% 또는 환경 변수).".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_key(seed: u8) -> HostKey {
        let algorithm = "ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(algorithm.len() as u32).to_be_bytes());
        blob.extend_from_slice(algorithm.as_bytes());
        blob.extend_from_slice(&[seed; 32]);
        parse_key(algorithm, &STANDARD.encode(blob)).unwrap()
    }

    #[test]
    fn validates_targets_without_allowing_option_or_host_patterns() {
        assert_eq!(normalize_host(" EXAMPLE.com ").unwrap(), "example.com");
        assert_eq!(normalize_host("::1").unwrap(), "::1");
        for host in [
            "",
            "-oProxyCommand=x",
            "example.com\nother",
            "a@host",
            "[::1]",
            "*.example.com",
            "a,b",
            "a/b",
            "foo..bar",
        ] {
            assert!(normalize_host(host).is_err(), "accepted {host:?}");
        }
        for user in [
            "",
            "-oProxyCommand=x",
            "a@host",
            "user name",
            "a\nother",
            "user\\domain",
        ] {
            assert!(normalize_username(user).is_err(), "accepted {user:?}");
        }
        assert!(validate_port(0).is_err());
    }

    #[test]
    fn scanner_accepts_only_matching_host_and_supported_key() {
        let key = sample_key(7);
        let text = format!(
            "[other]:2222 {} {}\n[example.com]:2222 {} {}\n[example.com]:2222 {} {}\n",
            key.algorithm,
            key.public_key,
            key.algorithm,
            key.public_key,
            key.algorithm,
            key.public_key
        );
        let keys = parse_scan("example.com", 2222, &text).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].fingerprint, key.fingerprint);
        assert!(parse_scan(
            "example.com",
            2222,
            &format!("[other]:2222 {} {}", key.algorithm, key.public_key)
        )
        .is_err());
        assert!(parse_key("ssh-rsa", &key.public_key).is_err());
        assert!(parse_key("ssh-ed25519", "not base64").is_err());
    }

    #[test]
    fn acceptance_is_single_use_and_replacement_requires_confirmation_and_current_pin() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SshManager::new(dir.path());
        let first = sample_key(1);
        let second = sample_key(2);
        manager.pending.lock().unwrap().insert(
            "first".into(),
            PendingProbe {
                host: "example.com".into(),
                port: 2222,
                keys: vec![first.clone()],
                previous: None,
                created: Instant::now(),
            },
        );
        assert_eq!(
            manager
                .trust("first", &first.fingerprint, "")
                .unwrap()
                .status,
            "trusted"
        );
        assert!(manager.trust("first", &first.fingerprint, "").is_err());
        assert_eq!(
            manager
                .lookup("example.com", 2222)
                .unwrap()
                .unwrap()
                .fingerprint,
            first.fingerprint
        );
        assert!(manager.save("example.com", 2222, &second, None).is_err());
        assert_eq!(
            manager
                .lookup("example.com", 2222)
                .unwrap()
                .unwrap()
                .fingerprint,
            first.fingerprint
        );
        assert!(manager.lookup("example.com", 22).unwrap().is_none());
        manager.pending.lock().unwrap().insert(
            "expired".into(),
            PendingProbe {
                host: "other.example".into(),
                port: 22,
                keys: vec![second.clone()],
                previous: None,
                created: Instant::now() - PROBE_LIFETIME,
            },
        );
        assert!(manager.trust("expired", &second.fingerprint, "").is_err());
        assert!(manager.lookup("other.example", 22).unwrap().is_none());

        for token in ["replace", "stale"] {
            manager.pending.lock().unwrap().insert(
                token.into(),
                PendingProbe {
                    host: "example.com".into(),
                    port: 2222,
                    keys: vec![second.clone()],
                    previous: Some(first.clone()),
                    created: Instant::now(),
                },
            );
        }
        assert!(manager.trust("replace", &second.fingerprint, "").is_err());
        assert_eq!(manager.lookup("example.com", 2222).unwrap().unwrap(), first);
        let db = Connection::open(dir.path().join("ssh-trust.sqlite")).unwrap();
        db.execute_batch("CREATE TRIGGER reject_trust_audit BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit failed'); END;").unwrap();
        assert!(manager
            .save("example.com", 2222, &second, Some(&first))
            .is_err());
        assert_eq!(manager.lookup("example.com", 2222).unwrap().unwrap(), first);
        db.execute_batch("DROP TRIGGER reject_trust_audit;")
            .unwrap();
        assert_eq!(
            manager
                .trust("replace", &second.fingerprint, "교체")
                .unwrap()
                .status,
            "trusted"
        );
        assert!(manager.trust("stale", &second.fingerprint, "교체").is_err());
        assert_eq!(
            manager.lookup("example.com", 2222).unwrap().unwrap(),
            second
        );
        let events: Vec<(String, Option<String>, String)> = db
            .prepare(
                "SELECT action, previous_fingerprint, fingerprint FROM trust_events ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(
            events,
            [
                ("accepted".into(), None, first.fingerprint.clone()),
                (
                    "replaced".into(),
                    Some(first.fingerprint.clone()),
                    second.fingerprint
                )
            ]
        );
        let history = manager.history(None).unwrap();
        assert_eq!(history.events.len(), 2);
        assert_eq!(history.events[0].action, "replaced");
        assert_eq!(
            history.events[0].previous_fingerprint.as_deref(),
            Some(first.fingerprint.as_str())
        );
        assert!(manager.history(Some(0)).is_err());
    }

    #[test]
    fn unversioned_or_tampered_store_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh-trust.sqlite");
        std::fs::write(&path, b"user data").unwrap();
        let manager = SshManager::new(dir.path());
        assert!(manager
            .save("example.com", 22, &sample_key(1), None)
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"user data");

        let unrelated = tempfile::tempdir().unwrap();
        let unrelated_path = unrelated.path().join("ssh-trust.sqlite");
        let db = Connection::open(&unrelated_path).unwrap();
        db.execute_batch("CREATE TABLE host_keys (host TEXT, port INTEGER, algorithm TEXT, public_key TEXT, fingerprint TEXT); PRAGMA user_version=1;").unwrap();
        drop(db);
        let before = std::fs::read(&unrelated_path).unwrap();
        assert!(SshManager::new(unrelated.path())
            .lookup("example.com", 22)
            .is_err());
        assert_eq!(std::fs::read(&unrelated_path).unwrap(), before);

        let other = tempfile::tempdir().unwrap();
        let manager = SshManager::new(other.path());
        manager
            .save("example.com", 22, &sample_key(1), None)
            .unwrap();
        let db = Connection::open(other.path().join("ssh-trust.sqlite")).unwrap();
        db.execute("UPDATE host_keys SET fingerprint='SHA256:wrong'", [])
            .unwrap();
        assert!(manager.lookup("example.com", 22).is_err());

        let missing_audit = tempfile::tempdir().unwrap();
        let manager = SshManager::new(missing_audit.path());
        manager
            .save("example.com", 22, &sample_key(1), None)
            .unwrap();
        let db = Connection::open(missing_audit.path().join("ssh-trust.sqlite")).unwrap();
        db.execute_batch("DROP TABLE trust_events;").unwrap();
        assert!(manager.lookup("example.com", 22).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn ssh_uses_only_the_verified_key_and_disables_user_configuration() {
        let path = Path::new("C:\\temporary folder\\known_hosts");
        let command = ssh_command(
            "example.com",
            2222,
            "alice",
            "ssh-ed25519",
            path,
            OpenSshAuthentication::Automatic,
        )
        .unwrap();
        let args: Vec<_> = command
            .get_argv()
            .iter()
            .map(|item| item.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-F", "none"]));
        assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        assert!(args
            .iter()
            .any(|arg| arg == "UserKnownHostsFile=\"C:/temporary folder/known_hosts\""));
        assert!(args
            .iter()
            .any(|arg| arg == "HostKeyAlgorithms=ssh-ed25519"));
        assert!(args.windows(2).any(|pair| pair == ["--", "example.com"]));
    }

    #[cfg(windows)]
    #[test]
    fn explicit_identity_disables_default_keys_and_other_authentication() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("identity with spaces");
        std::fs::write(&key, b"test fixture").unwrap();
        let selected = identity_file(key.to_str().unwrap()).unwrap();
        let command = ssh_command(
            "example.com",
            22,
            "alice",
            "ssh-ed25519",
            Path::new("C:\\known_hosts"),
            OpenSshAuthentication::KeyFiles(std::slice::from_ref(&selected)),
        )
        .unwrap();
        let args: Vec<_> = command
            .get_argv()
            .iter()
            .map(|item| item.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", selected.as_str()]));
        assert!(args.iter().any(|arg| arg == "IdentityFile=none"));
        assert!(args.iter().any(|arg| arg == "IdentitiesOnly=yes"));
        assert!(args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=publickey"));
        assert!(!args.iter().any(|arg| arg.contains("keyboard-interactive")));
        std::fs::remove_file(&key).unwrap();
        let output = std::process::Command::new(&args[0])
            .arg("-G")
            .args(&args[1..])
            .output()
            .unwrap();
        assert!(output.status.success());
        let configuration = String::from_utf8(output.stdout).unwrap();
        let identity_lines: Vec<_> = configuration
            .lines()
            .filter(|line| line.starts_with("identityfile "))
            .collect();
        assert_eq!(identity_lines, ["identityfile none"]);
        assert!(identity_file("relative-key").is_err());
        assert!(identity_file(dir.path().to_str().unwrap()).is_err());
        let percent = dir.path().join("key%h");
        std::fs::write(&percent, b"fixture").unwrap();
        assert!(identity_file(percent.to_str().unwrap()).is_err());
        let variable = dir.path().join("key${USER}");
        std::fs::write(&variable, b"fixture").unwrap();
        assert!(identity_file(variable.to_str().unwrap()).is_err());
    }
}
