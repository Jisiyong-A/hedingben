//! 移植自 scripts/lib/bilibili-resolver.mjs —— B 站匿名解析器。
//! 与 Node 侧完全相同的匿名原则：
//! - 请求不带账号 Cookie（仅 opus/detail 携带固定 buvid3 指纹，每安装生成一次并持久化）
//! - 带浏览器 UA（Chrome 151）与 Referer https://www.bilibili.com
//! - 无重试、无退避、无 UA 轮换；412/403/HTML 风控直接抛受控错误
//!
//! B 站专属约束（与 Node 逐行等价）：
//! - b23.tv 302 展开（最多 3 跳、每跳校验宿主，展开后非 bilibili 域名拒绝）
//! - 视频链：x/web-interface/view → x/tag/archive/tags →（可选）x/player/playurl
//!   仅落 DASH 元数据（清晰度/时长/cid），不落签名 URL
//! - 图文链：x/polymer/web-dynamic/v1/opus/detail（固定 buvid3 指纹）；失败直接回退
//!   note_from_shared_text，不调 x/article/view

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use url::Url;

use super::note_import;

const REQUEST_TIMEOUT_MS: u64 = 20_000;
const MAX_REDIRECTS: u32 = 3;
const API_BASE: &str = "https://api.bilibili.com";

const BILI_HOSTS: [&str; 4] = ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"];

const BILI_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const BILI_REFERER: &str = "https://www.bilibili.com";
const BUVID3_SETTINGS_KEY: &str = "buvid3";

fn clean_string(value: &Value) -> String {
    value.as_str().map(|s| s.trim().to_string()).unwrap_or_default()
}

fn first_string(object: &Value, keys: &[&str]) -> String {
    for key in keys {
        let value = clean_string(&object[key]);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// 把 http:// 前缀替换为 https://（与 Node `replace(/^http:/i, 'https:')` 等价）。
fn to_https(value: &str) -> String {
    if value[..value.len().min(7)].to_ascii_lowercase().starts_with("http://") {
        format!("https:{}", &value[5..])
    } else {
        value.to_string()
    }
}

fn looks_like_http_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn buvid3_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\{[0-9a-f]{16}\}infoc$",
            )
            .unwrap()
        })
}

fn xorshift64(mut x: u64) -> u64 {
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

fn hex_group(rng: &mut u64, len: usize, upper: bool) -> String {
    let mut out = String::with_capacity(len);
    for _ in 0..len {
        *rng = xorshift64(*rng);
        let digit = (*rng % 16) as u8;
        out.push(if digit < 10 {
            (b'0' + digit) as char
        } else if upper {
            (b'A' + digit - 10) as char
        } else {
            (b'a' + digit - 10) as char
        });
    }
    out
}

/// 生成固定格式的 buvid3 指纹：`uuid{hex16}infoc`（每安装生成一次并持久化复用）。
pub fn generate_buvid3() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let pid = std::process::id() as u64;
    let seed = now ^ pid.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    let mut rng = if seed == 0 { 0x9e37_79b9_7f4a_7c15 } else { seed };

    let uuid = format!(
        "{}-{}-{}-{}-{}",
        hex_group(&mut rng, 8, true),
        hex_group(&mut rng, 4, true),
        hex_group(&mut rng, 4, true),
        hex_group(&mut rng, 4, true),
        hex_group(&mut rng, 12, true),
    );
    let entropy = hex_group(&mut rng, 16, false);
    format!("{uuid}{{{entropy}}}infoc")
}

/// 读取 dataDirectory/settings.json 中的 buvid3；不存在则生成一次并持久化，重启复用。
/// 持久化失败不阻断本次解析（极端磁盘场景），下次启动会重试生成 —— 与 Node 等价。
pub async fn get_or_create_buvid3(data_directory: Option<&Path>) -> String {
    let Some(dir) = data_directory else {
        return generate_buvid3();
    };
    let settings_path = dir.join("settings.json");

    let mut settings: Value = Value::Object(Default::default());
    if let Ok(raw) = tokio::fs::read_to_string(&settings_path).await {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            settings = parsed;
        }
    }
    if let Some(existing) = settings[BUVID3_SETTINGS_KEY].as_str() {
        if buvid3_pattern().is_match(existing) {
            return existing.to_string();
        }
    }

    let buvid3 = generate_buvid3();
    let mut next = settings.clone();
    next[BUVID3_SETTINGS_KEY] = Value::String(buvid3.clone());
    let _ = tokio::fs::create_dir_all(dir).await;
    if let Ok(serialized) = serde_json::to_string_pretty(&next) {
        let _ = tokio::fs::write(&settings_path, format!("{serialized}\n")).await;
    }
    buvid3
}

fn assert_allowed_bili_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "没有识别到有效的B站链接".to_string())?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if url.scheme() != "https" || !BILI_HOSTS.contains(&host.as_str()) {
        return Err("B站解析器只允许访问 bilibili 相关地址".to_string());
    }
    Ok(url)
}

/// 构建 API_BASE 下的接口 URL（query 自动百分号编码，等价 JS encodeURIComponent）。
fn api_url(path: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse(API_BASE).expect("valid API base");
    url.set_path(path);
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.to_string()
}

// ---------- HTTP 抽象：真实 reqwest 实现 + 测试 mock ----------

pub struct BiliResponse {
    pub status: u16,
    /// 请求返回后的最终 URL（reqwest response.url()；redirect none 时即请求 URL）。
    pub url: String,
    pub location: Option<String>,
    pub body: String,
}

