// B 站匿名解析器：b23.tv 短链展开 + 视频/图文（opus）匿名解析。
//
// 与 anonymous-note-resolver.mjs 相同的匿名原则：
// - 所有请求显式 credentials: 'omit'，不携带账号 Cookie
// - 带浏览器 UA（Chrome 151）与 Referer https://www.bilibili.com
// - 无重试、无退避、无 UA 轮换；WAF/412/风控直接抛受控错误
//
// B 站专属约束：
// - b23.tv 302 展开（最多 3 跳、每跳校验宿主，展开后非 bilibili 域名拒绝）
// - 视频链：x/web-interface/view → x/tag/archive/tags →（可选）x/player/playurl
//   仅落 DASH 元数据（清晰度/时长/cid），不落签名 URL
// - 图文链：x/polymer/web-dynamic/v1/opus/detail（固定 buvid3 指纹，每安装生成一次
//   并持久化到 dataDirectory/settings.json，禁止每请求随机）；失败直接回退
//   noteFromSharedText，不调 x/article/view

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { noteFromSharedText } from './note-import.mjs';

const BILI_HOSTS = new Set([
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'b23.tv',
]);
const API_BASE = 'https://api.bilibili.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com';
const BUVid3_SETTINGS_KEY = 'buvid3';
const BUVid3_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\{[0-9a-f]{16}\}infoc$/i;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = cleanString(object?.[key]);
    if (value) return value;
  }
  return '';
}

/** 生成固定格式的 buvid3 指纹：uuid{hex16}infoc（每安装生成一次并持久化复用）。 */
export function generateBuvid3() {
  const uuid = randomUUID().toUpperCase();
  const entropy = randomUUID().replace(/-/g, '').slice(0, 16).toLowerCase();
  return `${uuid}{${entropy}}infoc`;
}

/** 读取 dataDirectory/settings.json 中的 buvid3；不存在则生成一次并持久化，重启复用。 */
export async function getOrCreateBuvid3(dataDirectory) {
  if (!dataDirectory || typeof dataDirectory !== 'string') return generateBuvid3();
  const settingsPath = path.join(dataDirectory, 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }
  const existing = settings[BUVid3_SETTINGS_KEY];
  if (typeof existing === 'string' && BUVid3_PATTERN.test(existing)) return existing;

  const buvid3 = generateBuvid3();
  const next = { ...settings, [BUVid3_SETTINGS_KEY]: buvid3 };
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // 持久化失败不阻断本次解析（极端磁盘场景），下次启动会重试生成。
  }
  return buvid3;
}

function assertAllowedBiliUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('没有识别到有效的B站链接');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !BILI_HOSTS.has(host)) {
    throw new Error('B站解析器只允许访问 bilibili 相关地址');
  }
  return url;
}

function biliRequestInit(extraHeaders = {}) {
  return {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': BILI_UA,
      Referer: BILI_REFERER,
      ...extraHeaders,
    },
  };
}

/** 展开 b23.tv 官方短链到真实 B 站页面；非短链（bilibili.com 域名）原样返回。
 *  最多跟随 MAX_REDIRECTS 跳，每跳校验目标必须是 B 站允许域名，
 *  展开后不是 bilibili 域名（如被带去任意站点）直接拒绝。 */
export async function expandBilibiliShortUrl(value, fetchImpl) {
  const initialUrl = assertAllowedBiliUrl(value);
  if (initialUrl.hostname.toLowerCase() !== 'b23.tv') return initialUrl;

  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, biliRequestInit());

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('B站短链展开重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('B站短链展开缺少目标地址');
      const next = assertAllowedBiliUrl(new URL(location, currentUrl).toString());
      // 跳到 bilibili 正式域名即视为展开完成；仍是 b23.tv 则继续跟随。
      if (next.hostname.toLowerCase() !== 'b23.tv') return next;
      currentUrl = next;
      continue;
    }
    if (!response.ok) throw new Error(`B站短链展开请求失败：${response.status}`);
    return currentUrl;
  }

  throw new Error('B站短链展开失败');
}

