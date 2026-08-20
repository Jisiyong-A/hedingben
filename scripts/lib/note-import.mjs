const DRAG_PAYLOAD_PREFIX = 'SHOUCANG_NOTE:';
const CARD_DRAG_PAYLOAD_PREFIX = 'SHOUCANG_CARD:';
const ALLOWED_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'm.xiaohongshu.com',
  'xhslink.cn',
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'b23.tv',
]);

const NOTE_PATH_PATTERNS = [
  // XHS note IDs vary in length (20-26 hex chars); match the common range.
  /^\/explore\/([0-9a-f]{20,26})(?:\/|$)/i,
  /^\/search_result\/([0-9a-f]{20,26})(?:\/|$)/i,
  /^\/discovery\/item\/([0-9a-f]{20,26})(?:\/|$)/i,
  // Bilibili video (BV id is 10 alphanumeric chars).
  /^\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/i,
  // Bilibili legacy av id.
  /^\/video\/(av\d+)(?:\/|$)/i,
  // Bilibili opus (article) id.
  /^\/opus\/(\d+)(?:\/|$)/i,
];

function extractUrls(input) {
  if (typeof input !== 'string') return [];
  return input.match(/https?:\/\/[^\s<>"'，。！？；）】]+/gi)
    ?.map((value) => value.replace(/[),.;!?]+$/g, '')) ?? [];
}

function parseSupportedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('没有识别到有效的小红书笔记链接');
  }

  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('不支持该页面链接');
  }

  return url;
}

export function extractSharedNoteUrl(input) {
  const supportedUrl = extractUrls(input)
    .map((value) => {
      try {
        return parseSupportedUrl(value);
      } catch {
        return null;
      }
    })
    .find(Boolean);

  if (!supportedUrl) {
    throw new Error('没有识别到有效的笔记链接');
  }

  return supportedUrl.toString();
}

export function extractNoteIdFromUrl(value) {
  const url = parseSupportedUrl(value);
  for (const pattern of NOTE_PATH_PATTERNS) {
    const match = url.pathname.match(pattern);
    if (match) {
      const id = match[1];
      // BV ids are base58-encoded and case-sensitive; XHS hex ids are case-insensitive
      return id.startsWith('BV') || id.startsWith('bv') ? id : id.toLowerCase();
    }
  }
  return null;
}

export function serializeDraggedNote(note) {
  return `${DRAG_PAYLOAD_PREFIX}${JSON.stringify(note)}`;
}

export function parseDraggedNoteInput(input) {
  if (typeof input !== 'string') return null;
  const markerIndex = input.indexOf(DRAG_PAYLOAD_PREFIX);
  if (markerIndex === -1) return null;

  try {
    return JSON.parse(input.slice(markerIndex + DRAG_PAYLOAD_PREFIX.length));
  } catch {
    throw new Error('拖入的笔记数据已损坏，请刷新页面后重试');
  }
}

export function parseDraggedCardInput(input) {
  if (typeof input !== 'string') return null;
  const markerIndex = input.indexOf(CARD_DRAG_PAYLOAD_PREFIX);
  if (markerIndex === -1) return null;

  try {
    const payload = JSON.parse(input.slice(markerIndex + CARD_DRAG_PAYLOAD_PREFIX.length));
    const sourceUrl = extractSharedNoteUrl(cleanText(payload?.sourceUrl, 5000));
    const noteId = extractNoteIdFromUrl(sourceUrl);
    // BV ids are case-sensitive base58; compare both sides lowercased so the
    // extension's exact BV string round-trips through the card payload.
    if (!noteId || noteId.toLowerCase() !== cleanText(payload?.id, 100).toLowerCase()) return null;
    return {
      id: noteId,
      sourceUrl,
      title: cleanText(payload?.title, 300),
    };
  } catch {
    throw new Error('拖入的笔记链接已损坏，请刷新页面后重试');
  }
}

function cleanText(value, maxLength = 20000) {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, maxLength)
    : '';
}

function normalizeImageUrls(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 3000))
    .filter((item) => /^https:\/\//i.test(item))
    .slice(0, 20);
}

