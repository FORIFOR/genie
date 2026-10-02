//! gateway（実バックエンド）を叩く OS 非依存の API クライアント。
//!
//! Tauri の React/TS client と同じ gateway を、native アプリも **同じ core** から使う（二重実装しない）。
//! ここは HTTP と JSON だけ。UI も Tauri も知らない。認証トークンは呼び出し側（OS の Keychain）が持つ。

use serde::Deserialize;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ApiError {
    #[error("network error: {message}")]
    Network { message: String },
    #[error("server error {status}: {message}")]
    Server { status: u16, message: String },
    #[error("unexpected response: {message}")]
    Decode { message: String },
}

/// dev サインインで得るトークン一式。
#[derive(uniffi::Record, Clone, Debug, serde::Serialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub device_token: String,
    pub expires_in: i64,
}

/// /v1/me の要点（UI が出す分だけ）。
#[derive(uniffi::Record, Clone, Debug, serde::Serialize)]
pub struct Me {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub tenant_id: String,
    pub tenant_name: String,
    pub role: String,
}

/// 冪等キー（8–128 文字）。外部乱数を足さず、pid + 単調時刻で一意にする。
fn idem_key() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("genie-core-{}-{}", std::process::id(), nanos)
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

fn map_transport(e: ureq::Error) -> ApiError {
    match e {
        ureq::Error::Status(code, resp) => {
            let msg = resp.into_string().unwrap_or_default();
            ApiError::Server { status: code, message: msg }
        }
        ureq::Error::Transport(t) => ApiError::Network { message: t.to_string() },
    }
}

