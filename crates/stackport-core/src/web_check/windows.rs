use super::{WebDiagnostic, WebHeader, WebMethod, WebResponse, WebSample, WebTls};
use crate::Result;
use std::{
    ffi::c_void,
    mem::size_of_val,
    ptr::{null, null_mut, NonNull},
    thread,
    time::{Duration, Instant},
};
use url::{Position, Url};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{GetLastError, ERROR_INVALID_PARAMETER},
        Networking::WinHttp::*,
        Security::Authentication::Identity::{
            SecPkgContext_CipherInfo, SecPkgContext_ConnectionInfo, SP_PROT_TLS1_2_CLIENT,
            SP_PROT_TLS1_3_CLIENT,
        },
    },
};

const MAX_RESPONSE_HEADER_BYTES: u32 = 16 * 1024;
const HEADERS_TIMEOUT_MS: u32 = 4_000;

struct InternetHandle(NonNull<c_void>);

impl InternetHandle {
    fn new(raw: *mut c_void) -> std::result::Result<Self, u32> {
        NonNull::new(raw).map(Self).ok_or_else(last_error)
    }

    fn raw(&self) -> *mut c_void {
        self.0.as_ptr()
    }

    fn set_u32(&self, option: u32, value: u32) -> std::result::Result<(), u32> {
        // WinHTTP copies the option value during this call.
        checked(unsafe {
            WinHttpSetOption(
                self.raw(),
                option,
                (&value as *const u32).cast(),
                size_of_val(&value) as u32,
            )
        })
    }
}

impl Drop for InternetHandle {
    fn drop(&mut self) {
        // This handle is uniquely owned, with child handles dropped first.
        unsafe { WinHttpCloseHandle(self.raw()) };
    }
}

pub(crate) fn run(url: Url, method: WebMethod, count: u8) -> Result<WebDiagnostic> {
    let port = url
        .port_or_known_default()
        .ok_or("유효한 대상 포트를 확인할 수 없습니다.")?;
    let host = wide(url.host_str().ok_or("대상 호스트를 확인할 수 없습니다.")?);
    let path = wide(&url[Position::BeforePath..]);
    let secure = url.scheme() == "https";
    let mut samples = Vec::with_capacity(count.into());
    for index in 0..count {
        if index > 0 {
            thread::sleep(Duration::from_secs(1));
        }
        let start = Instant::now();
        let response = match request(&host, port, &path, method, secure) {
            Ok(response) => response,
            Err(os_error) => WebResponse::Failed {
                reason: failure_reason(os_error),
                os_error,
            },
        };
        samples.push(WebSample {
            elapsed_ms: start.elapsed().as_millis() as u64,
            response,
        });
    }
    Ok(WebDiagnostic {
        origin: url.origin().ascii_serialization(),
        samples,
    })
}

fn request(
    host: &[u16],
    port: u16,
    path: &[u16],
    method: WebMethod,
    secure: bool,
) -> std::result::Result<WebResponse, u32> {
    // Both inputs are NUL-terminated UTF-16 for the lifetime of these calls.
    // Each request owns a fresh session with no proxy discovery or implicit credentials.
    let session = InternetHandle::new(unsafe {
        WinHttpOpen(
            w!("StackPort"),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            null(),
            null(),
            0,
        )
    })?;
    checked(unsafe {
        WinHttpSetTimeouts(
            session.raw(),
            2_500,
            2_500,
            2_000,
            HEADERS_TIMEOUT_MS as i32,
        )
    })?;
    session.set_u32(WINHTTP_OPTION_RECEIVE_RESPONSE_TIMEOUT, HEADERS_TIMEOUT_MS)?;
    session.set_u32(
        WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE,
        MAX_RESPONSE_HEADER_BYTES,
    )?;
    if secure {
        let tls12 = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        match session.set_u32(
            WINHTTP_OPTION_SECURE_PROTOCOLS,
            tls12 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3,
        ) {
            Err(ERROR_INVALID_PARAMETER | ERROR_WINHTTP_INVALID_OPTION) => {
                session.set_u32(WINHTTP_OPTION_SECURE_PROTOCOLS, tls12)?
            }
            result => result?,
        }
    }
    let connection =
        InternetHandle::new(unsafe { WinHttpConnect(session.raw(), host.as_ptr(), port, 0) })?;
    let verb = match method {
        WebMethod::Head => w!("HEAD"),
        WebMethod::Get => w!("GET"),
    };
    let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
    let request = InternetHandle::new(unsafe {
        WinHttpOpenRequest(
            connection.raw(),
            verb,
            path.as_ptr(),
            null(),
            null(),
            null(),
            flags,
        )
    })?;
    request.set_u32(
        WINHTTP_OPTION_DISABLE_FEATURE,
        WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION,
    )?;
    checked(unsafe { WinHttpSendRequest(request.raw(), null(), 0, null(), 0, 0, 0) })?;
    checked(unsafe { WinHttpReceiveResponse(request.raw(), null_mut()) })?;

    let mut status_code = 0u32;
    let mut bytes = size_of_val(&status_code) as u32;
    checked(unsafe {
        WinHttpQueryHeaders(
            request.raw(),
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            null(),
            (&mut status_code as *mut u32).cast(),
            &mut bytes,
            null_mut(),
        )
    })?;
    Ok(WebResponse::Received {
        status_code,
        headers: response_headers(&request)?,
        tls: secure.then(|| tls_details(&request)),
    })
}