export function normalizeImportedNote(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('没有读取到笔记内容');
  }

  const sharedUrl = extractSharedNoteUrl(cleanText(payload.sourceUrl, 5000));
  const sourceUrlObject = new URL(sharedUrl);
  sourceUrlObject.search = '';
  sourceUrlObject.hash = '';
  const sourceUrl = sourceUrlObject.toString();
  const noteId = extractNoteIdFromUrl(sourceUrl) || cleanText(payload.id, 100);
  const host = sourceUrlObject.hostname.toLowerCase();
  const isBilibili = /bilibili\.com$/i.test(host);
  // XHS note IDs are typically 20-26 hex chars; bilibili uses BV/av/opus ids.
  if (isBilibili) {
    if (!/^(BV[a-zA-Z0-9]{10}|av\d+|\d+)$/i.test(noteId)) {
      throw new Error('当前页面不是可识别的B站内容');
    }
  } else if (!/^[0-9a-f]{20,26}$/i.test(noteId)) {
    throw new Error('当前页面不是可识别的小红书笔记');
  }

  const title = cleanText(payload.title, 300) || '未命名笔记';
  const content = cleanText(payload.content);
  if (!content && title === '未命名笔记') {
    throw new Error('当前页面没有可收藏的正文，请先打开笔记详情');
  }

  const imageUrls = normalizeImageUrls(payload.imageUrls);
  const type = payload.type === 'video' ? 'video' : 'normal';
  const videoUrl = cleanText(payload.videoUrl, 5000);

  return {
    id: /^BV/i.test(noteId) ? noteId : noteId.toLowerCase(),
    source: isBilibili ? 'bilibili' : 'xhs',
    sourceUrl,
    title,
    content,
    rawContent: content,
    ocrText: '',
    coverUrl: cleanText(payload.coverUrl, 3000) || imageUrls[0] || '',
    imageUrls,
    sourceImageUrls: imageUrls,
    imageOcr: [],
    videoUrl,
    mediaStatus: imageUrls.length > 0 ? 'pending' : 'none',
    mediaError: '',
    author: {
      name: cleanText(payload.author?.name, 200) || '未知作者',
      avatar: cleanText(payload.author?.avatar, 3000),
      userId: cleanText(payload.author?.userId, 200),
    },
    likes: 0,
    collects: 0,
    comments: 0,
    category: '待分类',
    savedAt: new Date().toISOString(),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => cleanText(tag, 100)).filter(Boolean).slice(0, 20)
      : [],
    type,
    imageAspect: undefined,
    ...(isBilibili && {
      bvid: /^BV/i.test(noteId) ? noteId : cleanText(payload.bvid, 100) || undefined,
      aid: typeof payload.aid === 'number' ? payload.aid : undefined,
      cid: typeof payload.cid === 'number' ? payload.cid : undefined,
      opusId: cleanText(payload.opusId, 100) || (/^\/opus\//i.test(sourceUrlObject.pathname) ? noteId : undefined),
    }),
  };
}

export function noteFromSharedText(input) {
  const sourceUrl = extractSharedNoteUrl(input);
  const withoutUrl = cleanText(input).replace(sourceUrl, '').trim();
  const lines = withoutUrl
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(复制|打开小红书|查看完整笔记)/.test(line));

  const meaningfulText = lines.join('\n').trim();
  if (meaningfulText.length < 12) {
    throw new Error('单独拖入链接无法安全读取正文，请刷新扩展后直接拖动小红书笔记卡片');
  }

  // Bilibili URL: b23 short links don't have extractable noteIds in their paths,
  // so construct the note directly rather than going through normalizeImportedNote's
  // XHS-centric noteId extraction.
  let urlHost;
  try {
    urlHost = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    urlHost = '';
  }
  if (/bilibili\.com$/i.test(urlHost) || /b23\.tv$/i.test(urlHost)) {
    const title = lines[0] || '未命名笔记';
    const content = lines.slice(1).join('\n') || lines[0];
    // Try to extract opusId from URL path (e.g. /opus/12345)
    let opusId;
    try {
      const urlObj = new URL(sourceUrl);
      const opusMatch = urlObj.pathname.match(/^\/opus\/(\d+)/);
      if (opusMatch) opusId = opusMatch[1];
    } catch { /* ignore */ }
    return {
      id: sourceUrl,
      source: 'bilibili',
      sourceUrl,
      title,
      content,
      rawContent: content,
      ocrText: '',
      coverUrl: '',
      imageUrls: [],
      sourceImageUrls: [],
      imageOcr: [],
      videoUrl: '',
      mediaStatus: 'none',
      mediaError: '',
      author: { name: '未知作者', avatar: '', userId: '' },
      likes: 0,
      collects: 0,
      comments: 0,
      category: '待分类',
      savedAt: new Date().toISOString(),
      tags: [],
      type: 'normal',
      ...(opusId && { opusId }),
    };
  }

  return normalizeImportedNote({
    sourceUrl,
    title: lines[0],
    content: lines.slice(1).join('\n') || lines[0],
  });
}

export function mergeImportedNote(existingNotes, importedNote) {
  const safeExistingNotes = Array.isArray(existingNotes) ? existingNotes : [];
  const created = !safeExistingNotes.some((note) => note?.id === importedNote?.id);
  return {
    created,
    notes: [importedNote, ...safeExistingNotes.filter((note) => note?.id !== importedNote?.id)],
  };
}

export function removeStoredNote(existingNotes, noteId) {
  const safeExistingNotes = Array.isArray(existingNotes) ? existingNotes : [];
  const deletedNote = safeExistingNotes.find((note) => note?.id === noteId) || null;

  return {
    deletedNote,
    notes: deletedNote
      ? safeExistingNotes.filter((note) => note?.id !== noteId)
      : safeExistingNotes,
  };
}
