//! 移植自 scripts/lib/media-import.mjs —— 配图/视频本地化下载。
//! Android 上 OCR 暂缺（后续 ML Kit 接入），此处 imageOcr/ocrText 置空，
//! 与「无 OCR 引擎」时的桌面行为一致。

use futures_util::{stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, REFERER, USER_AGENT};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use url::Url;

const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const MAX_REDIRECTS: u32 = 3;
const REQUEST_TIMEOUT_MS: u64 = 20_000;
const MAX_VIDEO_BYTES: u64 = 300 * 1024 * 1024;
const VIDEO_TIMEOUT_MS: Duration = Duration::from_secs(10 * 60);

const MEDIA_HOST_SUFFIXES: [&str; 4] = [".xhscdn.com", ".xhsimg.com", ".hdslb.com", ".bilibili.com"];
const VIDEO_HOST_SUFFIXES: [&str; 6] = [
    ".hdslb.com",
    ".bilibili.com",
    ".bilivideo.com",
    ".akamaized.net",
    ".acgvideo.com",
    ".upos-hz-mirrorakam.akamaized.net",
];

fn content_type_extensions() -> Vec<(&'static str, &'static str)> {    vec![
        ("image/avif", ".avif"),
        ("image/gif", ".gif"),
        ("image/heic", ".heic"),
        ("image/heif", ".heif"),
        ("image/jpeg", ".jpg"),
        ("image/png", ".png"),
        ("image/webp", ".webp"),
    ]
}

pub fn is_allowed_remote_image_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    MEDIA_HOST_SUFFIXES.iter().any(|suffix| host.to_ascii_lowercase().ends_with(suffix))
}

pub fn is_allowed_remote_video_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    VIDEO_HOST_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
        || MEDIA_HOST_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
}

fn extension_from_content_type(content_type: &str) -> String {
    let normalized = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    for (name, ext) in content_type_extensions() {
        if name == normalized {
            return ext.to_string();
        }
    }
    String::new()
}

fn referer_for_source(source: &str) -> &'static str {
    match source {
        "bilibili" => "https://www.bilibili.com/",
        _ => "https://www.xiaohongshu.com/",
    }
}

fn image_client(source: &str) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
    );
    headers.insert(
        REFERER,
        HeaderValue::from_str(referer_for_source(source))
            .map_err(|err| format!("Referer header 构造失败：{err}"))?,
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("ShouCangFavorites/0.1 local-media-import"));
    reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .build()
        .map_err(|err| format!("HTTP 客户端初始化失败：{err}"))
}

async fn fetch_image_response(
    client: &reqwest::Client,
    url: &str,
) -> Result<reqwest::Response, String> {
    let mut current_url = url.to_string();

    for redirect_count in 0..=MAX_REDIRECTS {
        if !is_allowed_remote_image_url(&current_url) {
            return Err("图片地址不属于受支持的图床".to_string());
        }

        let response = client
            .get(&current_url)
            .send()
            .await
            .map_err(|err| format!("图片下载失败：{err}"))?;

        if response.status().is_redirection() {
            if redirect_count >= MAX_REDIRECTS {
                return Err("图片重定向次数过多".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "图片重定向缺少目标地址".to_string())?;
            let base = Url::parse(&current_url).map_err(|_| "图片重定向缺少目标地址".to_string())?;
            current_url = base
                .join(location)
                .map_err(|_| "图片重定向缺少目标地址".to_string())?
                .to_string();
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("图片下载失败：{}", response.status().as_u16()));
        }
        return Ok(response);
    }

    Err("图片重定向次数过多".to_string())
}

