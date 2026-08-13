//! Android 内嵌 sidecar —— 移植自 scripts/local-api.mjs。
//! 保持 HTTP 契约与桌面版完全一致（端口 4318、路由、响应结构、错误文案），
//! 前端 app/lib/xhs-client.ts 零改动复用。

mod category;
mod media;
mod note_import;
mod resolver;

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncSeekExt, SeekFrom};

const DEFAULT_PORT: u16 = 4318;
const EXTENSION_HEARTBEAT_WINDOW_MS: u64 = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct ServerState {
    pub data_directory: PathBuf,
    pub media_directory: PathBuf,
    pub public_base_url: String,
    pub mutation_queue: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl ServerState {
    pub fn new(data_directory: PathBuf) -> Self {
        let media_directory = data_directory.join("media");
        let public_base_url = format!("http://127.0.0.1:{DEFAULT_PORT}");
        Self {
            data_directory,
            media_directory,
            public_base_url,
            mutation_queue: Arc::new(Mutex::new(None)),
        }
    }
}

/// 启动内嵌 sidecar（Android）。blocking：调用方应放入独立线程。
pub fn start_server_blocking(data_directory: PathBuf, port: u16) -> Result<(), String> {
    let runtime = tokio::runtime::Runtime::new().map_err(|err| format!("tokio runtime 启动失败：{err}"))?;
    runtime.block_on(async move {
        let state = ServerState::new(data_directory);
        let app = build_router(state);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|err| format!("绑定端口 {port} 失败：{err}"))?;
        axum::serve(listener, app)
            .await
            .map_err(|err| format!("sidecar 服务运行失败：{err}"))
    })
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/health", get(handle_health))
        .route("/setup", get(handle_setup))
        .route("/setup/extension/heartbeat", post(handle_heartbeat))
        .route("/notes", get(handle_notes))
        .route("/notes/import", post(handle_import))
        .route("/notes/{note_id}", delete(handle_delete))
        .route("/media/{note_id}/{file}", get(handle_media))
        .fallback(handle_not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors_middleware,
        ))
        .with_state(state)
}

fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if origin.starts_with("chrome-extension://") {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() == "tauri:" {
        return true;
    }
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") => true,
        _ => false,
    }
}

fn is_heartbeat_request(req: &Request<Body>) -> bool {
    req.method() == Method::POST && req.uri().path() == "/setup/extension/heartbeat"
}

async fn cors_middleware(
    State(state): State<ServerState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|s| s.to_string());

    let allowed = match origin.as_deref() {
        Some(origin) if !is_allowed_origin(Some(origin)) => {
            // 心跳端点放行 xiaohongshu.com origin（扩展放行；Android 无扩展，保留兼容）
            if is_heartbeat_request(&req) && origin.ends_with("xiaohongshu.com") {
                true
            } else {
                return error_json(StatusCode::FORBIDDEN, "Origin not allowed");
            }
        }
        _ => true,
    };

    let mut response = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };

    if allowed {
        if let Some(origin) = origin {
            if let Ok(value) = HeaderValue::from_str(&origin) {
                response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            }
        }
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,POST,DELETE,OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
        response.headers_mut().insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }
    response
}

fn json_response(status: StatusCode, payload: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        payload.to_string(),
    )
        .into_response()
}

fn ok_json(payload: Value) -> Response {
    json_response(StatusCode::OK, payload)
}

fn error_json(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"ok": false, "error": message}))
}

// ---------- 数据读写 ----------

async fn read_notes_file(file_path: &FsPath) -> Vec<Value> {
    let raw = match tokio::fs::read_to_string(file_path).await {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(arr)) => arr
            .into_iter()
            .filter(|note| {
                let id = note["id"].as_str().map(|s| s.trim()).unwrap_or("");
                let title = note["title"].as_str().unwrap_or("");
                let raw_content = note["rawContent"].as_str().unwrap_or("");
                let cover_url = note["coverUrl"].as_str().unwrap_or("");
                !id.is_empty() && (!title.is_empty() || !raw_content.is_empty() || !cover_url.is_empty())
            })
            .collect(),
        _ => Vec::new(),
    }
}

