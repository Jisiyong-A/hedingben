const PAGE_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'm.xiaohongshu.com',
  'bilibili.com',
  'www.bilibili.com',
]);
// 小红书官方短链域名：分享链接形如 https://xhslink.cn/o/<code>，会 302 到真实笔记页。
// B站短链域名：分享链接形如 https://b23.tv/<code>，会 302 到真实视频页。
const SHORT_HOSTS = new Set(['xhslink.cn', 'b23.tv']);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

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

function assertAllowedPageUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(PAGE_HOSTS.has(host) || SHORT_HOSTS.has(host))) {
    throw new Error('匿名解析器只允许访问受支持的笔记页面');
  }
  return url;
}

function imageUrlFromItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';

  const direct = firstString(item, ['urlDefault', 'urlPre', 'url', 'originUrl']);
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

function imageUrlsFromNote(note) {
  const urls = [];
  for (const key of ['imageList', 'images', 'image_list']) {
    const list = note?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = imageUrlFromItem(item);
      if (url) urls.push(url);
    }
  }

  for (const candidate of [note?.cover, note?.video?.cover, note?.video?.firstFrame]) {
    const url = imageUrlFromItem(candidate);
    if (url) urls.push(url);
  }
  return Array.from(new Set(urls)).slice(0, 20);
}

function looksLikeNote(value, noteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidateId = firstString(value, ['noteId', 'note_id', 'id']).toLowerCase();
  if (candidateId !== noteId.toLowerCase()) return false;
  return Boolean(
    firstString(value, ['title', 'displayTitle', 'desc', 'description', 'content'])
    || imageUrlsFromNote(value).length,
  );
}

function findNote(root, noteId) {
  if (!root || typeof root !== 'object') return null;
  const directCandidates = [
    root?.noteDetailMap?.[noteId]?.note,
    root?.noteDetailMap?.[noteId],
    root?.noteData?.data?.noteData,
    root?.noteData?.note,
  ];
  const direct = directCandidates.find((value) => looksLikeNote(value, noteId));
  if (direct) return direct;

  const queue = [{ value: root, depth: 0 }];
  const visited = new WeakSet();
  let inspected = 0;
  while (queue.length && inspected < 20_000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    if (looksLikeNote(value, noteId)) return value;
    if (depth >= 8) continue;

    let entries;
    try {
      entries = Array.isArray(value) ? value : Object.values(value);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry === 'object') queue.push({ value: entry, depth: depth + 1 });
    }
  }
  return null;
}

// 把序列化 JSON 里的裸 undefined 字面量替换成 null。
// 必须跳过字符串字面量内部 —— 正文里出现 "undefined" 一词的笔记
// （技术类笔记很常见）不能被改成 "null"。
function replaceUndefinedLiterals(serialized) {
  let result = '';
  let inString = false;
  let escaped = false;
  let tokenStart = -1;
  for (let i = 0; i < serialized.length; i += 1) {
    const char = serialized[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      result += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      if (tokenStart === -1) tokenStart = i;
      continue;
    }
    if (tokenStart !== -1) {
      const word = serialized.slice(tokenStart, i);
      result += word === 'undefined' ? 'null' : word;
      tokenStart = -1;
    }
    result += char;
  }
  if (tokenStart !== -1) {
    const word = serialized.slice(tokenStart);
    result += word === 'undefined' ? 'null' : word;
  }
  return result;
}

function extractInitialState(html) {  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf('</script>', valueStart);
  if (valueEnd === -1) return null;
  const serialized = html.slice(valueStart, valueEnd).trim().replace(/;$/, '');

  try {
    return JSON.parse(serialized);
  } catch {
    try {
      return JSON.parse(replaceUndefinedLiterals(serialized));
    } catch {
      return null;
    }
  }
}

