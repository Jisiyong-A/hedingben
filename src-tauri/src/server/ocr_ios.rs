//! iOS 本地 OCR —— Apple Vision（VNRecognizeTextRequest），全离线。
//!
//! 与桌面 Node 侧 OCR 门面对齐：导入时在 sidecar 内跑完，
//! imageOcr / ocrText / ocrEngine 随笔记一起落库，前端零改动
//! （桌面就是这条路径；Android 因 ML Kit 是 JS 桥才走客户端编排）。
//!
//! 首次识别有系统级模型加载延迟；识别失败返回 error 文案，
//! 不阻断导入（mediaStatus 变 partial）。

use core_foundation::base::ToVoid;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, AnyThread};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSDictionary, NSString};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequestTextRecognitionLevel};

// ImageIO C 接口：文件 → CGImage（返回值遵循 Create 规则，调用方持有 +1）。
#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageSourceCreateWithURL(
        url: *const AnyObject,
        options: *const AnyObject,
    ) -> *mut AnyObject;
    fn CGImageSourceCreateImageAtIndex(
        source: *mut AnyObject,
        index: usize,
        options: *const AnyObject,
    ) -> *mut AnyObject;
}

/// 单张图片识别（阻塞调用，务必放 spawn_blocking 里跑）。
/// 返回识别文本；引擎内部失败返回 Err 文案。
fn recognize_text_blocking(image_path: &std::path::Path) -> Result<String, String> {
    // CFURL 与 NSURL 免费桥接；Vision 的 initWithCGImage 需要 CGImage。
    let cf_url = core_foundation::url::CFURL::from_file_system_path(
        core_foundation::string::CFString::new(&image_path.to_string_lossy()),
        core_foundation::url::kCFURLPOSIXPathStyle,
        false,
    );

    // SAFETY：C 函数签名与 ImageIO 导出一致；返回的 CF 对象遵循 Create 规则。
    let source =
        unsafe { CGImageSourceCreateWithURL(cf_url.to_void() as *const AnyObject, std::ptr::null()) };
    if source.is_null() {
        return Err("无法读取图片文件".to_string());
    }
    let cg_image_raw = unsafe { CGImageSourceCreateImageAtIndex(source, 0, std::ptr::null()) };
    if cg_image_raw.is_null() {
        return Err("图片解码失败".to_string());
    }
    // SAFETY：CGImageSourceCreateImageAtIndex 返回 +1 引用，交给 Retained 管理。
    let cg_image = unsafe { Retained::from_raw(cg_image_raw as *mut CGImage) }
        .ok_or_else(|| "图片引用构造失败".to_string())?;

    let request = VNRecognizeTextRequest::new();
    // 中文识别质量优先；语种必须显式给，否则中英混排会丢字
    {
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let languages = NSArray::from_retained_slice(&vec![
            NSString::from_str("zh-Hans"),
            NSString::from_str("zh-Hant"),
            NSString::from_str("en-US"),
        ]);
        request.setRecognitionLanguages(&languages);
    }

    // 上转型到基类 VNRequest（继承链 VNRecognizeTextRequest → VNImageBasedRequest → VNRequest）
    // clone 保住原对象，识别完还要取 results
    let requests =
        NSArray::from_retained_slice(&vec![request.clone().into_super().into_super()]);

    let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    let handler = unsafe {
        VNImageRequestHandler::initWithCGImage_options(
            VNImageRequestHandler::alloc(),
            &cg_image,
            &options,
        )
    };

    let result = handler.performRequests_error(&requests);
    if let Err(err) = result {
        // SAFETY：NSError 的 localizedDescription 是合法 ObjC 调用。
        let description: *const NSString = unsafe { msg_send![&*err, localizedDescription] };
        let message = if description.is_null() {
            "OCR 引擎调用失败".to_string()
        } else {
            unsafe { (*description).to_string() }
        };
        return Err(message);
    }

    let results = request.results();
    let Some(observations) = results else {
        return Err("OCR 没有返回结果".to_string());
    };

    let mut text = String::new();
    for observation in observations.iter() {
        let candidates = observation.topCandidates(1);
        if let Some(best) = candidates.firstObject() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&best.string().to_string());
        }
    }
    Ok(text)
}

#[derive(Debug)]
pub struct OcrItem {
    pub file_name: String,
    pub text: String,
    pub error: String,
}

/// 对一批本地图片跑 OCR（顺序执行，单图独立兜底，永不 panic）。
fn run_ocr(image_paths: Vec<(String, std::path::PathBuf)>) -> Vec<OcrItem> {
    image_paths
        .into_iter()
        .map(|(file_name, path)| match recognize_text_blocking(&path) {
            Ok(text) => OcrItem {
                file_name,
                text: text.trim().to_string(),
                error: String::new(),
            },
            Err(err) => OcrItem {
                file_name,
                text: String::new(),
                error: err,
            },
        })
        .collect()
}

/// spawn_blocking 包装：Vision 调用是阻塞的，不占 tokio worker。
pub async fn run_ocr_async(image_paths: Vec<(String, std::path::PathBuf)>) -> Vec<OcrItem> {
    tokio::task::spawn_blocking(move || run_ocr(image_paths))
        .await
        .unwrap_or_default()
}

/// 供 /health 报告引擎信息。
pub fn engine_info() -> (&'static str, Vec<&'static str>) {
    ("apple-vision", vec!["zh-Hans", "zh-Hant", "en-US"])
}
