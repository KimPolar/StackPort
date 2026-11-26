use super::{
    connector, establish,
    keys::{display, RedisBytes},
    resp::{Failure, Wire},
    RedisAuthentication, RedisManager, RedisPassword, RedisProfile, RedisSettings, CONNECT_TIMEOUT,
    UPDATE_UNKNOWN,
};
use crate::{insert_audit, AuditRecord, Result, Store};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const HISTORY_LIMIT: usize = 100;
const CHANNEL_LIMIT: usize = 512;
const PUBLISH_LIMIT: usize = 64 * 1024;
const PUBLISH_UNKNOWN: &str = "Redis 메시지 발행 결과를 확인할 수 없습니다. 연결이 닫혔습니다. 다시 보내기 전에 수신 여부를 확인하세요.";

#[derive(Clone, Serialize)]
pub struct RedisSubscriptionSnapshot {
    status: Status,
    error: Option<String>,
    interruptions: u64,
    evicted: u64,
    messages: VecDeque<Message>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Subscribed,
    Reconnecting,
    Failed,
}

#[derive(Clone, Serialize)]
struct Message {
    sequence: u64,
    received_at_ms: u64,
    channel: RedisBytes,
    payload: RedisBytes,
}

#[derive(Serialize)]
pub struct RedisPublishReport {
    receivers: u64,
    audit_warning: bool,
}

pub(super) struct Subscription {
    id: String,
    state: Arc<Mutex<RedisSubscriptionSnapshot>>,
    worker: JoinHandle<()>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

struct Channel {
    name: String,
    pattern: bool,
}

struct Connection {
    settings: RedisSettings,
    tls: Option<native_tls::TlsConnector>,
    password: RedisPassword,
    channel: Channel,
}

enum ConnectionError {
    Retry(String),
    Stop(String),
}

impl ConnectionError {
    fn reason(self) -> String {
        match self {
            Self::Retry(reason) | Self::Stop(reason) => reason,
        }
    }
}

impl RedisManager {
    pub async fn start_subscription(
        &self,
        id: &str,
        name: String,
        pattern: bool,
        authentication: impl Into<RedisAuthentication>,
        confirmation: &str,
    ) -> Result<String> {
        validate_channel(&name)?;
        let session = self.session(id)?;
        check_production(&session.profile, confirmation)?;
        let mut slot = session.subscription.lock().await;
        if slot.is_some() {
            return Err("기존 Redis 구독을 종료한 뒤 다시 시작하세요.".into());
        }
        let store = self.store.clone();
        let profile = session.profile.clone();
        let authentication = authentication.into();
        let mut connection = tokio::task::spawn_blocking(move || {
            let current = store.redis_profile(&profile.id, profile.revision)?;
            let (password, _) = store.redis_password(&current, authentication)?;
            let mut settings = current.settings;
            settings.database = 0;
            Ok::<_, String>(Connection {
                tls: connector(&settings)?,
                settings,
                password,
                channel: Channel { name, pattern },
            })
        })
        .await
        .map_err(|_| "Redis 구독 연결 설정을 읽을 수 없습니다.")??;
        let wire = connection.open().await.map_err(ConnectionError::reason)?;
        self.session(id)?;
        let state = Arc::new(Mutex::new(RedisSubscriptionSnapshot {
            status: Status::Subscribed,
            error: None,
            interruptions: 0,
            evicted: 0,
            messages: VecDeque::with_capacity(HISTORY_LIMIT),
        }));
        let subscription_id = Uuid::new_v4().to_string();
        let worker = tokio::spawn(connection.listen(wire, Arc::clone(&state)));
        *slot = Some(Subscription {
            id: subscription_id.clone(),
            state,
            worker,
        });
        Ok(subscription_id)
    }

    pub async fn subscription_snapshot(
        &self,
        id: &str,
        subscription: &str,
    ) -> Result<RedisSubscriptionSnapshot> {
        let session = self.session(id)?;
        let slot = session.subscription.lock().await;
        let current = active_subscription(&slot, subscription)?;
        let snapshot = lock_state(&current.state).clone();
        Ok(snapshot)
    }

