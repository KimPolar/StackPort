use crate::{Result, Store};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use windows::{delete, read, write};

#[cfg(not(windows))]
pub(crate) use unsupported::{delete, read, write};

#[cfg(not(windows))]
mod unsupported {
    use crate::Result;

    pub(crate) fn read<T>(_: &str, _: impl FnOnce(&[u8]) -> T) -> Result<Option<T>> {
        Ok(None)
    }

    pub(crate) fn write(_: &str, _: &mut [u8]) -> Result<()> {
        Err("이 환경에서는 암호 저장을 지원하지 않습니다.".into())
    }

    pub(crate) fn delete(_: &str) -> Result<()> {
        Ok(())
    }
}

pub(crate) const BINDING_BYTES: usize = 32;

#[derive(Serialize)]
pub struct CredentialStatus {
    supported: bool,
    stored: bool,
    pub(crate) usable: bool,
}

pub(crate) fn target(store: &Store, engine: &str, id: &str) -> Result<String> {
    let workspace = store
        .path
        .canonicalize()
        .map_err(|_| "작업 공간 위치를 확인할 수 없습니다.")?;
    let mut name = Sha256::new();
    name.update(format!("StackPort {engine} credential v1\0"));
    name.update(workspace.as_os_str().as_encoded_bytes());
    name.update(b"\0");
    name.update(id.as_bytes());
    Ok(format!("StackPort/{engine}/{:x}", name.finalize()))
}

pub(crate) fn status(target: &str, binding: &[u8; BINDING_BYTES]) -> Result<CredentialStatus> {
    let status = read(target, |blob| password_bytes(blob, binding).is_some())?;
    Ok(CredentialStatus {
        supported: cfg!(windows),
        stored: status.is_some(),
        usable: status == Some(true),
    })
}

pub(crate) fn password_bytes<'a>(blob: &'a [u8], binding: &[u8; BINDING_BYTES]) -> Option<&'a str> {
    let (saved, secret) = blob.split_at_checked(BINDING_BYTES)?;
    if saved != binding || secret.is_empty() {
        return None;
    }
    let password = std::str::from_utf8(secret).ok()?;
    (!password.contains('\0')).then_some(password)
}

pub(crate) fn save(target: &str, binding: &[u8; BINDING_BYTES], password: &str) -> Result<()> {
    if password.is_empty() || password.contains('\0') {
        return Err("저장할 암호를 확인하세요.".into());
    }
    let mut blob = Zeroizing::new(Vec::with_capacity(binding.len() + password.len()));
    blob.extend_from_slice(binding);
    blob.extend_from_slice(password.as_bytes());
    write(target, &mut blob)
}
