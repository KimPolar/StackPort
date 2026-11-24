//! Local endpoint snapshots from Windows IP Helper.

use super::Result;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PortEndpoint {
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Serialize)]
pub struct LocalPort {
    pub transport: &'static str,
    pub family: &'static str,
    pub state: &'static str,
    pub local: PortEndpoint,
    pub remote: Option<PortEndpoint>,
    pub pid: u32,
    pub process: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PortSnapshot {
    pub ports: Vec<LocalPort>,
    pub unavailable: Vec<String>,
}

#[cfg(windows)]
pub fn local_ports() -> Result<PortSnapshot> {
    windows::snapshot()
}

#[cfg(not(windows))]
pub fn local_ports() -> Result<PortSnapshot> {
    Err("로컬 포트 목록은 현재 Windows에서 지원합니다.".into())
}

#[cfg(windows)]
mod windows {
    use super::{LocalPort, PortEndpoint, PortSnapshot, Result};
    use std::{
        collections::HashMap,
        ffi::c_void,
        io,
        mem::{offset_of, size_of},
        net::{Ipv4Addr, Ipv6Addr},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID,
            MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
            MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID, MIB_UDPROW_OWNER_PID,
            MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
        },
        Networking::WinSock::{AF_INET, AF_INET6},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    const MAX_TABLE_BYTES: usize = 16 * 1024 * 1024;

    pub(super) fn snapshot() -> Result<PortSnapshot> {
        let mut snapshot = PortSnapshot {
            ports: Vec::new(),
            unavailable: Vec::new(),
        };
        let tables = [
            ("TCP", "IPv4", tcp4()),
            ("TCP", "IPv6", tcp6()),
            ("UDP", "IPv4", udp4()),
            ("UDP", "IPv6", udp6()),
        ];
        for (transport, family, table) in tables {
            match table {
                Ok(ports) => snapshot.ports.extend(ports),
                Err(error) => snapshot
                    .unavailable
                    .push(format!("{transport} {family}: {error}")),
            }
        }
        if snapshot.unavailable.len() == 4 {
            return Err(snapshot.unavailable.join("; "));
        }
        let mut processes = HashMap::new();
        let mut name_buffer = vec![0u16; 32768];
        for socket in &mut snapshot.ports {
            socket.process = processes
                .entry(socket.pid)
                .or_insert_with(|| process_name(socket.pid, &mut name_buffer))
                .clone();
        }
        snapshot.ports.sort_unstable_by(|a, b| {
            (
                a.local.port,
                a.transport,
                a.family,
                &a.local.address,
                a.pid,
                a.state,
            )
                .cmp(&(
                    b.local.port,
                    b.transport,
                    b.family,
                    &b.local.address,
                    b.pid,
                    b.state,
                ))
        });
        Ok(snapshot)
    }

