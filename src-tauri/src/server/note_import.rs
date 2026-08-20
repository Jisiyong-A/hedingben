//! 移植自 scripts/lib/note-import.mjs —— 拖拽载荷校验、标准化和去重。
//! 保持与 JS 版完全一致的 API 契约（错误文案、字段名、边界行为）。

use serde_json::{json, Value};
use std::collections::HashSet;
use url::Url;

const DRAG_PAYLOAD_PREFIX: &str = "SHOUCANG_NOTE:";
const CARD_DRAG_PAYLOAD_PREFIX: &str = "SHOUCANG_CARD:";

const ALLOWED_HOSTS: [&str; 8] = [
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "m.xiaohongshu.com",
    "xhslink.cn",
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
    "b23.tv",
];

fn is_allowed_host(hostname: &str) -> bool {
    ALLOWED_HOSTS.contains(&hostname.to_ascii_lowercase().as_str())
}

/// `https?://[^\s<>"'，。！？；）】]+` + 尾部 `[),.;!?]+` 修剪
fn extract_urls(input: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"https?://[^\s<>"'，。！？；）】]+"#).unwrap();
    re.find_iter(input)
        .map(|m| m.as_str().to_string())
        .map(|v| {
            let trimmed = v.trim_end_matches(|c| matches!(c, ')' | ',' | '.' | ';' | '!' | '?'));
            trimmed.to_string()
        })
        .collect()
}

fn parse_supported_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "没有识别到有效的小红书笔记链接".to_string())?;
    let host = url.host_str().ok_or_else(|| "没有识别到有效的小红书笔记链接".to_string())?;
    if !is_allowed_host(host) {
        return Err("只支持小红书笔记页面".to_string());
    }
    Ok(url)
}

pub fn extract_shared_note_url(input: &str) -> Result<String, String> {
    let supported = extract_urls(input)
        .iter()
        .filter_map(|value| parse_supported_url(value).ok())
        .next();
    match supported {
        Some(url) => Ok(url.to_string()),
        None => Err("没有识别到有效的小红书笔记链接".to_string()),
    }
}

pub fn extract_note_id_from_url(value: &str) -> Option<String> {
    let url = parse_supported_url(value).ok()?;
    extract_note_id_from_path(&url.path())
}

fn extract_note_id_from_path(path: &str) -> Option<String> {
    // 注意：Rust regex 的 `$` 在文本末尾匹配；JS 的 `(?:\/|$)` 也覆盖无尾斜杠情况。
    // BV id 是 base58 编码、大小写敏感；XHS hex id 与 av/opus 数字 id 均转小写。
    let patterns = [
        r#"^/explore/([0-9a-f]{20,26})(?:/|$)"#,
        r#"^/search_result/([0-9a-f]{20,26})(?:/|$)"#,
        r#"^/discovery/item/([0-9a-f]{20,26})(?:/|$)"#,
        // Bilibili video (BV id is 10 alphanumeric chars, case-sensitive).
        r#"^/video/(BV[a-zA-Z0-9]{10})(?:/|$)"#,
        // Bilibili legacy av id.
        r#"^/video/(av\d+)(?:/|$)"#,
        // Bilibili opus (article) id.
        r#"^/opus/(\d+)(?:/|$)"#,
    ];
    for pattern in patterns {
        let re = regex::Regex::new(pattern).unwrap();
        if let Some(captures) = re.captures(path) {
            if let Some(id) = captures.get(1) {
                let raw = id.as_str();
                // BV ids are base58-encoded and case-sensitive; keep as-is.
                // XHS hex ids and numeric ids are lowercased.
                return Some(if raw.starts_with("BV") || raw.starts_with("bv") {
                    raw.to_string()
                } else {
                    raw.to_ascii_lowercase()
                });
            }
        }
    }
    None
}

fn clean_text(value: &Value, max_length: usize) -> String {
    match value {
        Value::String(s) => {
            let cleaned: String = s
                .chars()
                .filter(|c| *c != '\u{0000}')
                .collect::<String>()
                .replace("\r\n", "\n");
            cleaned.trim().chars().take(max_length).collect()
        }
        _ => String::new(),
    }
}

