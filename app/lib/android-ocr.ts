import type { Note } from '../types/xiaohongshu';
import { LOCAL_API_BASE_URL } from './xhs-client';

declare global {
  interface Window {
    OcrBridge?: {
      submit: (noteId: string, file: string) => void;
      poll: (noteId: string, file: string) => string;
    };
  }
}

const OCR_PATH_PATTERN = /\/media\/([0-9a-f]{20,26})\/((?:\d{2}\.(?:avif|gif|heic|heif|jpg|png|webp)))$/i;

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Android 端 OCR 编排（桌面无 OcrBridge，安全 no-op）：
 * 导入完成后对本地图片逐张 submit → 轮询 poll（异步，不阻塞 JS 线程）
 * → 汇总 → POST /notes/{id}/ocr 回写。
 * best-effort：bridge 缺失/识别失败/超时均不阻断导入结果。
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

  // 异步提交全部图片
  for (const file of localFiles) {
    bridge.submit(note.id, file);
  }

  // 轮询结果（非阻塞，页面保持响应）
  const results = new Map<string, { text: string; error: string }>();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (results.size < localFiles.length && Date.now() < deadline) {
    for (const file of localFiles) {
      if (results.has(file)) continue;
      const text = bridge.poll(note.id, file).trim();
      if (text !== '') {
        results.set(file, { text, error: '' });
      } else if (Date.now() >= deadline) {
        results.set(file, { text: '', error: 'OCR 超时' });
      }
    }
    if (results.size < localFiles.length) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  // 超时未返回的置为失败
  for (const file of localFiles) {
    if (!results.has(file)) results.set(file, { text: '', error: 'OCR 超时' });
  }

  const imageOcr = localFiles.map((file) => {
    const result = results.get(file) ?? { text: '', error: 'OCR 调用失败' };
    return {
      imageUrl: `${LOCAL_API_BASE_URL}/media/${note.id}/${file}`,
      text: result.text,
      error: result.error,
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
