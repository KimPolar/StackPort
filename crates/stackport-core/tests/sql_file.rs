use stackport_core::{
    open_sql_file, open_sql_file_with_encoding, save_sql_definition, save_sql_file, SqlDocument,
    SqlFileEncoding, TextLineEnding,
};
use std::fs;

#[test]
fn opens_utf8_sql_and_creates_an_independent_copy() {
    let folder = tempfile::tempdir().unwrap();
    let source = folder.path().join("쿼리.SQL");
    let copy = folder.path().join("새 쿼리.sql");
    let original = "\u{feff}SELECT '한글';\r\n-- comment\r\n";
    let source_path = source.to_str().unwrap();
    let copy_path = copy.to_str().unwrap();
    fs::write(&source, original).unwrap();
    let mut document = open_sql_file(source_path).unwrap();
    assert!(document.bom);
    assert_eq!(document.encoding, SqlFileEncoding::Utf8);
    assert!(matches!(document.line_ending, TextLineEnding::Crlf));
    assert_eq!(document.text, "SELECT '한글';\n-- comment\n");
    document.text.push_str("SELECT 2;\n");
    assert!(save_sql_file(source_path, &document)
        .unwrap_err()
        .contains("같은 이름"));
    let expected = format!("{original}SELECT 2;\r\n");
    assert_eq!(save_sql_file(copy_path, &document).unwrap(), expected.len());
    assert_eq!(fs::read_to_string(source).unwrap(), original);
    assert_eq!(fs::read_to_string(copy).unwrap(), expected);
}

#[test]
fn saves_server_definition_byte_for_byte_and_keeps_existing_files() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("정의.sql");
    let destination = path.to_str().unwrap();
    let text = "CREATE VIEW [보고서] AS\r\nSELECT '첫 줄\r\n둘째 줄\n셋째 줄';\n";
    assert_eq!(save_sql_definition(destination, text).unwrap(), text.len());
    assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
    assert!(save_sql_definition(destination, "SELECT 2;")
        .unwrap_err()
        .contains("같은 이름"));
    assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
    let invalid = folder.path().join("invalid.sql");
    let invalid_path = invalid.to_str().unwrap();
    assert!(save_sql_definition(invalid_path, "SELECT '\0';").is_err());
    assert!(save_sql_definition(invalid_path, &"한".repeat(400_000))
        .unwrap_err()
        .contains("1 MiB"));
    assert!(!invalid.exists());
}

#[test]
fn rejects_unsupported_or_oversized_input() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("query.sql");
    let document_path = path.to_str().unwrap();
    for input in [
        b"select 1;\r\nselect 2;\n".as_slice(),
        b"select \0",
        b"\xff",
    ] {
        fs::write(&path, input).unwrap();
        assert!(open_sql_file(document_path).is_err());
    }
    fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(open_sql_file(document_path)
        .err()
        .unwrap()
        .contains("1 MiB"));
    assert!(open_sql_file("query.sql").is_err());
    let oversized = SqlDocument {
        text: "\n".repeat(512 * 1024),
        bom: true,
        line_ending: TextLineEnding::Crlf,
        encoding: SqlFileEncoding::Utf8,
    };
    assert!(save_sql_file(
        folder.path().join("large.sql").to_str().unwrap(),
        &oversized
    )
    .unwrap_err()
    .contains("1 MiB"));
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[test]
fn handles_utf16_bom_endianness_and_strict_decoding() {
    let folder = tempfile::tempdir().unwrap();
    for (name, encoding, bom, convert) in [
        (
            "le",
            SqlFileEncoding::Utf16Le,
            [0xff, 0xfe],
            u16::to_le_bytes as fn(u16) -> [u8; 2],
        ),
        (
            "be",
            SqlFileEncoding::Utf16Be,
            [0xfe, 0xff],
            u16::to_be_bytes,
        ),
    ] {
        let source = folder.path().join(format!("{name}.sql"));
        let copy = folder.path().join(format!("{name}-copy.sql"));
        let source = source.to_str().unwrap();
        let copy = copy.to_str().unwrap();
        let raw: Vec<_> = "SELECT '한😀';\r\n"
            .encode_utf16()
            .flat_map(convert)
            .collect();
        let bytes: Vec<_> = bom.into_iter().chain(raw.iter().copied()).collect();
        fs::write(source, &bytes).unwrap();
        let document = open_sql_file(source).unwrap();
        assert_eq!(document.text, "SELECT '한😀';\n");
        assert_eq!(document.encoding, encoding);
        assert!(document.bom);
        assert!(matches!(document.line_ending, TextLineEnding::Crlf));
        save_sql_file(copy, &document).unwrap();
        assert_eq!(fs::read(copy).unwrap(), bytes);
        assert!(
            open_sql_file_with_encoding(source, Some(SqlFileEncoding::Utf8))
                .err()
                .unwrap()
                .contains("BOM")
        );

        fs::write(source, &raw).unwrap();
        assert!(open_sql_file(source).is_err());
        assert!(
            !open_sql_file_with_encoding(source, Some(encoding))
                .unwrap()
                .bom
        );
        for malformed in [vec![b'a'], convert(0xd800).to_vec()] {
            fs::write(source, malformed).unwrap();
            assert!(open_sql_file_with_encoding(source, Some(encoding)).is_err());
        }
    }
}

