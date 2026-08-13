//! 移植自 scripts/lib/anonymous-note-resolver.mjs —— 不带账号凭证的单条公开页面解析。
//! 保持：credentials omit（无 Cookie 状态）、UA 伪装、重定向手动处理、5MB 上限、
//! 风控 /404 检测、MSE blob 视频直链正则提取（按档位取最大）。

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

const REQUEST_TIMEOUT_MS: u64 = 20_000;
const MAX_REDIRECTS: u32 = 3;
const MAX_HTML_BYTES: usize = 5 * 1024 * 1024;

const PAGE_HOSTS: [&str; 3] = [
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "m.xiaohongshu.com",
];

const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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

fn assert_allowed_page_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "匿名解析器只允许访问小红书笔记页面".to_string())?;
    let scheme_ok = url.scheme() == "https";
    let host = url.host_str().unwrap_or("");
    if !scheme_ok || !PAGE_HOSTS.contains(&host.to_ascii_lowercase().as_str()) {
        return Err("匿名解析器只允许访问小红书笔记页面".to_string());
    }
    Ok(url)
}

fn image_url_from_item(item: &Value) -> String {
    if let Some(s) = item.as_str() {
        return s.to_string();
    }
    if !item.is_object() {
        return String::new();
    }
    let direct = first_string(item, &["urlDefault", "urlPre", "url", "originUrl"]);
    if direct.starts_with("http://") || direct.starts_with("https://") {
        return direct.replace("http://", "https://").replace("http:/", "https:/");
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

fn image_urls_from_note(note: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for key in ["imageList", "images", "image_list"] {
        let list = note[key].as_array();
        if let Some(list) = list {
            for item in list {
                let url = image_url_from_item(item);
                if !url.is_empty() {
                    urls.push(url);
                }
            }
        }
    }
    for candidate in [
        note["cover"].clone(),
        note["video"]["cover"].clone(),
        note["video"]["firstFrame"].clone(),
    ] {
        let url = image_url_from_item(&candidate);
        if !url.is_empty() {
            urls.push(url);
        }
    }
    let mut seen = HashSet::new();
    urls.into_iter().filter(|u| seen.insert(u.clone())).take(20).collect()
}

fn looks_like_note(value: &Value, note_id: &str) -> bool {
    if !value.is_object() {
        return false;
    }
    let candidate_id = first_string(value, &["noteId", "note_id", "id"]).to_ascii_lowercase();
    if candidate_id != note_id.to_ascii_lowercase() {
        return false;
    }
    let has_text = !first_string(value, &["title", "displayTitle", "desc", "description", "content"]).is_empty();
    let has_images = !image_urls_from_note(value).is_empty();
    has_text || has_images
}

fn find_note(root: &Value, note_id: &str) -> Option<Value> {
    if root.is_null() {
        return None;
    }
    let direct_candidates = [
        root["noteDetailMap"][note_id]["note"].clone(),
        root["noteDetailMap"][note_id].clone(),
        root["noteData"]["data"]["noteData"].clone(),
        root["noteData"]["note"].clone(),
    ];
    for candidate in direct_candidates {
        if looks_like_note(&candidate, note_id) {
            return Some(candidate);
        }
    }

    // BFS，深度 8，最多 20_000 节点。serde_json::Value 是无环树，无需 visited。
    let mut queue: Vec<(Value, u32)> = vec![(root.clone(), 0)];
    let mut inspected = 0usize;
    while let Some((value, depth)) = queue.pop() {
        if inspected >= 20_000 {
            break;
        }
        inspected += 1;
        if looks_like_note(&value, note_id) {
            return Some(value);
        }
        if depth >= 8 {
            continue;
        }
        let children: Vec<Value> = match &value {
            Value::Array(arr) => arr.clone(),
            Value::Object(map) => map.values().cloned().collect(),
            _ => Vec::new(),
        };
        for child in children {
            if child.is_object() || child.is_array() {
                queue.push((child, depth + 1));
            }
        }
    }
    None
}

fn extract_initial_state(html: &str) -> Option<Value> {
    let marker = "window.__INITIAL_STATE__=";
    let start = html.find(marker)?;
    let value_start = start + marker.len();
    let value_end = html[value_start..].find("</script>")? + value_start;
    let serialized = html[value_start..value_end].trim();
    let serialized = serialized.strip_suffix(';').unwrap_or(serialized);

    match serde_json::from_str::<Value>(serialized) {
        Ok(value) => Some(value),
        Err(_) => {
            // JS 版同一兜底：undefined 字面量替换为 null
            let patched = serialized.replace("undefined", "null");
            serde_json::from_str::<Value>(&patched).ok()
        }
    }
}

fn tags_from_note(note: &Value) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for key in ["tagList", "tags", "topicList"] {
        let values = note[key].as_array();
        if let Some(values) = values {
            for value in values {
                let tag = match value {
                    Value::String(s) => s.clone(),
                    _ => first_string(value, &["name", "title", "tagName", "topicName"]),
                };
                if !tag.is_empty() {
                    tags.push(tag.trim_start_matches('#').to_string());
                }
            }
        }
    }
    let mut seen = HashSet::new();
    tags.into_iter().filter(|t| seen.insert(t.clone())).take(20).collect()
}

fn video_url_from_note(note: &Value) -> String {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(v) = note["video"].as_object() {
        let video = Value::Object(v.clone());
        let push = |candidates: &mut Vec<String>, value: &Value| {
            if let Some(s) = value.as_str() {
                if s.starts_with("http://") || s.starts_with("https://") {
                    candidates.push(s.to_string());
                }
            }
        };
        push(&mut candidates, &video["url"]);
        push(&mut candidates, &video["masterUrl"]);
        for stream_key in ["h264", "h265", "aac"] {
            let mut stream_value: Option<Value> = None;
            for path in [
                &video["media"]["video"][stream_key],
                &video["media"][stream_key],
                &video[stream_key],
            ] {
                if path.is_array() {
                    stream_value = Some(path.clone());
                    break;
                }
            }
            if let Some(stream) = stream_value {
                if let Some(arr) = stream.as_array() {
                    for entry in arr {
                        push(&mut candidates, &entry["masterUrl"]);
                        if let Some(backups) = entry["backupUrls"].as_array() {
                            for backup in backups {
                                push(&mut candidates, backup);
                            }
                        }
                    }
                }
            }
        }
    }
    candidates.into_iter().next().unwrap_or_default()
}

fn video_url_from_html(html: &str) -> String {
    let pattern = regex::Regex::new(
        r#"https?://sns-video[a-z0-9-]*\.xhscdn\.com[^"'\\\s)]*\.mp4[^"'\\\s)]*"#,
    )
    .unwrap();
    let tier_re = regex::Regex::new(r"_(\d{2,4})\.mp4").unwrap();
    let mut matches: Vec<(u32, String)> = pattern
        .find_iter(html)
        .map(|m| {
            let url = m.as_str().to_string();
            let tier: u32 = tier_re
                .captures(&url)
                .and_then(|c| c.get(1))
                .and_then(|c| c.as_str().parse().ok())
                .unwrap_or(0);
            (tier, url)
        })
        .collect();
    if matches.is_empty() {
        return String::new();
    }
    matches.sort_by(|a, b| b.0.cmp(&a.0));
    matches[0].1.clone()
}

fn note_payload_from_html(html: &str, note_id: &str, source_url: &str) -> Result<Value, String> {
    // 风控/失效页面检测
    if regex::Regex::new(r"/404/(?:sec_|pc_)?").unwrap().is_match(&html[..html.len().min(4000)]) {
        return Err("笔记暂时无法匿名浏览（风控），请稍后重试，或在笔记详情页使用「拖到收藏」按钮".to_string());
    }

    let state = extract_initial_state(html).ok_or_else(|| {
        "没有读到笔记内容：小红书当前要求登录后才能查看正文。请先点开这篇笔记，再使用详情页的「拖到收藏」按钮或直接拖拽笔记页面".to_string()
    })?;
    let note_root = if !state["note"].is_null() {
        state["note"].clone()
    } else {
        state["noteData"].clone()
    };
    let note = find_note(&note_root, note_id).ok_or_else(|| {
        "没有读到笔记内容：小红书当前要求登录后才能查看正文。请先点开这篇笔记，再使用详情页的「拖到收藏」按钮或直接拖拽笔记页面".to_string()
    })?;

    let user = if !note["user"].is_null() { note["user"].clone() } else { note["author"].clone() };
    let image_urls = image_urls_from_note(&note);
    let video_url = {
        let from_note = video_url_from_note(&note);
        if !from_note.is_empty() {
            from_note
        } else {
            video_url_from_html(html)
        }
    };
    let title = first_string(&note, &["title", "displayTitle"]);
    let content = first_string(&note, &["desc", "description", "content"]);
    if title.is_empty() && content.is_empty() && image_urls.is_empty() && video_url.is_empty() {
        return Err("匿名解析返回的笔记内容为空".to_string());
    }
    if image_urls.is_empty() && video_url.is_empty() {
        return Err("匿名解析没有读到笔记图片（风控或链接失效），请稍后重试".to_string());
    }

    let note_type = if note["type"] == "video" || !note["video"].is_null() {
        "video"
    } else {
        "normal"
    };

    Ok(serde_json::json!({
        "id": note_id,
        "sourceUrl": source_url,
        "title": title,
        "content": content,
        "imageUrls": image_urls,
        "coverUrl": image_urls.first().cloned().unwrap_or_default(),
        "videoUrl": video_url,
        "author": {
            "name": first_string(&user, &["nickname", "name", "nickName"]),
            "avatar": first_string(&user, &["avatar", "image"]),
            "userId": first_string(&user, &["userId", "user_id", "id"]),
        },
        "tags": tags_from_note(&note),
        "type": note_type,
    }))
}

/// 构建无 Cookie 状态的一次性客户端（每次解析新建，避免跨请求状态泄漏）
fn anonymous_client() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9"));
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_UA));
    reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(REQUEST_TIMEOUT_MS))
        .build()
        .map_err(|err| format!("HTTP 客户端初始化失败：{err}"))
}

