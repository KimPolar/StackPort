use crate::Result;
use bson::raw::RawDocumentBuf;
use flate2::bufread::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

const MAGIC: u32 = 0x8199e26d;
const TERMINATOR: u32 = u32::MAX;
const MAX_BSON: usize = 16 * 1024 * 1024;
const MAX_NAMESPACES: usize = 10_000;
const MAX_PRELUDE: usize = 64 * 1024 * 1024;
const INVALID: &str = "MongoDB 아카이브의 형식 또는 무결성을 확인할 수 없습니다.";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct Namespace {
    pub(super) database: String,
    pub(super) collection: String,
    pub(super) kind: String,
    pub(super) documents: u64,
    pub(super) restore_supported: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct ArchiveInfo {
    pub(super) server_version: String,
    pub(super) tool_version: String,
    pub(super) namespaces: Vec<Namespace>,
    pub(super) sha256: String,
    pub(super) size_bytes: u64,
    #[serde(skip)]
    pub(super) gzip: bool,
}

#[derive(Deserialize)]
struct ArchiveHeader {
    version: String,
    server_version: String,
    tool_version: String,
}

#[derive(Deserialize)]
struct CollectionMetadata {
    db: String,
    collection: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    metadata: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordHeader {
    db: String,
    collection: String,
    #[serde(rename = "EOF")]
    end: bool,
    #[serde(rename = "CRC")]
    crc: i64,
}

#[derive(Default)]
struct RecordState {
    crc: u64,
    count: u64,
    ended: bool,
}

pub(super) fn open_source(source: &str) -> Result<File> {
    let path = Path::new(source.trim());
    if !path.is_absolute() {
        return Err("MongoDB 아카이브의 절대 경로를 지정하세요.".into());
    }
    let file = File::open(path).map_err(|_| "MongoDB 아카이브를 열 수 없습니다.")?;
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err("MongoDB 아카이브 파일을 선택하세요.".into());
    }
    Ok(file)
}

pub(super) fn snapshot(mut source: File, check: &impl Fn() -> Result<()>) -> Result<File> {
    use std::io::Write;
    let mut target =
        tempfile::tempfile().map_err(|_| "복원할 아카이브의 임시 사본을 만들 수 없습니다.")?;
    let mut buffer = vec![0; 128 * 1024];
    loop {
        check()?;
        let size = source
            .read(&mut buffer)
            .map_err(|_| "MongoDB 아카이브를 읽을 수 없습니다.")?;
        if size == 0 {
            break;
        }
        target
            .write_all(&buffer[..size])
            .map_err(|_| "아카이브 임시 사본을 기록할 수 없습니다.")?;
    }
    target.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
    Ok(target)
}

pub(super) fn scan(mut source: File, check: &impl Fn() -> Result<()>) -> Result<ArchiveInfo> {
    source.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
    let mut input = BufReader::with_capacity(
        128 * 1024,
        HashedInput {
            source,
            hash: Sha256::new(),
            bytes: 0,
        },
    );
    let gzip = input
        .fill_buf()
        .map_err(|_| INVALID)?
        .starts_with(&[0x1f, 0x8b]);
    let (header, namespaces) = if gzip {
        let mut decoder = GzDecoder::new(&mut input);
        let result = read_archive(&mut decoder, check)?;
        if !input.fill_buf().map_err(|_| INVALID)?.is_empty() {
            return Err(INVALID.into());
        }
        result
    } else {
        read_archive(&mut input, check)?
    };
    let input = input.into_inner();
    Ok(ArchiveInfo {
        server_version: header.server_version,
        tool_version: header.tool_version,
        namespaces,
        sha256: format!("{:x}", input.hash.finalize()),
        size_bytes: input.bytes,
        gzip,
    })
}

fn read_archive(
    input: &mut impl Read,
    check: &impl Fn() -> Result<()>,
) -> Result<(ArchiveHeader, Vec<Namespace>)> {
    if word(input)? != Some(MAGIC) {
        return Err(INVALID.into());
    }
    let header: ArchiveHeader = read_typed(input)?;
    if header.version != "0.1" || header.server_version.len() > 48 || header.tool_version.len() > 48
    {
        return Err("지원하는 MongoDB 아카이브 버전을 확인하세요.".into());
    }
    let mut namespaces = Vec::new();
    let mut states = HashMap::new();
    let mut prelude_size = 0;
    loop {
        check()?;
        let size = word(input)?.ok_or(INVALID)?;
        if size == TERMINATOR {
            break;
        }
        prelude_size += size as usize;
        if namespaces.len() == MAX_NAMESPACES || prelude_size > MAX_PRELUDE {
            return Err(INVALID.into());
        }
        let body = bson_record(input, size)?;
        let metadata: CollectionMetadata =
            bson::deserialize_from_slice(&body).map_err(|_| INVALID)?;
        if metadata.collection.is_empty()
            || metadata.collection.len() > 256
            || metadata.db.len() > 63
            || metadata.collection.chars().any(char::is_control)
            || metadata.db.chars().any(char::is_control)
            || !matches!(
                metadata.kind.as_str(),
                "" | "collection" | "timeseries" | "view"
            )
        {
            return Err(INVALID.into());
        }
        let key = (metadata.db.clone(), metadata.collection.clone());
        if states.insert(key, RecordState::default()).is_some() {
            return Err(INVALID.into());
        }
        let kind = if metadata.kind.is_empty() {
            "collection".into()
        } else {
            metadata.kind
        };
        let restore_supported = kind == "collection"
            && ordinary_metadata(&metadata.metadata)
            && super::backup::check_database(&metadata.db).is_ok()
            && !metadata.collection.starts_with("system.")
            && !metadata.collection.contains(['\\', '*', '$']);
        namespaces.push(Namespace {
            database: metadata.db,
            collection: metadata.collection,
            kind,
            documents: 0,
            restore_supported,
        });
    }
    let aliases: HashMap<_, _> = namespaces
        .iter()
        .filter(|item| item.kind == "timeseries")
        .map(|item| {
            (
                (
                    item.database.as_str(),
                    format!("system.buckets.{}", item.collection),
                ),
                (item.database.clone(), item.collection.clone()),
            )
        })
        .collect();
    while let Some(size) = word(input)? {
        check()?;
        let bytes = bson_record(input, size)?;
        let header: RecordHeader = bson::deserialize_from_slice(&bytes).map_err(|_| INVALID)?;
        let key = (header.db, header.collection);
        let actual = aliases
            .get(&(key.0.as_str(), key.1.clone()))
            .unwrap_or(&key);
        let state = states.get_mut(actual).ok_or(INVALID)?;
        if state.ended {
            return Err(INVALID.into());
        }
        if header.end {
            if header.crc as u64 != state.crc || word(input)? != Some(TERMINATOR) {
                return Err(INVALID.into());
            }
            state.ended = true;
            continue;
        }
        loop {
            check()?;
            let size = word(input)?.ok_or(INVALID)?;
            if size == TERMINATOR {
                break;
            }
            let document = bson_record(input, size)?;
            // Keep raw BSON bytes so valid BSON data is counted without Extended JSON conversion.
            let raw = RawDocumentBuf::from_bytes(document).map_err(|_| INVALID)?;
            state.crc = crc64(state.crc, raw.as_bytes());
            state.count += 1;
        }
    }
    for namespace in &mut namespaces {
        let state = &states[&(namespace.database.clone(), namespace.collection.clone())];
        if namespace.kind != "view" && !state.ended {
            return Err(INVALID.into());
        }
        namespace.documents = state.count;
    }
    Ok((header, namespaces))
}

fn ordinary_metadata(metadata: &str) -> bool {
    let Ok(fields) = serde_json::from_str::<serde_json::Value>(metadata) else {
        return false;
    };
    fields.as_object().is_some_and(|fields| {
        fields.get("options").is_none_or(|options| {
            options.as_object().is_some_and(|options| {
                ["viewOn", "timeseries", "encryptedFields"]
                    .iter()
                    .all(|name| !options.contains_key(*name))
            })
        })
    })
}

fn read_typed<T: serde::de::DeserializeOwned>(input: &mut impl Read) -> Result<T> {
    let size = word(input)?.ok_or(INVALID)?;
    let bytes = bson_record(input, size)?;
    bson::deserialize_from_slice(&bytes).map_err(|_| INVALID.into())
}

fn word(input: &mut impl Read) -> Result<Option<u32>> {
    let mut bytes = [0; 4];
    match input.read(&mut bytes[..1]).map_err(|_| INVALID)? {
        0 => Ok(None),
        _ => {
            input.read_exact(&mut bytes[1..]).map_err(|_| INVALID)?;
            Ok(Some(u32::from_le_bytes(bytes)))
        }
    }
}

fn bson_record(input: &mut impl Read, size: u32) -> Result<Vec<u8>> {
    if !(5..=MAX_BSON).contains(&(size as usize)) {
        return Err(INVALID.into());
    }
    let mut bytes = vec![0; size as usize];
    bytes[..4].copy_from_slice(&size.to_le_bytes());
    input.read_exact(&mut bytes[4..]).map_err(|_| INVALID)?;
    if bytes.last() != Some(&0) {
        return Err(INVALID.into());
    }
    Ok(bytes)
}

struct HashedInput {
    source: File,
    hash: Sha256,
    bytes: u64,
}

impl Read for HashedInput {
    fn read(&mut self, destination: &mut [u8]) -> std::io::Result<usize> {
        let size = self.source.read(destination)?;
        self.hash.update(&destination[..size]);
        self.bytes += size as u64;
        Ok(size)
    }
}

const fn checksum_table() -> [u64; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < table.len() {
        let mut value = index as u64;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1)
                ^ if value & 1 == 1 {
                    0xc96c_5795_d787_0f42
                } else {
                    0
                };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

fn crc64(previous: u64, bytes: &[u8]) -> u64 {
    const TABLE: [u64; 256] = checksum_table();
    let mut value = !previous;
    for byte in bytes {
        value = TABLE[usize::from((value as u8) ^ byte)] ^ (value >> 8);
    }
    !value
}

#[cfg(test)]
mod tests {
    #[test]
    fn verifies_mongodump_crc64_in_separate_writes() {
        assert_eq!(
            super::crc64(super::crc64(0, b"1234"), b"56789"),
            0x995d_c9bb_df19_39fa
        );
    }
}
