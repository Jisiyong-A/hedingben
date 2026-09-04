import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

import { runOcr, getOcrEngineInfo } from '../ocr/index.mjs';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const MEDIA_HOST_SUFFIXES = ['.xhscdn.com', '.xhsimg.com', '.hdslb.com', '.bilibili.com'];
const VIDEO_HOST_SUFFIXES = [
  '.hdslb.com',
  '.bilibili.com',
  '.bilivideo.com',
  '.akamaized.net',
  '.acgvideo.com',
  '.upos-hz-mirrorakam.akamaized.net',
  '.upos-sz-mirrorcosov.bilivideo.com',
];
const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
export function isAllowedRemoteImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && MEDIA_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS.get(normalized) || '';
}

const REFERER_BY_SOURCE = {
  bilibili: 'https://www.bilibili.com/',
  xhs: 'https://www.xiaohongshu.com/',
};

async function fetchImageResponse(url, fetchImpl, source = 'xhs', redirectCount = 0) {
  if (!isAllowedRemoteImageUrl(url)) throw new Error('图片地址不属于受支持的图床');

  const referer = REFERER_BY_SOURCE[source] || REFERER_BY_SOURCE.xhs;
  const response = await fetchImpl(url, {
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: referer,
      'User-Agent': 'ShouCangFavorites/0.1 local-media-import',
    },
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error('图片重定向次数过多');
    const location = response.headers.get('location');
    if (!location) throw new Error('图片重定向缺少目标地址');
    return fetchImageResponse(new URL(location, url).toString(), fetchImpl, source, redirectCount + 1);
  }
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  return response;
}

async function downloadImage(url, noteDirectory, index, fetchImpl, source) {
  const response = await fetchImageResponse(url, fetchImpl, source);
  const extension = extensionFromContentType(response.headers.get('content-type'));
  if (!extension) throw new Error('远程内容不是可识别的图片');

  const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error('单张图片超过 15MB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('单张图片超过 15MB');

  const fileName = `${String(index + 1).padStart(2, '0')}${extension}`;
  const filePath = path.join(noteDirectory, fileName);
  await writeFile(filePath, buffer);
  return { fileName, filePath, sourceUrl: url };
}

const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300MB cap for a single video
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;

function isAllowedRemoteVideoUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return VIDEO_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
      || MEDIA_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  } catch { return false; }
}

/** Stream a remote video to <noteDir>/video.mp4. Best-effort: failures
 *  never block the import — the note stays saved with images only. */