fn clean_text_opt(value: Option<&str>, max_length: usize) -> String {
    match value {
        Some(s) => {
            let cleaned: String = s
                .chars()
                .filter(|c| *c != '\u{0000}')
                .collect::<String>()
                .replace("\r\n", "\n");
            cleaned.trim().chars().take(max_length).collect()
        }
        None => String::new(),
    }
}

fn normalize_image_urls(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| clean_text(item, 3000))
            .filter(|item| item.starts_with("https://"))
            .take(20)
            .collect(),
        _ => Vec::new(),
    }
}

pub fn serialize_dragged_note(note: &Value) -> String {
    format!("{DRAG_PAYLOAD_PREFIX}{note}")
}

pub fn parse_dragged_note_input(input: &str) -> Result<Option<Value>, String> {
    let marker_index = input.find(DRAG_PAYLOAD_PREFIX);
    let Some(marker_index) = marker_index else {
        return Ok(None);
    };
    let raw = &input[marker_index + DRAG_PAYLOAD_PREFIX.len()..];
    match serde_json::from_str(raw) {
        Ok(value) => Ok(Some(value)),
        Err(_) => Err("拖入的笔记数据已损坏，请刷新页面后重试".to_string()),
    }
}

pub fn parse_dragged_card_input(input: &str) -> Result<Option<Value>, String> {
    let marker_index = input.find(CARD_DRAG_PAYLOAD_PREFIX);
    let Some(marker_index) = marker_index else {
        return Ok(None);
    };
    let raw = &input[marker_index + CARD_DRAG_PAYLOAD_PREFIX.len()..];
    let payload: Value = serde_json::from_str(raw)
        .map_err(|_| "拖入的笔记链接已损坏，请刷新小红书页面后重试".to_string())?;

    let source_url =
        extract_shared_note_url(&clean_text(&payload["sourceUrl"], 5000)).map_err(|_| {
            "拖入的笔记链接已损坏，请刷新小红书页面后重试".to_string()
        })?;
    let note_id = extract_note_id_from_url(&source_url);
    let payload_id = clean_text(&payload["id"], 100).to_ascii_lowercase();
    let Some(note_id) = note_id else {
        return Err("拖入的笔记链接已损坏，请刷新小红书页面后重试".to_string());
    };
    if note_id != payload_id {
        return Ok(None);
    }

    Ok(Some(json!({
        "id": note_id,
        "sourceUrl": source_url,
        "title": clean_text(&payload["title"], 300),
    })))
}

