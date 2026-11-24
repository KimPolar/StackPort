//! Read a bounded prefix of a regular file without executing its contents.

use super::{
    file_error, open_local_file,
    transfer::{read_chunk, request, CHUNK_SIZE},
    RemotePath, SftpManager,
};
use crate::{
    png_preview::{png_for_display, png_read_length},
    Result,
};
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, SftpHandle},
};
use serde::Serialize;
use std::{fmt::Write as _, io::Read, time::Duration};
use tokio::time::timeout;

const TEXT_LIMIT: usize = 64 * 1024;
const HEX_LIMIT: usize = 4 * 1024;

#[derive(Serialize)]
pub struct FilePreview {
    total_bytes: String,
    shown_bytes: usize,
    #[serde(flatten)]
    content: PreviewContent,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PreviewContent {
    Text { value: String },
    Hex { value: String },
    Png { base64: String },
}

impl SftpManager {
    pub async fn preview(&self, id: &str, location: String) -> Result<FilePreview> {
        let path = RemotePath::Token(location).into_path()?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let files = &session.files;
        let listed = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        let size = regular_file_size(&listed)?;
        let handle = request(files.open(path, OpenFlags::READ, FileAttributes::empty()))
            .await
            .map_err(file_error)?
            .handle;
        let result = timeout(
            Duration::from_secs(18),
            read_remote_preview(files, &handle, &listed, size),
        )
        .await;
        let closed = request(files.close(handle)).await.map_err(file_error);
        let bytes = result.map_err(|_| "원격 파일 미리보기 시간이 초과되었습니다.")??;
        closed?;
        Ok(present(&bytes, size))
    }
}

async fn read_remote_preview(
    files: &RawSftpSession,
    handle: &SftpHandle,
    listed: &FileAttributes,
    size: u64,
) -> Result<Vec<u8>> {
    check_remote_snapshot(files, handle, listed, size).await?;
    let mut bytes = Vec::new();
    extend_remote_prefix(files, handle, &mut bytes, prefix_size(size)).await?;
    if let Some(length) = png_read_length(&bytes, size) {
        extend_remote_prefix(files, handle, &mut bytes, length).await?;
    }
    check_remote_snapshot(files, handle, listed, size).await?;
    Ok(bytes)
}

async fn check_remote_snapshot(
    files: &RawSftpSession,
    handle: &SftpHandle,
    listed: &FileAttributes,
    size: u64,
) -> Result<()> {
    let current = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    if regular_file_size(&current)? != size || current.mtime != listed.mtime {
        return Err("원격 파일이 미리보기 중 변경되었습니다. 다시 열어 확인하세요.".into());
    }
    Ok(())
}

async fn extend_remote_prefix(
    files: &RawSftpSession,
    handle: &SftpHandle,
    bytes: &mut Vec<u8>,
    length: usize,
) -> Result<()> {
    while bytes.len() < length {
        let wanted = (length - bytes.len()).min(CHUNK_SIZE as usize) as u32;
        bytes.extend(read_chunk(files, handle, bytes.len() as u64, wanted).await?);
    }
    Ok(())
}

fn regular_file_size(attrs: &FileAttributes) -> Result<u64> {
    if !attrs.is_regular() {
        return Err("원격 경로가 일반 파일인지 확인하세요.".into());
    }
    attrs
        .size
        .ok_or_else(|| "서버가 원격 파일 크기를 반환하지 않았습니다.".into())
}

pub fn preview_local_file(path: &str) -> Result<FilePreview> {
    let mut file = open_local_file(path)?;
    let original = file
        .metadata()
        .map_err(|_| "로컬 파일의 속성을 읽을 수 없습니다.")?;
    let size = original.len();
    let mut bytes = vec![0; prefix_size(size)];
    file.read_exact(&mut bytes)
        .map_err(|_| "로컬 파일을 읽을 수 없습니다.")?;
    if let Some(length) = png_read_length(&bytes, size) {
        let offset = bytes.len();
        bytes.resize(length, 0);
        file.read_exact(&mut bytes[offset..])
            .map_err(|_| "로컬 파일을 읽을 수 없습니다.")?;
    }
    let current = file
        .metadata()
        .map_err(|_| "로컬 파일의 속성을 읽을 수 없습니다.")?;
    if current.len() != size || current.modified().ok() != original.modified().ok() {
        return Err("로컬 파일이 미리보기 중 변경되었습니다. 다시 열어 확인하세요.".into());
    }
    Ok(present(&bytes, size))
}

fn prefix_size(size: u64) -> usize {
    size.min(TEXT_LIMIT as u64) as usize
}

fn present(bytes: &[u8], size: u64) -> FilePreview {
    let prefix = &bytes[..bytes.len().min(TEXT_LIMIT)];
    let (shown_bytes, content) = if let Some(base64) = png_for_display(bytes, size) {
        (bytes.len(), PreviewContent::Png { base64 })
    } else if let Some(text) = utf8_prefix(prefix, size) {
        let value = text.trim_start_matches('\u{feff}').to_owned();
        (text.len(), PreviewContent::Text { value })
    } else {
        let limit = prefix.len().min(HEX_LIMIT);
        (
            limit,
            PreviewContent::Hex {
                value: hex_lines(&prefix[..limit]),
            },
        )
    };
    FilePreview {
        total_bytes: size.to_string(),
        shown_bytes,
        content,
    }
}

pub(super) fn utf8_prefix(bytes: &[u8], size: u64) -> Option<&str> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() && size > bytes.len() as u64 => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    text.chars()
        .all(|ch| !ch.is_control() || matches!(ch, '\t' | '\r' | '\n'))
        .then_some(text)
}

