mod api;
mod catalog;
mod export;
mod profiles;

pub use crate::result_export::{
    ResultFileOptions as ExportOptions, ResultFileOutcome as ExportOutcome,
};
pub use catalog::{CatalogPage, Column, DataPage, Object};
pub use profiles::{Auth, Profile, ProfileSettings};

use self::api::Api;
use crate::{Result, Store};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;
use zeroize::Zeroizing;

const CLOSED: &str = "Snowflake 연결이 닫혔습니다. 다시 연결하세요.";

#[derive(Deserialize)]
#[serde(transparent)]
pub struct AccessToken(#[serde(deserialize_with = "deserialize_token")] Zeroizing<String>);

fn deserialize_token<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct SessionInfo {
    id: String,
    database: String,
    version: String,
    context: String,
}

struct Session {
    api: Api,
    database: String,
    profile: Profile,
    operations: Semaphore,
    export: Mutex<Option<export::ActiveExport>>,
    _permit: OwnedSemaphorePermit,
}

pub struct Manager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    capacity: Arc<Semaphore>,
}

impl Manager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            capacity: Arc::new(Semaphore::new(8)),
        }
    }

    pub async fn open(
        &self,
        profile_id: String,
        revision: i64,
        token: AccessToken,
        confirmation: String,
    ) -> Result<SessionInfo> {
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 Snowflake 연결이 너무 많습니다.")?;
        let store = self.store.clone();
        let profile =
            tokio::task::spawn_blocking(move || store.snowflake_profile(&profile_id, revision))
                .await
                .map_err(|_| "Snowflake 연결 설정을 읽을 수 없습니다.")??;
        let expected = &profile.settings;
        if expected.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if token.0.is_empty()
            || token.0.len() > 16_384
            || !token.0.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err("Snowflake 액세스 토큰을 확인하세요.".into());
        }
        let mut api = Api::new(expected.clone(), token)?;
        let rows = api
            .query(
                "SELECT CURRENT_DATABASE(), CURRENT_VERSION(), CURRENT_ROLE(), CURRENT_WAREHOUSE()",
                &[],
                1,
            )
            .await?;
        let [Some(database), Some(version), Some(role), warehouse] = rows
            .first()
            .map(Vec::as_slice)
            .ok_or("Snowflake 접속 정보를 확인할 수 없습니다.")?
        else {
            return Err("Snowflake 접속 정보를 확인할 수 없습니다.".into());
        };
        let warehouse = warehouse
            .as_ref()
            .ok_or("Snowflake 웨어하우스 또는 계정의 기본 웨어하우스를 지정하세요.")?;
        if database != &expected.database
            || expected.role.as_ref().is_some_and(|name| name != role)
            || expected
                .warehouse
                .as_ref()
                .is_some_and(|name| name != warehouse)
        {
            return Err(
                "Snowflake 접속 권한과 데이터베이스, 역할, 웨어하우스 설정을 확인하세요.".into(),
            );
        }
        api.set_context(role, warehouse);

        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "Snowflake 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Arc::new(Session {
                    api,
                    database: database.clone(),
                    profile,
                    operations: Semaphore::new(3),
                    export: Mutex::new(None),
                    _permit: permit,
                }),
            );
        Ok(SessionInfo {
            id,
            database: database.clone(),
            version: version.clone(),
            context: format!("{role} / {warehouse}"),
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        if let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| "Snowflake 연결 목록을 읽을 수 없습니다.")?
            .remove(id)
        {
            session.api.close();
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .map_err(|_| "Snowflake 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or_else(|| CLOSED.into())
    }
}

impl Session {
    fn operation(&self) -> Result<tokio::sync::SemaphorePermit<'_>> {
        self.operations
            .try_acquire()
            .map_err(|_| "Snowflake 조회가 진행 중입니다. 잠시 후 다시 시도하세요.".into())
    }
}