/// normalizeImportedNote 返回的 Value 是完整 note 结构（与 JS 字段一致）
pub fn normalize_imported_note(payload: &Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("没有读取到笔记内容".to_string());
    }

    let shared_url = extract_shared_note_url(&clean_text(&payload["sourceUrl"], 5000))?;
    let mut source_url_obj =
        Url::parse(&shared_url).map_err(|_| "没有识别到有效的小红书笔记链接".to_string())?;
    let host = source_url_obj
        .host_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_bilibili = host.ends_with("bilibili.com");
    source_url_obj.set_query(None);
    source_url_obj.set_fragment(None);
    let source_url = source_url_obj.to_string();

    // fallback 取 payload.id 但不转小写，与 JS 侧逐行等价
    let note_id = extract_note_id_from_url(&source_url)
        .unwrap_or_else(|| clean_text(&payload["id"], 100));

    if is_bilibili {
        let bilibili_re = regex::Regex::new(r"^(BV[a-zA-Z0-9]{10}|av\d+|\d+)$").unwrap();
        if !bilibili_re.is_match(&note_id) {
            return Err("当前页面不是可识别的B站内容".to_string());
        }
    } else {
        let id_pattern = regex::Regex::new(r"^[0-9a-f]{20,26}$").unwrap();
        if !id_pattern.is_match(&note_id) {
            return Err("当前页面不是可识别的小红书笔记".to_string());
        }
    }

    // BV id 大小写敏感保持原样，其余转小写（与 JS 侧逐行等价）
    let final_id = if is_bilibili && (note_id.starts_with("BV") || note_id.starts_with("bv")) {
        note_id.clone()
    } else {
        note_id.to_ascii_lowercase()
    };

    // bilibili 可选字段
    let bvid: Option<String> = if is_bilibili && (note_id.starts_with("BV") || note_id.starts_with("bv")) {
        Some(note_id.clone())
    } else {
        None
    };
    let aid: Option<String> = if is_bilibili && note_id.starts_with("av") {
        Some(note_id[2..].to_string())
    } else {
        None
    };
    let cid: Option<String> = None;
    let opus_id: Option<String> = if is_bilibili && !note_id.is_empty() && note_id.bytes().all(|b| b.is_ascii_digit()) {
        Some(note_id.clone())
    } else {
        None
    };

    let title = {
        let t = clean_text(&payload["title"], 300);
        if t.is_empty() {
            "未命名笔记".to_string()
        } else {
            t
        }
    };
    let content = clean_text(&payload["content"], 20_000);
    if content.is_empty() && title == "未命名笔记" {
        return Err("当前页面没有可收藏的正文，请先打开笔记详情".to_string());
    }

    let image_urls = normalize_image_urls(&payload["imageUrls"]);
    let note_type = if payload["type"] == "video" { "video" } else { "normal" };
    let video_url = clean_text(&payload["videoUrl"], 5000);

    let author_name = {
        let n = clean_text(&payload["author"]["name"], 200);
        if n.is_empty() {
            "未知作者".to_string()
        } else {
            n
        }
    };

    let tags: Vec<String> = payload["tags"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|tag| clean_text(tag, 100))
                .filter(|tag| !tag.is_empty())
                .take(20)
                .collect()
        })
        .unwrap_or_default();

    let cover_url = {
        let direct = clean_text(&payload["coverUrl"], 3000);
        if !direct.is_empty() {
            direct
        } else {
            image_urls.first().cloned().unwrap_or_default()
        }
    };
    let now = chrono_now_iso();

    Ok(json!({
        "id": final_id,
        "source": if is_bilibili { "bilibili" } else { "xhs" },
        "sourceUrl": source_url,
        "title": title,
        "content": content,
        "rawContent": content,
        "ocrText": "",
        "coverUrl": cover_url,
        "imageUrls": image_urls,
        "sourceImageUrls": image_urls,
        "imageOcr": [],
        "videoUrl": video_url,
        "mediaStatus": if image_urls.is_empty() { "none" } else { "pending" },
        "mediaError": "",
        "author": {
            "name": author_name,
            "avatar": clean_text(&payload["author"]["avatar"], 3000),
            "userId": clean_text(&payload["author"]["userId"], 200),
        },
        "likes": 0,
        "collects": 0,
        "comments": 0,
        "category": "待分类",
        "savedAt": now,
        "tags": tags,
        "type": note_type,
        "bvid": bvid,
        "aid": aid,
        "cid": cid,
        "opusId": opus_id,
    }))
}

/// 共享文本（复制的小红书分享）→ note
pub fn note_from_shared_text(input: &str) -> Result<Value, String> {
    let source_url = extract_shared_note_url(input)?;
    let without_url = input.replace(&source_url, "");
    let lines: Vec<String> = without_url
        .split('\n')
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !(line.starts_with("复制")
                || line.starts_with("打开小红书")
                || line.starts_with("查看完整笔记"))
        })
        .collect();

    let meaningful_text = lines.join("\n");
    let meaningful_text = meaningful_text.trim();
    if meaningful_text.chars().count() < 12 {
        return Err("单独拖入链接无法安全读取正文，请刷新扩展后直接拖动小红书笔记卡片".to_string());
    }

    let title = lines.first().cloned().unwrap_or_default();
    let rest = lines[1..].join("\n");
    let content = if rest.is_empty() { title.clone() } else { rest };

    normalize_imported_note(&json!({
        "sourceUrl": source_url,
        "title": title,
        "content": content,
    }))
}