    pub async fn clear_subscription_history(&self, id: &str, subscription: &str) -> Result<()> {
        let session = self.session(id)?;
        let slot = session.subscription.lock().await;
        let mut state = lock_state(&active_subscription(&slot, subscription)?.state);
        state.messages.clear();
        state.evicted = 0;
        Ok(())
    }

    pub async fn stop_subscription(&self, id: &str, subscription: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut slot = session.subscription.lock().await;
        if slot
            .as_ref()
            .is_some_and(|active| active.id == subscription)
        {
            *slot = None;
        }
        Ok(())
    }

    pub async fn publish_message(
        &self,
        id: &str,
        channel: String,
        message: String,
        confirmed: bool,
        confirmation: &str,
    ) -> Result<RedisPublishReport> {
        validate_channel(&channel)?;
        let message = Zeroizing::new(message);
        if message.len() > PUBLISH_LIMIT {
            return Err("Redis 메시지는 64 KiB 이하로 입력하세요.".into());
        }
        let session = self.session(id)?;
        if !session.allow_publish || !confirmed {
            return Err("메시지 발행을 허용한 Redis 연결에서 발행 내용을 확인하세요.".into());
        }
        check_production(&session.profile, confirmation)?;
        let correlation = Uuid::new_v4().to_string();
        let store = self.store.clone();
        let profile = session.profile.clone();
        let started = correlation.clone();
        tokio::task::spawn_blocking(move || {
            store.redis_profile(&profile.id, profile.revision)?;
            publish_audit(&store, &profile, &started, false, "started", None)
        })
        .await
        .map_err(|_| "Redis 발행 기록을 시작할 수 없습니다.")??;

        let result = self
            .run(id, &session, |state| {
                Box::pin(async move {
                    state.committing = true;
                    let reply = state
                        .wire
                        .command(&[b"PUBLISH", channel.as_bytes(), message.as_bytes()])
                        .await
                        .and_then(|reply| reply.integer())
                        .and_then(|count| u64::try_from(count).map_err(|_| Failure::Protocol));
                    if matches!(reply, Ok(_) | Err(Failure::Server(_))) {
                        state.committing = false;
                    }
                    reply
                })
            })
            .await;
        let (unknown, outcome) = match &result {
            Ok(_) => (false, "succeeded"),
            Err(message) if message == UPDATE_UNKNOWN => (true, "started"),
            Err(_) => (false, "failed"),
        };
        let receivers = result.as_ref().ok().map(|count| *count as i64);
        let store = self.store.clone();
        let profile = session.profile.clone();
        let audit_warning = !matches!(
            tokio::task::spawn_blocking(move || {
                publish_audit(&store, &profile, &correlation, unknown, outcome, receivers)
            })
            .await,
            Ok(Ok(()))
        );
        result
            .map(|receivers| RedisPublishReport {
                receivers,
                audit_warning,
            })
            .map_err(|error| {
                if unknown {
                    PUBLISH_UNKNOWN.into()
                } else {
                    error
                }
            })
    }
}

impl Connection {
    async fn open(&mut self) -> std::result::Result<Wire, ConnectionError> {
        let result = timeout(CONNECT_TIMEOUT, async {
            let (_, _, mut wire) = establish(&self.settings, self.tls.clone(), &self.password)
                .await
                .map_err(ConnectionError::Retry)?;
            let (command, ack): (&[u8], &[u8]) = if self.channel.pattern {
                (b"PSUBSCRIBE", b"psubscribe")
            } else {
                (b"SUBSCRIBE", b"subscribe")
            };
            let bytes = self.channel.name.as_bytes();
            let check = async {
                let mut reply = wire.command(&[command, bytes]).await?.array()?.into_iter();
                if reply.len() != 3
                    || reply.next().ok_or(Failure::Protocol)?.bytes()? != ack
                    || reply.next().ok_or(Failure::Protocol)?.bytes()? != bytes
                    || reply.next().ok_or(Failure::Protocol)?.integer()? != 1
                {
                    return Err(Failure::Protocol);
                }
                Ok(())
            };
            check.await.map_err(|error| match error {
                Failure::Transport => ConnectionError::Retry(error.message().into()),
                _ => ConnectionError::Stop(error.message().into()),
            })?;
            Ok(wire)
        })
        .await;
        result.unwrap_or_else(|_| {
            Err(ConnectionError::Retry(
                "Redis 구독 연결 시간이 초과되었습니다.".into(),
            ))
        })
    }