    fn tcp4() -> Result<Vec<LocalPort>> {
        let (buffer, length) = fetch_table(|data, size| unsafe {
            GetExtendedTcpTable(
                data,
                size,
                0,
                u32::from(AF_INET),
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        })?;
        // The API selects the matching C row structure; all fields are integers.
        let rows = unsafe {
            decode_rows::<MIB_TCPROW_OWNER_PID>(
                &buffer,
                length,
                offset_of!(MIB_TCPTABLE_OWNER_PID, table),
            )?
        };
        Ok(rows
            .iter()
            .map(|row| {
                let state = tcp_state(row.dwState);
                LocalPort {
                    transport: "TCP",
                    family: "IPv4",
                    state,
                    local: ipv4(row.dwLocalAddr, row.dwLocalPort),
                    remote: (state != "LISTEN").then(|| ipv4(row.dwRemoteAddr, row.dwRemotePort)),
                    pid: row.dwOwningPid,
                    process: None,
                }
            })
            .collect())
    }

    fn tcp6() -> Result<Vec<LocalPort>> {
        let (buffer, length) = fetch_table(|data, size| unsafe {
            GetExtendedTcpTable(
                data,
                size,
                0,
                u32::from(AF_INET6),
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        })?;
        // The IPv6 owner table contains these fixed-layout integer rows.
        let rows = unsafe {
            decode_rows::<MIB_TCP6ROW_OWNER_PID>(
                &buffer,
                length,
                offset_of!(MIB_TCP6TABLE_OWNER_PID, table),
            )?
        };
        Ok(rows
            .iter()
            .map(|row| {
                let state = tcp_state(row.dwState);
                LocalPort {
                    transport: "TCP",
                    family: "IPv6",
                    state,
                    local: ipv6(row.ucLocalAddr, row.dwLocalScopeId, row.dwLocalPort),
                    remote: (state != "LISTEN")
                        .then(|| ipv6(row.ucRemoteAddr, row.dwRemoteScopeId, row.dwRemotePort)),
                    pid: row.dwOwningPid,
                    process: None,
                }
            })
            .collect())
    }

    fn udp4() -> Result<Vec<LocalPort>> {
        let (buffer, length) = fetch_table(|data, size| unsafe {
            GetExtendedUdpTable(data, size, 0, u32::from(AF_INET), UDP_TABLE_OWNER_PID, 0)
        })?;
        // UDP returns local binds and owner IDs in fixed-layout integer rows.
        let rows = unsafe {
            decode_rows::<MIB_UDPROW_OWNER_PID>(
                &buffer,
                length,
                offset_of!(MIB_UDPTABLE_OWNER_PID, table),
            )?
        };
        Ok(rows
            .iter()
            .map(|row| LocalPort {
                transport: "UDP",
                family: "IPv4",
                state: "BOUND",
                local: ipv4(row.dwLocalAddr, row.dwLocalPort),
                remote: None,
                pid: row.dwOwningPid,
                process: None,
            })
            .collect())
    }

    fn udp6() -> Result<Vec<LocalPort>> {
        let (buffer, length) = fetch_table(|data, size| unsafe {
            GetExtendedUdpTable(data, size, 0, u32::from(AF_INET6), UDP_TABLE_OWNER_PID, 0)
        })?;
        // The IPv6 UDP owner row likewise contains only integer fields.
        let rows = unsafe {
            decode_rows::<MIB_UDP6ROW_OWNER_PID>(
                &buffer,
                length,
                offset_of!(MIB_UDP6TABLE_OWNER_PID, table),
            )?
        };
        Ok(rows
            .iter()
            .map(|row| LocalPort {
                transport: "UDP",
                family: "IPv6",
                state: "BOUND",
                local: ipv6(row.ucLocalAddr, row.dwLocalScopeId, row.dwLocalPort),
                remote: None,
                pid: row.dwOwningPid,
                process: None,
            })
            .collect())
    }

    fn fetch_table(
        mut call: impl FnMut(*mut c_void, &mut u32) -> u32,
    ) -> Result<(Vec<u64>, usize)> {
        let mut needed = 0;
        let status = call(null_mut(), &mut needed);
        if status != ERROR_INSUFFICIENT_BUFFER {
            return Err(windows_error(status));
        }
        for _ in 0..4 {
            if needed as usize > MAX_TABLE_BYTES || needed < 4 {
                return Err("포트 목록의 크기가 지원 범위를 벗어났습니다.".into());
            }
            // u64 storage keeps the Win32 table suitably aligned.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
            needed = (buffer.len() * size_of::<u64>()) as u32;
            match call(buffer.as_mut_ptr().cast(), &mut needed) {
                NO_ERROR => return Ok((buffer, needed as usize)),
                ERROR_INSUFFICIENT_BUFFER => {}
                error => return Err(windows_error(error)),
            }
        }
        Err("포트 목록이 계속 바뀌었습니다. 다시 조회하세요.".into())
    }

    /// The caller must supply the corresponding IP Helper row type and offset.
    /// The row must be valid for any bytes (these C structs contain integers).
    unsafe fn decode_rows<Row>(buffer: &[u64], length: usize, offset: usize) -> Result<&[Row]> {
        if length < offset || length < size_of::<u32>() || length > std::mem::size_of_val(buffer) {
            return Err("Windows에서 잘못된 포트 목록 길이를 반환했습니다.".into());
        }
        let header = buffer.as_ptr().cast::<u32>();
        let count = unsafe { *header } as usize;
        if count > (length - offset) / size_of::<Row>() {
            return Err("Windows에서 잘못된 포트 목록 항목 수를 반환했습니다.".into());
        }
        let rows = unsafe { buffer.as_ptr().cast::<u8>().add(offset).cast::<Row>() };
        if !rows.is_aligned() {
            return Err("Windows 포트 목록의 정렬이 올바르지 않습니다.".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(rows, count) })
    }

    fn ipv4(address: u32, port: u32) -> PortEndpoint {
        PortEndpoint {
            address: Ipv4Addr::from(address.to_ne_bytes()).to_string(),
            port: u16::from_be(port as u16),
        }
    }

    fn ipv6(address: [u8; 16], scope: u32, port: u32) -> PortEndpoint {
        let mut address = Ipv6Addr::from(address).to_string();
        let scope = u32::from_be(scope);
        if scope != 0 {
            address.push_str(&format!("%{scope}"));
        }
        PortEndpoint {
            address,
            port: u16::from_be(port as u16),
        }
    }

    fn process_name(pid: u32, buffer: &mut [u16]) -> Option<String> {
        if pid == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let mut length = buffer.len() as u32;
        let result =
            unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe {
            CloseHandle(process);
        }
        if result == 0 || length as usize > buffer.len() {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }

    fn tcp_state(value: u32) -> &'static str {
        match value {
            1 => "CLOSED",
            2 => "LISTEN",
            3 => "SYN_SENT",
            4 => "SYN_RECEIVED",
            5 => "ESTABLISHED",
            6 => "FIN_WAIT_1",
            7 => "FIN_WAIT_2",
            8 => "CLOSE_WAIT",
            9 => "CLOSING",
            10 => "LAST_ACK",
            11 => "TIME_WAIT",
            12 => "DELETE_TCB",
            _ => "UNKNOWN",
        }
    }

    fn windows_error(code: u32) -> String {
        format!(
            "Windows 오류 {code}: {}",
            io::Error::from_raw_os_error(code as i32)
        )
    }
}