async fn read_notes(state: &ServerState) -> Vec<Value> {
    tokio::fs::create_dir_all(&state.data_directory).await.ok();
    tokio::fs::create_dir_all(&state.media_directory).await.ok();
    read_notes_file(&state.data_directory.join("notes.json")).await
}

async fn write_notes(state: &ServerState, notes: &Value) -> Result<(), String> {
    tokio::fs::create_dir_all(&state.data_directory)
        .await
        .map_err(|err| format!("创建数据目录失败：{err}"))?;
    let temp_path = state.data_directory.join("notes.next.json");
    let final_path = state.data_directory.join("notes.json");
    let serialized = serde_json::to_string_pretty(notes).map_err(|err| format!("笔记序列化失败：{err}"))?;
    tokio::fs::write(&temp_path, format!("{serialized}\n"))
        .await
        .map_err(|err| format!("笔记写入失败：{err}"))?;
    tokio::fs::rename(&temp_path, &final_path)
        .await
        .map_err(|err| format!("笔记写入失败：{err}"))?;
    Ok(())
}

fn get_last_imported_at(notes: &[Value]) -> Option<String> {
    let mut max_ts: i64 = 0;
    for note in notes {
        if let Some(ts) = note["savedAt"].as_str().and_then(|s| parse_iso_millis(s)) {
            if ts > max_ts {
                max_ts = ts;
            }
        }
    }
    if max_ts == 0 {
        None
    } else {
        Some(note_import::format_iso_from_unix((max_ts / 1000) as u64, (max_ts % 1000) as u32))
    }
}