#[test]
fn round_trips_legacy_encodings_and_rejects_lossy_saves() {
    let folder = tempfile::tempdir().unwrap();
    for (name, encoding, encoded, decoded) in [
        (
            "korean",
            SqlFileEncoding::EucKr,
            b"SELECT '\xc7\xd1\xb1\xdb\xc6\x52';\n".as_slice(),
            "SELECT '한글힣';\n",
        ),
        (
            "western",
            SqlFileEncoding::Windows1252,
            b"SELECT 'caf\xe9 \x80';\n".as_slice(),
            "SELECT 'café €';\n",
        ),
    ] {
        let path = |suffix| folder.path().join(format!("{name}-{suffix}.sql"));
        fs::write(path("source"), encoded).unwrap();
        assert!(open_sql_file(path("source").to_str().unwrap()).is_err());
        let mut document =
            open_sql_file_with_encoding(path("source").to_str().unwrap(), Some(encoding)).unwrap();
        assert_eq!(document.text, decoded);
        assert_eq!(document.encoding, encoding);
        assert!(!document.bom);
        save_sql_file(path("copy").to_str().unwrap(), &document).unwrap();
        assert_eq!(fs::read(path("copy")).unwrap(), encoded);
        document.text.push_str("-- 😀\n");
        assert!(save_sql_file(path("unicode").to_str().unwrap(), &document)
            .unwrap_err()
            .contains("표현할 수 없는 문자"));
        assert!(!path("unicode").exists());
        document.encoding = SqlFileEncoding::Utf8;
        save_sql_file(path("unicode").to_str().unwrap(), &document).unwrap();
        assert_eq!(
            fs::read_to_string(path("unicode")).unwrap(),
            format!("{decoded}-- 😀\n")
        );
    }
}

#[test]
fn applies_the_file_limit_to_encoded_bytes_and_accepts_older_payloads() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("limit.sql");
    let destination = path.to_str().unwrap();
    let mut document: SqlDocument = serde_json::from_value(serde_json::json!({
        "text": "", "line_ending": "lf", "bom": false
    }))
    .unwrap();
    assert_eq!(document.encoding, SqlFileEncoding::Utf8);
    document.encoding = SqlFileEncoding::Windows1252;
    document.text = "€".repeat(1024 * 1024);
    assert_eq!(save_sql_file(destination, &document).unwrap(), 1024 * 1024);
    assert_eq!(
        open_sql_file_with_encoding(destination, Some(document.encoding))
            .unwrap()
            .text,
        document.text
    );
    fs::remove_file(&path).unwrap();
    document.text.push('a');
    assert!(save_sql_file(destination, &document)
        .unwrap_err()
        .contains("1 MiB"));
    assert!(!path.exists());

    document.encoding = SqlFileEncoding::Utf16Le;
    document.bom = true;
    document.line_ending = TextLineEnding::Crlf;
    document.text = "\n".repeat(256 * 1024);
    assert!(save_sql_file(destination, &document)
        .unwrap_err()
        .contains("1 MiB"));
    assert!(!path.exists());
}