/// 開発用サインイン（POST /v1/auth/dev/token）。gateway が dev token を許すときだけ。
#[uniffi::export]
pub fn api_dev_sign_in(base_url: String, email: String, display_name: String) -> Result<Tokens, ApiError> {
    #[derive(Deserialize)]
    struct Resp {
        access_token: String,
        refresh_token: String,
        device_token: String,
        expires_in: i64,
    }
    let resp: Resp = ureq::post(&format!("{}/v1/auth/dev/token", base(&base_url)))
        .send_json(ureq::json!({ "email": email, "display_name": display_name }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(Tokens {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        device_token: resp.device_token,
        expires_in: resp.expires_in,
    })
}

/// 自分の情報（GET /v1/me）。access token が要る。
#[uniffi::export]
pub fn api_me(base_url: String, access_token: String) -> Result<Me, ApiError> {
    #[derive(Deserialize)]
    struct User { id: String, email: String, display_name: String }
    #[derive(Deserialize)]
    struct Tenant { id: String, name: String }
    #[derive(Deserialize)]
    struct Resp { user: User, tenant: Tenant, role: String }
    let resp: Resp = ureq::get(&format!("{}/v1/me", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(Me {
        user_id: resp.user.id,
        email: resp.user.email,
        display_name: resp.user.display_name,
        tenant_id: resp.tenant.id,
        tenant_name: resp.tenant.name,
        role: resp.role,
    })
}

/// 会議（POST /v1/meetings）。同意確認済みでのみ開始する。
#[uniffi::export]
pub fn api_create_meeting(
    base_url: String,
    access_token: String,
    title: String,
    language: String,
) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Resp { id: String }
    let resp: Resp = ureq::post(&format!("{}/v1/meetings", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({
            "title": title,
            "language": language,
            "audio_sources": ["microphone"],
            "consent_confirmed": true,
        }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.id)
}

/// 会議を終える（POST /v1/meetings/:id/finish）。finalize task の id を返す。
#[uniffi::export]
pub fn api_finish_meeting(
    base_url: String,
    access_token: String,
    meeting_id: String,
) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Resp { task_id: String }
    let resp: Resp = ureq::post(&format!("{}/v1/meetings/{}/finish", base(&base_url), meeting_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({}))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.task_id)
}

/// gateway に届くか（GET /healthz, 認証・rate limit 対象外）。依存サービスの readiness は判定しない。
#[uniffi::export]
pub fn api_reachable(base_url: String) -> bool {
    ureq::get(&format!("{}/healthz", base(&base_url)))
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .is_ok_and(|response| (200..300).contains(&response.status()))
}

// gateway を起動して実行する結合テスト。`ASTRA_GATEWAY_URL` が無ければ skip。
#[cfg(test)]
mod tests {
    use super::*;

    fn reachability_server(statuses: Vec<u16>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, Write};
        use std::time::{Duration, Instant};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for health_status in statuses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "reachability probe did not arrive");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("reachability listener failed: {error}"),
                    }
                };
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = String::new();
                std::io::BufReader::new(&socket).read_line(&mut request).unwrap();
                // Auth is deliberately unavailable: probes must not consume its shared budget.
                let status = if request.starts_with("GET /healthz ") { health_status } else { 429 };
                requests.push(request.trim_end().to_owned());
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
            requests
        });
        (url, thread)
    }

    #[test]
    fn reachable_repeated_probes_use_health_without_auth_budget() {
        let (url, server) = reachability_server(vec![200; 12]);
        let results: Vec<_> = (0..12).map(|_| api_reachable(format!("{url}/"))).collect();
        let requests = server.join().unwrap();
        assert!(results.into_iter().all(|reachable| reachable));
        assert_eq!(requests, vec!["GET /healthz HTTP/1.1"; 12]);
    }

    #[test]
    fn reachable_requires_success_status_and_rejects_transport_failure() {
        let (url, server) = reachability_server(vec![200, 204, 302, 401, 429, 500, 503]);
        let results: Vec<_> = (0..7).map(|_| api_reachable(url.clone())).collect();
        let requests = server.join().unwrap();
        assert_eq!(results, vec![true, true, false, false, false, false, false]);
        assert_eq!(requests, vec!["GET /healthz HTTP/1.1"; 7]);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(!api_reachable(unavailable));
    }

    fn task_server(responses: Vec<u16>, minimum_spacing_ms: u128) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut previous: Option<std::time::Instant> = None;
            for (index, code) in responses.iter().enumerate() {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
                let mut bytes = [0u8; 4096];
                let n = socket.read(&mut bytes).unwrap();
                assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("GET /v1/tasks/existing "));
                let status = if previous.is_some_and(|t| t.elapsed().as_millis() < minimum_spacing_ms) { 429 } else { *code };
                previous = Some(std::time::Instant::now());
                let task_status = if index + 1 == responses.len() { "COMPLETED" } else { "RUNNING" };
                let body = format!(r#"{{"id":"existing","status":"{task_status}","result_artifact_id":"artifact"}}"#);
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (url, thread)
    }

    #[test]
    fn waiting_for_a_long_task_leaves_rate_limit_headroom() {
        let (url, server) = task_server(vec![200, 200], 800);
        let result = api_wait_task(url, "test-token".into(), "existing".into(), 5000);
        server.join().unwrap();
        assert_eq!(result.unwrap().status, "COMPLETED");
    }

    #[test]
    fn task_poll_recovers_transient_read_failure_without_resubmitting() {
        let (url, server) = task_server(vec![503, 200], 0);
        let result = api_wait_task(url, "test-token".into(), "existing".into(), 5000);
        server.join().unwrap();
        assert_eq!(result.unwrap().status, "COMPLETED");
    }

    #[test]
    fn task_poll_bounds_failure_retries_and_does_not_retry_auth() {
        for responses in [vec![503, 503, 503], vec![401], vec![429]] {
            let expected = *responses.last().unwrap();
            let (url, server) = task_server(responses, 0);
            let error = api_wait_task(url, "test-token".into(), "existing".into(), 5000).unwrap_err();
            server.join().unwrap();
            assert!(matches!(error, ApiError::Server { status, .. } if status == expected));
        }
    }

    /// SCREENSHOT_EGRESS_TRUTH: gateway へ行く turn に画素が無い。添付は id / kind / label だけ。
    #[test]
    fn turn_body_carries_ids_and_labels_but_never_pixels() {
        let atts = vec![TurnAttachment {
            id: "0a1b2c3d-0000-4000-8000-000000000001".into(),
            kind: "screenshot".into(),
            label: "スクリーンショット（たった今）".into(),
        }];
        let body = turn_body("これ何？", &atts);
        let obj = body.as_object().expect("object");
        let mut keys: Vec<&String> = obj.keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["attachments", "interrupt", "modality", "text"]);
        let att = body["attachments"][0].as_object().expect("attachment object");
        let mut att_keys: Vec<&String> = att.keys().collect();
        att_keys.sort();
        assert_eq!(att_keys, vec!["id", "kind", "label"]);
        for (_, v) in att { assert!(v.is_string(), "attachment fields are short strings, never bytes"); }
        let serialized = body.to_string();
        assert!(serialized.len() < 512, "a turn with an attachment stays tiny: {} bytes", serialized.len());
        assert!(!serialized.contains("data:image") && !serialized.contains("base64"));
    }

    fn gateway() -> Option<String> {
        std::env::var("ASTRA_GATEWAY_URL").ok().filter(|s| !s.is_empty())
    }

    #[test]
    fn dev_sign_in_then_me_round_trips_through_the_real_gateway() {
        let Some(url) = gateway() else {
            eprintln!("skip: set ASTRA_GATEWAY_URL to run against a live gateway");
            return;
        };
        let email = format!("core-api-{}@astra.local", std::process::id());
        let tokens = api_dev_sign_in(url.clone(), email.clone(), "Core API".into())
            .expect("dev sign-in should succeed against a live gateway");
        assert!(!tokens.access_token.is_empty());
        let me = api_me(url.clone(), tokens.access_token.clone()).expect("/v1/me should succeed");
        assert_eq!(me.email, email);
        assert_eq!(me.role, "owner");

        // 会議の作成 → 録音（実断片）→ 送信 → 終了。すべて core 経由、Tauri を介さない。
        let meeting_id = api_create_meeting(url.clone(), tokens.access_token.clone(), "core E2E".into(), "ja-JP".into())
            .expect("create meeting should succeed");
        assert!(!meeting_id.is_empty());

        let root = std::env::temp_dir().join(format!("astra-api-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        let session = crate::session::RecordingSession::start(
            root.to_string_lossy().to_string(), meeting_id.clone()).unwrap();
        let one_sec = vec![0.1f32; crate::recording::WIRE_SAMPLE_RATE as usize];
        for _ in 0..6 { session.push_samples(one_sec.clone(), crate::recording::WIRE_SAMPLE_RATE); }
        session.finish().unwrap();
        let sent = api_upload_meeting_audio(
            url.clone(), tokens.access_token.clone(), meeting_id.clone(),
            root.to_string_lossy().to_string()).expect("audio upload should succeed");
        assert!(sent > 0, "should have uploaded fragment bytes");
        let _ = std::fs::remove_dir_all(&root);

        let meeting_id_for_segments = meeting_id.clone();
        let task_id = api_finish_meeting(url.clone(), tokens.access_token.clone(), meeting_id)
            .expect("finish meeting should return a finalize task id");
        assert!(!task_id.is_empty());

        // 会話/Agent: 依頼 → 仕事 id（Agent 経路が Tauri を介さず動く）
        let conv = api_start_conversation(url.clone(), tokens.access_token.clone())
            .expect("start conversation");
        assert!(!conv.is_empty());
        let outcome = api_send_turn(url.clone(), tokens.access_token.clone(), conv, "テスト依頼を実行して".into())
            .expect("send turn");
        // 経路が通れば、task_id / 聞き返し / 即答 / notice のいずれかが返る（dev は notice）
        assert!(!outcome.task_id.is_empty() || outcome.needs_clarification || !outcome.answer.is_empty() || !outcome.notice.is_empty());

        // Apps: plugin catalog（同梱が並ぶ）
        let apps = api_plugin_catalog(url.clone(), tokens.access_token.clone()).expect("plugin catalog");
        assert!(!apps.is_empty(), "builtin plugins should be listed");

        // Agent round-trip: echo タスク → 完了まで待つ → COMPLETED + 成果物
        let task = api_create_task(
            url.clone(), tokens.access_token.clone(), "echo".into(),
            "{\"message\":\"core e2e\",\"steps\":1}".into()).expect("create task");
        assert!(!task.is_empty());
        let done = api_wait_task(url.clone(), tokens.access_token.clone(), task, 15_000).expect("wait task");
        assert_eq!(done.status, "COMPLETED", "echo task should complete");
        assert!(!done.result_artifact_id.is_empty(), "echo should produce an artifact");

        // 成果物の本文まで読める（Agent → 成果物 → 内容の完全ループ）
        let content = api_artifact_content(url.clone(), tokens.access_token.clone(), done.result_artifact_id)
            .expect("artifact content");
        assert!(!content.is_empty(), "artifact content should not be empty");

        // Library に成果物が並ぶ
        let library = api_library(url.clone(), tokens.access_token.clone()).expect("library");
        assert!(!library.is_empty(), "library should list the produced artifact");

        // transcript の取得経路（dev の STT は未接続のことがあるので件数は 0 以上でよい）
        let _segs = api_meeting_segment_count(url, tokens.access_token, meeting_id_for_segments)
            .expect("segments endpoint should respond");
    }
}

