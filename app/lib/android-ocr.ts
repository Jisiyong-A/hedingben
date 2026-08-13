import type { Note } from '../types/xiaohongshu';
import { LOCAL_API_BASE_URL } from './xhs-client';

declare global {
  interface Window {
    OcrBridge?: {
      recognize: (noteId: string, file: string) => string;
    };
  }
}

const OCR_PATH_PATTERN = /\/media\/([0-9a-f]{20,26})\/((?:\d{2}\.(?:avif|gif|heic|heif|jpg|png|webp)))$/i;

/**
 * Android 端 OCR 编排（桌面无 OcrBridge，安全 no-op）：
 * 导入完成后对本地图片逐张调 ML Kit bridge → 汇总 → POST /notes/{id}/ocr 回写。
 * best-effort：bridge 缺失/识别失败均不阻断导入结果。
 */
export async function runAndroidOcr(note: Note): Promise<void> {
  const bridge = window.OcrBridge;
  if (!bridge) return;

  const localFiles = (note.imageUrls || [])
    .map((url) => url.match(OCR_PATH_PATTERN))
    .filter((match): match is RegExpMatchArray =>
      match !== null && match[1].toLowerCase() === note.id.toLowerCase())
    .map((match) => match[2]);

  if (localFiles.length === 0) return;

  const imageOcr = localFiles.map((file) => {
    let text = '';
    let error = '';
    try {
      text = bridge.recognize(note.id, file).trim();
    } catch {
      error = 'OCR 调用失败';
    }
    return {
      imageUrl: `${LOCAL_API_BASE_URL}/media/${note.id}/${file}`,
      text,
      error,
    };
  });

  const ocrText = imageOcr.map((item) => item.text).filter(Boolean).join('\n\n');

  try {
    await fetch(`${LOCAL_API_BASE_URL}/notes/${note.id}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageOcr, ocrText }),
    });
  } catch {
    // best-effort：OCR 回写失败不影响已保存的笔记
  }
}