/** 请求 B 站 JSON 接口：校验宿主、拦截 412/403/HTML 风控页，返回解析后的 JSON。 */
async function fetchBiliJson(url, fetchImpl, extraHeaders = {}) {
  const response = await fetchImpl(url, biliRequestInit(extraHeaders));

  const finalHost = new URL(response.url || url).hostname.toLowerCase();
  if (finalHost !== 'api.bilibili.com') {
    throw new Error('B站接口跳转到了未知地址，已拒绝');
  }
  if (response.status === 412 || response.status === 403) {
    throw new Error('B站风控拦截，暂时无法匿名解析，请稍后重试');
  }
  if (!response.ok) throw new Error(`B站接口请求失败：${response.status}`);

  const text = await response.text();
  const trimmed = text.trim();
  // 风控/验证页面返回 HTML 而非 JSON，直接判为受控错误。
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error('B站接口返回了风控页面，暂时无法匿名解析');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('B站接口返回了无法解析的内容');
  }
}

function assertBiliCode(payload) {
  const code = payload?.code;
  if (code === 0) return payload?.data;
  if (code === -412) throw new Error('B站风控拦截（-412），暂时无法匿名解析，请稍后重试');
  if (code === -404) throw new Error('该B站内容不存在或已删除');
  if (code === -400) throw new Error('B站接口参数错误');
  throw new Error(`B站接口返回错误（code=${code ?? 'unknown'}）`);
}

/** 从 opus 图文中提取图片 URL（兼容 url / urlDefault / originUrl 字段）。 */
function imageUrlFromItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const direct = firstString(item, ['url', 'urlDefault', 'urlPre', 'originUrl']);
  if (/^https?:\/\//i.test(direct)) return direct.replace(/^http:/i, 'https:');
  for (const listKey of ['urlList', 'infoList', 'stream']) {
    const list = item[listKey];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const nested = imageUrlFromItem(entry);
      if (nested) return nested;
    }
  }
  return '';
}

function pictureUrlsFromOpus(opus) {
  const urls = [];
  for (const key of ['pictures', 'images', 'imageList', 'pics']) {
    const list = opus?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = imageUrlFromItem(item);
      if (url) urls.push(url);
    }
  }
  const cover = imageUrlFromItem(opus?.cover);
  if (cover) urls.push(cover);
  return Array.from(new Set(urls)).slice(0, 20);
}

/** 视频链：view → tags →（可选）playurl，仅落 DASH 元数据，不落签名 URL。 */
async function resolveVideo(bvid, aid, sourceUrl, fetchImpl) {
  const query = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : `aid=${encodeURIComponent(String(aid))}`;
  const viewPayload = await fetchBiliJson(
    `${API_BASE}/x/web-interface/view?${query}`,
    fetchImpl,
  );
  const data = assertBiliCode(viewPayload);
  const resolvedBvid = firstString(data, ['bvid']) || bvid;
  const resolvedAid = typeof data?.aid === 'number' ? data.aid : aid;
  const cid = typeof data?.cid === 'number' ? data.cid : undefined;
  if (!resolvedBvid || !cid) throw new Error('B站视频解析缺少必要字段（bvid/cid）');

  // 标签接口失败不阻断主数据（降级为空，用分区名兜底）。
  let tags = [];
  try {
    const tagsPayload = await fetchBiliJson(
      `${API_BASE}/x/tag/archive/tags?bvid=${encodeURIComponent(resolvedBvid)}`,
      fetchImpl,
    );
    const tagsData = assertBiliCode(tagsPayload);
    tags = Array.isArray(tagsData)
      ? tagsData.map((tag) => cleanString(tag?.tag_name)).filter(Boolean).slice(0, 20)
      : [];
  } catch {
    tags = [];
  }

  // DASH 链路：提取可直接下载的 mp4/m4s baseUrl，供 downloadVideo 本地落盘与详情页本地播放
  let dashMeta = {};
  let playableVideoUrl = '';
  try {
    const playPayload = await fetchBiliJson(
      // fnval=1 请求 MP4 容器（durl 完整单文件，<video> 可直接播放）；
      // fnval=16 会返回 DASH 分片（m4s 音画分离），本地落盘后无法直接播放。
      `${API_BASE}/x/player/playurl?bvid=${encodeURIComponent(resolvedBvid)}&cid=${cid}&fnval=1&fnver=0&fourk=0`,
      fetchImpl,
    );
    const playData = assertBiliCode(playPayload);
    dashMeta = {
      quality: typeof playData?.quality === 'number' ? playData.quality : undefined,
      duration: typeof playData?.duration === 'number' ? playData.duration : undefined,
    };
    const pickVideoBaseUrl = (payload) => {
      const durl = Array.isArray(payload?.durl) ? payload.durl : null;
      if (durl && durl[0]?.url) return String(durl[0].url);
      const dashVideo = payload?.dash?.video;
      if (Array.isArray(dashVideo) && dashVideo[0]?.baseUrl) return String(dashVideo[0].baseUrl);
      if (Array.isArray(dashVideo) && dashVideo[0]?.base_url) return String(dashVideo[0].base_url);
      return '';
    };
    playableVideoUrl = pickVideoBaseUrl(playData);
  } catch {
    dashMeta = {};
    playableVideoUrl = '';
  }

  const pic = cleanString(data?.pic).replace(/^http:/i, 'https:');
  const face = cleanString(data?.owner?.face).replace(/^http:/i, 'https:');
  return {
    id: resolvedBvid,
    sourceUrl,
    title: cleanString(data?.title) || '未命名视频',
    content: cleanString(data?.desc),
    imageUrls: pic ? [pic] : [],
    coverUrl: pic,
    videoUrl: playableVideoUrl,
    author: {
      name: cleanString(data?.owner?.name) || '未知作者',
      avatar: face,
      userId: typeof data?.owner?.mid === 'number' ? String(data.owner.mid) : '',
    },
    tags: tags.length ? tags : cleanString(data?.tname) ? [cleanString(data.tname)] : [],
    type: 'video',
    bvid: resolvedBvid,
    aid: resolvedAid,
    cid,
    duration: typeof data?.duration === 'number' ? data.duration : dashMeta.duration,
    quality: dashMeta.quality,
  };
}