/// 録音済み断片を gateway の音声 WS へ送る（POST 相当の upgrade + binary frames）。
/// `journal_root/<meeting_id>/mic/NNNNNN.pcm` を順に送る。送ったバイト数を返す。
///
/// これで native は Tauri を介さず、作成→録音→**送信**→終了を実バックエンドで通せる。
#[uniffi::export]
pub fn api_upload_meeting_audio(
    base_url: String,
    access_token: String,
    meeting_id: String,
    journal_root: String,
) -> Result<u64, ApiError> {
    use tungstenite::client::IntoClientRequest;
    use tungstenite::Message;

    let ws_base = base(&base_url)
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let url = format!("{ws_base}/v1/meetings/{meeting_id}/audio");
    let mut request = url
        .into_client_request()
        .map_err(|e| ApiError::Network { message: format!("bad audio url: {e}") })?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {access_token}")
            .parse()
            .map_err(|_| ApiError::Network { message: "token is not a valid header".into() })?,
    );
    let (mut socket, _) =
        tungstenite::connect(request).map_err(|e| ApiError::Network { message: e.to_string() })?;

    let mic_dir = std::path::Path::new(&journal_root).join(&meeting_id).join("mic");
    let mut entries: Vec<_> = std::fs::read_dir(&mic_dir)
        .map_err(|e| ApiError::Network { message: format!("no fragments: {e}") })?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "pcm").unwrap_or(false))
        .collect();
    entries.sort();

    let mut sent = 0u64;
    for path in entries {
        let bytes = std::fs::read(&path)
            .map_err(|e| ApiError::Network { message: e.to_string() })?;
        sent += bytes.len() as u64;
        socket
            .send(Message::Binary(bytes))
            .map_err(|e| ApiError::Network { message: e.to_string() })?;
    }
    let _ = socket.close(None);
    Ok(sent)
}