/// 解析 ISO-8601（YYYY-MM-DDTHH:MM:SS.sssZ）为 epoch 毫秒；失败返回 None
fn parse_iso_millis(value: &str) -> Option<i64> {
    let digits: Vec<i64> = value
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(6)
        .filter_map(|part| part.parse::<i64>().ok())
        .collect();
    if digits.len() < 3 {
        return None;
    }
    let year = *digits.get(0)?;
    let month = *digits.get(1)?;
    let day = *digits.get(2)?;
    let hour = digits.get(3).copied().unwrap_or(0);
    let minute = digits.get(4).copied().unwrap_or(0);
    let second = digits.get(5).copied().unwrap_or(0);

    let days = days_from_civil(year, month, day)?;
    let total_secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(total_secs * 1000)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if month < 1 || month > 12 || day < 1 || day > 31 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

// ---------- 处理器 ----------

async fn handle_health(State(state): State<ServerState>) -> Response {
    ok_json(json!({
        "ok": true,
        "port": DEFAULT_PORT,
        "platform": "android",
        "dataDirectory": state.data_directory.to_string_lossy(),
        "localOcr": false,
        "ocr": {
            "engine": null,
            "available": false,
            "languages": [],
            "error": null,
        },
    }))
}

async fn handle_setup(State(state): State<ServerState>) -> Response {
    ok_json(json!({
        "extension": {
            "available": false,
            "path": null,
            "version": null,
            "connected": false,
            "browsers": { "chrome": false, "edge": false },
        },
        "agent": {
            "available": false,
            "serverPath": null,
            "nodePath": null,
            "dataDirectory": state.data_directory.to_string_lossy(),
            "clients": {
                "hermes": { "available": false, "connected": false },
                "codex": { "available": false, "connected": false },
                "claude": { "available": false, "connected": false },
            },
            "manualConfig": null,
        },
    }))
}

async fn handle_heartbeat() -> Response {
    ok_json(json!({"ok": true}))
}

async fn handle_notes(State(state): State<ServerState>) -> Response {
    let notes = read_notes(&state).await;
    ok_json(json!({
        "notes": notes,
        "lastImportedAt": get_last_imported_at(&notes),
    }))
}

async fn read_json_body(body: Bytes) -> Result<Value, Response> {
    if body.len() > MAX_BODY_BYTES {
        return Err(error_json(StatusCode::BAD_REQUEST, "导入内容过大"));
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(value) => Ok(value),
        Err(_) => Err(error_json(StatusCode::BAD_REQUEST, "导入数据格式不正确")),
    }
}

async fn handle_import(State(state): State<ServerState>, body: Bytes) -> Response {
    let parsed = match read_json_body(body).await {
        Ok(value) => value,
        Err(resp) => return resp,
    };

    let result = run_import(&state, parsed).await;
    match result {
        Ok(payload) => ok_json(payload),
        Err(message) => error_json(StatusCode::BAD_REQUEST, &message),
    }
}

async fn run_import(state: &ServerState, body: Value) -> Result<Value, String> {
    let input = body["input"].as_str().unwrap_or("").to_string();
    let note_payload = body.get("note").cloned();

    let normalized = if let Some(payload) = note_payload {
        if payload.is_object() {
            note_import::normalize_imported_note(&payload)?
        } else {
            let dragged = note_import::parse_dragged_note_input(&input)?;
            match dragged {
                Some(payload) => note_import::normalize_imported_note(&payload)?,
                None => resolve_via_input(&input).await?,
            }
        }
    } else {
        resolve_via_input(&input).await?
    };

    let localized = media::localize_note_media(&normalized, &state.media_directory, &state.public_base_url).await;

    let mut note = localized;
    note["category"] = Value::String(category::infer_category_from_note(&note));
    note["savedAt"] = Value::String(note_import::chrono_now_iso_public());

    let existing = read_notes(state).await;
    let (created, merged) = note_import::merge_imported_note(&Value::Array(existing), &note);
    write_notes(state, &merged).await?;

    Ok(json!({
        "notes": merged,
        "note": note,
        "created": created,
        "lastImportedAt": note["savedAt"].clone(),
    }))
}

/// 输入兜底链路：拖拽卡片 payload → 共享文本 → URL 匿名解析
async fn resolve_via_input(input: &str) -> Result<Value, String> {
    if let Some(card) = note_import::parse_dragged_card_input(input)? {
        let source_url = card["sourceUrl"].as_str().unwrap_or("").to_string();
        let expected_id = card["id"].as_str().unwrap_or("").to_string();
        let resolved = resolver::resolve_anonymous_note(&source_url, Some(&expected_id)).await?;
        let title = card["title"].as_str().unwrap_or("").to_string();
        let mut normalized = note_import::normalize_imported_note(&resolved)?;
        if normalized["title"].as_str().unwrap_or("").is_empty() && !title.is_empty() {
            normalized["title"] = Value::String(title);
        }
        return Ok(normalized);
    }

    match note_import::note_from_shared_text(input) {
        Ok(note) => Ok(note),
        Err(shared_err) => {
            // 共享文本不可用时，尝试纯 URL 匿名解析
            let source_url = note_import::extract_shared_note_url(input)?;
            let note_id = note_import::extract_note_id_from_url(&source_url);
            let resolved = resolver::resolve_anonymous_note(&source_url, note_id.as_deref()).await?;
            let _ = shared_err;
            note_import::normalize_imported_note(&resolved)
        }
    }
}

async fn handle_delete(State(state): State<ServerState>, Path(note_id): Path<String>) -> Response {
    let id_pattern = regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap();
    let note_id = note_id.to_ascii_lowercase();
    if !id_pattern.is_match(&note_id) {
        return error_json(StatusCode::BAD_REQUEST, "无效的笔记 ID");
    }

    let existing = read_notes(&state).await;
    let (deleted, rest) = note_import::remove_stored_note(&Value::Array(existing), &note_id);
    if deleted.is_none() {
        return error_json(StatusCode::NOT_FOUND, "笔记不存在或已被删除");
    }

    if let Err(message) = write_notes(&state, &rest).await {
        return error_json(StatusCode::INTERNAL_SERVER_ERROR, &message);
    }
    let media_dir = state.media_directory.join(&note_id);
    let _ = tokio::fs::remove_dir_all(&media_dir).await;

    let rest_array = rest.as_array().cloned().unwrap_or_default();
    ok_json(json!({
        "notes": rest,
        "deletedId": note_id,
        "lastImportedAt": get_last_imported_at(&rest_array),
    }))
}

const MEDIA_CONTENT_TYPES: [(&str, &str); 8] = [
    (".avif", "image/avif"),
    (".gif", "image/gif"),
    (".heic", "image/heic"),
    (".heif", "image/heif"),
    (".jpg", "image/jpeg"),
    (".png", "image/png"),
    (".webp", "image/webp"),
    (".mp4", "video/mp4"),
];

fn media_content_type(extension: &str) -> Option<&'static str> {
    MEDIA_CONTENT_TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

async fn handle_media(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((note_id, file)): Path<(String, String)>,
) -> Response {
    let id_pattern = regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap();
    let file_pattern = regex::Regex::new(r"(?i)^(?:\d{2}\.(?:avif|gif|heic|heif|jpg|png|webp)|video\.mp4)$").unwrap();
    if !id_pattern.is_match(&note_id) || !file_pattern.is_match(&file) {
        return error_json(StatusCode::NOT_FOUND, "Media not found");
    }

    let file_path = state.media_directory.join(note_id.to_ascii_lowercase()).join(file.to_ascii_lowercase());
    let metadata = match tokio::fs::metadata(&file_path).await {
        Ok(metadata) => metadata,
        Err(_) => return error_json(StatusCode::NOT_FOUND, "Media not found"),
    };
    if !metadata.is_file() {
        return error_json(StatusCode::NOT_FOUND, "Media not found");
    }

    let extension = file_path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    let content_type = media_content_type(&extension).unwrap_or("application/octet-stream");
    let size = metadata.len();

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    resp_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );

    // Range 支持（视频拖动播放必需）
    if let Some(range_header) = headers.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        if let Some((start, end)) = parse_range(range_header, size) {
            if start >= size || start > end {
                return json_response(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    json!({"error": "Range not satisfiable"}),
                )
                .into_response();
            }
            let length = end - start + 1;
            let mut file = match tokio::fs::File::open(&file_path).await {
                Ok(file) => file,
                Err(_) => return error_json(StatusCode::NOT_FOUND, "Media not found"),
            };
            if let Err(_) = file.seek(SeekFrom::Start(start)).await {
                return error_json(StatusCode::INTERNAL_SERVER_ERROR, "流式响应失败");
            }
            let stream = tokio_util::io::ReaderStream::with_capacity(file, 128 * 1024).take(length as usize);
            let body = Body::from_stream(stream);
            return Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, length)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
                .body(body)
                .unwrap_or_else(|_| error_json(StatusCode::INTERNAL_SERVER_ERROR, "流式响应失败"));
        }
    }

    let file = match tokio::fs::File::open(&file_path).await {
        Ok(file) => file,
        Err(_) => return error_json(StatusCode::NOT_FOUND, "Media not found"),
    };
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 128 * 1024);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, size)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| error_json(StatusCode::INTERNAL_SERVER_ERROR, "流式响应失败"))
}

