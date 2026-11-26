use crate::Result;
use std::{io, ptr, slice};
use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, ERROR_NO_SUCH_LOGON_SESSION},
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    },
};
use zeroize::Zeroize;

struct CredentialBuffer(*mut CREDENTIALW);

impl Drop for CredentialBuffer {
    fn drop(&mut self) {
        // CredRead returns one system-owned allocation with a mutable BLOB.
        unsafe {
            let record = &mut *self.0;
            if !record.CredentialBlob.is_null()
                && record.CredentialBlobSize <= CRED_MAX_CREDENTIAL_BLOB_SIZE
            {
                slice::from_raw_parts_mut(
                    record.CredentialBlob,
                    record.CredentialBlobSize as usize,
                )
                .zeroize();
            }
            CredFree(self.0.cast());
        }
    }
}

pub(crate) fn read<T>(name: &str, inspect: impl FnOnce(&[u8]) -> T) -> Result<Option<T>> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut out = ptr::null_mut();
    let ok = unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut out) };
    if ok == 0 {
        return match io::Error::last_os_error()
            .raw_os_error()
            .map(|status| status as u32)
        {
            Some(ERROR_NOT_FOUND | ERROR_NO_SUCH_LOGON_SESSION) => Ok(None),
            _ => Err("Windows 자격 증명 관리자에서 저장 상태를 확인할 수 없습니다.".into()),
        };
    }
    if out.is_null() {
        return Err("Windows 자격 증명 관리자에서 저장 상태를 확인할 수 없습니다.".into());
    }
    let buffer = CredentialBuffer(out);
    let item = unsafe { &*buffer.0 };
    if item.CredentialBlobSize == 0 || item.CredentialBlob.is_null() {
        return Ok(Some(inspect(&[])));
    }
    if item.CredentialBlobSize > CRED_MAX_CREDENTIAL_BLOB_SIZE {
        return Err("저장된 자격 증명의 형식을 읽을 수 없습니다.".into());
    }
    let blob =
        unsafe { slice::from_raw_parts(item.CredentialBlob, item.CredentialBlobSize as usize) };
    Ok(Some(inspect(blob)))
}

pub(crate) fn write(name: &str, blob: &mut [u8]) -> Result<()> {
    if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err("암호가 Windows 자격 증명 관리자의 저장 한도를 초과합니다.".into());
    }
    let mut name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut entry: CREDENTIALW = unsafe { std::mem::zeroed() };
    entry.Type = CRED_TYPE_GENERIC;
    entry.TargetName = name.as_mut_ptr();
    entry.CredentialBlob = blob.as_mut_ptr();
    entry.CredentialBlobSize = blob.len() as u32;
    entry.Persist = CRED_PERSIST_LOCAL_MACHINE;
    if unsafe { CredWriteW(&entry, 0) } == 0 {
        return Err("Windows 자격 증명 관리자에 암호를 저장할 수 없습니다.".into());
    }
    Ok(())
}

pub(crate) fn delete(name: &str) -> Result<()> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
        return Ok(());
    }
    match io::Error::last_os_error()
        .raw_os_error()
        .map(|status| status as u32)
    {
        Some(ERROR_NOT_FOUND | ERROR_NO_SUCH_LOGON_SESSION) => Ok(()),
        _ => Err("Windows 자격 증명 관리자에서 저장한 암호를 삭제할 수 없습니다.".into()),
    }
}
