//! Windows Remote Desktop clients and their per-connection settings.

use crate::{ssh, Result};
use serde::{Deserialize, Serialize};
use std::{
    fmt::Write as _,
    io::Write,
    net::Ipv6Addr,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tempfile::TempPath;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct RdpRequest {
    host: String,
    port: u16,
    username: String,
    domain: String,
    display: RdpDisplay,
    color_depth: u8,
    admin: bool,
    clipboard: bool,
    printers: bool,
    smart_cards: bool,
    drives: String,
    keyboard: RdpKeyboard,
    dynamic_resolution: bool,
    reconnect: bool,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum RdpDisplay {
    Window { width: u16, height: u16 },
    Fullscreen,
    MultipleMonitors,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RdpKeyboard {
    Local,
    Remote,
    Fullscreen,
}

#[derive(Serialize)]
pub struct RdpAvailability {
    available: bool,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RdpSession {
    pub id: String,
    pub address: String,
    pub process_id: u32,
    pub display: &'static str,
    pub admin: bool,
}

pub struct RdpManager {
    directory: PathBuf,
    state: Mutex<ClientState>,
}

#[derive(Default)]
struct ClientState {
    closing: bool,
    clients: Vec<Client>,
}

struct Client {
    session: RdpSession,
    process: Child,
    _profile: TempPath,
}

impl Client {
    fn disconnect(&mut self) -> std::io::Result<()> {
        if self.process.try_wait()?.is_none() {
            if let Err(error) = self.process.kill() {
                if self.process.try_wait()?.is_none() {
                    return Err(error);
                }
            }
            self.process.wait()?;
        }
        Ok(())
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}

impl RdpManager {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Mutex::new(ClientState::default()),
        }
    }

    pub fn availability(&self) -> RdpAvailability {
        let reason = client_executable().err();
        RdpAvailability {
            available: reason.is_none(),
            reason,
        }
    }

    pub fn open(&self, request: &RdpRequest) -> Result<RdpSession> {
        let (address, display, profile_text) = request.profile()?;
        let executable = client_executable()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "RDP 클라이언트 상태를 읽을 수 없습니다.")?;
        if state.closing {
            return Err("StackPort를 종료하는 중입니다.".into());
        }
        reap(&mut state.clients);
        let mut profile = tempfile::Builder::new()
            .prefix(".stackport-rdp-")
            .suffix(".rdp")
            .tempfile_in(&self.directory)
            .map_err(|error| format!("RDP 연결 파일을 만들 수 없습니다: {error}"))?;
        // mstsc uses Windows Unicode files. The file carries settings only.
        let bytes: Vec<u8> = std::iter::once(0xfeff)
            .chain(profile_text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        profile
            .write_all(&bytes)
            .and_then(|_| profile.flush())
            .map_err(|error| format!("RDP 연결 설정을 기록할 수 없습니다: {error}"))?;
        let profile = profile.into_temp_path();
        let mut command = Command::new(&executable);
        command
            .current_dir(
                executable
                    .parent()
                    .ok_or("Windows 시스템 폴더를 찾을 수 없습니다.")?,
            )
            .arg(profile.as_os_str())
            .args(["/prompt", "/public"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if request.admin {
            command.arg("/admin");
        }
        let process = command
            .spawn()
            .map_err(|error| format!("Windows 원격 데스크톱을 열 수 없습니다: {error}"))?;
        let session = RdpSession {
            id: Uuid::new_v4().to_string(),
            address,
            process_id: process.id(),
            display,
            admin: request.admin,
        };
        state.clients.push(Client {
            session: session.clone(),
            process,
            _profile: profile,
        });
        Ok(session)
    }

    pub fn list(&self) -> Result<Vec<RdpSession>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "RDP 클라이언트 상태를 읽을 수 없습니다.")?;
        reap(&mut state.clients);
        Ok(state
            .clients
            .iter()
            .map(|client| client.session.clone())
            .collect())
    }

    pub fn disconnect(&self, id: &str) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "RDP 클라이언트 상태를 읽을 수 없습니다.")?;
        let clients = &mut state.clients;
        if let Some(index) = clients.iter().position(|client| client.session.id == id) {
            clients[index]
                .disconnect()
                .map_err(|error| format!("RDP 클라이언트를 닫을 수 없습니다: {error}"))?;
            clients.remove(index);
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|lock| lock.into_inner());
        state.closing = true;
        state.clients.clear();
    }
}

fn reap(clients: &mut Vec<Client>) {
    clients.retain_mut(|client| !matches!(client.process.try_wait(), Ok(Some(_))));
}

#[cfg(windows)]
fn client_executable() -> Result<PathBuf> {
    let path = crate::windows_system::system_directory()?.join("mstsc.exe");
    if !path.is_file() {
        return Err("Windows 원격 데스크톱 클라이언트(mstsc.exe)가 설치되어 있지 않습니다.".into());
    }
    Ok(path)
}

#[cfg(not(windows))]
fn client_executable() -> Result<PathBuf> {
    Err("이 기기에서는 Windows 원격 데스크톱 클라이언트를 사용할 수 없습니다.".into())
}

impl RdpRequest {
    fn profile(&self) -> Result<(String, &'static str, String)> {
        let host = self.host.trim();
        let host = if let Some(value) = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
        {
            value
                .parse::<Ipv6Addr>()
                .map_err(|_| "IPv6 주소를 확인하세요.")?
                .to_string()
        } else {
            ssh::normalize_host(host)?
        };
        if self.port == 0 {
            return Err("RDP 포트는 1부터 65535까지 지정하세요.".into());
        }
        let address = if host.contains(':') {
            format!("[{host}]:{}", self.port)
        } else {
            format!("{host}:{}", self.port)
        };
        let username = identity_field(&self.username)?;
        let domain = identity_field(&self.domain)?;
        if !matches!(self.color_depth, 16 | 24 | 32) {
            return Err("색 깊이는 16, 24, 32비트 중에서 선택하세요.".into());
        }
        let drives = drive_list(&self.drives)?;
        let keyboard = match self.keyboard {
            RdpKeyboard::Local => 0,
            RdpKeyboard::Remote => 1,
            RdpKeyboard::Fullscreen => 2,
        };
        let (display, screen, multimon, dimensions) = match self.display {
            RdpDisplay::Window { width, height } => {
                if !(200..=8192).contains(&width) || !(200..=8192).contains(&height) {
                    return Err("창의 가로·세로 해상도는 200~8192픽셀로 지정하세요.".into());
                }
                ("window", 1, 0, Some((width, height)))
            }
            RdpDisplay::Fullscreen => ("fullscreen", 2, 0, None),
            RdpDisplay::MultipleMonitors => ("multiple_monitors", 2, 1, None),
        };
        let mut lines = format!(
            "full address:s:{address}\r\nusername:s:{username}\r\ndomain:s:{domain}\r\n\
             screen mode id:i:{screen}\r\nuse multimon:i:{multimon}\r\nsession bpp:i:{}\r\n\
             authentication level:i:1\r\nenablecredsspsupport:i:1\r\nprompt for credentials:i:1\r\npublic mode:i:1\r\n\
             gatewayusagemethod:i:0\r\nredirectclipboard:i:{}\r\nredirectprinters:i:{}\r\n\
             redirectsmartcards:i:{}\r\nredirectcomports:i:0\r\nredirectwebauthn:i:0\r\nredirectposdevices:i:0\r\n\
             drivestoredirect:s:{drives}\r\ndevicestoredirect:s:\r\nusbdevicestoredirect:s:\r\n\
             audiomode:i:2\r\naudiocapturemode:i:0\r\nkeyboardhook:i:{keyboard}\r\n\
             dynamic resolution:i:{}\r\nautoreconnection enabled:i:{}\r\n",
            self.color_depth, u8::from(self.clipboard), u8::from(self.printers), u8::from(self.smart_cards),
            u8::from(self.dynamic_resolution && display == "window"), u8::from(self.reconnect),
        );
        if let Some((width, height)) = dimensions {
            write!(
                lines,
                "desktopwidth:i:{width}\r\ndesktopheight:i:{height}\r\n"
            )
            .expect("writing to String");
        }
        Ok((address, display, lines))
    }
}

fn identity_field(value: &str) -> Result<&str> {
    if value.encode_utf16().count() > 256
        || value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
    {
        return Err("사용자 이름과 도메인은 제어 문자 없이 256자 이내로 입력하세요.".into());
    }
    Ok(value.trim())
}

fn drive_list(value: &str) -> Result<String> {
    if value.len() > 104 {
        return Err("공유할 드라이브 목록은 104자 이내로 입력하세요.".into());
    }
    if value.trim().is_empty() {
        return Ok(String::new());
    }
    let mut drives = String::new();
    for drive in value.split(',') {
        match drive.trim().as_bytes() {
            [letter, b':'] if letter.is_ascii_alphabetic() => {
                let root = format!("{}:\\;", letter.to_ascii_uppercase() as char);
                if !drives.contains(&root) {
                    drives.push_str(&root);
                }
            }
            _ => return Err("드라이브를 C:, D:처럼 드라이브 문자와 쉼표로 지정하세요.".into()),
        }
    }
    Ok(drives)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window_request() -> RdpRequest {
        RdpRequest {
            host: "EXAMPLE.COM".into(),
            port: 3389,
            username: "사용자".into(),
            domain: "CONTOSO".into(),
            display: RdpDisplay::Window {
                width: 1280,
                height: 800,
            },
            color_depth: 32,
            admin: false,
            clipboard: false,
            printers: false,
            smart_cards: false,
            drives: String::new(),
            keyboard: RdpKeyboard::Fullscreen,
            dynamic_resolution: true,
            reconnect: false,
        }
    }

    #[test]
    fn window_profile_requires_server_authentication_and_disables_default_sharing() {
        let (endpoint, mode, profile) = window_request().profile().unwrap();
        assert_eq!(endpoint, "example.com:3389");
        assert_eq!(mode, "window");
        let lines = profile.lines().collect::<Vec<_>>();
        for expected in [
            "full address:s:example.com:3389",
            "username:s:사용자",
            "domain:s:CONTOSO",
            "authentication level:i:1",
            "enablecredsspsupport:i:1",
            "prompt for credentials:i:1",
            "public mode:i:1",
            "gatewayusagemethod:i:0",
            "screen mode id:i:1",
            "use multimon:i:0",
            "session bpp:i:32",
            "desktopwidth:i:1280",
            "desktopheight:i:800",
            "dynamic resolution:i:1",
            "autoreconnection enabled:i:0",
            "redirectclipboard:i:0",
            "redirectprinters:i:0",
            "redirectsmartcards:i:0",
            "drivestoredirect:s:",
            "redirectcomports:i:0",
            "devicestoredirect:s:",
            "usbdevicestoredirect:s:",
            "redirectwebauthn:i:0",
        ] {
            assert!(lines.contains(&expected), "missing {expected}");
        }
        assert!(!profile.contains("password"));
    }

    #[test]
    fn multiple_monitors_and_redirected_resources_are_explicit() {
        let mut request = window_request();
        request.host = "[2001:db8::1]".into();
        request.port = 3390;
        request.display = RdpDisplay::MultipleMonitors;
        request.clipboard = true;
        request.printers = true;
        request.smart_cards = true;
        request.drives = "c:, D:, C:".into();
        request.keyboard = RdpKeyboard::Remote;
        request.reconnect = true;
        let (endpoint, mode, profile) = request.profile().unwrap();
        assert_eq!(endpoint, "[2001:db8::1]:3390");
        assert_eq!(mode, "multiple_monitors");
        for expected in [
            "screen mode id:i:2",
            "use multimon:i:1",
            "keyboardhook:i:1",
            "redirectclipboard:i:1",
            "redirectprinters:i:1",
            "redirectsmartcards:i:1",
            "drivestoredirect:s:C:\\;D:\\;",
            "dynamic resolution:i:0",
            "autoreconnection enabled:i:1",
        ] {
            assert!(
                profile.lines().any(|line| line == expected),
                "missing {expected}"
            );
        }
        assert!(!profile.contains("desktopwidth"));
        request.display = RdpDisplay::Fullscreen;
        assert!(request.profile().unwrap().2.contains("use multimon:i:0"));
    }

    #[test]
    fn refuses_ambiguous_hosts_and_configuration_injection() {
        let mut request = window_request();
        request.host = "server:3389".into();
        assert!(request.profile().is_err());
        request.host = "localhost".into();
        request.username = "alice\r\nauthentication level:i:0".into();
        assert!(request.profile().is_err());
        request.username.clear();
        request.drives = "C:, *".into();
        assert!(request.profile().is_err());
        request.drives.clear();
        request.display = RdpDisplay::Window {
            width: 1280,
            height: 8193,
        };
        assert!(request.profile().is_err());
    }
}