fn parse_range(range_header: &str, size: u64) -> Option<(u64, u64)> {
    let prefix = "bytes=";
    let rest = range_header.strip_prefix(prefix)?;
    let (start_raw, end_raw) = rest.split_once('-')?;
    let start: u64 = if start_raw.is_empty() {
        // suffix range: 最后 N 字节
        let suffix: u64 = end_raw.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        if suffix >= size {
            return Some((0, size.saturating_sub(1)));
        }
        return Some((size - suffix, size - 1));
    } else {
        start_raw.trim().parse().ok()?
    };
    let end: u64 = if end_raw.is_empty() {
        size.saturating_sub(1)
    } else {
        end_raw.trim().parse().ok()?
    };
    Some((start, end))
}

async fn handle_not_found() -> Response {
    error_json(StatusCode::NOT_FOUND, "Not found")
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::time::Duration;

    fn temp_data_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shoucang-server-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 起一个内嵌 server（独立线程 + 独立 tokio runtime），返回数据目录
    async fn spawn_server(tag: &str, port: u16) -> PathBuf {
        let data_dir = temp_data_dir(tag);
        let dir = data_dir.clone();
        std::thread::spawn(move || {
            let _ = start_server_blocking(dir, port);
        });
        // 等待就绪
        let client = reqwest::Client::new();
        for _ in 0..50 {
            if let Ok(resp) = client.get(format!("http://127.0.0.1:{port}/health")).send().await {
                if resp.status().is_success() {
                    return data_dir;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("server did not start on port {port}");
    }

    #[tokio::test]
    async fn health_and_notes_contract() {
        let dir = spawn_server("health", 24318).await;
        let client = reqwest::Client::new();

        let health: Value = client
            .get("http://127.0.0.1:24318/health")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["ok"], true);
        assert_eq!(health["port"], 4318);
        assert_eq!(health["platform"], "android");
        assert_eq!(health["localOcr"], false);

        let notes: Value = client.get("http://127.0.0.1:24318/notes").send().await.unwrap().json().await.unwrap();
        assert_eq!(notes["notes"].as_array().unwrap().len(), 0);
        assert!(notes["lastImportedAt"].is_null());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn import_delete_roundtrip() {
        let dir = spawn_server("import", 24319).await;
        let client = reqwest::Client::new();

        // 完整 payload 导入（无媒体，mediaStatus none，不触网）
        let payload = json!({
            "note": {
                "sourceUrl": "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef",
                "title": "端到端测试标题",
                "content": "端到端测试正文内容，验证导入链路完整性",
                "imageUrls": [],
            }
        });
        let import: Value = client
            .post("http://127.0.0.1:24319/notes/import")
            .json(&payload)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(import["created"], true);
        assert_eq!(import["note"]["id"], "abcdef0123456789abcdef");
        assert_eq!(import["note"]["mediaStatus"], "none");
        assert_eq!(import["note"]["category"], "待分类");
        assert!(!import["note"]["savedAt"].as_str().unwrap().is_empty());

        // notes.json 落盘
        let notes_file = dir.join("notes.json");
        assert!(notes_file.exists());
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&notes_file).unwrap()).unwrap();
        assert_eq!(stored.as_array().unwrap().len(), 1);

        // 重复导入 → created false 且不重复
        let reimport: Value = client
            .post("http://127.0.0.1:24319/notes/import")
            .json(&payload)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reimport["created"], false);
        assert_eq!(reimport["notes"].as_array().unwrap().len(), 1);

        // 删除
        let deleted: Value = client
            .delete("http://127.0.0.1:24319/notes/abcdef0123456789abcdef")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(deleted["deletedId"], "abcdef0123456789abcdef");
        assert_eq!(deleted["notes"].as_array().unwrap().len(), 0);

        // 再删 → 404
        let resp = client
            .delete("http://127.0.0.1:24319/notes/abcdef0123456789abcdef")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn media_range_and_origin_guard() {
        let dir = spawn_server("media", 24320).await;
        let client = reqwest::Client::new();

        // 媒体不存在 → 404
        let resp = client
            .get("http://127.0.0.1:24320/media/abcdef0123456789abcdef/01.webp")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // 造一个媒体文件验证 Range/206
        let media_dir = dir.join("media/abcdef0123456789abcdef");
        std::fs::create_dir_all(&media_dir).unwrap();
        let content = (0..4096).map(|i| (i % 251) as u8).collect::<Vec<u8>>();
        std::fs::write(media_dir.join("01.webp"), &content).unwrap();

        let full = client
            .get("http://127.0.0.1:24320/media/abcdef0123456789abcdef/01.webp")
            .send()
            .await
            .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[header::CONTENT_TYPE], "image/webp");
        assert_eq!(full.bytes().await.unwrap().len(), 4096);

        let ranged = client
            .get("http://127.0.0.1:24320/media/abcdef0123456789abcdef/01.webp")
            .header(header::RANGE, "bytes=100-199")
            .send()
            .await
            .unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.headers()[header::CONTENT_RANGE], "bytes 100-199/4096");
        let body = ranged.bytes().await.unwrap();
        assert_eq!(body.len(), 100);
        assert_eq!(body[0], content[100]);

        // 尾段 range
        let tail = client
            .get("http://127.0.0.1:24320/media/abcdef0123456789abcdef/01.webp")
            .header(header::RANGE, "bytes=-500")
            .send()
            .await
            .unwrap();
        assert_eq!(tail.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(tail.bytes().await.unwrap().len(), 500);

        // 非法 origin → 403
        let forbidden = client
            .get("http://127.0.0.1:24320/notes")
            .header(header::ORIGIN, "https://evil.example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        // tauri.localhost origin 放行
        let allowed = client
            .get("http://127.0.0.1:24320/notes")
            .header(header::ORIGIN, "https://tauri.localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        assert_eq!(
            allowed.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://tauri.localhost"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