    async fn listen(mut self, mut wire: Wire, state: Arc<Mutex<RedisSubscriptionSnapshot>>) {
        let mut sequence = 0u64;
        loop {
            match self.channel.receive(&mut wire).await {
                Ok((channel, payload)) => {
                    sequence = sequence.saturating_add(1);
                    let mut history = lock_state(&state);
                    if history.messages.len() == HISTORY_LIMIT {
                        history.messages.pop_front();
                        history.evicted = history.evicted.saturating_add(1);
                    }
                    history.messages.push_back(Message {
                        sequence,
                        received_at_ms: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                        channel: display(&channel, false),
                        payload: display(&payload, true),
                    });
                }
                Err(Failure::Transport) => {
                    drop(wire);
                    {
                        let mut status = lock_state(&state);
                        status.interruptions = status.interruptions.saturating_add(1);
                        status.status = Status::Reconnecting;
                        status.error = None;
                    }
                    let mut delay = Duration::from_secs(1);
                    wire = loop {
                        sleep(delay).await;
                        match self.open().await {
                            Ok(wire) => {
                                let mut status = lock_state(&state);
                                status.status = Status::Subscribed;
                                status.error = None;
                                break wire;
                            }
                            Err(ConnectionError::Retry(reason)) => {
                                lock_state(&state).error = Some(reason);
                                delay = (delay * 2).min(Duration::from_secs(15));
                            }
                            Err(ConnectionError::Stop(reason)) => {
                                fail(&state, reason);
                                return;
                            }
                        }
                    };
                }
                Err(error) => {
                    fail(&state, error.message().into());
                    return;
                }
            }
        }
    }
}

impl Channel {
    async fn receive(&self, wire: &mut Wire) -> std::result::Result<(Vec<u8>, Vec<u8>), Failure> {
        let mut parts = wire.receive().await?.array()?.into_iter();
        let original = parts.len();
        let mut field = || parts.next().ok_or(Failure::Protocol)?.bytes();
        let kind = field()?;
        let name = field()?;
        let channel = match (self.pattern, kind.as_slice(), original) {
            (false, b"message", 3) if name == self.name.as_bytes() => name,
            (true, b"pmessage", 4) if name == self.name.as_bytes() => field()?,
            _ => return Err(Failure::Protocol),
        };
        Ok((channel, field()?))
    }
}

fn active_subscription<'a>(slot: &'a Option<Subscription>, id: &str) -> Result<&'a Subscription> {
    slot.as_ref()
        .filter(|active| active.id == id)
        .ok_or_else(|| "Redis 구독이 종료되었습니다.".into())
}

fn lock_state(
    state: &Mutex<RedisSubscriptionSnapshot>,
) -> MutexGuard<'_, RedisSubscriptionSnapshot> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fail(state: &Mutex<RedisSubscriptionSnapshot>, reason: String) {
    let mut state = lock_state(state);
    state.status = Status::Failed;
    state.error = Some(reason);
}

fn validate_channel(channel: &str) -> Result<()> {
    if channel.is_empty() || channel.len() > CHANNEL_LIMIT || channel.chars().any(char::is_control)
    {
        return Err("Redis 채널이나 패턴을 제어 문자 없이 1~512바이트로 입력하세요.".into());
    }
    Ok(())
}

fn check_production(profile: &RedisProfile, confirmation: &str) -> Result<()> {
    if profile.settings.environment == "PROD" && confirmation != "PROD" {
        return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
    }
    Ok(())
}

fn publish_audit(
    store: &Store,
    profile: &RedisProfile,
    correlation: &str,
    unknown: bool,
    outcome: &'static str,
    receivers: Option<i64>,
) -> Result<()> {
    insert_audit(
        &store.connect()?,
        AuditRecord {
            correlation_id: correlation,
            operation: if unknown {
                "redis.pubsub.publish.unconfirmed"
            } else {
                "redis.pubsub.publish"
            },
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome,
            affected_count: receivers,
        },
    )
}