fn response_headers(request: &InternetHandle) -> std::result::Result<Vec<WebHeader>, u32> {
    // One received header byte can expand to a UTF-16 code unit. WinHTTP
    // rejects oversized responses before this bounded buffer is used.
    let mut data = vec![0u16; MAX_RESPONSE_HEADER_BYTES as usize + 1];
    let mut bytes = size_of_val(data.as_slice()) as u32;
    checked(unsafe {
        WinHttpQueryHeaders(
            request.raw(),
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            null(),
            data.as_mut_ptr().cast(),
            &mut bytes,
            null_mut(),
        )
    })?;
    let raw = String::from_utf16_lossy(until_nul(&data));
    Ok(raw
        .lines()
        .skip(1)
        .filter(|line| !line.starts_with([' ', '\t']))
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            let value = match name.trim().to_ascii_lowercase().as_str() {
                "set-cookie"
                | "set-cookie2"
                | "cookie"
                | "authorization"
                | "proxy-authorization"
                | "authentication-info"
                | "proxy-authentication-info" => "[숨김]",
                _ => value.trim(),
            };
            Some(WebHeader {
                name: name.into(),
                value: value.into(),
            })
        })
        .collect())
}

// This WinHTTP type is absent from windows-sys 0.59. Its two members use the
// published Windows SDK ABI and generated Schannel types.
#[repr(C)]
struct SecurityInfo {
    connection: SecPkgContext_ConnectionInfo,
    cipher: SecPkgContext_CipherInfo,
}

fn tls_details(request: &InternetHandle) -> WebTls {
    // Both structs contain only integers and fixed-size UTF-16 buffers.
    let mut info: SecurityInfo = unsafe { std::mem::zeroed() };
    let mut bytes = size_of_val(&info) as u32;
    if unsafe {
        WinHttpQueryOption(
            request.raw(),
            WINHTTP_OPTION_SECURITY_INFO,
            (&mut info as *mut SecurityInfo).cast(),
            &mut bytes,
        )
    } != 0
    {
        let protocol = match info.connection.dwProtocol {
            SP_PROT_TLS1_2_CLIENT => Some("TLS 1.2"),
            SP_PROT_TLS1_3_CLIENT => Some("TLS 1.3"),
            _ => None,
        };
        let suite = until_nul(&info.cipher.szCipherSuite);
        return WebTls {
            protocol,
            cipher_suite: (!suite.is_empty()).then(|| String::from_utf16_lossy(suite)),
            cipher_bits: (info.connection.dwCipherStrength > 0)
                .then_some(info.connection.dwCipherStrength),
        };
    }
    // Earlier Windows versions may only report the key strength.
    let mut bits = 0u32;
    let mut bytes = size_of_val(&bits) as u32;
    let ok = unsafe {
        WinHttpQueryOption(
            request.raw(),
            WINHTTP_OPTION_SECURITY_KEY_BITNESS,
            (&mut bits as *mut u32).cast(),
            &mut bytes,
        )
    } != 0;
    WebTls {
        protocol: None,
        cipher_suite: None,
        cipher_bits: (ok && bits > 0).then_some(bits),
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn until_nul(value: &[u16]) -> &[u16] {
    &value[..value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len())]
}

fn checked(ok: i32) -> std::result::Result<(), u32> {
    (ok != 0).then_some(()).ok_or_else(last_error)
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn failure_reason(code: u32) -> &'static str {
    match code {
        ERROR_WINHTTP_TIMEOUT => "timeout",
        ERROR_WINHTTP_NAME_NOT_RESOLVED => "dns",
        ERROR_WINHTTP_CANNOT_CONNECT | ERROR_WINHTTP_CONNECTION_ERROR => "connection",
        ERROR_WINHTTP_SECURE_FAILURE
        | ERROR_WINHTTP_SECURE_CERT_DATE_INVALID
        | ERROR_WINHTTP_SECURE_CERT_CN_INVALID
        | ERROR_WINHTTP_SECURE_INVALID_CA
        | ERROR_WINHTTP_SECURE_INVALID_CERT
        | ERROR_WINHTTP_SECURE_CERT_REVOKED
        | ERROR_WINHTTP_SECURE_CERT_REV_FAILED
        | ERROR_WINHTTP_SECURE_CERT_WRONG_USAGE => "certificate",
        ERROR_WINHTTP_SECURE_CHANNEL_ERROR | ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED => "tls",
        ERROR_WINHTTP_HEADER_SIZE_OVERFLOW | ERROR_WINHTTP_HEADER_COUNT_EXCEEDED => "headers",
        _ => "other",
    }
}