async function downloadVideo(url, noteDirectory, fetchImpl, source) {
  if (!/^https?:\/\//.test(url || '')) return null;
  // 无条件白名单（与 Rust 侧 download_video 对齐）：B站 DASH 产生的可播放
  // mp4/m4s 必须在白名单内。XHS 源同样不允许任意 URL —— 否则 payload 里的
  // videoUrl 就是任意的服务端 fetch+落盘（SSRF 读穿）。
  if (!isAllowedRemoteVideoUrl(url)) return null;
  const referer = REFERER_BY_SOURCE[source] || REFERER_BY_SOURCE.xhs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);
  const filePath = path.join(noteDirectory, 'video.mp4');
  const fileStream = createWriteStream(filePath);
  try {
    let currentUrl = url;
    for (let redirectCount = 0; ; redirectCount += 1) {
      // 每一跳都复核：白名单域的 302 可以指向任意域
      if (!isAllowedRemoteVideoUrl(currentUrl)) return null;
      const response = await (fetchImpl || fetch)(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          Referer: referer,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirectCount >= MAX_REDIRECTS) return null;
        const location = response.headers.get('location');
        if (!location) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok || !response.body) return null;
      const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
      if (declaredLength > MAX_VIDEO_BYTES) return null;

      let received = 0;
      const reader = response.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_VIDEO_BYTES) {
          throw new Error('video exceeds size cap');
        }
        const chunk = Buffer.from(value);
        // 尊重背压：慢盘上不限制会让 300MB 全部堆进内存
        if (!fileStream.write(chunk)) {
          await new Promise((resolve) => fileStream.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => {
        fileStream.end(resolve);
        fileStream.on('error', reject);
      });
      return { fileName: 'video.mp4', filePath, sourceUrl: url };
    }
  } catch {
    // 失败不能留下截断的 video.mp4 —— /media/:id/video.mp4 会把它
    // 当完整文件伺服出去
    fileStream.destroy();
    await rm(filePath, { force: true }).catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(values, concurrency, callback) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await callback(values[index], index);
      } catch (error) {
        results[index] = {
          error: error instanceof Error ? error.message : '图片处理失败',
          sourceUrl: values[index],
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function localizeNoteMedia(note, options) {
  const sourceUrls = Array.from(new Set(
    (note.imageUrls || []).filter(isAllowedRemoteImageUrl),
  )).slice(0, 20);
  const noteDirectory = path.join(options.mediaDirectory, note.id);
  await mkdir(noteDirectory, { recursive: true });

  if (sourceUrls.length === 0 && !note.videoUrl) {
    return {
      ...note,
      sourceImageUrls: [],
      imageUrls: [],
      imageOcr: [],
      ocrText: '',
      videoLocalPath: '',
      videoError: '',
      mediaStatus: 'none',
    };
  }
  const source = note.source === 'bilibili' ? 'bilibili' : 'xhs';
  const downloads = await mapWithConcurrency(
    sourceUrls,
    options.downloadConcurrency || 2,
    (url, index) => downloadImage(url, noteDirectory, index, options.fetchImpl || fetch, source),
  );
  const successful = downloads.filter((item) => item?.filePath);

  let ocrResults = [];
  let ocrError = '';
  let ocrEngine = null;
  let ocrEngineVersion = null;
  try {
    const ocrOutcome = await (options.ocrRunner || runOcr)(
      successful.map((item) => item.filePath),
      { concurrency: options.ocrConcurrency || 1 },
    );
    // facade returns { results, engine, engineVersion }; legacy runners
    // return a bare array.
    ocrResults = Array.isArray(ocrOutcome) ? ocrOutcome : (ocrOutcome?.results || []);
    ocrEngine = Array.isArray(ocrOutcome) ? null : (ocrOutcome?.engine || null);
    ocrEngineVersion = Array.isArray(ocrOutcome) ? null : (ocrOutcome?.engineVersion || null);
  } catch (error) {
    ocrError = error instanceof Error ? error.message : '本地 OCR 失败';
  }
  const ocrEngineInfo = getOcrEngineInfo(ocrEngine);
  const ocrProcessedAt = new Date().toISOString();
  const ocrByPath = new Map(ocrResults.map((result) => [result.path, result]));
  const imageOcr = successful.map((item) => {
    const result = ocrByPath.get(item.filePath);
    return {
      imageUrl: `${options.publicBaseUrl}/media/${note.id}/${item.fileName}`,
      text: typeof result?.text === 'string' ? result.text.trim() : '',
      error: result?.error || '',
    };
  });
  const localImageUrls = imageOcr.map((item) => item.imageUrl);
  const ocrText = imageOcr.map((item) => item.text).filter(Boolean).join('\n\n');
  const failedDownloads = downloads.length - successful.length;

  // Video (best-effort, never blocks the import)
  let videoLocalPath = '';
  let videoError = '';
  if (note.videoUrl) {
    const videoResult = await downloadVideo(note.videoUrl, noteDirectory, options.fetchImpl, source);
    if (videoResult?.filePath) {
      videoLocalPath = `${options.publicBaseUrl}/media/${note.id}/video.mp4`;
    } else {
      videoError = '视频下载失败（已保留图片）';
    }
  }

  return {
    ...note,
    sourceImageUrls: sourceUrls,
    imageUrls: localImageUrls,
    coverUrl: localImageUrls[0] || note.coverUrl || '',
    imageOcr,
    ocrText,
    videoLocalPath,
    videoError,
    // OCR cache metadata: lets a future engine-version bump re-run OCR.
    ...(ocrEngine ? {
      ocrEngine: ocrEngineInfo.engine,
      ocrEngineVersion: ocrEngineInfo.engineVersion,
      ocrProcessedAt,
    } : {}),
    mediaStatus: failedDownloads === 0 && !ocrError && !videoError ? 'ready' : 'partial',
    mediaError: [
      failedDownloads ? `${failedDownloads} 张图片保存失败` : '',
      ocrError,
      videoError,
    ].filter(Boolean).join('；'),
  };
}
