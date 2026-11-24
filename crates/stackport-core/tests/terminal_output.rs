use stackport_core::{save_terminal_output, TerminalOutputFormat};

#[test]
fn writes_exact_utf8_and_leaves_existing_files_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let txt = dir.path().join("output.txt");
    let ansi = dir.path().join("output.ansi");
    let text = "한글 출력\r\n";
    let styled = "\u{1b}[38;2;123;45;67m한글 출력\u{1b}[0m\r\n";
    assert_eq!(
        save_terminal_output(txt.to_str().unwrap(), TerminalOutputFormat::Txt, text).unwrap(),
        text.len()
    );
    assert_eq!(
        save_terminal_output(ansi.to_str().unwrap(), TerminalOutputFormat::Ansi, styled).unwrap(),
        styled.len()
    );
    assert!(save_terminal_output(
        txt.to_str().unwrap(),
        TerminalOutputFormat::Txt,
        "replacement"
    )
    .is_err());
    assert_eq!(std::fs::read(txt).unwrap(), text.as_bytes());
    assert_eq!(std::fs::read(ansi).unwrap(), styled.as_bytes());
    assert_eq!(dir.path().read_dir().unwrap().count(), 2);
}

#[test]
fn rejects_unsupported_paths_and_large_or_empty_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("output.txt");
    let wrong = dir.path().join("output.exe");
    assert!(
        save_terminal_output(wrong.to_str().unwrap(), TerminalOutputFormat::Txt, "sample").is_err()
    );
    assert!(save_terminal_output("relative.txt", TerminalOutputFormat::Txt, "sample").is_err());
    assert!(save_terminal_output(target.to_str().unwrap(), TerminalOutputFormat::Txt, "").is_err());
    let large = "x".repeat(16 * 1024 * 1024 + 1);
    assert!(
        save_terminal_output(target.to_str().unwrap(), TerminalOutputFormat::Txt, &large).is_err()
    );
    assert_eq!(dir.path().read_dir().unwrap().count(), 0);
}
