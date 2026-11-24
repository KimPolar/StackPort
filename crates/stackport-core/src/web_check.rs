//! Explicit HTTP(S) header requests with independent, bounded samples.

use crate::Result;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum WebMethod {
    Head,
    Get,
}

#[derive(Debug, Serialize)]
pub struct WebDiagnostic {
    pub origin: String,
    pub samples: Vec<WebSample>,
}

#[derive(Debug, Serialize)]
pub struct WebSample {
    pub elapsed_ms: u64,
    #[serde(flatten)]
    pub response: WebResponse,
}

#[derive(Debug, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum WebResponse {
    Received {
        status_code: u32,
        headers: Vec<WebHeader>,
        tls: Option<WebTls>,
    },
    Failed {
        reason: &'static str,
        os_error: u32,
    },
}

#[derive(Debug, Serialize)]
pub struct WebHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct WebTls {
    pub protocol: Option<&'static str>,
    pub cipher_suite: Option<String>,
    pub cipher_bits: Option<u32>,
}

pub(crate) fn parse_address(address: &str) -> Result<Url> {
    let address = address.trim();
    if address.len() > 4096 || address.contains('\\') || address.chars().any(char::is_control) {
        return Err("제어 문자 없이 4096바이트 이하의 HTTP 또는 HTTPS URL을 입력하세요.".into());
    }
    let authority = address
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .filter(|authority| !authority.is_empty())
        .ok_or("http:// 또는 https://로 시작하는 전체 URL을 입력하세요.")?;
    let url = Url::parse(address).map_err(|_| "유효한 HTTP 또는 HTTPS URL을 입력하세요.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() || url.port() == Some(0) {
        return Err("유효한 대상과 포트가 있는 HTTP 또는 HTTPS URL을 입력하세요.".into());
    }
    if authority.contains('@') || url.fragment().is_some() {
        return Err("사용자 정보와 URL 조각(#)을 제거하고 다시 시도하세요.".into());
    }
    Ok(url)
}

#[cfg(not(windows))]
pub(crate) fn run(_url: Url, _method: WebMethod, _count: u8) -> Result<WebDiagnostic> {
    Err("HTTP 상태 확인은 현재 Windows에서 지원합니다.".into())
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::run;
