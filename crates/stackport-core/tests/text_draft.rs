use stackport_core::{save_text_draft, TextLineEnding};
use std::{fs, path::Path};

fn save(path: &Path, text: &str) -> Result<usize, String> {
    save_text_draft(path.to_str().unwrap(), text, TextLineEnding::Crlf, true)
}

#[test]
fn preserves_bom_and_crlf_without_replacing_an_existing_file() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("초안.TXT");
    let expected = "\u{feff}첫 줄\r\n둘째 줄\r\n";
    assert_eq!(save(&path, "첫 줄\n둘째 줄\n").unwrap(), expected.len());
    assert!(save(&path, "다른 내용").unwrap_err().contains("같은 이름"));
    assert_eq!(fs::read(&path).unwrap(), expected.as_bytes());
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[test]
fn saves_empty_and_lf_drafts_as_written() {
    let folder = tempfile::tempdir().unwrap();
    let empty = folder.path().join("empty.txt");
    let lf = folder.path().join("lf.txt");
    for (path, text) in [(&empty, ""), (&lf, "one\ntwo\n")] {
        let count =
            save_text_draft(path.to_str().unwrap(), text, TextLineEnding::Lf, false).unwrap();
        assert_eq!(count, text.len());
        assert_eq!(fs::read(path).unwrap(), text.as_bytes());
    }
}

#[test]
fn rejects_invalid_destinations_and_measures_the_encoded_size() {
    let folder = tempfile::tempdir().unwrap();
    assert!(save(Path::new("relative.txt"), "draft").is_err());
    assert!(save(&folder.path().join("draft.exe"), "draft").is_err());
    if cfg!(windows) {
        assert!(save(&folder.path().join("CON.txt"), "draft").is_err());
        assert!(save(&folder.path().join("file:stream.txt"), "draft").is_err());
    }
    let expanded = "\n".repeat(8 * 1024 * 1024);
    assert!(save(&folder.path().join("large.txt"), &expanded)
        .unwrap_err()
        .contains("16 MiB"));
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);
}