pub fn merge_imported_note(existing_notes: &Value, imported_note: &Value) -> (bool, Value) {
    let safe_existing: &Vec<Value> = match existing_notes {
        Value::Array(arr) => arr,
        _ => &Vec::new(),
    };
    let note_id = imported_note["id"].as_str().unwrap_or_default().to_string();
    let created = !safe_existing.iter().any(|note| {
        note.get("id").and_then(|id| id.as_str()) == Some(note_id.as_str())
    });

    let mut notes: Vec<Value> = Vec::with_capacity(safe_existing.len() + 1);
    notes.push(imported_note.clone());
    for note in safe_existing {
        if note.get("id").and_then(|id| id.as_str()) != Some(note_id.as_str()) {
            notes.push(note.clone());
        }
    }
    (created, Value::Array(notes))
}

pub fn remove_stored_note(existing_notes: &Value, note_id: &str) -> (Option<Value>, Value) {
    let safe_existing: &Vec<Value> = match existing_notes {
        Value::Array(arr) => arr,
        _ => &Vec::new(),
    };
    let deleted = safe_existing
        .iter()
        .find(|note| note.get("id").and_then(|id| id.as_str()) == Some(note_id))
        .cloned();

    let notes: Vec<Value> = safe_existing
        .iter()
        .filter(|note| note.get("id").and_then(|id| id.as_str()) != Some(note_id))
        .cloned()
        .collect();

    (deleted, Value::Array(notes))
}

/// 去重辅助：URL 提取（供测试与内部复用）
pub fn dedup_urls(urls: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    urls.into_iter().filter(|u| seen.insert(u.clone())).collect()
}

pub fn chrono_now_iso_public() -> String {
    chrono_now_iso()
}

fn chrono_now_iso() -> String {
    // 无 chrono 依赖：用 system time 格式化 UTC ISO-8601
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let millis = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis();
    format_iso_from_unix(secs, millis)
}

