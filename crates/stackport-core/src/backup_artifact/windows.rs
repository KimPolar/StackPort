use super::CHANGED;
use crate::Result;
use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io,
    mem::{size_of, MaybeUninit},
    os::windows::{
        ffi::OsStringExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::GENERIC_READ,
    Storage::FileSystem::{
        FileDispositionInfo, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_ID_INFO, FILE_NAME_NORMALIZED, FILE_SHARE_READ,
    },
};

pub(super) fn identity(file: &File) -> Option<String> {
    let mut info = MaybeUninit::<FILE_ID_INFO>::uninit();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let id: String = info
        .FileId
        .Identifier
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(format!("{:016x}-{id}", info.VolumeSerialNumber))
}

pub(super) fn open(path: &Path, remove: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if remove {
        // Exclusive access prevents another handle from writing or unlinking
        // this file between the fingerprint check and disposition.
        options.access_mode(GENERIC_READ | DELETE).share_mode(0);
    } else {
        options.read(true).share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path).map_err(|error| {
        format!("백업 파일을 잠금 상태에서 열 수 없습니다. 열린 프로그램과 파일 권한을 확인하세요. ({error})")
    })?;
    let metadata = file.metadata().map_err(|_| CHANGED)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || final_path(&file)? != path
    {
        return Err(CHANGED.into());
    }
    if remove {
        let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 || unsafe { info.assume_init() }.nNumberOfLinks != 1 {
            return Err(
                "하드 링크가 있거나 링크 수를 확인할 수 없는 백업은 삭제할 수 없습니다.".into(),
            );
        }
    }
    Ok(file)
}

fn final_path(file: &File) -> Result<PathBuf> {
    let handle = file.as_raw_handle();
    let capacity =
        unsafe { GetFinalPathNameByHandleW(handle, ptr::null_mut(), 0, FILE_NAME_NORMALIZED) };
    if capacity == 0 || capacity > 32_768 {
        return Err(CHANGED.into());
    }
    let mut name = vec![0; capacity as usize];
    let length = unsafe {
        GetFinalPathNameByHandleW(handle, name.as_mut_ptr(), capacity, FILE_NAME_NORMALIZED)
    };
    if length == 0 || length >= capacity {
        return Err(CHANGED.into());
    }
    Ok(PathBuf::from(OsString::from_wide(&name[..length as usize])))
}

pub(super) fn remove(file: File) -> Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows에서 백업을 삭제할 수 없습니다. ({})",
            io::Error::last_os_error()
        ));
    }
    drop(file);
    Ok(())
}