async fn download_image(
    client: &reqwest::Client,
    url: &str,
    note_directory: &std::path::Path,
    index: usize,
) -> Result<Value, String> {
    let response = fetch_image_response(client, url).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let extension = extension_from_content_type(&content_type);
    if extension.is_empty() {
        return Err("远程内容不是可识别的图片".to_string());
    }

    let declared_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if declared_length > MAX_IMAGE_BYTES {
        return Err("单张图片超过 15MB".to_string());
    }

    let bytes = response.bytes().await.map_err(|err| format!("图片下载失败：{err}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("单张图片超过 15MB".to_string());
    }

    let file_name = format!("{:02}{}", index + 1, extension);
    let file_path = note_directory.join(&file_name);
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|err| format!("图片保存失败：{err}"))?;

    Ok(json!({
        "fileName": file_name,
        "filePath": file_path.to_string_lossy(),
        "sourceUrl": url,
    }))
}

async fn download_video(client: &reqwest::Client, url: &str, note_directory: &std::path::Path) -> Option<Value> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        eprintln!("[bili-video] reject: not http url");
        return None;
    }
    if !is_allowed_remote_video_url(url) {
        eprintln!("[bili-video] reject: host not allowed: {url}");
        return None;
    }
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(err) => {
            eprintln!("[bili-video] send failed: {err}");
            return None;
        }
    };
    if !response.status().is_success() {
        eprintln!("[bili-video] http {}: {url}", response.status().as_u16());
        return None;
    }
    let declared_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if declared_length > MAX_VIDEO_BYTES {
        return None;
    }

    let file_path = note_directory.join("video.mp4");
    let mut file = match tokio::fs::File::create(&file_path).await {
        Ok(file) => file,
        Err(err) => {
            eprintln!("[bili-video] create file failed: {err}");
            return None;
        }
    };
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                eprintln!("[bili-video] stream error at {received} bytes: {err}");
                let _ = tokio::fs::remove_file(&file_path).await;
                return None;
            }
        };
        received += chunk.len() as u64;
        if received > MAX_VIDEO_BYTES {
            eprintln!("[bili-video] exceeds {MAX_VIDEO_BYTES} bytes cap");
            drop(file);
            let _ = tokio::fs::remove_file(&file_path).await;
            return None;
        }
        if let Err(err) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            eprintln!("[bili-video] write failed: {err}");
            let _ = tokio::fs::remove_file(&file_path).await;
            return None;
        }
    }
    drop(file);
    eprintln!("[bili-video] downloaded {received} bytes ok");

    Some(json!({
        "fileName": "video.mp4",
        "filePath": file_path.to_string_lossy(),
        "sourceUrl": url,
    }))
}

/// 并发 2 下载（与 JS downloadConcurrency 一致），错误并入结果数组。
/// buffered 保序：结果顺序与输入一致，文件名序号正确。
async fn map_downloads(
    source_urls: Vec<String>,
    note_directory: std::path::PathBuf,
    client: reqwest::Client,
) -> Vec<Value> {
    stream::iter(source_urls.into_iter().enumerate())
        .map(|(index, url)| {
            let client = client.clone();
            let note_directory = note_directory.clone();
            async move {
                match download_image(&client, &url, &note_directory, index).await {
                    Ok(item) => item,
                    Err(error) => json!({
                        "error": error,
                        "sourceUrl": url,
                    }),
                }
            }
        })
        .buffered(2)
        .collect::<Vec<Value>>()
        .await
}