/// 可注入的 fetch（对应 Node 的 fetchImpl 参数），测试用 mock 覆盖各分支。
pub trait BiliFetcher: Send + Sync {
    fn fetch(
        &self,
        url: &str,
        extra_headers: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = Result<BiliResponse, String>> + Send + '_>>;
}

/// 真实 reqwest 客户端：浏览器 UA + Referer + 无 Cookie 状态 + 手动重定向 + 20s 超时。
pub struct ReqwestFetcher {
    client: reqwest::Client,
}

impl ReqwestFetcher {
    pub fn new() -> Result<Self, String> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9"));
        headers.insert(USER_AGENT, HeaderValue::from_static(BILI_UA));
        headers.insert(REFERER, HeaderValue::from_static(BILI_REFERER));
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(REQUEST_TIMEOUT_MS))
            .build()
            .map_err(|err| format!("HTTP 客户端初始化失败：{err}"))?;
        Ok(Self { client })
    }
}

impl BiliFetcher for ReqwestFetcher {
    fn fetch(
        &self,
        url: &str,
        extra_headers: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = Result<BiliResponse, String>> + Send + '_>> {
        let client = self.client.clone();
        let url = url.to_string();
        Box::pin(async move {
            let mut request = client.get(&url);
            for (key, value) in extra_headers {
                request = request.header(&key, &value);
            }
            let response = request
                .send()
                .await
                .map_err(|err| format!("B站请求失败：{err}"))?;
            let status = response.status().as_u16();
            let final_url = response.url().to_string();
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(|s| s.to_string());
            let body = response
                .text()
                .await
                .map_err(|err| format!("B站响应读取失败：{err}"))?;
            Ok(BiliResponse {
                status,
                url: final_url,
                location,
                body,
            })
        })
    }
}

pub fn reqwest_fetcher() -> Result<ReqwestFetcher, String> {
    ReqwestFetcher::new()
}

/// 展开 b23.tv 官方短链到真实 B 站页面；非短链（bilibili.com 域名）原样返回。
/// 最多跟随 MAX_REDIRECTS 跳，每跳校验目标必须是 B 站允许域名，
/// 展开后不是 bilibili 域名（如被带去任意站点）直接拒绝。
pub async fn expand_bilibili_short_url<F: BiliFetcher + ?Sized>(
    value: &str,
    fetcher: &F,
) -> Result<Url, String> {
    let initial_url = assert_allowed_bili_url(value)?;
    if initial_url.host_str().unwrap_or("").to_ascii_lowercase() != "b23.tv" {
        return Ok(initial_url);
    }

    let mut current_url = initial_url;
    for redirect_count in 0..=MAX_REDIRECTS {
        let response = fetcher.fetch(current_url.as_str(), Vec::new()).await?;
        let status = response.status;
        if (300..400).contains(&status) {
            if redirect_count >= MAX_REDIRECTS {
                return Err("B站短链展开重定向次数过多".to_string());
            }
            let location = response
                .location
                .as_deref()
                .filter(|l| !l.is_empty())
                .ok_or_else(|| "B站短链展开缺少目标地址".to_string())?;
            let next = current_url
                .join(location)
                .map_err(|_| "B站短链展开缺少目标地址".to_string())?;
            let next = assert_allowed_bili_url(next.as_str())?;
            // 跳到 bilibili 正式域名即视为展开完成；仍是 b23.tv 则继续跟随。
            if next.host_str().unwrap_or("").to_ascii_lowercase() != "b23.tv" {
                return Ok(next);
            }
            current_url = next;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("B站短链展开请求失败：{status}"));
        }
        return Ok(current_url);
    }

    Err("B站短链展开失败".to_string())
}

/// 请求 B 站 JSON 接口：校验宿主、拦截 412/403/HTML 风控页，返回解析后的 JSON。
async fn fetch_bili_json<F: BiliFetcher + ?Sized>(
    url: &str,
    fetcher: &F,
    extra_headers: Vec<(String, String)>,
) -> Result<Value, String> {
    let response = fetcher.fetch(url, extra_headers).await?;

    let final_host = Url::parse(&response.url)
        .map(|u| u.host_str().unwrap_or("").to_ascii_lowercase())
        .unwrap_or_default();
    if final_host != "api.bilibili.com" {
        return Err("B站接口跳转到了未知地址，已拒绝".to_string());
    }
    if response.status == 412 || response.status == 403 {
        return Err("B站风控拦截，暂时无法匿名解析，请稍后重试".to_string());
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("B站接口请求失败：{}", response.status));
    }

    let trimmed = response.body.trim();
    // 风控/验证页面返回 HTML 而非 JSON，直接判为受控错误。
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return Err("B站接口返回了风控页面，暂时无法匿名解析".to_string());
    }
    serde_json::from_str(trimmed).map_err(|_| "B站接口返回了无法解析的内容".to_string())
}

fn assert_bili_code(payload: &Value) -> Result<Value, String> {
    let code = payload.get("code").and_then(|c| c.as_i64());
    match code {
        Some(0) => Ok(payload.get("data").cloned().unwrap_or(Value::Null)),
        Some(-412) => Err("B站风控拦截（-412），暂时无法匿名解析，请稍后重试".to_string()),
        Some(-404) => Err("该B站内容不存在或已删除".to_string()),
        Some(-400) => Err("B站接口参数错误".to_string()),
        _ => Err(format!(
            "B站接口返回错误（code={}）",
            code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
        )),
    }
}