/// 会話を始める（POST /v1/conversations）。会話 id を返す。
#[uniffi::export]
pub fn api_start_conversation(base_url: String, access_token: String) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Resp { id: String }
    let resp: Resp = ureq::post(&format!("{}/v1/conversations", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({ "response_mode": "text" }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.id)
}

/// 依頼を送る（POST /v1/conversations/:id/turns）。Agent が仕事を起こしたら task_id。
#[derive(uniffi::Record, Clone, Debug, serde::Serialize)]
pub struct TurnOutcome {
    pub needs_clarification: bool,
    /// 聞き返し or 即答（無ければ空）。
    pub answer: String,
    /// 仕事が起きたらその id（無ければ空）。
    pub task_id: String,
    /// 仕事を起こさなかった理由・一言（無ければ空）。
    pub notice: String,
    /// 返信案なら、宛先・出所・何を踏まえたか（`ReplyDraftMeta` の JSON。無ければ空）。
    pub reply_json: String,
}

/// この turn に添えた端末内の画像（スクショ / クリップボード画像）。
///
/// **画素はここを通らない。**cloud へ渡すのは id とラベルだけで、実体は端末の
/// `visual-context/<id>.png` にあり、端末で走るモデル呼び出しがそこから読む。
#[derive(uniffi::Record, Clone, Debug, serde::Serialize)]
pub struct TurnAttachment {
    /// 端末側の受け渡しファイル名になる（`[A-Za-z0-9-]{1,64}`）。
    pub id: String,
    /// "screenshot" | "clipboard_image"
    pub kind: String,
    /// 「スクリーンショット（たった今）」など。指示語の解決に使う。
    pub label: String,
}

#[uniffi::export]
pub fn api_send_turn(
    base_url: String,
    access_token: String,
    conversation_id: String,
    text: String,
) -> Result<TurnOutcome, ApiError> {
    api_send_turn_with_attachments(base_url, access_token, conversation_id, text, Vec::new())
}

/// turn の本文。**画素はここに無い。**添付は id / kind / label の 3 つだけ（検査で固定する）。
pub fn turn_body(text: &str, attachments: &[TurnAttachment]) -> serde_json::Value {
    serde_json::json!({
        "text": text,
        "modality": "text",
        "interrupt": true,
        "attachments": attachments,
    })
}

/// 依頼を送る。端末内の画像を添えるとき（「これ何？」）はこちら。撮っただけでは呼ばない。
#[uniffi::export]
pub fn api_send_turn_with_attachments(
    base_url: String,
    access_token: String,
    conversation_id: String,
    text: String,
    attachments: Vec<TurnAttachment>,
) -> Result<TurnOutcome, ApiError> {
    let resp: TurnResponse = ureq::post(&format!(
        "{}/v1/conversations/{}/turns",
        base(&base_url),
        conversation_id
    ))
    .set("Authorization", &format!("Bearer {access_token}"))
    .send_json(turn_body(&text, &attachments))
    .map_err(map_transport)?
    .into_json()
    .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(TurnOutcome {
        needs_clarification: resp.needs_clarification,
        answer: resp.answer_text(),
        task_id: resp.task_id.unwrap_or_default(),
        notice: resp.notice.unwrap_or_default(),
        reply_json: resp.reply.map(|v| v.to_string()).unwrap_or_default(),
    })
}

/// 「これ返して」の候補つきで依頼を送る。候補は `ReplyCandidate` の JSON 配列（端末が決めた順）。
#[uniffi::export]
pub fn api_send_turn_with_reply_candidates(
    base_url: String,
    access_token: String,
    conversation_id: String,
    text: String,
    attachments: Vec<TurnAttachment>,
    reply_candidates_json: String,
) -> Result<TurnOutcome, ApiError> {
    let candidates: serde_json::Value =
        serde_json::from_str(&reply_candidates_json).unwrap_or(serde_json::json!([]));
    let mut body = turn_body(&text, &attachments);
    if let serde_json::Value::Object(ref mut map) = body {
        map.insert("reply_candidates".to_string(), candidates);
    }
    let resp: TurnResponse = ureq::post(&format!(
        "{}/v1/conversations/{}/turns",
        base(&base_url),
        conversation_id
    ))
    .set("Authorization", &format!("Bearer {access_token}"))
    .send_json(body)
    .map_err(map_transport)?
    .into_json()
    .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(TurnOutcome {
        needs_clarification: resp.needs_clarification,
        answer: resp.answer_text(),
        task_id: resp.task_id.unwrap_or_default(),
        notice: resp.notice.unwrap_or_default(),
        reply_json: resp.reply.map(|v| v.to_string()).unwrap_or_default(),
    })
}

/// Apps（GET /v1/plugins/catalog）。name の一覧だけ（UI が並べる分）。
#[uniffi::export]
pub fn api_plugin_catalog(base_url: String, access_token: String) -> Result<Vec<String>, ApiError> {
    #[derive(Deserialize)]
    struct Item { name: String }
    #[derive(Deserialize)]
    struct Resp { items: Vec<Item> }
    let resp: Resp = ureq::get(&format!("{}/v1/plugins/catalog", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.items.into_iter().map(|i| i.name).collect())
}

/// 仕事の状態（GET /v1/tasks/:id）。
#[derive(uniffi::Record, Clone, Debug, serde::Serialize)]
pub struct TaskStatus {
    pub id: String,
    pub status: String,
    /// 完成した成果物 id（無ければ空）。
    pub result_artifact_id: String,
}

/// 仕事を起こす（POST /v1/tasks）。Agent 実行の入口。task id を返す。
#[uniffi::export]
pub fn api_create_task(
    base_url: String,
    access_token: String,
    kind: String,
    input_json: String,
) -> Result<String, ApiError> {
    let input: serde_json::Value =
        serde_json::from_str(&input_json).unwrap_or(serde_json::json!({}));
    #[derive(Deserialize)]
    struct Resp { id: String }
    let resp: Resp = ureq::post(&format!("{}/v1/tasks", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Idempotency-Key", &idem_key())
        .send_json(ureq::json!({ "kind": kind, "input": input }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.id)
}

/// 仕事の状態を引く。
#[uniffi::export]
pub fn api_task_status(
    base_url: String,
    access_token: String,
    task_id: String,
) -> Result<TaskStatus, ApiError> {
    #[derive(Deserialize)]
    struct Resp {
        id: String,
        status: String,
        #[serde(default)]
        result_artifact_id: Option<String>,
    }
    let resp: Resp = ureq::get(&format!("{}/v1/tasks/{}", base(&base_url), task_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(TaskStatus {
        id: resp.id,
        status: resp.status,
        result_artifact_id: resp.result_artifact_id.unwrap_or_default(),
    })
}

/// 完了まで待つ（poll）。timeout_ms を超えたら最後の状態を返す。UI は進捗表示に使う。
#[uniffi::export]
pub fn api_wait_task(
    base_url: String,
    access_token: String,
    task_id: String,
    timeout_ms: u64,
) -> Result<TaskStatus, ApiError> {
    let start = std::time::Instant::now();
    let mut transient_failures = 0;
    loop {
        let st = match api_task_status(base_url.clone(), access_token.clone(), task_id.clone()) {
            Ok(st) => { transient_failures = 0; st }
            Err(error) => {
                // Only repeat the read of an existing task. Never recreate a
                // task or retry authentication, permission, or rate-limit errors.
                let transient = matches!(error, ApiError::Network { .. }
                    | ApiError::Server { status: 502 | 503 | 504, .. });
                transient_failures += 1;
                if !transient || transient_failures >= 3
                    || start.elapsed().as_millis() as u64 >= timeout_ms {
                    return Err(error);
                }
                std::thread::sleep(std::time::Duration::from_millis(1000.min(
                    timeout_ms.saturating_sub(start.elapsed().as_millis() as u64))));
                continue;
            }
        };
        if matches!(st.status.as_str(), "COMPLETED" | "FAILED" | "CANCELLED") {
            return Ok(st);
        }
        if start.elapsed().as_millis() as u64 >= timeout_ms {
            return Ok(st);
        }
        // 200ms polling alone consumes the general API's entire 300/min
        // allowance, leaving no room for the host or the rest of the app.
        std::thread::sleep(std::time::Duration::from_millis(1000.min(
            timeout_ms.saturating_sub(start.elapsed().as_millis() as u64))));
    }
}

/// 成果物の本文（GET /v1/artifacts/:id/content）。テキスト成果物を UI に出す。
#[uniffi::export]
pub fn api_artifact_content(
    base_url: String,
    access_token: String,
    artifact_id: String,
) -> Result<String, ApiError> {
    let body = ureq::get(&format!("{}/v1/artifacts/{}/content", base(&base_url), artifact_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_string()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(body)
}

/// Library（GET /v1/artifacts）。title の一覧（UI が並べる分）。
#[uniffi::export]
pub fn api_library(base_url: String, access_token: String) -> Result<Vec<String>, ApiError> {
    #[derive(Deserialize)]
    struct Item { title: String }
    #[derive(Deserialize)]
    struct Resp { items: Vec<Item> }
    let resp: Resp = ureq::get(&format!("{}/v1/artifacts", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.items.into_iter().map(|i| i.title).collect())
}

/// 会議の文字起こし（GET /v1/meetings/:id/segments）。行数を返す（STT 未接続の dev では 0 もある）。
#[uniffi::export]
pub fn api_meeting_segment_count(
    base_url: String,
    access_token: String,
    meeting_id: String,
) -> Result<u32, ApiError> {
    #[derive(Deserialize)]
    struct Resp { #[serde(default)] items: Vec<serde_json::Value> }
    let resp: Resp = ureq::get(&format!("{}/v1/meetings/{}/segments", base(&base_url), meeting_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.items.len() as u32)
}

// ---------------------------------------------------------------- Work Context

/// 認証つき GET。本文をそのまま返す（JSON は Swift 側で Codable に写す）。
///
/// Work Context は入れ子の深い構造（priority → factors → sources）で、uniffi の Record に
/// 写すと Rust と Swift の両方に同じ形を 2 度書くことになる。契約の正本は TypeScript 側
/// （`@genie/contracts` の zod）なので、ここは運ぶだけにして形を持たない。
fn get_json(base_url: &str, access_token: &str, path: &str) -> Result<String, ApiError> {
    ureq::get(&format!("{}{}", base(base_url), path))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?
        .into_string()
        .map_err(|e| ApiError::Decode { message: e.to_string() })
}

/// path の 1 区切りにする（RFC 3986 unreserved 以外は %XX）。
/// item id は `owed:gmail:m1` のような形で、そのまま入れると経路が変わる。
fn path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Home の Work Context（GET /v1/work/context）。JSON 本文。
#[uniffi::export]
pub fn api_work_context(base_url: String, access_token: String) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, "/v1/work/context")
}

/// 1 件の出所（GET /v1/work/evidence/:itemId）。JSON 本文。
#[uniffi::export]
pub fn api_work_evidence(
    base_url: String,
    access_token: String,
    item_id: String,
) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, &format!("/v1/work/evidence/{}", path_segment(&item_id)))
}

/// 本人の訂正（POST /v1/work/corrections）。1 操作。
#[uniffi::export]
pub fn api_work_correct(
    base_url: String,
    access_token: String,
    item_id: String,
    action: String,
    note: String,
) -> Result<(), ApiError> {
    let body = ureq::json!({
        "item_id": item_id,
        "action": action,
        "note": if note.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(note) },
    });
    ureq::post(&format!("{}/v1/work/corrections", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body)
        .map_err(map_transport)?;
    Ok(())
}

/// Genie が使っている本人の情報（GET /v1/personalization）。JSON 本文。
#[uniffi::export]
pub fn api_personalization(base_url: String, access_token: String) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, "/v1/personalization")
}

/// 確認・使わない・全体の停止（PUT /v1/personalization）。更新後の profile を JSON で返す。
#[uniffi::export]
pub fn api_personalization_update(
    base_url: String,
    access_token: String,
    update_json: String,
) -> Result<String, ApiError> {
    let update: serde_json::Value =
        serde_json::from_str(&update_json).map_err(|e| ApiError::Decode { message: e.to_string() })?;
    ureq::put(&format!("{}/v1/personalization", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(update)
        .map_err(map_transport)?
        .into_string()
        .map_err(|e| ApiError::Decode { message: e.to_string() })
}

#[cfg(test)]
mod work_tests {
    use super::*;

    #[test]
    fn evidence_ids_with_colons_are_escaped_in_the_path() {
        assert_eq!(path_segment("owed:gmail:m1/x"), "owed%3Agmail%3Am1%2Fx");
        assert_eq!(path_segment("project:MOPITA"), "project%3AMOPITA");
        assert_eq!(path_segment("plain-id_1.0~"), "plain-id_1.0~");
    }
}

// ---------------------------------------------------------------- connections

/// plugin の接続記録（GET /v1/plugins/:id/connections）。JSON 本文（`items`）。
#[uniffi::export]
pub fn api_plugin_connections(
    base_url: String,
    access_token: String,
    plugin_id: String,
) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, &format!("/v1/plugins/{}/connections", path_segment(&plugin_id)))
}

/// 繋いだことを cloud に記録する（POST /v1/plugins/:id/connect）。**参照だけ。値は渡さない。**
#[uniffi::export]
pub fn api_plugin_connect(
    base_url: String,
    access_token: String,
    plugin_id: String,
    connect_json: String,
) -> Result<String, ApiError> {
    let body: serde_json::Value =
        serde_json::from_str(&connect_json).map_err(|e| ApiError::Decode { message: e.to_string() })?;
    ureq::post(&format!("{}/v1/plugins/{}/connect", base(&base_url), path_segment(&plugin_id)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body)
        .map_err(map_transport)?
        .into_string()
        .map_err(|e| ApiError::Decode { message: e.to_string() })
}

/// 接続を切る（DELETE /v1/plugins/:id/connections/:connector）。
#[uniffi::export]
pub fn api_plugin_disconnect(
    base_url: String,
    access_token: String,
    plugin_id: String,
    connector_id: String,
) -> Result<(), ApiError> {
    ureq::delete(&format!(
        "{}/v1/plugins/{}/connections/{}",
        base(&base_url),
        path_segment(&plugin_id),
        path_segment(&connector_id)
    ))
    .set("Authorization", &format!("Bearer {access_token}"))
    .call()
    .map_err(map_transport)?;
    Ok(())
}

// ---------------------------------------------------------------- reply / brief / approvals

/** 返信を送る task を起こす（POST /v1/work/reply/send）。承認は別（`api_task_approve`）。task id を返す。 */
#[uniffi::export]
pub fn api_work_reply_send(
    base_url: String,
    access_token: String,
    send_json: String,
) -> Result<String, ApiError> {
    let body: serde_json::Value =
        serde_json::from_str(&send_json).map_err(|e| ApiError::Decode { message: e.to_string() })?;
    #[derive(Deserialize)]
    struct Resp { task_id: String }
    let resp: Resp = ureq::post(&format!("{}/v1/work/reply/send", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body)
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.task_id)
}

/** 次の会議の brief（GET /v1/work/brief/next）。無ければ空文字。 */
#[uniffi::export]
pub fn api_work_brief_next(base_url: String, access_token: String) -> Result<String, ApiError> {
    let resp = ureq::get(&format!("{}/v1/work/brief/next", base(&base_url)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(map_transport)?;
    if resp.status() == 204 {
        return Ok(String::new());
    }
    resp.into_string().map_err(|e| ApiError::Decode { message: e.to_string() })
}

/** 答えを待っている承認（GET /v1/tasks/:id/approvals）。JSON 本文。 */
#[uniffi::export]
pub fn api_task_approvals(
    base_url: String,
    access_token: String,
    task_id: String,
) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, &format!("/v1/tasks/{}/approvals", path_segment(&task_id)))
}

/** 承認に答える（POST /v1/tasks/:id/approve）。decision は APPROVED / REJECTED。 */
#[uniffi::export]
pub fn api_task_approve(
    base_url: String,
    access_token: String,
    task_id: String,
    approval_id: String,
    decision: String,
) -> Result<(), ApiError> {
    ureq::post(&format!("{}/v1/tasks/{}/approve", base(&base_url), path_segment(&task_id)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({ "approval_id": approval_id, "decision": decision }))
        .map_err(map_transport)?;
    Ok(())
}

/// 動いている仕事へ追加指示を渡す（POST /v1/tasks/:id/instructions）。返すのは状態（RECEIVED など）。
/// 受け取った ≠ 反映した。反映したかは一覧（GET 同じパス）で分かる。終わった仕事は 409（task.invalid_state）。
/// `request_id` は呼ぶ側が保存しておき、送り直しても 1 件にする。
#[uniffi::export]
pub fn api_add_task_instruction(
    base_url: String,
    access_token: String,
    task_id: String,
    request_id: String,
    text: String,
) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Resp {
        status: String,
    }
    let resp: Resp = ureq::post(&format!("{}/v1/tasks/{}/instructions", base(&base_url), path_segment(&task_id)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({ "request_id": request_id, "text": text }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.status)
}

/// 仕事を取り消す（POST /v1/tasks/:id/cancel）。返すのは取り消し後の状態（CANCELLING / CANCELLED）。
/// 終わった仕事は 409（task.invalid_state）。呼ぶのは人が「止める」を押したときだけ。
#[uniffi::export]
pub fn api_cancel_task(base_url: String, access_token: String, task_id: String, reason: String) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Resp {
        status: String,
    }
    let resp: Resp = ureq::post(&format!("{}/v1/tasks/{}/cancel", base(&base_url), path_segment(&task_id)))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(ureq::json!({ "reason": reason }))
        .map_err(map_transport)?
        .into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(resp.status)
}

/// 仕事そのもの（GET /v1/tasks/:id）。JSON 本文。失敗の理由（error.code）を読むために使う。
#[uniffi::export]
pub fn api_task_json(base_url: String, access_token: String, task_id: String) -> Result<String, ApiError> {
    get_json(&base_url, &access_token, &format!("/v1/tasks/{}", path_segment(&task_id)))
}

/// One-time initial profile; only the four user-facing operations are exposed.
#[uniffi::export]
pub fn api_initial_profile(
    base_url: String,
    access_token: String,
    operation: String,
    body_json: String,
) -> Result<String, ApiError> {
    let path = "/v1/work/initial-profile";
    if operation == "get" { return get_json(&base_url, &access_token, path); }
    let (method, suffix) = match operation.as_str() {
        "begin" => ("POST", ""),
        "confirm" => ("PUT", ""),
        "retry" => ("POST", "/retry"),
        _ => return Err(ApiError::Decode { message: "unsupported initial profile operation".into() }),
    };
    let body: serde_json::Value = serde_json::from_str(&body_json)
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    let response = ureq::request(method, &format!("{}{}{}", base(&base_url), path, suffix))
        .timeout(std::time::Duration::from_secs(20))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body).map_err(map_transport)?;
    if response.status() == 204 { return Ok("{}".into()); }
    response.into_string().map_err(|e| ApiError::Decode { message: e.to_string() })
}


/// Wire shape shared by submission and read-only recovery. Legacy strings also decode.
#[derive(Deserialize)]
struct TurnResponse {
    needs_clarification: bool,
    #[serde(default)]
    answer: Option<serde_json::Value>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    notice: Option<String>,
    #[serde(default)]
    reply: Option<serde_json::Value>,
}
impl TurnResponse {
    fn answer_text(&self) -> String {
        self.answer.as_ref().and_then(|v| v.as_str().or_else(|| v.get("text").and_then(|t| t.as_str())))
            .unwrap_or_default().to_string()
    }
    fn outcome(self) -> TurnOutcome {
        TurnOutcome { needs_clarification: self.needs_clarification, answer: self.answer_text(),
            task_id: self.task_id.unwrap_or_default(), notice: self.notice.unwrap_or_default(),
            reply_json: self.reply.map(|v| v.to_string()).unwrap_or_default() }
    }
}

/// Send exactly once with a caller-persisted identity. There is no transport retry.
#[uniffi::export]
pub fn api_send_recoverable_turn(base_url: String, access_token: String, conversation_id: String,
    request_id: String, text: String, attachments: Vec<TurnAttachment>, reply_candidates_json: String,
) -> Result<TurnOutcome, ApiError> {
    let mut body = turn_body(&text, &attachments);
    body["request_id"] = serde_json::Value::String(request_id);
    if !reply_candidates_json.is_empty() {
        body["reply_candidates"] = serde_json::from_str(&reply_candidates_json)
            .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    }
    let response: TurnResponse = ureq::post(&format!("{}/v1/conversations/{}/turns", base(&base_url), conversation_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body).map_err(map_transport)?.into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(response.outcome())
}

/// Pending is not failure/success. This GET never starts or resumes external execution.
#[uniffi::export]
pub fn api_recover_turn(base_url: String, access_token: String, conversation_id: String,
    request_id: String,
) -> Result<Option<TurnOutcome>, ApiError> {
    #[derive(Deserialize)]
    #[serde(tag = "status", rename_all = "lowercase")]
    enum Receipt { Pending, Resolved { response: TurnResponse } }
    let receipt: Receipt = ureq::get(&format!("{}/v1/conversations/{}/requests/{}", base(&base_url), conversation_id, request_id))
        .set("Authorization", &format!("Bearer {access_token}"))
        .call().map_err(map_transport)?.into_json()
        .map_err(|e| ApiError::Decode { message: e.to_string() })?;
    Ok(match receipt { Receipt::Pending => None, Receipt::Resolved { response } => Some(response.outcome()) })
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn lost_response_is_recovered_by_get_without_a_second_post() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0u8; 1];
                while !bytes.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); bytes.push(byte[0]); }
                let head = String::from_utf8(bytes).unwrap();
                let length = head.lines().find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                let mut body = vec![0; length]; stream.read_exact(&mut body).unwrap();
                requests.push((head.lines().next().unwrap().to_string(), body));
                if index == 0 { continue; } // Server accepted; response is lost.
                let body = r#"{"status":"resolved","response":{"needs_clarification":false,"task_id":"original-task","notice":null}}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            requests
        });
        let id = "00000000-0000-4000-8000-000000000001".to_string();
        assert!(api_send_recoverable_turn(url.clone(), "test-token".into(), "conversation".into(), id.clone(), "メモを整理".into(), vec![], "".into()).is_err());
        let outcome = api_recover_turn(url, "test-token".into(), "conversation".into(), id.clone()).unwrap().unwrap();
        assert_eq!(outcome.task_id, "original-task");
        let requests = server.join().unwrap();
        assert_eq!(requests[0].0, "POST /v1/conversations/conversation/turns HTTP/1.1");
        assert_eq!(requests[1].0, format!("GET /v1/conversations/conversation/requests/{id} HTTP/1.1"));
        let body: serde_json::Value = serde_json::from_slice(&requests[0].1).unwrap();
        assert_eq!(body["request_id"], id);
        assert_eq!(body["text"], "メモを整理");
    }

    #[test]
    fn clarification_object_and_legacy_string_preserve_the_answer() {
        for answer in [serde_json::json!({"text":"対象を教えてください"}), serde_json::json!("対象を教えてください")] {
            let response: TurnResponse = serde_json::from_value(serde_json::json!({"needs_clarification":true,"answer":answer})).unwrap();
            let result = response.outcome();
            assert!(result.needs_clarification);
            assert_eq!(result.answer, "対象を教えてください");
            assert!(result.task_id.is_empty());
        }
    }
}
