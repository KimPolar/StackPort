#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{env, fs, path::PathBuf};

fn main() {
    let mut args = env::args_os().skip(1);
    let draft = PathBuf::from(args.next().expect("draft file argument"));
    assert!(args.next().is_none());
    assert_eq!(
        fs::read(&draft).unwrap(),
        b"\xef\xbb\xbfalpha\r\neditor input\r\n"
    );
    let trace = env::current_exe().unwrap().with_extension("trace");
    fs::write(trace, draft.to_str().unwrap()).unwrap();
    let staged = draft.with_extension("new");
    fs::write(&staged, b"\xef\xbb\xbfalpha\r\nsaved\r\n").unwrap();
    fs::rename(staged, draft).unwrap();
}
