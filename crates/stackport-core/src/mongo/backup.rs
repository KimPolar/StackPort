use super::{
    archive::{self, ArchiveInfo},
    document_edit::editable_collection_uuid,
    message,
    restore::RestoreReviewSlot,
    tools::{self, Tools},
    valid_database, validate_namespace, MongoManager, MongoPassword, MongoProfile, READ_TIMEOUT,
};
use crate::{local_file::NewFile, Result};
use bson::doc;
use mongodb::Client;
use serde::{Deserialize, Serialize};
use std::{
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{task::spawn_blocking, time::timeout};

pub(super) const ARCHIVE_TIME: Duration = Duration::from_secs(30 * 60);
pub(super) const ARCHIVE_TIMEOUT: &str = "MongoDB 아카이브 처리 시간이 초과되었습니다.";
pub(super) const CANCELLED: &str = "MongoDB 아카이브 작업이 중단되었습니다.";
pub(super) const CLOSED: &str = "MongoDB 연결이 닫혔습니다. 다시 연결하세요.";
const OPERATION: &str = "mongo.archive.backup";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoBackupInput {
    database: String,
    collection: Option<String>,
    directory: String,
    destination: String,
    password: MongoPassword,
    confirmation: String,
}

#[derive(Serialize)]
pub struct MongoBackupReport {
    path: String,
    #[serde(flatten)]
    archive: ArchiveInfo,
    audit_warning: bool,
}

pub(super) struct ArchiveConnection {
    pub(super) client: Client,
    pub(super) profile: MongoProfile,
    pub(super) auth_database: Option<String>,
    pub(super) restore: Option<Arc<RestoreReviewSlot>>,
}

impl MongoManager {
    pub(super) fn archive_connection(&self, id: &str) -> Result<ArchiveConnection> {
        let sessions = self.sessions.lock().map_err(|_| CLOSED)?;
        let session = sessions.get(id).ok_or(CLOSED)?;
        Ok(ArchiveConnection {
            client: session.client.clone(),
            profile: session.profile.clone(),
            auth_database: session.auth_database.clone(),
            restore: session.restore_review.clone(),
        })
    }

    pub async fn create_backup_archive(
        &self,
        id: &str,
        token: String,
        input: MongoBackupInput,
    ) -> Result<MongoBackupReport> {
        let request = self.store.queries.claim(&token)?;
        let connection = self.archive_connection(id)?;
        check_production(&connection.profile, &input.confirmation)?;
        check_database(&input.database)?;
        if let Some(name) = &input.collection {
            validate_namespace(&input.database, name)?;
            if name.starts_with("system.") {
                return Err("백업할 일반 MongoDB 컬렉션을 선택하세요.".into());
            }
        }
        let target = input.collection.as_ref().map_or_else(
            || input.database.clone(),
            |name| format!("{}.{name}", input.database),
        );
        self.audit_mongo_change(
            &connection.profile,
            &token,
            OPERATION,
            "started",
            None,
            Some(&target),
        )
        .await?;
        let deadline = Instant::now() + ARCHIVE_TIME;
        let cancel = request.cancellation_check();
        let mut result = tokio::select! {
            biased;
            _ = request.wait_cancelled() => Err(CANCELLED.into()),
            result = timeout(ARCHIVE_TIME, stage_backup(&connection, input, deadline, cancel)) =>
                result.map_err(|_| ARCHIVE_TIMEOUT.to_owned()).and_then(|result| result),
        };
        if result.is_ok() {
            let sessions = self.sessions.lock().map_err(|_| CLOSED)?;
            if !sessions.contains_key(id) || !request.begin_export_publication() {
                result = Err(CANCELLED.into());
            }
        }
        let mut report = match result {
            Ok((file, report)) => spawn_blocking(move || {
                file.publish()?;
                Ok(report)
            })
            .await
            .map_err(|_| "MongoDB 백업 파일을 저장할 수 없습니다.")?,
            Err(error) => Err(error),
        };
        let count = report
            .as_ref()
            .ok()
            .and_then(|report| i64::try_from(report.archive.namespaces.len()).ok());
        let recorded = self
            .audit_mongo_change(
                &connection.profile,
                &token,
                OPERATION,
                if report.is_ok() {
                    "succeeded"
                } else {
                    "failed"
                },
                count,
                Some(&target),
            )
            .await;
        if recorded.is_err() {
            match &mut report {
                Ok(report) => report.audit_warning = true,
                Err(error) => error.push_str(" 완료 작업 기록도 저장하지 못했습니다."),
            }
        }
        Ok(report?)
    }
}

async fn stage_backup(
    connection: &ArchiveConnection,
    input: MongoBackupInput,
    deadline: Instant,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<(NewFile, MongoBackupReport)> {
    let MongoBackupInput {
        database,
        collection,
        directory,
        destination,
        password,
        ..
    } = input;
    let (tools, expected_version) =
        tokio::try_join!(Tools::open(directory), server_version(&connection.client))?;
    if let Some(name) = &collection {
        timeout(
            READ_TIMEOUT,
            editable_collection_uuid(&connection.client.database(&database), name),
        )
        .await
        .map_err(|_| "백업 대상 컬렉션을 확인하는 시간이 초과되었습니다.")??;
    }
    let (file, report_path) = spawn_blocking(move || {
        Ok::<_, String>((
            NewFile::stage(&destination, Some("gz"), ".stackport-mongo-")?,
            destination,
        ))
    })
    .await
    .map_err(|_| "MongoDB 백업 파일을 준비할 수 없습니다.")??;
    let mut command = tools.command("mongodump");
    command
        .args(["--archive", "--gzip"])
        .arg(format!("--db={database}"))
        .stdout(Stdio::from(file.writer()?));
    if let Some(name) = &collection {
        command.arg(format!("--collection={name}"));
    }
    tools::run(
        command,
        &connection.profile.settings,
        connection.auth_database.as_deref(),
        password,
        "mongodump가 백업에 실패했습니다. 서버·도구 호환성, 자격 증명과 접근 권한을 확인하세요.",
    )
    .await?;
    let archive = spawn_blocking(move || {
        let info = archive::scan(file.writer()?, &|| check_local(deadline, &cancelled))?;
        if info.namespaces.is_empty()
            || !info.gzip
            || info.tool_version != tools.version
            || info.namespaces.iter().any(|item| item.database != database)
            || collection.is_some_and(|name| {
                info.namespaces.len() != 1 || info.namespaces[0].collection != name
            })
            || version_family(&info.server_version) != version_family(&expected_version)
        {
            return Err(
                "백업 아카이브의 서버 버전 또는 대상이 확인한 정보와 일치하지 않습니다.".into(),
            );
        }
        Ok::<_, String>((
            file,
            MongoBackupReport {
                path: report_path,
                archive: info,
                audit_warning: false,
            },
        ))
    })
    .await
    .map_err(|_| "MongoDB 백업 아카이브를 검증할 수 없습니다.")??;
    Ok(archive)
}

pub(super) fn check_database(database: &str) -> Result<()> {
    if !valid_database(database) || matches!(database, "admin" | "config" | "local") {
        return Err("일반 MongoDB 데이터베이스를 선택하세요.".into());
    }
    Ok(())
}

pub(super) fn check_production(profile: &MongoProfile, confirmation: &str) -> Result<()> {
    if profile.settings.environment == "PROD" && confirmation != "PROD" {
        return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
    }
    Ok(())
}

pub(super) fn check_local(deadline: Instant, cancelled: &impl Fn() -> bool) -> Result<()> {
    if cancelled() {
        Err(CANCELLED.into())
    } else if Instant::now() >= deadline {
        Err(ARCHIVE_TIMEOUT.into())
    } else {
        Ok(())
    }
}

pub(super) fn version_family(version: &str) -> Option<[u32; 2]> {
    let mut pieces = version.split('.');
    Some([pieces.next()?.parse().ok()?, pieces.next()?.parse().ok()?])
}

pub(super) async fn server_version(client: &Client) -> Result<String> {
    let reply = timeout(
        READ_TIMEOUT,
        client
            .database("admin")
            .run_command(doc! { "buildInfo": 1 }),
    )
    .await
    .map_err(|_| "MongoDB 서버 버전 응답 시간이 초과되었습니다.")?
    .map_err(message)?;
    let version = reply
        .get_str("version")
        .map_err(|_| "MongoDB 서버 버전을 확인할 수 없습니다.")?;
    if version_family(version).is_none() || version.len() > 48 {
        return Err("MongoDB 서버 버전을 확인할 수 없습니다.".into());
    }
    Ok(version.to_owned())
}