/// localizeNoteMedia 的 Android 实现（无 OCR）
pub async fn localize_note_media(
    note: &Value,
    media_directory: &std::path::Path,
    public_base_url: &str,
) -> Value {
    let source_urls: Vec<String> = {
        let mut seen = HashSet::new();
        note["imageUrls"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str())
                    .filter(|url| is_allowed_remote_image_url(url))
                    .map(|url| url.to_string())
                    .filter(|url| seen.insert(url.clone()))
                    .take(20)
                    .collect()
            })
            .unwrap_or_default()
    };
    let note_id = note["id"].as_str().unwrap_or("").to_string();
    let note_directory = media_directory.join(&note_id);
    if let Err(err) = tokio::fs::create_dir_all(&note_directory).await {
        return json!({
            "error": format!("创建笔记目录失败：{err}"),
        });
    }

    let video_url = note["videoUrl"].as_str().unwrap_or("").to_string();
    if source_urls.is_empty() && video_url.is_empty() {
        let mut result = note.clone();
        for key in ["sourceImageUrls", "imageUrls", "imageOcr"] {
            result[key] = Value::Array(Vec::new());
        }
        result["ocrText"] = Value::String(String::new());
        result["videoLocalPath"] = Value::String(String::new());
        result["videoError"] = Value::String(String::new());
        result["mediaStatus"] = Value::String("none".to_string());
        return result;
    }

    let source = note["source"].as_str().unwrap_or("xhs");
    let client = match image_client(source) {
        Ok(client) => client,
        Err(err) => {
            let mut result = note.clone();
            result["mediaStatus"] = Value::String("partial".to_string());
            result["mediaError"] = Value::String(err);
            return result;
        }
    };

    let downloads = map_downloads(source_urls.clone(), note_directory.clone(), client.clone()).await;

    let successful: Vec<Value> = downloads
        .iter()
        .filter(|item| item.get("filePath").is_some())
        .cloned()
        .collect();
    let failed_downloads = downloads.len() - successful.len();

    let local_image_urls: Vec<String> = successful
        .iter()
        .filter_map(|item| item["fileName"].as_str())
        .map(|file_name| format!("{public_base_url}/media/{note_id}/{file_name}"))
        .collect();

    let mut result = note.clone();
    result["sourceImageUrls"] = Value::Array(source_urls.iter().map(|u| Value::String(u.clone())).collect());
    result["imageUrls"] = Value::Array(local_image_urls.iter().map(|u| Value::String(u.clone())).collect());

    // iOS：导入时直接跑 Apple Vision OCR（与桌面 Node 门面同构，前端零改动）。
    // Android 由 Kotlin OcrBridge + 前端编排回写；桌面 shell 由 Node 跑 OCR。
    #[cfg(target_os = "ios")]
    {
        let ocr_paths: Vec<(String, std::path::PathBuf)> = successful
            .iter()
            .filter_map(|item| {
                let file_name = item["fileName"].as_str()?.to_string();
                let file_path = item["filePath"].as_str()?.to_string();
                Some((file_name, std::path::PathBuf::from(file_path)))
            })
            .collect();
        if ocr_paths.is_empty() {
            result["imageOcr"] = Value::Array(Vec::new());
            result["ocrText"] = Value::String(String::new());
        } else {
            let items = crate::server::ocr_ios::run_ocr_async(ocr_paths).await;
            let image_ocr: Vec<Value> = items
                .iter()
                .map(|item| {
                    json!({
                        "imageUrl": format!("{public_base_url}/media/{note_id}/{}", item.file_name),
                        "text": item.text,
                        "error": item.error,
                    })
                })
                .collect();
            let ocr_text = items
                .iter()
                .map(|item| item.text.as_str())
                .filter(|text| !text.is_empty())
                .collect::<Vec<&str>>()
                .join("\n\n");
            let engine = crate::server::ocr_ios::engine_info().0;
            result["imageOcr"] = Value::Array(image_ocr);
            result["ocrText"] = Value::String(ocr_text);
            result["ocrEngine"] = Value::String(engine.to_string());
            result["ocrProcessedAt"] =
                Value::String(crate::server::note_import::chrono_now_iso_public());
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        result["imageOcr"] = Value::Array(Vec::new());
        result["ocrText"] = Value::String(String::new());
    }
    result["coverUrl"] = local_image_urls
        .first()
        .map(|u| Value::String(u.clone()))
        .unwrap_or_else(|| note["coverUrl"].clone());

    // 视频 best-effort，永不阻断导入
    let mut video_local_path = String::new();
    let mut video_error = String::new();
    if !video_url.is_empty() {
        match reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(VIDEO_TIMEOUT_MS)
            .default_headers({
                let mut h = HeaderMap::new();
                // B站 CDN（upos/bilivideo）要求浏览器 UA + bilibili Referer，
                // 缺 UA 会被 403 拒绝（与 Node 侧 downloadVideo 行为对齐）。
                h.insert(USER_AGENT, HeaderValue::from_static(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
                ));
                if let Ok(val) = HeaderValue::from_str(referer_for_source(source)) {
                    h.insert(REFERER, val);
                }
                h
            })
            .build()
        {
            Ok(video_client) => {
                let video_result = download_video(&video_client, &video_url, &note_directory).await;
                match video_result {
                    Some(_) => {
                        video_local_path = format!("{public_base_url}/media/{note_id}/video.mp4");
                    }
                    None => {
                        video_error = "视频下载失败（已保留图片）".to_string();
                    }
                }
            }
            Err(_) => {
                video_error = "视频下载失败（已保留图片）".to_string();
            }
        }
    }

    let video_local_path_value = video_local_path.clone();
    let video_error_value = video_error.clone();
    result["videoLocalPath"] = Value::String(video_local_path_value);
    result["videoError"] = Value::String(video_error_value);

    let media_status = if failed_downloads == 0 && video_error.is_empty() {
        "ready"
    } else {
        "partial"
    };
    result["mediaStatus"] = Value::String(media_status.to_string());

    let mut errors: Vec<String> = Vec::new();
    if failed_downloads > 0 {
        errors.push(format!("{failed_downloads} 张图片保存失败"));
    }
    if !video_error.is_empty() {
        errors.push(video_error.clone());
    }
    result["mediaError"] = Value::String(errors.join("；"));

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_host_allowlist() {
        assert!(is_allowed_remote_image_url("https://sns-webpic-qc.xhscdn.com/a.webp"));
        assert!(is_allowed_remote_image_url("https://sns-img-hw.xhscdn.com/b.png"));
        assert!(is_allowed_remote_image_url("https://sns-avatar.qx.xhsimg.com/c.jpg"));
        assert!(is_allowed_remote_image_url("https://i0.hdslb.com/bfs/new_dyn/abc.webp"));
        assert!(!is_allowed_remote_image_url("https://example.com/a.webp"));
        assert!(!is_allowed_remote_image_url("http://sns-webpic-qc.xhscdn.com/a.webp"));
        assert!(!is_allowed_remote_image_url("https://evil.hdslb.com.evil.com/a.webp"));
        assert!(!is_allowed_remote_image_url("https://bilivideo.com/a.webp"));
        assert!(!is_allowed_remote_image_url("not a url"));
    }

    #[test]
    fn video_host_allowlist() {
        assert!(is_allowed_remote_video_url("https://sns-video-v3.xhscdn.com/stream/xx.mp4"));
        assert!(is_allowed_remote_video_url("https://i0.hdslb.com/bfs/new_dyn/xx.mp4"));
        assert!(is_allowed_remote_video_url("https://upos-hz-mirrorakam.akamaized.net/upos/xx.mp4"));
        assert!(!is_allowed_remote_video_url("https://example.com/a.mp4"));
        assert!(!is_allowed_remote_video_url("https://evil.hdslb.com.evil.com/a.mp4"));
        assert!(!is_allowed_remote_video_url("not a url"));
    }

    #[test]
    fn referer_by_source() {
        assert_eq!(referer_for_source("bilibili"), "https://www.bilibili.com/");
        assert_eq!(referer_for_source("xhs"), "https://www.xiaohongshu.com/");
        assert_eq!(referer_for_source("unknown"), "https://www.xiaohongshu.com/");
    }

    #[test]
    fn content_type_mapping() {
        assert_eq!(extension_from_content_type("image/webp"), ".webp");
        assert_eq!(extension_from_content_type("image/jpeg; charset=binary"), ".jpg");
        assert_eq!(extension_from_content_type("video/mp4"), "");
        assert_eq!(extension_from_content_type(""), "");
    }
}
