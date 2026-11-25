use super::{profiles::ProfileSettings, AccessToken};
use crate::Result;
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, Method, RequestBuilder, Response, StatusCode,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(test)]
mod tests;

const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const STATEMENT_SECONDS: u64 = 30;
const DEADLINE: Duration = Duration::from_secs(45);
const BAD_RESPONSE: &str = "Snowflake SQL API 응답을 읽을 수 없습니다.";
const CLOSED: &str = "Snowflake 연결이 닫혔습니다. 다시 연결하세요.";

pub(super) type Row = Vec<Option<String>>;

pub(super) struct Api {
    client: Client,
    endpoint: Url,
    settings: ProfileSettings,
    token: AccessToken,
    cancel: CancellationToken,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    statement_handle: Option<Uuid>,
    result_set_meta_data: Option<ResultMetadata>,
    data: Option<Vec<Row>>,
    sql_state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultMetadata {
    num_rows: usize,
    #[serde(default)]
    partition_info: Vec<Partition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Partition {
    row_count: usize,
}

impl Api {
    pub(super) fn new(settings: ProfileSettings, token: AccessToken) -> Result<Self> {
        let client = client_builder()
            .build()
            .map_err(|_| "Snowflake HTTPS 클라이언트를 열 수 없습니다.")?;
        let endpoint = Url::parse(&format!("https://{}/api/v2/statements", settings.host))
            .map_err(|_| "Snowflake 계정 호스트를 확인하세요.")?;
        Ok(Self {
            client,
            endpoint,
            settings,
            token,
            cancel: CancellationToken::new(),
        })
    }

    pub(super) fn close(&self) {
        self.cancel.cancel();
    }

    pub(super) fn set_context(&mut self, role: &str, warehouse: &str) {
        self.settings.role = Some(role.into());
        self.settings.warehouse = Some(warehouse.into());
    }

    pub(super) async fn query(
        &self,
        statement: &str,
        bindings: &[&str],
        row_limit: usize,
    ) -> Result<Vec<Row>> {
        let mut handle = None;
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(CLOSED.into()),
            result = timeout(DEADLINE, self.collect(statement, bindings, row_limit, &mut handle)) =>
                result.unwrap_or_else(|_| Err("Snowflake 조회 시간이 초과되었습니다.".into())),
        };
        if result.is_err() {
            if let Some(id) = handle {
                let mut url = self.statement_url(id);
                url.path_segments_mut().unwrap().push("cancel");
                if let Ok(request) = self.request(Method::POST, url) {
                    let _ = request.timeout(Duration::from_secs(2)).send().await;
                }
            }
        }
        result
    }

    async fn collect(
        &self,
        statement: &str,
        bindings: &[&str],
        row_limit: usize,
        pending: &mut Option<Uuid>,
    ) -> Result<Vec<Row>> {
        let mut url = self.endpoint.clone();
        url.query_pairs_mut()
            .append_pair("requestId", &Uuid::new_v4().to_string())
            .append_pair("async", "true");
        let mut body = json!({
            "statement": statement,
            "database": self.settings.database,
            "schema": "INFORMATION_SCHEMA",
            "timeout": STATEMENT_SECONDS,
            "parameters": {
                "rows_per_resultset": row_limit
            }
        });
        if let Some(warehouse) = &self.settings.warehouse {
            body["warehouse"] = json!(warehouse);
        }
        if let Some(role) = &self.settings.role {
            body["role"] = json!(role);
        }
        if !bindings.is_empty() {
            let values: Map<String, Value> = bindings
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    (
                        (index + 1).to_string(),
                        json!({ "type": "TEXT", "value": value }),
                    )
                })
                .collect();
            body["bindings"] = Value::Object(values);
        }