/// 从 opus 图文的图片项中提取图片 URL（兼容 url / urlDefault / originUrl 字段）。
fn image_url_from_item(item: &Value) -> String {
    if let Some(s) = item.as_str() {
        return s.to_string();
    }
    if !item.is_object() {
        return String::new();
    }
    let direct = first_string(item, &["url", "urlDefault", "urlPre", "originUrl"]);
    if !direct.is_empty() && looks_like_http_url(&direct) {
        return to_https(&direct);
    }
    for list_key in ["urlList", "infoList", "stream"] {
        let list = item[list_key].as_array();
        if let Some(list) = list {
            for entry in list {
                let nested = image_url_from_item(entry);
                if !nested.is_empty() {
                    return nested;
                }
            }
        }
    }
    String::new()
}

fn picture_urls_from_opus(opus: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for key in ["pictures", "images", "imageList", "pics"] {
        let list = opus[key].as_array();
        if let Some(list) = list {
            for item in list {
                let url = image_url_from_item(item);
                if !url.is_empty() {
                    urls.push(url);
                }
            }
        }
    }
    let cover = image_url_from_item(&opus["cover"]);
    if !cover.is_empty() {
        urls.push(cover);
    }
    let mut seen = HashSet::new();
    urls.into_iter().filter(|u| seen.insert(u.clone())).take(20).collect()
}

/// 视频链：view → tags →（可选）playurl，仅落 DASH 元数据，不落签名 URL。
async fn resolve_video<F: BiliFetcher + ?Sized>(
    bvid: Option<&str>,
    aid: Option<i64>,
    source_url: &str,
    fetcher: &F,
) -> Result<Value, String> {
    let view_url = if let Some(bvid) = bvid {
        api_url("/x/web-interface/view", &[("bvid", bvid)])
    } else {
        api_url(
            "/x/web-interface/view",
            &[("aid", &aid.unwrap_or_default().to_string())],
        )
    };
    let view_payload = fetch_bili_json(&view_url, fetcher, Vec::new()).await?;
    let data = assert_bili_code(&view_payload)?;
    let resolved_bvid = {
        let from_data = first_string(&data, &["bvid"]);
        if from_data.is_empty() {
            bvid.unwrap_or("").to_string()
        } else {
            from_data
        }
    };
    let resolved_aid = data["aid"].as_i64().or(aid).unwrap_or_default();
    let cid = data["cid"].as_i64();
    if resolved_bvid.is_empty() || cid.is_none() {
        return Err("B站视频解析缺少必要字段（bvid/cid）".to_string());
    }
    let cid = cid.unwrap();

    // 标签接口失败不阻断主数据（降级为空，用分区名兜底）。
    let mut tags: Vec<String> = Vec::new();
    if let Ok(tags_payload) = fetch_bili_json(
        &api_url("/x/tag/archive/tags", &[("bvid", &resolved_bvid)]),
        fetcher,
        Vec::new(),
    )
    .await
    {
        if let Ok(tags_data) = assert_bili_code(&tags_payload) {
            if let Some(arr) = tags_data.as_array() {
                tags = arr
                    .iter()
                    .map(|tag| clean_string(&tag["tag_name"]))
                    .filter(|t| !t.is_empty())
                    .take(20)
                    .collect();
            }
        }
    }

    // DASH 链路：提取可直接下载的 mp4/m4s baseUrl，供 downloadVideo 本地落盘
    let mut dash_quality: Option<i64> = None;
    let mut dash_duration: Option<i64> = None;
    let mut playable_video_url = String::new();
    if let Ok(play_payload) = fetch_bili_json(
        &api_url(
            "/x/player/playurl",
            &[
                ("bvid", &resolved_bvid),
                ("cid", &cid.to_string()),
                ("fnval", "16"),
                ("fnver", "0"),
                ("fourk", "0"),
            ],
        ),
        fetcher,
        Vec::new(),
    )
    .await
    {
        if let Ok(play_data) = assert_bili_code(&play_payload) {
            dash_quality = play_data["quality"].as_i64();
            dash_duration = play_data["duration"].as_i64();
            let pick_video_base_url = |payload: &Value| -> String {
                if let Some(durl) = payload.get("durl").and_then(|v| v.as_array()) {
                    if let Some(url) = durl.first().and_then(|v| v.get("url")).and_then(|v| v.as_str()) {
                        return url.to_string();
                    }
                }
                if let Some(video) = payload
                    .get("dash")
                    .and_then(|v| v.get("video"))
                    .and_then(|v| v.as_array())
                {
                    if let Some(url) = video.first().and_then(|v| v.get("baseUrl")).and_then(|v| v.as_str()) {
                        return url.to_string();
                    }
                    if let Some(url) = video.first().and_then(|v| v.get("base_url")).and_then(|v| v.as_str()) {
                        return url.to_string();
                    }
                }
                String::new()
            };
            playable_video_url = pick_video_base_url(&play_data);
        }
    }

    let pic = to_https(&clean_string(&data["pic"]));
    let face = to_https(&clean_string(&data["owner"]["face"]));
    let title = clean_string(&data["title"]);
    let author_name = clean_string(&data["owner"]["name"]);
    let tname = clean_string(&data["tname"]);
    let mut image_urls: Vec<String> = Vec::new();
    if !pic.is_empty() {
        image_urls.push(pic.clone());
    }
    let tags_final = if !tags.is_empty() {
        tags
    } else if !tname.is_empty() {
        vec![tname]
    } else {
        Vec::new()
    };

    Ok(json!({
        "id": resolved_bvid,
        "sourceUrl": source_url,
        "title": if title.is_empty() { "未命名视频" } else { &title },
        "content": clean_string(&data["desc"]),
        "imageUrls": image_urls,
        "coverUrl": pic,
        "videoUrl": playable_video_url,
        "author": {
            "name": if author_name.is_empty() { "未知作者" } else { &author_name },
            "avatar": face,
            "userId": data["owner"]["mid"].as_i64().map(|m| m.to_string()).unwrap_or_default(),
        },
        "tags": tags_final,
        "type": "video",
        "bvid": resolved_bvid,
        "aid": resolved_aid,
        "cid": cid,
        "duration": data["duration"].as_i64().or(dash_duration),
        "quality": dash_quality,
    }))
}

