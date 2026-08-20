import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  expandBilibiliShortUrl,
  generateBuvid3,
  getOrCreateBuvid3,
  resolveBilibiliNote,
} from './bilibili-resolver.mjs';
import { normalizeImportedNote } from './note-import.mjs';

const BV = 'BV1GJ411x7h7';
const AID = 170001;
const CID = 280001;
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const OPUS_URL = 'https://www.bilibili.com/opus/9000001';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(status = 200) {
  return new Response('<!DOCTYPE html><html><body>风控页</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

function viewPayload() {
  return jsonResponse({
    code: 0,
    data: {
      bvid: BV,
      aid: AID,
      cid: CID,
      title: '测试视频标题',
      desc: '测试视频正文',
      pic: 'http://i0.hdslb.com/cover.jpg',
      pubdate: 1500000000,
      duration: 320,
      owner: { mid: 12345, name: 'UP主', face: 'http://i0.hdslb.com/face.jpg' },
      tname: '科技',
    },
  });
}

function tagsPayload() {
  return jsonResponse({
    code: 0,
    data: [{ tag_name: '标签A' }, { tag_name: '标签B' }],
  });
}

function playurlPayload() {
  return jsonResponse({
    code: 0,
    data: {
      quality: 64,
      duration: 320,
      videos: 1,
      dash: {
        video: [{ id: 32, baseUrl: 'https://upos.example.com/secret-signed-url.mp4' }],
      },
    },
  });
}

function opusPayload() {
  return jsonResponse({
    code: 0,
    data: {
      item: {
        opus_id: '9000001',
        title: '图文标题',
        summary: '图文正文',
        pictures: [
          { url: 'http://i0.hdslb.com/opus-pic-1.jpg' },
          { url: 'https://i0.hdslb.com/opus-pic-2.jpg' },
        ],
        author: { name: '作者名', face: 'http://i0.hdslb.com/face.jpg', mid: 999 },
      },
    },
  });
}

test('generateBuvid3 returns a stable buvid3-shaped fingerprint', () => {
  const buvid3 = generateBuvid3();
  assert.match(
    buvid3,
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\{[0-9a-f]{16}\}infoc$/,
  );
  assert.notEqual(generateBuvid3(), buvid3);
});

test('getOrCreateBuvid3 persists one fingerprint per installation and reuses it', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'buvid3-'));
  try {
    const first = await getOrCreateBuvid3(dataDir);
    const second = await getOrCreateBuvid3(dataDir);
    assert.equal(first, second);
    const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(settings.buvid3, first);
    assert.match(settings.buvid3, /\{.*\}infoc$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('expandBilibiliShortUrl expands b23.tv to a bilibili page (max 3 hops)', async () => {
  const requests = [];
  const expanded = await expandBilibiliShortUrl('https://b23.tv/abc123', async (url) => {
    requests.push(url.toString());
    if (url.toString().startsWith('https://b23.tv')) {
      return new Response('', { status: 302, headers: { Location: VIDEO_URL } });
    }
    return jsonResponse({ code: 0, data: {} });
  });
  assert.equal(expanded.toString(), VIDEO_URL);
  assert.deepEqual(requests, ['https://b23.tv/abc123']);
});

test('expandBilibiliShortUrl rejects a short link that lands off-origin', async () => {
  await assert.rejects(
    expandBilibiliShortUrl('https://b23.tv/abc123', async () =>
      new Response('', { status: 302, headers: { Location: 'https://evil.example.com/steal' } })),
    /只允许访问 bilibili 相关地址/,
  );
});

test('expandBilibiliShortUrl rejects too many redirects', async () => {
  await assert.rejects(
    expandBilibiliShortUrl('https://b23.tv/abc123', async () =>
      new Response('', { status: 302, headers: { Location: 'https://b23.tv/loop' } })),
    /重定向次数过多/,
  );
});

test('expandBilibiliShortUrl passes through non-short bilibili urls', async () => {
  const result = await expandBilibiliShortUrl(VIDEO_URL, async () => {
    throw new Error('should not be called');
  });
  assert.equal(result.toString(), VIDEO_URL);
});

test('video resolution maps fields and never stores signed dash urls', async () => {
  const requests = [];
  const note = await resolveBilibiliNote(VIDEO_URL, {
    fetchImpl: async (url, init) => {
      requests.push({ url: url.toString(), init });
      const value = url.toString();
      if (value.includes('/x/web-interface/view')) return viewPayload();
      if (value.includes('/x/tag/archive/tags')) return tagsPayload();
      if (value.includes('/x/player/playurl')) return playurlPayload();
      return jsonResponse({ code: -400, message: 'unexpected' });
    },
  });

  assert.deepEqual(
    requests.map((entry) => entry.url),
    [
      `https://api.bilibili.com/x/web-interface/view?bvid=${BV}`,
      `https://api.bilibili.com/x/tag/archive/tags?bvid=${BV}`,
      `https://api.bilibili.com/x/player/playurl?bvid=${BV}&cid=${CID}&fnval=16`,
    ],
  );
  for (const { init } of requests) {
    assert.equal(init.credentials, 'omit');
    assert.match(init.headers['User-Agent'], /Chrome\/151/);
    assert.equal(init.headers.Referer, 'https://www.bilibili.com');
    assert.equal(
      Object.keys(init.headers).some((name) => name.toLowerCase() === 'cookie'),
      false,
    );
  }

  assert.equal(note.id, BV);
  assert.equal(note.title, '测试视频标题');
  assert.equal(note.content, '测试视频正文');
  assert.deepEqual(note.imageUrls, ['https://i0.hdslb.com/cover.jpg']);
  assert.equal(note.coverUrl, 'https://i0.hdslb.com/cover.jpg');
  assert.equal(note.author.name, 'UP主');
  assert.equal(note.author.userId, '12345');
  assert.deepEqual(note.tags, ['标签A', '标签B']);
  assert.equal(note.type, 'video');
  assert.equal(note.bvid, BV);
  assert.equal(note.aid, AID);
  assert.equal(note.cid, CID);
  assert.equal(note.duration, 320);
  assert.equal(note.quality, 64);
  assert.equal(JSON.stringify(note).includes('baseUrl'), false, '签名 URL 不得落库');
  assert.equal(JSON.stringify(note).includes('secret-signed-url'), false);
});

test('video resolution supports legacy av ids via aid', async () => {
  const requests = [];
  const note = await resolveBilibiliNote(`https://www.bilibili.com/video/av${AID}`, {
    fetchImpl: async (url) => {
      requests.push(url.toString());
      if (url.toString().includes('/x/web-interface/view')) return viewPayload();
      if (url.toString().includes('/x/tag/archive/tags')) return tagsPayload();
      if (url.toString().includes('/x/player/playurl')) return playurlPayload();
      return jsonResponse({ code: -400 });
    },
  });
  assert.equal(requests[0], `https://api.bilibili.com/x/web-interface/view?aid=${AID}`);
  assert.equal(note.id, BV);
  assert.equal(note.aid, AID);
  assert.equal(note.cid, CID);
});

test('video resolution tolerates tags/playurl failures (degrade, not block)', async () => {
  const note = await resolveBilibiliNote(VIDEO_URL, {
    fetchImpl: async (url) => {
      if (url.toString().includes('/x/web-interface/view')) return viewPayload();
      return htmlResponse();
    },
  });
  assert.equal(note.id, BV);
  assert.equal(note.quality, undefined);
  assert.equal(note.duration, 320);
  assert.deepEqual(note.tags, ['科技']);
});

test('video resolution surfaces 404 as a controlled error', async () => {
  await assert.rejects(
    resolveBilibiliNote(VIDEO_URL, {
      fetchImpl: async () => jsonResponse({ code: -404, message: '啥都木有' }),
    }),
    /不存在或已删除/,
  );
});

test('video resolution surfaces 412 / WAF as a controlled error', async () => {
  await assert.rejects(
    resolveBilibiliNote(VIDEO_URL, {
      fetchImpl: async () => jsonResponse({ code: -412, message: '请求被拦截' }),
    }),
    /风控拦截/,
  );
  await assert.rejects(
    resolveBilibiliNote(VIDEO_URL, {
      fetchImpl: async () => new Response('', { status: 412 }),
    }),
    /风控拦截/,
  );
  await assert.rejects(
    resolveBilibiliNote(VIDEO_URL, {
      fetchImpl: async () => htmlResponse(),
    }),
    /风控页面/,
  );
});

test('opus resolution sends the persisted buvid3 cookie and maps fields', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'buvid3-opus-'));
  try {
    const requests = [];
    const note = await resolveBilibiliNote(OPUS_URL, {
      dataDirectory: dataDir,
      fetchImpl: async (url, init) => {
        requests.push({ url: url.toString(), init });
        return opusPayload();
      },
    });

    assert.equal(
      requests[0].url,
      'https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=9000001&features=htmlNewStyle',
    );
    const cookie = requests[0].init.headers.Cookie;
    assert.match(cookie, /^buvid3=.*infoc$/);
    assert.equal(cookie.replace('buvid3=', ''), JSON.parse(
      await readFile(path.join(dataDir, 'settings.json'), 'utf8'),
    ).buvid3);

    assert.equal(note.id, '9000001');
    assert.equal(note.title, '图文标题');
    assert.equal(note.content, '图文正文');
    assert.deepEqual(note.imageUrls, [
      'https://i0.hdslb.com/opus-pic-1.jpg',
      'https://i0.hdslb.com/opus-pic-2.jpg',
    ]);
    assert.equal(note.coverUrl, 'https://i0.hdslb.com/opus-pic-1.jpg');
    assert.equal(note.author.name, '作者名');
    assert.equal(note.author.userId, '999');
    assert.equal(note.type, 'normal');
    assert.equal(note.opusId, '9000001');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('opus resolution reuses the same buvid3 across calls (never per-request random)', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'buvid3-reuse-'));
  try {
    const cookies = [];
    for (const id of ['9000001', '9000002']) {
      await resolveBilibiliNote(`https://www.bilibili.com/opus/${id}`, {
        dataDirectory: dataDir,
        fetchImpl: async (_url, init) => {
          cookies.push(init.headers.Cookie);
          return opusPayload();
        },
      });
    }
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0], cookies[1], '同一安装内 buvid3 必须固定复用');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('opus failure falls back to noteFromSharedText when sharedText is provided', async () => {
  const requests = [];
  const sharedText = `图文标题\n图文正文内容足够长\n${OPUS_URL}`;
  const note = await resolveBilibiliNote(OPUS_URL, {
    sharedText,
    fetchImpl: async (url, init) => {
      requests.push(url.toString());
      return htmlResponse();
    },
  });

  assert.equal(requests.some((url) => url.includes('x/article/view')), false, '不得调用 x/article/view');
  assert.equal(note.source, 'bilibili');
  assert.equal(note.opusId, '9000001');
  assert.equal(note.title, '图文标题');
  assert.equal(note.content, '图文正文内容足够长');
});

test('opus failure without sharedText surfaces the controlled error', async () => {
  await assert.rejects(
    resolveBilibiliNote(OPUS_URL, {
      fetchImpl: async () => htmlResponse(),
    }),
    /风控页面/,
  );
});

test('resolveBilibiliNote rejects off-origin and unidentifiable links', async () => {
  await assert.rejects(
    resolveBilibiliNote('https://example.com/video/BV1GJ411x7h7', {
      fetchImpl: async () => htmlResponse(),
    }),
    /只允许访问 bilibili 相关地址/,
  );
  await assert.rejects(
    resolveBilibiliNote('https://www.bilibili.com/watchlater/list', {
      fetchImpl: async () => htmlResponse(),
    }),
    /没有识别到B站视频或图文链接/,
  );
});

test('resolved video payload passes through normalizeImportedNote as a bilibili note', async () => {
  const payload = await resolveBilibiliNote(VIDEO_URL, {
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.includes('/x/web-interface/view')) return viewPayload();
      if (value.includes('/x/tag/archive/tags')) return tagsPayload();
      if (value.includes('/x/player/playurl')) return playurlPayload();
      return jsonResponse({ code: -400 });
    },
  });
  const note = normalizeImportedNote(payload);
  assert.equal(note.source, 'bilibili');
  assert.equal(note.id, BV);
  assert.equal(note.bvid, BV);
  assert.equal(note.aid, AID);
  assert.equal(note.cid, CID);
  assert.equal(note.type, 'video');
  assert.equal(note.mediaStatus, 'pending');
});
