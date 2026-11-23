#![cfg(windows)]

use stackport_core::TerminalManager;
use std::time::{Duration, Instant};

fn wait_for(manager: &TerminalManager, id: &str, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut bytes = Vec::new();
    while Instant::now() < deadline {
        let output = manager.read(id).unwrap();
        bytes.extend(output.data);
        let text = String::from_utf8_lossy(&bytes);
        if text.contains(needle) {
            return text.into_owned();
        }
        if let Some(error) = output.output_error {
            panic!("{error}");
        }
    }
    panic!(
        "terminal did not produce {needle:?}: {}",
        String::from_utf8_lossy(&bytes)
    );
}

#[test]
fn interactive_cmd_reads_input_resizes_and_reports_exit() {
    let manager = TerminalManager::default();
    assert!(manager.open("invalid", 24, 80).is_err());
    assert!(manager.open("cmd", 0, 80).is_err());
    let terminal = manager.open("cmd", 24, 80).unwrap();
    assert!(terminal.process_id.is_some());
    manager.resize(&terminal.id, 32, 100).unwrap();
    assert!(manager.resize(&terminal.id, 0, 100).is_err());
    assert!(manager.write(&terminal.id, &vec![b'x'; 65537]).is_err());
    manager.write(&terminal.id, b"set /a 137*193\r\n").unwrap();
    wait_for(&manager, &terminal.id, "26441");
    manager.write(&terminal.id, b"exit /b 7\r\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let output = manager.read(&terminal.id).unwrap();
        if let Some(exit) = output.exit {
            assert_eq!(exit.code, Some(7));
            break;
        }
        assert!(Instant::now() < deadline, "shell did not exit");
    }
    manager.close(&terminal.id).unwrap();
    assert!(manager.read(&terminal.id).is_err());
}

#[test]
fn closing_a_session_terminates_its_spawned_process() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let manager = TerminalManager::default();
    let terminal = manager.open("cmd", 24, 100).unwrap();
    manager.write(&terminal.id, b"powershell.exe -NoLogo -NoProfile -Command \"Write-Output ('STACKPORT_PID_' + $PID); Start-Sleep -Seconds 60\"\r\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut output = Vec::new();
    let pid = loop {
        output.extend(manager.read(&terminal.id).unwrap().data);
        let text = String::from_utf8_lossy(&output);
        if let Some(pid) = text
            .split("STACKPORT_PID_")
            .filter_map(|part| {
                let value: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
                if value.len() < part.len() {
                    value.parse::<u32>().ok()
                } else {
                    None
                }
            })
            .next()
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "child process ID not found in terminal output: {text}"
        );
    };
    // SAFETY: OpenProcess returns either a null handle or an owned process handle.
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!raw.is_null(), "child process must still be running");
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    manager.close(&terminal.id).unwrap();
    // SAFETY: the owned handle is valid until this function returns.
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
        WAIT_OBJECT_0
    );
}

#[test]
fn closing_a_terminal_with_unread_output_does_not_hang() {
    let manager = TerminalManager::default();
    let terminal = manager.open("cmd", 24, 80).unwrap();
    manager.write(&terminal.id, b"powershell.exe -NoLogo -NoProfile -Command \"[Console]::Write(('x' * 2000000)); Start-Sleep -Seconds 60\"\r\n").unwrap();
    std::thread::sleep(Duration::from_secs(2));
    let start = Instant::now();
    manager.close(&terminal.id).unwrap();
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[test]
fn closing_a_terminal_with_blocked_input_does_not_hang() {
    use std::sync::{mpsc, Arc};
    let manager = Arc::new(TerminalManager::default());
    let terminal = manager.open("cmd", 24, 80).unwrap();
    manager.write(&terminal.id, b"powershell.exe -NoLogo -NoProfile -Command \"Write-Output ('STACKPORT_' + 'SLEEP_READY'); Start-Sleep -Seconds 60\"\r\n").unwrap();
    wait_for(&manager, &terminal.id, "STACKPORT_SLEEP_READY");
    let writer_manager = Arc::clone(&manager);
    let writer_id = terminal.id.clone();
    let writer = std::thread::spawn(move || {
        let input = vec![b'x'; 65536];
        for _ in 0..256 {
            if writer_manager.write(&writer_id, &input).is_err() {
                break;
            }
        }
    });
    std::thread::sleep(Duration::from_millis(300));
    let close_manager = Arc::clone(&manager);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(close_manager.close(&terminal.id));
    });
    assert!(receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("terminal close blocked on input")
        .is_ok());
    writer.join().unwrap();
}