/// 图文链：opus/detail（固定 buvid3 指纹），失败回退由调用方处理。
async fn resolve_opus<F: BiliFetcher + ?Sized>(
    opus_id: &str,
    source_url: &str,
    fetcher: &F,
    data_directory: Option<&Path>,
) -> Result<Value, String> {
    let buvid3 = get_or_create_buvid3(data_directory).await;

    let payload = fetch_bili_json(
        &api_url(
            "/x/polymer/web-dynamic/v1/opus/detail",
            &[("id", opus_id), ("features", "htmlNewStyle")],
        ),
        fetcher,
        vec![("Cookie".to_string(), format!("buvid3={buvid3}"))],
    )
    .await?;
    let data = assert_bili_code(&payload)?;
    let opus = data
        .get("item")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| data.clone());
    let opus = if opus.is_null() {
        Value::Object(Default::default())
    } else {
        opus
    };

    let title = first_string(&opus, &["title"]);
    let content = first_string(&opus, &["summary", "content", "text"]);
    let pictures = picture_urls_from_opus(&opus);
    if title.is_empty() && content.is_empty() && pictures.is_empty() {
        return Err("B站图文解析返回内容为空".to_string());
    }

    let face = to_https(&clean_string(&opus["author"]["face"]));
    let author_name = first_string(&opus["author"], &["name", "nickname"]);
    let resolved_id = {
        let raw = first_string(&opus, &["opus_id", "id"]);
        if raw.is_empty() {
            opus_id.to_string()
        } else {
            raw
        }
    };

    Ok(json!({
        "id": resolved_id,
        "sourceUrl": source_url,
        "title": if title.is_empty() { "未命名图文" } else { &title },
        "content": content,
        "imageUrls": pictures,
        "coverUrl": pictures.first().cloned().unwrap_or_default(),
        "videoUrl": "",
        "author": {
            "name": if author_name.is_empty() { "未知作者" } else { &author_name },
            "avatar": face,
            "userId": opus["author"]["mid"].as_i64().map(|m| m.to_string()).unwrap_or_default(),
        },
        "tags": [],
        "type": "normal",
        "opusId": opus_id.to_string(),
    }))
}

