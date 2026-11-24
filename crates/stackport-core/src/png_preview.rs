use base64::{engine::general_purpose::STANDARD, Engine as _};

pub(crate) const PNG_LIMIT: usize = 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

pub(crate) fn png_read_length(bytes: &[u8], size: u64) -> Option<usize> {
    if size > PNG_LIMIT as u64 || !bytes.starts_with(PNG_SIGNATURE) {
        return None;
    }
    let header = bytes.get(8..24)?;
    let width = u32::from_be_bytes(header[8..12].try_into().ok()?);
    let height = u32::from_be_bytes(header[12..16].try_into().ok()?);
    (header[..8] == *b"\0\0\0\rIHDR" && (1..=2048).contains(&width) && (1..=2048).contains(&height))
        .then_some(size as usize)
}

pub(crate) fn png_for_display(bytes: &[u8], size: u64) -> Option<String> {
    if png_read_length(bytes, size)? != bytes.len() {
        return None;
    }
    let mut safe = PNG_SIGNATURE.to_vec();
    let mut remaining = &bytes[PNG_SIGNATURE.len()..];
    let mut has_data = false;
    // Pass through raster chunks and transparency only. Drop optional metadata.
    while let Some(header) = remaining.get(..8) {
        let length = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        let end = length.checked_add(12)?;
        let chunk = remaining.get(..end)?;
        remaining = &remaining[end..];
        match &header[4..8] {
            b"IHDR" if safe.len() == PNG_SIGNATURE.len() => safe.extend_from_slice(chunk),
            b"PLTE" | b"tRNS" => safe.extend_from_slice(chunk),
            b"IDAT" => {
                has_data = true;
                safe.extend_from_slice(chunk);
            }
            b"IEND" if length == 0 && has_data && remaining.is_empty() => {
                safe.extend_from_slice(chunk);
                return Some(STANDARD.encode(safe));
            }
            b"acTL" | b"fcTL" | b"fdAT" => return None,
            name if name[0].is_ascii_lowercase() => {}
            _ => return None,
        }
    }
    None
}
