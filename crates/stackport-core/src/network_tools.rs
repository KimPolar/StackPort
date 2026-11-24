//! Bounded explicit ICMP diagnostics using the Windows networking tools.

use super::Result;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum RouteTool {
    Ping,
    Trace,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum RouteFamily {
    Auto,
    Ipv4,
    Ipv6,
}

#[derive(Debug, Serialize)]
pub struct RouteDiagnostic {
    pub target: String,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub output: String,
    pub errors: String,
    pub truncated: bool,
}

#[cfg(not(windows))]
pub(crate) fn run(
    _target: &str,
    _tool: RouteTool,
    _family: RouteFamily,
) -> Result<RouteDiagnostic> {
    Err("ping과 경로 추적은 현재 Windows에서 지원합니다.".into())
}

#[cfg(windows)]
pub(crate) fn run(target: &str, tool: RouteTool, family: RouteFamily) -> Result<RouteDiagnostic> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let (name, args, timeout): (_, &[_], _) = match tool {
        RouteTool::Ping => (
            "ping.exe",
            &["-n", "4", "-w", "1000"],
            Duration::from_secs(12),
        ),
        RouteTool::Trace => (
            "tracert.exe",
            &["-d", "-h", "12", "-w", "500"],
            Duration::from_secs(24),
        ),
    };
    let system = crate::windows_system::system_directory()?;
    let mut command = Command::new(system.join(name));
    command.args(args);
    match family {
        RouteFamily::Auto => {}
        RouteFamily::Ipv4 => {
            command.arg("-4");
        }
        RouteFamily::Ipv6 => {
            command.arg("-6");
        }
    }
    let start = Instant::now();
    let mut child = command
        .arg(target)
        .current_dir(&system)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Windows 진단 도구를 시작할 수 없습니다: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let read_output = thread::spawn(move || read_stream(stdout));
    let read_errors = thread::spawn(move || read_stream(stderr));
    let finished = loop {
        match child.try_wait() {
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            result => break result,
        }
    };
    if !matches!(finished, Ok(Some(_))) {
        let _ = child.kill();
        let _ = child.wait();
    }
    let status =
        finished.map_err(|error| format!("Windows 진단 도구 상태를 읽을 수 없습니다: {error}"))?;
    let (output, output_truncated) = read_output
        .join()
        .map_err(|_| "진단 출력을 읽을 수 없습니다.")??;
    let (errors, error_truncated) = read_errors
        .join()
        .map_err(|_| "진단 오류 출력을 읽을 수 없습니다.")??;
    Ok(RouteDiagnostic {
        target: target.into(),
        timed_out: status.is_none(),
        exit_code: status.and_then(|status| status.code()),
        elapsed_ms: start.elapsed().as_millis() as u64,
        output: decode(&output),
        errors: decode(&errors),
        truncated: output_truncated || error_truncated,
    })
}

#[cfg(windows)]
fn read_stream(mut reader: impl std::io::Read) -> Result<(Vec<u8>, bool)> {
    const LIMIT: usize = 16 * 1024;
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 4096];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("진단 출력을 읽을 수 없습니다: {error}"))?;
        if read == 0 {
            break;
        }
        let kept = read.min(LIMIT - output.len());
        output.extend_from_slice(&buffer[..kept]);
        truncated |= kept < read;
    }
    Ok((output, truncated))
}

#[cfg(windows)]
fn decode(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{GetOEMCP, MultiByteToWideChar};
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim().into();
    }
    // Console tools normally use the system OEM code page when redirected.
    let mut wide = vec![0; bytes.len()];
    let length = unsafe {
        MultiByteToWideChar(
            GetOEMCP(),
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            wide.len() as i32,
        )
    };
    if length > 0 {
        String::from_utf16_lossy(&wide[..length as usize])
            .trim()
            .into()
    } else {
        String::from_utf8_lossy(bytes).trim().into()
    }
}