        let mut response = send(self.request(Method::POST, url)?.json(&body)).await?;
        let mut delay = Duration::from_millis(300);
        while matches!(
            response.0,
            StatusCode::ACCEPTED | StatusCode::TOO_MANY_REQUESTS
        ) {
            let id = response.1.statement_handle.or(*pending);
            let Some(id) = id else {
                return Err(if response.0 == StatusCode::TOO_MANY_REQUESTS {
                    "Snowflake 요청이 너무 많습니다. 잠시 후 다시 시도하세요."
                } else {
                    BAD_RESPONSE
                }
                .into());
            };
            if pending.is_some_and(|previous| previous != id) {
                return Err(BAD_RESPONSE.into());
            }
            *pending = Some(id);
            sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
            response = send(self.request(Method::GET, self.statement_url(id))?).await?;
        }
        let mut first = successful(response)?;
        if let Some(previous) = pending.take() {
            if first.statement_handle.is_some_and(|id| id != previous) {
                return Err(BAD_RESPONSE.into());
            }
            first.statement_handle = Some(previous);
        }
        let meta = first.result_set_meta_data.ok_or(BAD_RESPONSE)?;
        if meta.num_rows > row_limit
            || meta.partition_info.len() > row_limit.max(1)
            || meta
                .partition_info
                .iter()
                .try_fold(0_usize, |sum, part| sum.checked_add(part.row_count))
                != Some(meta.num_rows)
        {
            return Err(BAD_RESPONSE.into());
        }
        let first_count = meta.partition_info.first().map_or(0, |part| part.row_count);
        let mut rows = partition_rows(first.data, first_count)?;
        for (index, partition) in meta.partition_info.into_iter().enumerate().skip(1) {
            let mut url = self.statement_url(first.statement_handle.ok_or(BAD_RESPONSE)?);
            url.query_pairs_mut()
                .append_pair("partition", &index.to_string());
            let next = successful(send(self.request(Method::GET, url)?).await?)?;
            rows.extend(partition_rows(next.data, partition.row_count)?);
        }
        Ok(rows)
    }

    fn statement_url(&self, id: Uuid) -> Url {
        let mut url = self.endpoint.clone();
        url.path_segments_mut().unwrap().push(&id.to_string());
        url
    }

    fn request(&self, method: Method, url: Url) -> Result<RequestBuilder> {
        let bearer = Zeroizing::new(format!("Bearer {}", self.token.0.as_str()));
        let mut authorization =
            HeaderValue::from_str(&bearer).map_err(|_| "Snowflake 토큰 형식을 확인하세요.")?;
        authorization.set_sensitive(true);
        Ok(self
            .client
            .request(method, url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(
                "x-snowflake-authorization-token-type",
                self.settings.auth.header(),
            ))
    }
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .tls_backend_native()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .user_agent(concat!("StackPort/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
}

async fn send(request: RequestBuilder) -> Result<(StatusCode, Payload)> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "Snowflake HTTPS 응답 시간이 초과되었습니다."
        } else {
            "Snowflake HTTPS 연결을 열 수 없습니다. 계정 주소와 인증서를 확인하세요."
        }
    })?;
    let status = response.status();
    let payload = match status {
        StatusCode::OK | StatusCode::ACCEPTED => read_payload(response).await?,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::UNPROCESSABLE_ENTITY => {
            read_payload(response).await.unwrap_or_default()
        }
        _ => Payload::default(),
    };
    Ok((status, payload))
}

async fn read_payload(mut response: Response) -> Result<Payload> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| BAD_RESPONSE)? {
        if chunk.len() > RESPONSE_LIMIT - body.len() {
            return Err("Snowflake 응답이 미리보기 크기 제한을 초과했습니다.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| BAD_RESPONSE.into())
}

fn successful((status, payload): (StatusCode, Payload)) -> Result<Payload> {
    match status {
        StatusCode::OK => Ok(payload),
        StatusCode::UNAUTHORIZED => Err("Snowflake 토큰이 만료되었거나 올바르지 않습니다.".into()),
        StatusCode::FORBIDDEN => {
            Err("Snowflake 계정 또는 역할에서 이 연결을 허용하지 않습니다.".into())
        }
        StatusCode::UNPROCESSABLE_ENTITY => {
            let state = payload.sql_state.filter(|state| {
                state.len() == 5 && state.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
            Err(state.map_or_else(
                || "Snowflake가 조회를 처리하지 못했습니다.".into(),
                |state| format!("Snowflake가 조회를 처리하지 못했습니다 (SQLSTATE {state})."),
            ))
        }
        _ => Err(format!(
            "Snowflake SQL API 요청이 실패했습니다 (HTTP {}).",
            status.as_u16()
        )),
    }
}

fn partition_rows(data: Option<Vec<Row>>, expected: usize) -> Result<Vec<Row>> {
    let data = data.unwrap_or_default();
    if data.len() == expected {
        Ok(data)
    } else {
        Err(BAD_RESPONSE.into())
    }
}