function tagsFromNote(note) {
  const tags = [];
  for (const key of ['tagList', 'tags', 'topicList']) {
    const values = note?.[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const tag = typeof value === 'string'
        ? value
        : firstString(value, ['name', 'title', 'tagName', 'topicName']);
      if (tag) tags.push(tag.replace(/^#/, ''));
    }
  }
  return Array.from(new Set(tags)).slice(0, 20);
}

function videoUrlFromNote(note) {
  const candidates = [];
  if (note?.video) {
    const v = note.video;
    const push = (value) => {
      if (typeof value === 'string' && /^https?:\/\//.test(value)) candidates.push(value);
    };
    push(v.url);
    push(v.masterUrl);
    // stream sources (h264/aac), XHS serves these via masterUrl / backupUrls
    for (const streamKey of ['h264', 'h265', 'aac']) {
      const stream = v?.media?.video?.[streamKey] || v?.media?.[streamKey] || v?.[streamKey];
      if (Array.isArray(stream)) {
        for (const entry of stream) {
          push(entry?.masterUrl);
          for (const backup of entry?.backupUrls || []) push(backup);
        }
      }
    }
  }
  return candidates[0] || '';
}

/** Regex-scan raw HTML for XHS video CDN URLs (signed mp4 stream links
 *  live in script payloads, not __INITIAL_STATE__). */
function videoUrlFromHtml(html) {
  const matches = String(html || '').match(/https?:\/\/sns-video[a-z0-9-]*\.xhscdn\.com[^"'\\\s)]*\.mp4[^"'\\\s)]*/g) || [];
  if (matches.length === 0) return '';
  const tier = (url) => Number.parseInt(url.match(/_(\d{2,4})\.mp4/)?.[1] || '0', 10);
  return matches.sort((a, b) => tier(b) - tier(a))[0] || '';
}

function notePayloadFromHtml(html, noteId, sourceUrl) {
  // 风控/失效页面 detection: Xiaohongshu serves /404/sec_* pages (which
  // contain no note data) when the anonymous request is challenged. Never
  // silently import recommendations from those pages.
  if (/\/404\/(?:sec_|pc_)?/i.test(html.slice(0, 4000))) {
    throw new Error('笔记暂时无法匿名浏览（风控），请稍后重试，或在笔记详情页使用「拖到收藏」按钮');
  }

  const state = extractInitialState(html);
  const noteRoot = state?.note || state?.noteData || null;
  const note = findNote(noteRoot, noteId);
  if (!note) {
    throw new Error('没有读到笔记内容：小红书当前要求登录后才能查看正文。请先点开这篇笔记，再使用详情页的「拖到收藏」按钮或直接拖拽笔记页面');
  }

  const user = note.user || note.author || {};
  const imageUrls = imageUrlsFromNote(note);
  const videoUrl = videoUrlFromNote(note) || videoUrlFromHtml(html);
  const title = firstString(note, ['title', 'displayTitle']);
  const content = firstString(note, ['desc', 'description', 'content']);
  if (!title && !content && imageUrls.length === 0 && !videoUrl) {
    throw new Error('匿名解析返回的笔记内容为空');
  }
  // Guard: a valid note must carry its own images (or be a video with a
  // cover); a note with a bare cover and no body is almost certainly a
  // recommendation-card artifact.
  if (imageUrls.length === 0 && !videoUrl) {
    throw new Error('匿名解析没有读到笔记图片（风控或链接失效），请稍后重试');
  }

  return {
    id: noteId,
    sourceUrl,
    title,
    content,
    imageUrls,
    coverUrl: imageUrls[0] || '',
    videoUrl,
    author: {
      name: firstString(user, ['nickname', 'name', 'nickName']),
      avatar: firstString(user, ['avatar', 'image']),
      userId: firstString(user, ['userId', 'user_id', 'id']),
    },
    tags: tagsFromNote(note),
    type: note.type === 'video' || note.video ? 'video' : 'normal',
  };
}

async function fetchAnonymousPage(sourceUrl, fetchImpl) {
  let currentUrl = assertAllowedPageUrl(sourceUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        // A standard browser UA matters: Xiaohongshu serves its SSR page to
        // browser-like clients and 302-redirects exotic UAs to /404/ (风控).
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('匿名解析重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('匿名解析重定向缺少目标地址');
      currentUrl = assertAllowedPageUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`匿名解析请求失败：${response.status}`);

    const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredLength > MAX_HTML_BYTES) throw new Error('匿名解析页面过大');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('匿名解析页面过大');
    return html;
  }

  throw new Error('匿名解析失败');
}

/// 展开小红书官方短链（xhslink.cn）到真实笔记 URL；非短链原样返回。
/// 只跟随重定向（最多 MAX_REDIRECTS 次），每跳校验目标必须是小红书允许域名，
/// 避免被短链带往任意站点。
async function expandShortUrl(value, fetchImpl) {
  const initialUrl = assertAllowedPageUrl(value);
  if (!SHORT_HOSTS.has(initialUrl.hostname.toLowerCase())) return initialUrl;

  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('短链展开重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('短链展开缺少目标地址');
      const next = assertAllowedPageUrl(new URL(location, currentUrl).toString());
      // 跳到小红书正式域名即视为展开完成；仍为短链则继续跟随。
      if (!SHORT_HOSTS.has(next.hostname.toLowerCase())) return next;
      currentUrl = next;
      continue;
    }
    if (!response.ok) throw new Error(`短链展开请求失败：${response.status}`);
    // 短链服务通常只返回重定向；如果直接 200（很少见），按当前地址处理。
    return currentUrl;
  }

  throw new Error('短链展开失败');
}

export async function resolveAnonymousNote(sourceUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const pageUrl = await expandShortUrl(sourceUrl, fetchImpl);
  const noteId = options.expectedNoteId || pageUrl.pathname
    .match(/^\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{20,26})(?:\/|$)/i)?.[1];
  if (!noteId || !/^[0-9a-f]{20,26}$/i.test(noteId)) {
    throw new Error('匿名解析器没有识别到笔记 ID');
  }

  const html = await fetchAnonymousPage(pageUrl.toString(), fetchImpl);
  return notePayloadFromHtml(html, noteId.toLowerCase(), pageUrl.toString());
}
