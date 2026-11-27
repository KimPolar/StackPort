use super::{profiles::ProfileSettings, AccessToken};
use crate::Result;
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, Method, RequestBuilder, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Copy, Serialize)]
pub(super) struct Binding<'a> {
    #[serde(rename = "type")]
    pub(super) data_type: &'static str,
    pub(super) value: Option<&'a str>,
}

fn set_bindings<'a>(body: &mut Value, values: impl IntoIterator<Item = Binding<'a>>) {
    let values = values
        .into_iter()
        .enumerate()
        .map(|(index, binding)| ((index + 1).to_string(), json!(binding)))
        .collect::<Map<_, _>>();
    if !values.is_empty() {
        body["bindings"] = Value::Object(values);
    }
}
use zeroize::Zeroizing;

#[cfg(test)]
mod tests;

const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const STATEMENT_SECONDS: u64 = 30;
const DEADLINE: Duration = Duration::from_secs(45);
pub(super) const BAD_RESPONSE: &str = "Snowflake SQL API 응답을 읽을 수 없습니다.";
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
pub(super) struct Payload {
    pub(super) statement_handle: Option<Uuid>,
    pub(super) result_set_meta_data: Option<ResultMetadata>,
    pub(super) data: Option<Vec<Row>>,
    pub(super) sql_state: Option<String>,
    pub(super) code: Option<String>,
    pub(super) message: Option<String>,
    pub(super) statement_handles: Option<Vec<Uuid>>,
    pub(super) stats: Option<StatementStats>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub(super) struct StatementStats {
    pub(super) num_rows_inserted: Option<u64>,
    pub(super) num_rows_updated: Option<u64>,
    pub(super) num_rows_deleted: Option<u64>,
    pub(super) num_duplicate_rows_updated: Option<u64>,
}

#[derive(Deserialize)]
pub(super) struct ResultColumn {
    pub(super) name: String,
    #[serde(rename = "type")]
    pub(super) data_type: String,
    pub(super) precision: Option<i64>,
    pub(super) scale: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResultMetadata {
    pub(super) num_rows: usize,
    #[serde(default)]
    pub(super) partition_info: Vec<Partition>,
    pub(super) row_type: Option<Vec<ResultColumn>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Partition {
    pub(super) row_count: usize,
}

impl ResultMetadata {
    pub(super) fn validate(&self, limit: Option<usize>) -> Result<()> {
        if limit
            .is_some_and(|limit| self.num_rows > limit || self.partition_info.len() > limit.max(1))
            || self
                .partition_info
                .iter()
                .try_fold(0_usize, |sum, part| sum.checked_add(part.row_count))
                != Some(self.num_rows)
        {
            return Err(BAD_RESPONSE.into());
        }
        Ok(())
    }
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

    pub(super) fn token(&self) -> &str {
        self.token.0.as_str()
    }

    pub(super) fn operation_token(&self) -> CancellationToken {
        self.cancel.child_token()
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
        self.query_cancellable(statement, bindings, row_limit, &self.cancel)
            .await
    }

    pub(super) async fn query_cancellable(
        &self,
        statement: &str,
        bindings: &[&str],
        row_limit: usize,
        stop: &CancellationToken,
    ) -> Result<Vec<Row>> {
        let mut handle = None;
        let result = tokio::select! {
            biased;
            _ = stop.cancelled() => Err(CLOSED.into()),
            result = timeout(DEADLINE, self.collect(statement, bindings, row_limit, &mut handle)) =>
                result.unwrap_or_else(|_| Err("Snowflake 조회 시간이 초과되었습니다.".into())),
        };
        if result.is_err() {
            self.cancel_pending(handle).await;
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
        let first = read_payload(
            self.start(statement, bindings, row_limit, STATEMENT_SECONDS, pending)
                .await?,
        )
        .await?;
        let handle = finish_handle(pending, first.statement_handle)?;
        let meta = first.result_set_meta_data.ok_or(BAD_RESPONSE)?;
        meta.validate(Some(row_limit))?;
        let first_count = meta.partition_info.first().map_or(0, |part| part.row_count);
        let mut rows = partition_rows(first.data, first_count)?;
        for (index, partition) in meta.partition_info.into_iter().enumerate().skip(1) {
            let next = read_payload(
                self.partition(handle.ok_or(BAD_RESPONSE)?, index, Duration::from_secs(12))
                    .await?,
            )
            .await?;
            check_handle(handle, next.statement_handle)?;
            rows.extend(partition_rows(next.data, partition.row_count)?);
        }
        Ok(rows)
    }

    pub(super) async fn start(
        &self,
        statement: &str,
        bindings: &[&str],
        row_limit: usize,
        statement_seconds: u64,
        pending: &mut Option<Uuid>,
    ) -> Result<Response> {
        let mut body = json!({
            "statement": statement,
            "database": self.settings.database,
            "schema": "INFORMATION_SCHEMA",
            "timeout": statement_seconds,
            "parameters": {
                "rows_per_resultset": row_limit
            }
        });
        set_bindings(
            &mut body,
            bindings.iter().map(|value| Binding {
                data_type: "TEXT",
                value: Some(value),
            }),
        );

        let request_timeout = if row_limit == 0 {
            Duration::from_secs(statement_seconds)
        } else {
            Duration::from_secs(12)
        };
        let response = self
            .post(body, Uuid::new_v4(), request_timeout, pending)
            .await?;
        successful(response).await
    }

    pub(super) async fn submit_script(
        &self,
        sql: &str,
        request_id: Uuid,
        count: usize,
        row_limit: usize,
        bindings: &[Binding<'_>],
        pending: &mut Option<Uuid>,
    ) -> Result<Response> {
        let mut body = json!({
            "statement": sql,
            "database": self.settings.database,
            "timeout": STATEMENT_SECONDS,
            "parameters": {
                "rows_per_resultset": row_limit,
                "binary_output_format": "HEX",
                "date_output_format": "YYYY-MM-DD",
                "time_output_format": "HH24:MI:SS.FF9",
                "timestamp_ntz_output_format": "YYYY-MM-DD\"T\"HH24:MI:SS.FF9",
                "timestamp_ltz_output_format": "YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM",
                "timestamp_tz_output_format": "YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM"
            }
        });
        if count > 1 {
            body["parameters"]["MULTI_STATEMENT_COUNT"] = json!(count.to_string());
        }
        set_bindings(&mut body, bindings.iter().copied());
        self.post(body, request_id, Duration::from_secs(12), pending)
            .await
    }

    async fn post(
        &self,
        mut body: Value,
        request_id: Uuid,
        request_timeout: Duration,
        pending: &mut Option<Uuid>,
    ) -> Result<Response> {
        let mut url = self.endpoint.clone();
        url.query_pairs_mut()
            .append_pair("requestId", &request_id.to_string())
            .append_pair("nullable", "true")
            .append_pair("async", "true");
        if let Some(warehouse) = &self.settings.warehouse {
            body["warehouse"] = json!(warehouse);
        }
        if let Some(role) = &self.settings.role {
            body["role"] = json!(role);
        }
        let response = send(
            self.request(Method::POST, url)?
                .timeout(request_timeout)
                .json(&body),
        )
        .await?;
        self.poll(response, request_timeout, pending).await
    }

    async fn poll(
        &self,
        mut response: Response,
        request_timeout: Duration,
        pending: &mut Option<Uuid>,
    ) -> Result<Response> {
        let mut delay = Duration::from_millis(300);
        while matches!(
            response.status(),
            StatusCode::ACCEPTED | StatusCode::TOO_MANY_REQUESTS
        ) {
            let status = response.status();
            let payload = if status == StatusCode::ACCEPTED {
                read_payload(response).await?
            } else {
                read_payload(response).await.unwrap_or_default()
            };
            check_handle(*pending, payload.statement_handle)?;
            let id = payload.statement_handle.or(*pending);
            let Some(id) = id else {
                return Err(if status == StatusCode::TOO_MANY_REQUESTS {
                    "Snowflake 요청이 너무 많습니다. 잠시 후 다시 시도하세요."
                } else {
                    BAD_RESPONSE
                }
                .into());
            };
            *pending = Some(id);
            sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(2));
            response = send(
                self.request(Method::GET, self.statement_url(id))?
                    .timeout(request_timeout),
            )
            .await?;
        }
        Ok(response)
    }

    pub(super) async fn script_result(&self, handle: Uuid) -> Result<Payload> {
        let request_timeout = Duration::from_secs(12);
        let response = send(
            self.request(Method::GET, self.statement_url(handle))?
                .timeout(request_timeout),
        )
        .await?;
        let response = self
            .poll(response, request_timeout, &mut Some(handle))
            .await?;
        let payload = read_payload(successful(response).await?).await?;
        check_handle(Some(handle), payload.statement_handle)?;
        Ok(payload)
    }

    pub(super) async fn partition(
        &self,
        handle: Uuid,
        index: usize,
        request_timeout: Duration,
    ) -> Result<Response> {
        let mut url = self.statement_url(handle);
        url.query_pairs_mut()
            .append_pair("partition", &index.to_string());
        let mut response = send(
            self.request(Method::GET, url.clone())?
                .timeout(request_timeout),
        )
        .await?;
        for delay in [300, 600, 1200] {
            if response.status() != StatusCode::TOO_MANY_REQUESTS {
                break;
            }
            drop(response);
            sleep(Duration::from_millis(delay)).await;
            response = send(
                self.request(Method::GET, url.clone())?
                    .timeout(request_timeout),
            )
            .await?;
        }
        successful(response).await
    }

    pub(super) async fn cancel_pending(&self, handle: Option<Uuid>) -> bool {
        if let Some(id) = handle {
            let mut url = self.statement_url(id);
            url.path_segments_mut().unwrap().push("cancel");
            if let Ok(request) = self.request(Method::POST, url) {
                return request
                    .timeout(Duration::from_secs(2))
                    .send()
                    .await
                    .is_ok_and(|response| response.status() == StatusCode::OK);
            }
        }
        false
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

async fn send(request: RequestBuilder) -> Result<Response> {
    request.send().await.map_err(|error| {
        {
            if error.is_timeout() {
                "Snowflake HTTPS 응답 시간이 초과되었습니다."
            } else {
                "Snowflake HTTPS 연결을 열 수 없습니다. 계정 주소와 인증서를 확인하세요."
            }
        }
        .into()
    })
}

pub(super) async fn read_payload(mut response: Response) -> Result<Payload> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| BAD_RESPONSE)? {
        if chunk.len() > RESPONSE_LIMIT - body.len() {
            return Err("Snowflake 응답이 미리보기 크기 제한을 초과했습니다.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| BAD_RESPONSE.into())
}

pub(super) async fn successful(response: Response) -> Result<Response> {
    match response.status() {
        StatusCode::OK => Ok(response),
        StatusCode::UNAUTHORIZED => Err("Snowflake 토큰이 만료되었거나 올바르지 않습니다.".into()),
        StatusCode::FORBIDDEN => {
            Err("Snowflake 계정 또는 역할에서 이 연결을 허용하지 않습니다.".into())
        }
        StatusCode::UNPROCESSABLE_ENTITY => {
            let payload = read_payload(response).await.unwrap_or_default();
            let state = payload.sql_state.filter(|state| {
                state.len() == 5 && state.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
            Err(state.map_or_else(
                || "Snowflake가 조회를 처리하지 못했습니다.".into(),
                |state| format!("Snowflake가 조회를 처리하지 못했습니다 (SQLSTATE {state})."),
            ))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            Err("Snowflake 요청이 너무 많습니다. 잠시 후 다시 시도하세요.".into())
        }
        status => Err(format!(
            "Snowflake SQL API 요청이 실패했습니다 (HTTP {}).",
            status.as_u16()
        )),
    }
}

pub(super) fn check_handle(expected: Option<Uuid>, received: Option<Uuid>) -> Result<()> {
    if expected
        .zip(received)
        .is_some_and(|(expected, received)| expected != received)
    {
        return Err(BAD_RESPONSE.into());
    }
    Ok(())
}

pub(super) fn finish_handle(
    pending: &mut Option<Uuid>,
    received: Option<Uuid>,
) -> Result<Option<Uuid>> {
    check_handle(*pending, received)?;
    Ok(pending.take().or(received))
}

pub(super) fn partition_rows(data: Option<Vec<Row>>, expected: usize) -> Result<Vec<Row>> {
    let data = data.unwrap_or_default();
    if data.len() == expected {
        Ok(data)
    } else {
        Err(BAD_RESPONSE.into())
    }
}