pub fn format_iso_from_unix(secs: u64, millis: u32) -> String {
    // 仅用于 savedAt 等时间戳；不依赖外部库
    let days = secs / 86_400;
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let mut month = 1i64;
    loop {
        let days_in_month = days_in_month_of(y, month);
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        month += 1;
    }
    let day = remaining + 1;
    let secs_of_day = secs % 86_400;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        month,
        day,
        hour,
        minute,
        second,
        millis
    )
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month_of(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_shared_url_from_text() {
        let input = "复制这条信息，打开小红书：https://www.xiaohongshu.com/explore/abcdef0123456789abcdef?xsec_token=abc 查看";
        let url = extract_shared_note_url(input).unwrap();
        assert!(url.contains("abcdef0123456789abcdef"));
    }

    #[test]
    fn extract_shared_url_recognizes_xhslink_short_link() {
        let input = "怪不得香磷说鸣人的查克拉像个小太阳呢？ https://xhslink.cn/o/8hQar8EEdkE 存好口令，直达【小红书】瞅瞅~";
        let url = extract_shared_note_url(input).unwrap();
        assert_eq!(url, "https://xhslink.cn/o/8hQar8EEdkE");
    }

    #[test]
    fn rejects_non_xhs_host() {
        // JS 版行为：parseSupportedUrl 逐个失败被 filterMap 吞掉，最终报"没有识别到"
        let err = extract_shared_note_url("https://example.com/explore/abc").unwrap_err();
        assert_eq!(err, "没有识别到有效的小红书笔记链接");
        // 但 parse_supported_url 直接调用时报"只支持小红书"
        let err = parse_supported_url("https://example.com/explore/abc").unwrap_err();
        assert_eq!(err, "只支持小红书笔记页面");
    }

    #[test]
    fn note_id_variable_length_20_26() {
        for id in [
            "abcdef0123456789abcd",     // 20
            "abcdef0123456789abcdef",   // 22
            "abcdef0123456789abcdefab", // 24
            "abcdef0123456789abcdefabcd", // 26
        ] {
            let url = format!("https://www.xiaohongshu.com/explore/{id}");
            assert_eq!(extract_note_id_from_url(&url).unwrap(), id);
        }
        let url = "https://www.xiaohongshu.com/explore/abcdef0123456789abc"; // 19
        assert!(extract_note_id_from_url(url).is_none());
    }

    #[test]
    fn normalize_strips_query_and_hash() {
        let payload = json!({
            "sourceUrl": "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef?xsec_token=xyz#frag",
            "title": "标题",
            "content": "正文",
            "imageUrls": ["https://sns-webpic-qc.xhscdn.com/a.webp", "http://not-https.webp"],
        });
        let note = normalize_imported_note(&payload).unwrap();
        assert_eq!(note["sourceUrl"], "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef");
        assert_eq!(note["id"], "abcdef0123456789abcdef");
        assert_eq!(note["imageUrls"].as_array().unwrap().len(), 1);
        assert_eq!(note["mediaStatus"], "pending");
    }

    #[test]
    fn normalize_rejects_bad_id() {
        let payload = json!({
            "sourceUrl": "https://www.xiaohongshu.com/explore/not-an-id",
            "title": "标题",
            "content": "正文",
        });
        assert!(normalize_imported_note(&payload).is_err());
    }

    #[test]
    fn normalize_rejects_empty_body() {
        let payload = json!({
            "sourceUrl": "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef",
        });
        let err = normalize_imported_note(&payload).unwrap_err();
        assert_eq!(err, "当前页面没有可收藏的正文，请先打开笔记详情");
    }

    #[test]
    fn merge_creates_and_dedupes() {
        let existing = json!([{"id": "a"}, {"id": "b"}]);
        let (created, merged) = merge_imported_note(&existing, &json!({"id": "c"}));
        assert!(created);
        assert_eq!(merged.as_array().unwrap().len(), 3);

        let (created, merged) = merge_imported_note(&existing, &json!({"id": "b"}));
        assert!(!created);
        assert_eq!(merged.as_array().unwrap().len(), 2);
        assert_eq!(merged[0]["id"], "b");
    }

    #[test]
    fn remove_stored_works() {
        let existing = json!([{"id": "a"}, {"id": "b"}]);
        let (deleted, rest) = remove_stored_note(&existing, "a");
        assert!(deleted.is_some());
        assert_eq!(rest.as_array().unwrap().len(), 1);
        assert_eq!(rest[0]["id"], "b");
    }

    #[test]
    fn shared_text_extracts_content() {
        let input = "复制这条信息，打开小红书：https://www.xiaohongshu.com/explore/abcdef0123456789abcdef\n\n标题行\n\n正文内容超过十二个字啊朋友们\n\n查看完整笔记";
        let note = note_from_shared_text(input).unwrap();
        assert_eq!(note["title"], "标题行");
        assert!(note["content"].as_str().unwrap().contains("正文内容"));
    }

    #[test]
    fn shared_text_too_short_rejects() {
        let input = "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef";
        assert!(note_from_shared_text(input).is_err());
    }

    #[test]
    fn dragged_card_payload_roundtrip() {
        let payload = json!({
            "id": "abcdef0123456789abcdef",
            "sourceUrl": "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef?xsec_token=t",
            "title": "卡片标题",
        });
        let serialized = serialize_dragged_note(&payload);
        let parsed = parse_dragged_note_input(&serialized).unwrap().unwrap();
        assert_eq!(parsed["id"], "abcdef0123456789abcdef");

        let card = format!("SHOUCANG_CARD:{payload}");
        let parsed_card = parse_dragged_card_input(&card).unwrap().unwrap();
        assert_eq!(parsed_card["title"], "卡片标题");
    }

    #[test]
    fn iso_format_is_stable() {
        // node 验证：new Date(1782000000*1000).toISOString() = 2026-06-21T00:00:00.000Z
        let secs = 1782_000_000u64;
        let iso = format_iso_from_unix(secs, 0);
        assert_eq!(iso, "2026-06-21T00:00:00.000Z");
        // 1702000000 → 2023-12-08T01:46:40
        let unix_check: u64 = 1_702_000_000;
        let iso2 = format_iso_from_unix(unix_check, 500);
        assert!(iso2.starts_with("2023-12-08T01:46:40"));
        assert!(iso2.ends_with(".500Z"));
    }
}