/// 解析 B 站分享链接（b23.tv / bilibili.com 视频或图文）。
/// - fetcher: 注入的 HTTP 实现（测试用 mock）
/// - data_directory: buvid3 指纹持久化目录（opus 解析需要）
/// - shared_text: 原始共享文本；opus 解析失败时回退 note_from_shared_text
pub async fn resolve_bilibili_note<F: BiliFetcher + ?Sized>(
    source_url: &str,
    fetcher: &F,
    data_directory: Option<&Path>,
    shared_text: Option<&str>,
) -> Result<Value, String> {
    let page_url = expand_bilibili_short_url(source_url, fetcher).await?;
    let pathname = page_url.path();
    let page_str = page_url.to_string();

    let bv_re = regex::Regex::new(r"^/video/(BV[a-zA-Z0-9]{10})(?:/|$)").unwrap();
    let av_re = regex::Regex::new(r"^/video/(av\d+)(?:/|$)").unwrap();
    let opus_re = regex::Regex::new(r"^/opus/(\d+)(?:/|$)").unwrap();

    if let Some(captures) = bv_re.captures(pathname) {
        let bvid = captures.get(1).unwrap().as_str().to_string();
        return resolve_video(Some(&bvid), None, &page_str, fetcher).await;
    }
    if let Some(captures) = av_re.captures(pathname) {
        let aid = captures.get(1).unwrap().as_str()[2..].parse::<i64>().unwrap_or_default();
        return resolve_video(None, Some(aid), &page_str, fetcher).await;
    }
    if let Some(captures) = opus_re.captures(pathname) {
        let opus_id = captures.get(1).unwrap().as_str().to_string();
        return match resolve_opus(&opus_id, &page_str, fetcher, data_directory).await {
            Ok(note) => Ok(note),
            Err(resolve_err) => {
                // 图文匿名解析失败直接回退共享文本；不调 x/article/view。
                if let Some(text) = shared_text {
                    let text = text.trim();
                    if !text.is_empty() {
                        if let Ok(note) = note_import::note_from_shared_text(text) {
                            return Ok(note);
                        }
                    }
                }
                Err(resolve_err)
            }
        };
    }
    Err("没有识别到B站视频或图文链接".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_json_body(url: &str, value: Value) -> BiliResponse {
        BiliResponse {
            status: 200,
            url: url.to_string(),
            location: None,
            body: value.to_string(),
        }
    }

    fn redirect_body(url: &str, location: &str, status: u16) -> BiliResponse {
        BiliResponse {
            status,
            url: url.to_string(),
            location: Some(location.to_string()),
            body: String::new(),
        }
    }

    /// 按 URL 子串分发的 mock fetcher；回调返回 (请求URL, 额外请求头)。
    fn mock(
        handler: impl Fn(&str, &[(String, String)]) -> Result<BiliResponse, String> + Send + Sync + 'static,
    ) -> MockFetcher {
        MockFetcher { handler: Box::new(handler) }
    }

    struct MockFetcher {
        handler: Box<dyn Fn(&str, &[(String, String)]) -> Result<BiliResponse, String> + Send + Sync>,
    }

    impl BiliFetcher for MockFetcher {
        fn fetch(
            &self,
            url: &str,
            extra_headers: Vec<(String, String)>,
        ) -> Pin<Box<dyn Future<Output = Result<BiliResponse, String>> + Send + '_>> {
            let handler: &(dyn Fn(&str, &[(String, String)]) -> Result<BiliResponse, String> + Send + Sync) =
                &self.handler;
            let url = url.to_string();
            Box::pin(async move { handler(&url, &extra_headers) })
        }
    }

    fn temp_data_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bili-resolver-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn assert_allowed_bili_url_allows_bili_and_rejects_others() {
        assert!(assert_allowed_bili_url("https://b23.tv/abc").is_ok());
        assert!(assert_allowed_bili_url("https://www.bilibili.com/video/BV1xx411c7mD").is_ok());
        assert!(assert_allowed_bili_url("https://m.bilibili.com/opus/123").is_ok());

        assert!(assert_allowed_bili_url("http://b23.tv/abc").is_err());
        assert!(assert_allowed_bili_url("https://example.com/x").is_err());
        assert!(assert_allowed_bili_url("https://www.xiaohongshu.com/explore/abc").is_err());
        assert!(assert_allowed_bili_url("not-a-url").is_err());
    }

    #[test]
    fn generate_buvid3_matches_pattern() {
        for _ in 0..50 {
            let value = generate_buvid3();
            assert!(
                buvid3_pattern().is_match(&value),
                "generated buvid3 does not match pattern: {value}"
            );
        }
        assert!(!buvid3_pattern().is_match("buvid3=foo"));
    }

    #[tokio::test]
    async fn get_or_create_buvid3_persists_and_reuses() {
        let dir = temp_data_dir("buvid3");
        let settings_path = dir.join("settings.json");

        let first = get_or_create_buvid3(Some(&dir)).await;
        assert!(buvid3_pattern().is_match(&first));

        // 重启复用：再读一次返回同一个指纹
        let second = get_or_create_buvid3(Some(&dir)).await;
        assert_eq!(first, second);

        // 已写入 settings.json
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(stored["buvid3"].as_str().unwrap(), first);

        // 预置合法指纹时直接复用
        let preset = "01234567-89AB-CDEF-0123-456789ABCDEF{0123456789abcdef}infoc";
        let mut settings = stored.clone();
        settings["buvid3"] = Value::String(preset.to_string());
        std::fs::write(&settings_path, settings.to_string()).unwrap();
        let reused = get_or_create_buvid3(Some(&dir)).await;
        assert_eq!(reused, preset);

        // 无 dataDirectory → 每次生成新指纹
        let fresh_a = get_or_create_buvid3(None).await;
        let fresh_b = get_or_create_buvid3(None).await;
        assert!(buvid3_pattern().is_match(&fresh_a));
        assert!(buvid3_pattern().is_match(&fresh_b));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn expand_short_url_chains_redirects() {
        // 单跳：b23.tv → www.bilibili.com
        let fetcher = mock(|url, _| {
            if url.starts_with("https://b23.tv/") {
                Ok(redirect_body(url, "https://www.bilibili.com/video/BV1xx411c7mD", 302))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });
        let url = expand_bilibili_short_url("https://b23.tv/short1", &fetcher)
            .await
            .unwrap();
        assert_eq!(url.as_str(), "https://www.bilibili.com/video/BV1xx411c7mD");

        // 多跳：b23.tv → b23.tv → bilibili.com
        let fetcher = mock(|url, _| {
            if url == "https://b23.tv/a" {
                Ok(redirect_body(url, "https://b23.tv/b", 302))
            } else if url == "https://b23.tv/b" {
                Ok(redirect_body(url, "https://m.bilibili.com/video/BV1xx411c7mD", 302))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });
        let url = expand_bilibili_short_url("https://b23.tv/a", &fetcher)
            .await
            .unwrap();
        assert_eq!(url.as_str(), "https://m.bilibili.com/video/BV1xx411c7mD");

        // 非短链原样返回
        let fetcher = mock(|url, _| Ok(ok_json_body(url, json!({}))));
        let url = expand_bilibili_short_url("https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap();
        assert_eq!(url.as_str(), "https://www.bilibili.com/video/BV1xx411c7mD");
    }

    #[tokio::test]
    async fn expand_short_url_rejects_bad_redirects() {
        // 无限重定向（永远 b23.tv）→ 次数过多
        let fetcher = mock(|url, _| Ok(redirect_body(url, "https://b23.tv/next", 302)));
        let err = expand_bilibili_short_url("https://b23.tv/loop", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("次数过多"), "unexpected: {err}");

        // 跳到非 bilibili 域名 → 拒绝
        let fetcher = mock(|url, _| {
            if url == "https://b23.tv/evil" {
                Ok(redirect_body(url, "https://evil.example.com/x", 302))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });
        let err = expand_bilibili_short_url("https://b23.tv/evil", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("只允许访问"), "unexpected: {err}");

        // 缺少 location → 拒绝
        let fetcher = mock(|url, _| Ok(redirect_body(url, "", 302)));
        let err = expand_bilibili_short_url("https://b23.tv/noloc", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("缺少目标地址"), "unexpected: {err}");
    }

    #[tokio::test]
    async fn fetch_bili_json_rejects_risk_and_bad_host() {
        // 412 → 风控
        let fetcher = mock(|url, _| {
            Ok(BiliResponse { status: 412, url: url.to_string(), location: None, body: "{}".to_string() })
        });
        let err = fetch_bili_json("https://api.bilibili.com/x/web-interface/view?bvid=BV1", &fetcher, Vec::new())
            .await
            .unwrap_err();
        assert!(err.contains("风控"), "unexpected: {err}");

        // HTML 风控页 → 受控错误
        let fetcher = mock(|url, _| {
            Ok(BiliResponse {
                status: 200,
                url: url.to_string(),
                location: None,
                body: "<html><body>risk</body></html>".to_string(),
            })
        });
        let err = fetch_bili_json("https://api.bilibili.com/x/web-interface/view?bvid=BV1", &fetcher, Vec::new())
            .await
            .unwrap_err();
        assert!(err.contains("风控页面"), "unexpected: {err}");

        // 最终 host 非 api.bilibili.com → 拒绝
        let fetcher = mock(|_url, _| {
            Ok(BiliResponse {
                status: 200,
                url: "https://evil.example.com/x".to_string(),
                location: None,
                body: "{}".to_string(),
            })
        });
        let err = fetch_bili_json("https://api.bilibili.com/x/web-interface/view?bvid=BV1", &fetcher, Vec::new())
            .await
            .unwrap_err();
        assert!(err.contains("未知地址"), "unexpected: {err}");
    }

    #[test]
    fn assert_bili_code_branches() {
        assert_eq!(assert_bili_code(&json!({"code": 0, "data": {"x": 1}})).unwrap()["x"], 1);
        assert_eq!(assert_bili_code(&json!({"code": 0})).unwrap(), Value::Null);

        let err = assert_bili_code(&json!({"code": -412})).unwrap_err();
        assert!(err.contains("风控"), "unexpected: {err}");
        let err = assert_bili_code(&json!({"code": -404})).unwrap_err();
        assert!(err.contains("不存在"), "unexpected: {err}");
        let err = assert_bili_code(&json!({"code": -400})).unwrap_err();
        assert!(err.contains("参数错误"), "unexpected: {err}");
        let err = assert_bili_code(&json!({"code": 500})).unwrap_err();
        assert!(err.contains("code=500"), "unexpected: {err}");
        let err = assert_bili_code(&json!({})).unwrap_err();
        assert!(err.contains("unknown"), "unexpected: {err}");
    }

    #[test]
    fn picture_urls_from_opus_extracts_and_dedups() {
        let opus = json!({
            "pictures": [
                { "url": "http://i0.hdslb.com/p1.jpg" },
                { "url": "https://i0.hdslb.com/p1.jpg" }, // http 转 https 后与上一条去重
                { "originUrl": "https://i0.hdslb.com/p2.jpg" },
            ],
            "cover": { "url": "https://i0.hdslb.com/cover.jpg" },
        });
        let urls = picture_urls_from_opus(&opus);
        assert_eq!(urls.len(), 3, "unexpected: {urls:?}");
        assert!(urls[0].starts_with("https://i0.hdslb.com/p1.jpg"), "unexpected: {urls:?}");
        assert!(urls.contains(&"https://i0.hdslb.com/p2.jpg".to_string()));
        assert!(urls.contains(&"https://i0.hdslb.com/cover.jpg".to_string()));
    }

    fn view_payload_json() -> Value {
        json!({
            "code": 0,
            "data": {
                "bvid": "BV1xx411c7mD",
                "aid": 123,
                "cid": 456,
                "title": "测试视频",
                "desc": "视频描述",
                "pic": "http://i0.hdslb.com/bfs/archive/abc.jpg",
                "duration": 120,
                "tname": "科技",
                "owner": {
                    "name": "作者甲",
                    "mid": 10001,
                    "face": "http://i0.hdslb.com/bfs/face/face.jpg",
                },
            }
        })
    }

    fn route_video_chain(fetcher_url: &str, handler: &dyn Fn(&str, &[(String, String)]) -> Result<BiliResponse, String>) -> Option<BiliResponse> {
        if fetcher_url.contains("/x/web-interface/view") {
            Some(handler(fetcher_url, &[]).unwrap_or_else(|_| ok_json_body(fetcher_url, view_payload_json())))
        } else if fetcher_url.contains("/x/tag/archive/tags") {
            Some(ok_json_body(
                fetcher_url,
                json!({"code": 0, "data": [{"tag_name": "标签一"}, {"tag_name": "标签二"}]}),
            ))
        } else if fetcher_url.contains("/x/player/playurl") {
            Some(ok_json_body(
                fetcher_url,
                json!({"code": 0, "data": {"quality": 64, "duration": 120}}),
            ))
        } else {
            None
        }
    }

    #[tokio::test]
    async fn resolve_video_happy_path_and_no_signed_urls() {
        let fetcher = mock(|url, _| {
            if url.contains("/x/web-interface/view") {
                Ok(ok_json_body(url, view_payload_json()))
            } else if url.contains("/x/tag/archive/tags") {
                Ok(ok_json_body(
                    url,
                    json!({"code": 0, "data": [{"tag_name": "标签一"}, {"tag_name": "标签二"}]}),
                ))
            } else if url.contains("/x/player/playurl") {
                // playurl 返回带签名 URL 的完整 dash；解析器必须只落元数据
                Ok(ok_json_body(
                    url,
                    json!({
                        "code": 0,
                        "data": {
                            "quality": 64,
                            "duration": 120,
                            "dash": {
                                "video": [{"baseUrl": "https://upos-hz-mirrorakam.akamaized.net/sign.mp4?token=abc"}],
                                "audio": [{"baseUrl": "https://upos-hz-mirrorakam.akamaized.net/sign.m4a?token=abc"}],
                            }
                        }
                    }),
                ))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });

        let note = resolve_video(Some("BV1xx411c7mD"), None, "https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap();
        assert_eq!(note["id"], "BV1xx411c7mD");
        assert_eq!(note["type"], "video");
        assert_eq!(note["bvid"], "BV1xx411c7mD");
        assert_eq!(note["aid"], 123);
        assert_eq!(note["cid"], 456);
        assert_eq!(note["title"], "测试视频");
        assert_eq!(note["content"], "视频描述");
        assert_eq!(note["duration"], 120);
        assert_eq!(note["quality"], 64);
        assert_eq!(note["videoUrl"], "https://upos-hz-mirrorakam.akamaized.net/sign.mp4?token=abc");
        assert_eq!(note["author"]["name"], "作者甲");
        assert_eq!(note["author"]["userId"], "10001");
        assert!(note["coverUrl"].as_str().unwrap().starts_with("https://"));
        assert_eq!(note["tags"].as_array().unwrap().len(), 2);
        assert_eq!(note["tags"][0], "标签一");

        // 仅允许落单条可播放 videoUrl，不得落 dash 原始字段
        let serialized = note.to_string();
        assert!(!serialized.contains("dash"), "dash leaked: {serialized}");
        assert!(!serialized.contains("baseUrl"), "baseUrl leaked: {serialized}");
    }

    #[tokio::test]
    async fn resolve_video_tags_and_playurl_failures_degrade() {
        // tags / playurl 失败 → 降级，不报错
        let fetcher = mock(|url, _| {
            if url.contains("/x/web-interface/view") {
                Ok(ok_json_body(url, view_payload_json()))
            } else {
                Err("network down".to_string())
            }
        });
        let note = resolve_video(Some("BV1xx411c7mD"), None, "https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap();
        // 标签失败 → 用分区名 tname 兜底
        assert_eq!(note["tags"].as_array().unwrap().len(), 1);
        assert_eq!(note["tags"][0], "科技");
        // playurl 失败 → quality 为空
        assert!(note["quality"].is_null());
        assert_eq!(note["duration"], 120); // 回落 view 的 duration
    }

    #[tokio::test]
    async fn resolve_video_errors_propagate() {
        // view 返回 -404 → 不存在
        let fetcher = mock(|url, _| {
            Ok(ok_json_body(url, json!({"code": -404, "message": "nope"})))
        });
        let err = resolve_video(Some("BV1xx411c7mD"), None, "https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("不存在"), "unexpected: {err}");

        // view 缺 cid → 缺少必要字段
        let fetcher = mock(|url, _| {
            Ok(ok_json_body(url, json!({"code": 0, "data": {"bvid": "BV1xx411c7mD", "title": "x"}})))
        });
        let err = resolve_video(Some("BV1xx411c7mD"), None, "https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("bvid/cid"), "unexpected: {err}");

        // 风控 412 → 受控错误
        let fetcher = mock(|url, _| {
            Ok(BiliResponse { status: 412, url: url.to_string(), location: None, body: "{}".to_string() })
        });
        let err = resolve_video(Some("BV1xx411c7mD"), None, "https://www.bilibili.com/video/BV1xx411c7mD", &fetcher)
            .await
            .unwrap_err();
        assert!(err.contains("风控"), "unexpected: {err}");
    }

    #[tokio::test]
    async fn resolve_opus_happy_path_with_cookie() {
        let dir = temp_data_dir("opus");
        let fetcher = mock(|url, headers| {
            assert!(
                url.contains("/x/polymer/web-dynamic/v1/opus/detail"),
                "unexpected url: {url}"
            );
            assert!(
                url.contains("features=htmlNewStyle"),
                "unexpected url: {url}"
            );
            // 必须携带固定 buvid3 Cookie
            let cookie = headers.iter().find(|(k, _)| k == "Cookie").map(|(_, v)| v.as_str());
            assert!(cookie.is_some(), "missing Cookie header");
            assert!(
                cookie.unwrap().starts_with("buvid3="),
                "unexpected cookie: {:?}",
                cookie
            );
            Ok(ok_json_body(
                url,
                json!({
                    "code": 0,
                    "data": {
                        "item": {
                            "opus_id": 999,
                            "title": "图文标题",
                            "summary": "图文摘要",
                            "pictures": [
                                {"url": "https://i0.hdslb.com/bfs/opus/p1.jpg"},
                                {"url": "https://i0.hdslb.com/bfs/opus/p2.jpg"},
                            ],
                            "author": {
                                "name": "作者乙",
                                "mid": 20002,
                                "face": "https://i0.hdslb.com/bfs/face/b.jpg",
                            },
                        }
                    }
                }),
            ))
        });

        let note = resolve_opus("999", "https://www.bilibili.com/opus/999", &fetcher, Some(&dir))
            .await
            .unwrap();
        assert_eq!(note["id"], "999");
        assert_eq!(note["opusId"], "999");
        assert_eq!(note["type"], "normal");
        assert_eq!(note["title"], "图文标题");
        assert_eq!(note["content"], "图文摘要");
        assert_eq!(note["videoUrl"], "");
        assert_eq!(note["imageUrls"].as_array().unwrap().len(), 2);
        assert_eq!(note["coverUrl"], "https://i0.hdslb.com/bfs/opus/p1.jpg");
        assert_eq!(note["author"]["name"], "作者乙");
        assert_eq!(note["author"]["userId"], "20002");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn resolve_opus_empty_content_errors() {
        let dir = temp_data_dir("opus-empty");
        let fetcher = mock(|url, _| {
            Ok(ok_json_body(
                url,
                json!({"code": 0, "data": {"item": {"opus_id": 1, "title": "", "summary": ""}}}),
            ))
        });
        let err = resolve_opus("1", "https://www.bilibili.com/opus/1", &fetcher, Some(&dir))
            .await
            .unwrap_err();
        assert!(err.contains("内容为空"), "unexpected: {err}");

        // 接口 412 → 风控错误
        let fetcher = mock(|url, _| {
            Ok(BiliResponse { status: 412, url: url.to_string(), location: None, body: "{}".to_string() })
        });
        let err = resolve_opus("1", "https://www.bilibili.com/opus/1", &fetcher, Some(&dir))
            .await
            .unwrap_err();
        assert!(err.contains("风控"), "unexpected: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn resolve_note_bv_and_av_video() {
        // BV 视频全链路（b23.tv 展开 → view → tags → playurl）
        let fetcher = mock(|url, _| {
            if url == "https://b23.tv/x" {
                Ok(redirect_body(url, "https://www.bilibili.com/video/BV1xx411c7mD", 302))
            } else if url.contains("/x/web-interface/view") {
                Ok(ok_json_body(url, view_payload_json()))
            } else if url.contains("/x/tag/archive/tags") {
                Ok(ok_json_body(url, json!({"code": 0, "data": []})))
            } else if url.contains("/x/player/playurl") {
                Ok(ok_json_body(url, json!({"code": 0, "data": {"quality": 64}})))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });
        let note = resolve_bilibili_note("https://b23.tv/x", &fetcher, None, None)
            .await
            .unwrap();
        assert_eq!(note["id"], "BV1xx411c7mD");
        assert_eq!(note["type"], "video");

        // av 视频链
        let fetcher = mock(|url, _| {
            if url.contains("/x/web-interface/view") {
                assert!(url.contains("aid=123"), "unexpected: {url}");
                Ok(ok_json_body(url, view_payload_json()))
            } else if url.contains("/x/tag/archive/tags") {
                Ok(ok_json_body(url, json!({"code": 0, "data": []})))
            } else if url.contains("/x/player/playurl") {
                Ok(ok_json_body(url, json!({"code": 0, "data": {}})))
            } else {
                Ok(ok_json_body(url, json!({})))
            }
        });
        let note = resolve_bilibili_note("https://www.bilibili.com/video/av123", &fetcher, None, None)
            .await
            .unwrap();
        assert_eq!(note["id"], "BV1xx411c7mD");
        assert_eq!(note["type"], "video");
    }

    #[tokio::test]
    async fn resolve_note_opus_falls_back_to_shared_text() {
        let dir = temp_data_dir("opus-fb");
        // opus 接口 412 风控 → 回退 note_from_shared_text
        let fetcher = mock(|url, _| {
            Ok(BiliResponse { status: 412, url: url.to_string(), location: None, body: "{}".to_string() })
        });
        let shared = "图文标题文字\nhttps://www.bilibili.com/opus/999\n这是一段超过十二个字符的正文内容";
        let note = resolve_bilibili_note(
            "https://www.bilibili.com/opus/999",
            &fetcher,
            Some(&dir),
            Some(shared),
        )
        .await
        .unwrap();
        // 回退产物是共享文本 note（normalize_imported_note 结构）
        assert!(!note["title"].as_str().unwrap_or("").is_empty());
        assert!(!note["content"].as_str().unwrap_or("").is_empty());

        // 无 shared_text → 原错误透传
        let err = resolve_bilibili_note("https://www.bilibili.com/opus/999", &fetcher, Some(&dir), None)
            .await
            .unwrap_err();
        assert!(err.contains("风控"), "unexpected: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn resolve_note_unrecognized_path() {
        let fetcher = mock(|url, _| Ok(ok_json_body(url, json!({}))));
        let err = resolve_bilibili_note("https://www.bilibili.com/whatever/xyz", &fetcher, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("没有识别到"), "unexpected: {err}");

        // 非 B 站域名直接拒绝
        let err = resolve_bilibili_note("https://example.com/opus/1", &fetcher, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("只允许访问"), "unexpected: {err}");
    }

    // 保留一个编译期引用，确保 route_video_chain 辅助不被 dead_code 警告（测试内使用）
    #[allow(dead_code)]
    fn _route_helper_used(fetcher_url: &str, handler: &dyn Fn(&str, &[(String, String)]) -> Result<BiliResponse, String>) {
        let _ = route_video_chain(fetcher_url, handler);
    }
}
