use super::{
    begin, disk_path, operation_id, read_set, Active, BackupOutcome, BackupSet, Failure, Manager,
    Phase, SqlClient, VerifyInput, Work, OPEN, PREVIEW_TTL, STATE,
};
use crate::sql_server::{catalog::ident, connect, profiles::valid_identifier, TIMEOUT};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tiberius::{numeric::Numeric, ToSql};
use tokio::time::{timeout, Instant};
use uuid::Uuid;

const REVIEW: &str = "SQL Server 복원 미리보기를 다시 확인하세요.";
const PERMISSION: &str =
    "SQL Server 복원에는 CREATE DATABASE, ALTER ANY DATABASE, CONNECT ANY DATABASE 권한이 필요합니다.";
const COLLISION: &str = "서버에 같은 이름의 대상 DB가 있습니다. 다른 이름을 지정하세요.";
const FILE_COLLISION: &str = "서버에 이미 같은 경로의 복원 파일이나 폴더가 있습니다.";
const MEDIA_CHANGED: &str = "검토한 백업 세트 또는 파일 목록이 바뀌었습니다. 다시 검토하세요.";
const FILE_LIMIT: usize = 1000;

const SERVER: &str = "SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')),
    CONVERT(int, SERVERPROPERTY('EngineEdition')),
    CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')),
    CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath')),
    CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE DATABASE') = 1
        OR HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') = 1
        OR IS_SRVROLEMEMBER('dbcreator') = 1 THEN 1 ELSE 0 END),
    CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY DATABASE') = 1
        OR IS_SRVROLEMEMBER('dbcreator') = 1 THEN 1 ELSE 0 END),
    CONVERT(bit, HAS_PERMS_BY_NAME(NULL, NULL, 'CONNECT ANY DATABASE')),
    DB_ID(@P1), DB_ID(@P2)";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreOptions {
    path: String,
    position: i32,
    database: String,
    data_directory: Option<String>,
    log_directory: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RestorePreview {
    token: String,
    path: String,
    database: String,
    staging_database: String,
    set: BackupSet,
    files: Vec<MoveFile>,
    expires_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct ArchiveFile {
    logical_name: String,
    original_path: String,
    kind: String,
    size_bytes: String,
}

#[derive(Clone, Serialize)]
struct MoveFile {
    source: ArchiveFile,
    destination: String,
}

pub(super) struct Plan {
    preview: RestorePreview,
    expires: Instant,
}

#[derive(Serialize)]
pub(super) struct RestoreResult {
    database: String,
    staging_database: Option<String>,
}

impl Plan {
    pub(super) fn path(&self) -> &str {
        &self.preview.path
    }

    pub(super) fn result(&self, writing: bool) -> RestoreResult {
        RestoreResult {
            database: self.preview.database.clone(),
            staging_database: writing.then(|| self.preview.staging_database.clone()),
        }
    }
}

struct Server {
    major: i32,
    data_directory: Option<String>,
    log_directory: Option<String>,
}

impl Manager {
    pub async fn preview_restore(
        &self,
        id: &str,
        options: RestoreOptions,
    ) -> Result<RestorePreview> {
        let options = validate_options(options)?;
        let session = self.session(id)?;
        let auth = session.operation_auth()?.ok_or(OPEN)?;
        let preview = timeout(TIMEOUT, async {
            let mut client = connect(&session.profile.settings, auth).await?;
            prepare(&mut client, options).await.map_err(preview_error)
        })
        .await
        .map_err(|_| {
            "SQL Server 복원 미리보기가 서버 응답을 기다리는 중 시간이 초과되었습니다."
        })??;
        let mut state = session.backup.lock().map_err(|_| STATE)?;
        if session.closed.load(Ordering::Acquire) {
            return Err(OPEN.into());
        }
        if state.active.is_some() {
            return Err("이 연결에서 백업 또는 복원 작업을 실행 중입니다.".into());
        }
        state.restore = Some(Plan {
            preview: preview.clone(),
            expires: Instant::now() + PREVIEW_TTL,
        });
        Ok(preview)
    }

    pub fn discard_restore(&self, id: &str, token: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut state = session.backup.lock().map_err(|_| STATE)?;
        if state
            .restore
            .as_ref()
            .is_some_and(|plan| plan.preview.token == token)
        {
            state.restore.take();
        }
        Ok(())
    }

    pub async fn run_restore(
        &self,
        id: &str,
        request_id: &str,
        token: &str,
        database: &str,
        approved: bool,
        confirmation: &str,
    ) -> Result<BackupOutcome> {
        let request_id = operation_id(request_id)?;
        let session = self.session(id)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if !approved {
            return Err("복원할 백업 세트와 새 DB의 파일 위치를 확인하세요.".into());
        }
        let (active, plan) = {
            let mut state = session.backup.lock().map_err(|_| STATE)?;
            let plan = state
                .restore
                .as_ref()
                .filter(|plan| plan.preview.token == token && plan.expires > Instant::now())
                .ok_or(REVIEW)?;
            if plan.preview.database != database {
                return Err("미리보기에 표시된 새 DB 이름을 입력하세요.".into());
            }
            let active = begin(&session, &mut state, request_id)?;
            (active, state.restore.take().ok_or(REVIEW)?)
        };
        self.run_backup_work(&session, &active, Work::Restore(plan))
            .await
    }
}

fn validate_options(mut options: RestoreOptions) -> Result<RestoreOptions> {
    options.path = options.path.trim().to_owned();
    disk_path(&options.path, false)?;
    if !(1..=32767).contains(&options.position) {
        return Err("백업 세트 위치를 확인하세요.".into());
    }
    options.database = options.database.trim().to_owned();
    let name = &options.database;
    if !valid_identifier(name)
        || ["master", "model", "msdb", "tempdb", "mssqlsystemresource"]
            .iter()
            .any(|system| name.eq_ignore_ascii_case(system))
    {
        return Err("복원할 새 사용자 데이터베이스 이름을 확인하세요.".into());
    }
    for directory in [&mut options.data_directory, &mut options.log_directory] {
        *directory = directory
            .take()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(value) = directory {
            disk_path(value, true)?;
        }
    }
    Ok(options)
}

async fn inspect_server(
    client: &mut SqlClient,
    target: &str,
    staging: &str,
) -> std::result::Result<Server, Failure> {
    client
        .simple_query("USE [master]")
        .await?
        .into_results()
        .await?;
    let row = client
        .query(SERVER, &[&target, &staging])
        .await?
        .into_row()
        .await?
        .ok_or(Failure::Input(
            "SQL Server 복원 권한과 기본 폴더를 확인할 수 없습니다.",
        ))?;
    let major = row.try_get::<i32, _>(0)?.unwrap_or(0);
    if major < 14 || !matches!(row.try_get::<i32, _>(1)?, Some(2..=4)) {
        return Err(Failure::Input(
            "SQL Server 2017 이상의 서버 로컬 디스크 복원을 사용하세요.",
        ));
    }
    if row.try_get::<bool, _>(4)? != Some(true)
        || row.try_get::<bool, _>(5)? != Some(true)
        || row.try_get::<bool, _>(6)? != Some(true)
    {
        return Err(Failure::Input(PERMISSION));
    }
    if row.try_get::<i32, _>(7)?.is_some() {
        return Err(Failure::Input(COLLISION));
    }
    if row.try_get::<i32, _>(8)?.is_some() {
        return Err(Failure::Input(
            "임시 DB 이름이 이미 사용 중입니다. 복원을 다시 준비하세요.",
        ));
    }
    Ok(Server {
        major,
        data_directory: row.try_get::<&str, _>(2)?.map(str::to_owned),
        log_directory: row.try_get::<&str, _>(3)?.map(str::to_owned),
    })
}

async fn prepare(
    client: &mut SqlClient,
    options: RestoreOptions,
) -> std::result::Result<RestorePreview, Failure> {
    let token = Uuid::new_v4();
    let stage = format!("stackport_restore_{}", Uuid::new_v4().simple());
    let server = inspect_server(client, &options.database, &stage).await?;
    let input = VerifyInput {
        path: options.path,
        position: options.position,
        expected_name: None,
    };
    let set = read_set(client, &input).await?;
    check_set(&set, &server, &stage)?;
    let files = read_files(client, &input.path, input.position).await?;
    let data = options.data_directory.or(server.data_directory);
    let log = options.log_directory.or(server.log_directory);
    let files = files
        .into_iter()
        .enumerate()
        .map(|(index, source)| {
            let folder = if source.kind == "L" { &log } else { &data };
            let folder = folder.as_deref().ok_or(Failure::Input(
                "서버의 데이터 파일 폴더와 로그 파일 폴더를 지정하세요.",
            ))?;
            let separator = disk_path(folder, true).map_err(|_| Failure::Input(super::DISK))?;
            let extension = match source.kind.as_str() {
                "L" => ".ldf",
                "D" if index == 0 => ".mdf",
                "D" => ".ndf",
                _ => "",
            };
            let destination = format!(
                "{}{separator}{stage}_{index}{extension}",
                folder.trim_end_matches(separator)
            );
            disk_path(&destination, false).map_err(|_| Failure::Input(super::DISK))?;
            Ok(MoveFile {
                source,
                destination,
            })
        })
        .collect::<std::result::Result<Vec<_>, Failure>>()?;
    check_paths(client, &files).await?;
    Ok(RestorePreview {
        token: token.to_string(),
        path: input.path,
        database: options.database,
        staging_database: stage,
        set,
        files,
        expires_seconds: PREVIEW_TTL.as_secs(),
    })
}

fn check_set(set: &BackupSet, server: &Server, stage: &str) -> std::result::Result<(), Failure> {
    if set.backup_type != 1 || set.snapshot {
        return Err(Failure::Input(
            "새 DB 복원에 일반 전체 데이터베이스 백업 세트를 선택하세요.",
        ));
    }
    if set.source_major > server.major {
        return Err(Failure::Input(
            "이 백업은 대상보다 새 SQL Server 버전에서 생성되었습니다.",
        ));
    }
    if set.database.eq_ignore_ascii_case(stage) {
        return Err(Failure::Input(
            "임시 DB 이름이 백업 원본과 같습니다. 복원을 다시 준비하세요.",
        ));
    }
    Ok(())
}

async fn read_files(
    client: &mut SqlClient,
    path: &str,
    position: i32,
) -> std::result::Result<Vec<ArchiveFile>, Failure> {
    let rows = client
        .query(
            "RESTORE FILELISTONLY FROM DISK = @P1 WITH FILE = @P2",
            &[&path, &position],
        )
        .await?
        .into_first_result()
        .await?;
    if rows.is_empty() || rows.len() > FILE_LIMIT {
        return Err(Failure::Input("백업 세트의 파일 목록이 비어 있거나 이 복원에서 처리할 수 있는 파일 수를 초과했습니다."));
    }
    let mut files = Vec::with_capacity(rows.len());
    for row in rows {
        let malformed =
            || Failure::Input("SQL Server가 복원 파일의 필수 정보를 반환하지 않았습니다.");
        let get = |name| row.try_get::<&str, _>(name)?.ok_or_else(malformed);
        let kind = get("Type")?;
        if row.try_get::<bool, _>("IsPresent")? != Some(true)
            || !matches!(kind, "D" | "L" | "F" | "S")
        {
            return Err(Failure::Input(
                "백업 세트에 복원할 수 없는 유형이 있거나 백업에 포함되지 않은 파일이 있습니다.",
            ));
        }
        let size = row
            .try_get::<i64, _>("Size")
            .map(|size| size.map(i128::from))
            .or_else(|_| {
                row.try_get::<Numeric, _>("Size")
                    .map(|size| size.filter(|size| size.scale() == 0).map(Numeric::value))
            })?
            .filter(|size| *size >= 0)
            .ok_or_else(malformed)?;
        files.push(ArchiveFile {
            logical_name: get("LogicalName")?.to_owned(),
            original_path: get("PhysicalName")?.to_owned(),
            kind: kind.to_owned(),
            size_bytes: size.to_string(),
        });
    }
    Ok(files)
}

async fn check_paths(
    client: &mut SqlClient,
    files: &[MoveFile],
) -> std::result::Result<(), Failure> {
    let rows = (1..=files.len())
        .map(|index| format!("(@P{index})"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT CONVERT(bit, MAX(item.file_exists | item.file_is_a_directory)),
        CONVERT(bit, MIN(COALESCE(item.parent_directory_exists, 0)))
        FROM (VALUES {rows}) AS wanted(path)
        OUTER APPLY sys.dm_os_file_exists(wanted.path) AS item"
    );
    let params: Vec<&dyn ToSql> = files
        .iter()
        .map(|file| &file.destination as &dyn ToSql)
        .collect();
    let row = client
        .query(sql, &params)
        .await?
        .into_row()
        .await?
        .ok_or(Failure::Input(
            "SQL Server에서 복원 파일 경로를 확인할 수 없습니다.",
        ))?;
    if row.try_get::<bool, _>(0)? == Some(true) {
        return Err(Failure::Input(FILE_COLLISION));
    }
    if row.try_get::<bool, _>(1)? != Some(true) {
        return Err(Failure::Input(
            "SQL Server가 복원 폴더를 찾을 수 없습니다. 서버 경로와 서비스 계정 권한을 확인하세요.",
        ));
    }
    Ok(())
}

pub(super) async fn execute(
    client: &mut SqlClient,
    active: &Active,
    plan: &Plan,
) -> std::result::Result<BackupSet, Failure> {
    let preview = &plan.preview;
    let staging = &preview.staging_database;
    let server = inspect_server(client, &preview.database, staging).await?;
    let input = VerifyInput {
        path: preview.path.clone(),
        position: preview.set.position,
        expected_name: None,
    };
    active.phase.store(Phase::Reading as u8, Ordering::Release);
    let current = read_set(client, &input).await?;
    check_set(&current, &server, staging)?;
    let files = read_files(client, &input.path, input.position).await?;
    if current != preview.set
        || !files
            .iter()
            .eq(preview.files.iter().map(|file| &file.source))
    {
        return Err(Failure::Input(MEDIA_CHANGED));
    }
    check_paths(client, &preview.files).await?;
    let mut params: Vec<&dyn ToSql> = vec![&input.path, &input.position, staging];
    let mut options = String::from("FILE = @P2, STOP_ON_ERROR");
    if current.has_checksums {
        options.push_str(", CHECKSUM");
    }
    for file in &preview.files {
        let logical = params.len() + 1;
        let physical = logical + 1;
        options.push_str(&format!(", MOVE @P{logical} TO @P{physical}"));
        params.push(&file.source.logical_name);
        params.push(&file.destination);
    }
    active
        .phase
        .store(Phase::Verifying as u8, Ordering::Release);
    // Keep parameter numbers consistent for verification and restore.
    let verify = format!("RESTORE VERIFYONLY FROM DISK = @P1 WITH {options}");
    client.query(verify, &params).await?.into_results().await?;
    if read_set(client, &input).await? != current {
        return Err(Failure::Input(MEDIA_CHANGED));
    }
    inspect_server(client, &preview.database, staging).await?;
    check_paths(client, &preview.files).await?;
    active
        .phase
        .store(Phase::Restoring as u8, Ordering::Release);
    let restore = format!("RESTORE DATABASE @P3 FROM DISK = @P1 WITH {options}, RECOVERY");
    client.query(restore, &params).await?.into_results().await?;
    check_restored(client, staging, &preview.files).await?;
    active
        .phase
        .store(Phase::Publishing as u8, Ordering::Release);
    // SQL Server enforces uniqueness at the rename, including objects created after our last check.
    let rename = format!(
        "ALTER DATABASE {} MODIFY NAME = {}",
        ident(staging),
        ident(&preview.database)
    );
    client.simple_query(rename).await?.into_results().await?;
    Ok(current)
}

async fn check_restored(
    client: &mut SqlClient,
    staging: &str,
    files: &[MoveFile],
) -> std::result::Result<(), Failure> {
    let rows = client.query("SELECT d.state, f.name, f.physical_name FROM sys.databases AS d
        JOIN sys.master_files AS f ON f.database_id = d.database_id WHERE d.database_id = DB_ID(@P1)", &[&staging])
        .await?.into_first_result().await?;
    if rows.len() != files.len() {
        return Err(Failure::Input(
            "복원한 임시 DB의 파일 수가 미리보기와 다릅니다.",
        ));
    }
    let mut destinations = std::collections::HashMap::with_capacity(files.len());
    for file in files {
        destinations.insert(file.source.logical_name.as_str(), file.destination.as_str());
    }
    for row in rows {
        let name = row.try_get::<&str, _>(1)?.unwrap_or_default();
        let expected = destinations.remove(name);
        if row.try_get::<u8, _>(0)? != Some(0)
            || expected.is_none()
            || row.try_get::<&str, _>(2)? != expected
        {
            return Err(Failure::Input(
                "임시 DB가 온라인 상태이고 파일 위치가 검토 내용과 같은지 확인하세요.",
            ));
        }
    }
    Ok(())
}

fn preview_error(error: Failure) -> String {
    match error {
        Failure::Input(message) => message.into(),
        Failure::Server(error) => server_message(error.code()).into(),
    }
}

pub(super) fn server_message(code: Option<u32>) -> &'static str {
    match code {
        Some(229 | 262 | 297 | 916 | 15247) => PERMISSION,
        Some(1801 | 1829 | 1832 | 5039) => COLLISION,
        Some(1834 | 3156) => FILE_COLLISION,
        Some(3201 | 3202 | 3203 | 3234) =>
            "SQL Server가 백업 또는 복원 파일을 열 수 없습니다. 서버 경로와 서비스 계정 권한을 확인하세요.",
        Some(3169) => "이 백업은 대상보다 새 SQL Server 버전에서 생성되었습니다.",
        _ => "SQL Server 복원을 완료할 수 없습니다. 백업 세트, 대상 파일 경로와 서버 상태를 확인하세요.",
    }
}