fn hex_lines(bytes: &[u8]) -> String {
    let mut output = String::new();
    for (line, chunk) in bytes.chunks(16).enumerate() {
        let _ = write!(output, "{:08X}  ", line * 16);
        for byte in chunk {
            let _ = write!(output, "{byte:02X} ");
        }
        for _ in chunk.len()..16 {
            output.push_str("   ");
        }
        output.push(' ');
        output.extend(chunk.iter().map(|&byte| match byte {
            32..=126 => char::from(byte),
            _ => '.',
        }));
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn previews_bounded_utf8_and_hex_without_splitting_a_character() {
        let mut body = vec![b'a'; TEXT_LIMIT - 1];
        body.extend_from_slice("한".as_bytes());
        let preview = present(&body[..TEXT_LIMIT], body.len() as u64);
        assert_eq!(preview.shown_bytes, TEXT_LIMIT - 1);
        assert!(matches!(preview.content, PreviewContent::Text { .. }));
        assert!(
            matches!(present(&[0xff, b'A'], 2).content, PreviewContent::Hex { value } if value.starts_with("00000000  FF 41") && value.ends_with(".A\n"))
        );
        assert!(
            matches!(present(b"<b>test</b>", 11).content, PreviewContent::Text { value } if value == "<b>test</b>")
        );
    }

    #[test]
    fn previews_a_small_png_and_rejects_excessive_dimensions_or_animation() {
        let fixture = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIqIgCAAI+ASOK5tZ4AAAAAElFTkSuQmCC").unwrap();
        assert!(matches!(
            present(&fixture, fixture.len() as u64).content,
            PreviewContent::Png { .. }
        ));
        let mut wide = fixture.clone();
        wide[16..20].copy_from_slice(&2049_u32.to_be_bytes());
        assert!(png_for_display(&wide, wide.len() as u64).is_none());
        let mut animated = fixture;
        animated.splice(33..33, *b"\0\0\0\x08acTL\0\0\0\x01\0\0\0\0\0\0\0\0");
        assert!(png_for_display(&animated, animated.len() as u64).is_none());
    }
}
