use crate::Result;
use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

pub(crate) fn system_directory() -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    // The writable UTF-16 buffer has the advertised length.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Windows 시스템 폴더를 찾을 수 없습니다.".into());
    }
    Ok(OsString::from_wide(&buffer[..length]).into())
}
