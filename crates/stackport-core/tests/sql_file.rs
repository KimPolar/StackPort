use stackport_core::{open_sql_file, save_sql_file, SqlDocument, TextLineEnding};
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
    };
    assert!(save_sql_file(
        folder.path().join("large.sql").to_str().unwrap(),
        &oversized
    )
    .unwrap_err()
    .contains("1 MiB"));
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}