/** 图文链：opus/detail（固定 buvid3 指纹），失败回退由调用方处理。 */
async function resolveOpus(opusId, sourceUrl, fetchImpl, dataDirectory) {
  let buvid3;
  try {
    buvid3 = await getOrCreateBuvid3(dataDirectory);
  } catch {
    // settings.json 完全不可用时兜底一次（正常路径每安装只生成一次）。
    buvid3 = generateBuvid3();
  }

  const payload = await fetchBiliJson(
    `${API_BASE}/x/polymer/web-dynamic/v1/opus/detail?id=${encodeURIComponent(opusId)}&features=htmlNewStyle`,
    fetchImpl,
    { Cookie: `buvid3=${buvid3}` },
  );
  const item = assertBiliCode(payload);
  const opus = item?.item || item || {};
  const title = firstString(opus, ['title']);
  const content = firstString(opus, ['summary', 'content', 'text']);
  const pictures = pictureUrlsFromOpus(opus);
  if (!title && !content && pictures.length === 0) {
    throw new Error('B站图文解析返回内容为空');
  }
  const face = cleanString(opus?.author?.face).replace(/^http:/i, 'https:');
  return {
    id: String(opus?.opus_id || opus?.id || opusId),
    sourceUrl,
    title: title || '未命名图文',
    content,
    imageUrls: pictures,
    coverUrl: pictures[0] || '',
    videoUrl: '',
    author: {
      name: firstString(opus?.author, ['name', 'nickname']) || '未知作者',
      avatar: face,
      userId: typeof opus?.author?.mid === 'number' ? String(opus.author.mid) : '',
    },
    tags: [],
    type: 'normal',
    opusId: String(opusId),
  };
}

/** 解析 B 站分享链接（b23.tv / bilibili.com 视频或图文）。
 *  options:
 *  - fetchImpl: 注入的 fetch（测试用）
 *  - dataDirectory: buvid3 指纹持久化目录（opus 解析需要）
 *  - sharedText: 原始共享文本；opus 解析失败时回退 noteFromSharedText */
export async function resolveBilibiliNote(sourceUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const pageUrl = await expandBilibiliShortUrl(sourceUrl, fetchImpl);
  const pathname = pageUrl.pathname;

  const bvMatch = pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/i);
  const avMatch = pathname.match(/^\/video\/(av\d+)(?:\/|$)/i);
  const opusMatch = pathname.match(/^\/opus\/(\d+)(?:\/|$)/i);

  if (bvMatch) {
    return resolveVideo(bvMatch[1], undefined, pageUrl.toString(), fetchImpl);
  }
  if (avMatch) {
    const aid = Number.parseInt(avMatch[1].slice(2), 10);
    return resolveVideo(undefined, aid, pageUrl.toString(), fetchImpl);
  }
  if (opusMatch) {
    try {
      return await resolveOpus(opusMatch[1], pageUrl.toString(), fetchImpl, options.dataDirectory);
    } catch (error) {
      // 图文匿名解析失败直接回退共享文本；不调 x/article/view。
      if (typeof options.sharedText === 'string' && options.sharedText.trim()) {
        return noteFromSharedText(options.sharedText);
      }
      throw error;
    }
  }
  throw new Error('没有识别到B站视频或图文链接');
}