async fn fetch_anonymous_page(source_url: &Url, client: &reqwest::Client) -> Result<String, String> {
    let mut current_url = source_url.clone();

    for redirect_count in 0..=MAX_REDIRECTS {
        let response = client
            .get(current_url.clone())
            .send()
            .await
            .map_err(|err| format!("匿名解析请求失败：{err}"))?;

        let status = response.status();
        if status.is_redirection() {
            if redirect_count >= MAX_REDIRECTS {
                return Err("匿名解析重定向次数过多".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "匿名解析重定向缺少目标地址".to_string())?;
            let next = current_url
                .join(location)
                .map_err(|_| "匿名解析重定向缺少目标地址".to_string())?;
            current_url = assert_allowed_page_url(&next.to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("匿名解析请求失败：{}", status.as_u16()));
        }

        let declared_length = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if declared_length > MAX_HTML_BYTES {
            return Err("匿名解析页面过大".to_string());
        }

        let bytes = response.bytes().await.map_err(|err| format!("匿名解析读取失败：{err}"))?;
        if bytes.len() > MAX_HTML_BYTES {
            return Err("匿名解析页面过大".to_string());
        }
        let html = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(html);
    }

    Err("匿名解析失败".to_string())
}

pub async fn resolve_anonymous_note(
    source_url: &str,
    expected_note_id: Option<&str>,
) -> Result<Value, String> {
    let page_url = assert_allowed_page_url(source_url)?;
    let note_id = match expected_note_id {
        Some(id) => id.to_string(),
        None => page_url
            .path()
            .strip_prefix("/explore/")
            .or_else(|| page_url.path().strip_prefix("/search_result/"))
            .or_else(|| page_url.path().strip_prefix("/discovery/item/"))
            .map(|rest| {
                let tail = rest.split('/').next().unwrap_or("");
                let id_pattern = regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap();
                if id_pattern.is_match(tail) {
                    tail.to_string()
                } else {
                    String::new()
                }
            })
            .unwrap_or_default(),
    };
    if note_id.is_empty() || !regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap().is_match(&note_id) {
        return Err("匿名解析器没有识别到笔记 ID".to_string());
    }

    let client = anonymous_client()?;
    let html = fetch_anonymous_page(&page_url, &client).await?;
    note_payload_from_html(&html, &note_id.to_ascii_lowercase(), &page_url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_html() -> String {
        r#"<html><body>
        <script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abcdef0123456789abcdef":{"note":{"noteId":"abcdef0123456789abcdef","title":"测试标题","desc":"测试正文内容","imageList":[{"urlDefault":"https://sns-webpic-qc.xhscdn.com/abc.webp"}],"user":{"nickname":"作者名"},"type":"video","video":{"media":{"video":{"h264":[{"masterUrl":"https://sns-video-v2.xhscdn.com/stream/xyz_720.mp4?sign=a","backupUrls":["https://sns-video-v2.xhscdn.com/stream/xyz_1080.mp4?sign=b"]}]}}}}}}}};</script>
        <script>var x = "https://sns-video-bd.xhscdn.com/stream/low_480.mp4?t=1"</script>
        </body></html>"#.to_string()
    }

    #[test]
    fn extract_initial_state_parses() {
        let html = sample_html();
        let state = extract_initial_state(&html).unwrap();
        assert!(state["note"]["noteDetailMap"]["abcdef0123456789abcdef"]["note"]["title"].is_string());
    }

    #[test]
    fn find_note_finds_nested() {
        let html = sample_html();
        let state = extract_initial_state(&html).unwrap();
        let note_root = state["note"].clone();
        let note = find_note(&note_root, "abcdef0123456789abcdef").unwrap();
        assert_eq!(note["title"], "测试标题");
    }

    #[test]
    fn video_url_prefers_note_over_html() {
        let html = sample_html();
        let state = extract_initial_state(&html).unwrap();
        let note = find_note(&state["note"].clone(), "abcdef0123456789abcdef").unwrap();
        let url = video_url_from_note(&note);
        assert!(url.contains("_720.mp4"), "unexpected: {url}");
    }

    #[test]
    fn video_url_from_html_takes_max_tier() {
        let html = sample_html();
        let url = video_url_from_html(&html);
        // html 里两个：720（脚本 h264 内嵌在 __INITIAL_STATE__ 里也算匹配）和 480
        assert!(url.contains("720") || url.contains("1080"), "unexpected: {url}");
    }

    #[test]
    fn payload_rejects_risk_control_page() {
        let html = r#"<html><head><title>404</title></head><body>/404/sec_abc<script>window.__INITIAL_STATE__={}</script></body></html>"#;
        let result = note_payload_from_html(html, "abcdef0123456789abcdef", "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("风控"));
    }

    #[test]
    fn payload_extracts_full_note() {
        let html = sample_html();
        let payload = note_payload_from_html(&html, "abcdef0123456789abcdef", "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef").unwrap();
        assert_eq!(payload["title"], "测试标题");
        assert_eq!(payload["type"], "video");
        assert_eq!(payload["author"]["name"], "作者名");
        assert_eq!(payload["imageUrls"][0], "https://sns-webpic-qc.xhscdn.com/abc.webp");
        assert!(payload["videoUrl"].as_str().unwrap().contains("xhscdn.com/stream/"));
    }

    #[test]
    fn rejects_non_xhs_url() {
        let err = assert_allowed_page_url("https://example.com/explore/abc").unwrap_err();
        assert!(err.contains("只允许访问"));
        let err = assert_allowed_page_url("http://www.xiaohongshu.com/explore/abc").unwrap_err();
        assert!(err.contains("只允许访问"));
    }

    #[test]
    fn note_id_variable_length() {
        let id = "abcdef0123456789abcd"; // 20 位
        let url = format!("https://www.xiaohongshu.com/explore/{id}");
        let page_url = assert_allowed_page_url(&url).unwrap();
        let tail = page_url.path().strip_prefix("/explore/").unwrap();
        let pattern = regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap();
        assert!(pattern.is_match(tail));
    }

    #[test]
    fn extract_state_handles_undefined() {
        let html = r#"<script>window.__INITIAL_STATE__={"a":undefined,"b":1};</script>"#;
        let state = extract_initial_state(html).unwrap();
        assert_eq!(state["a"], Value::Null);
        assert_eq!(state["b"], 1);
    }
}
