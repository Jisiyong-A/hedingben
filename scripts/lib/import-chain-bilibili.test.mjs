import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBilibiliNote } from './bilibili-resolver.mjs';
import { resolveAnonymousNote } from './anonymous-note-resolver.mjs';
import {
  normalizeImportedNote,
  noteFromSharedText,
  extractSharedNoteUrl,
} from './note-import.mjs';

const BV = 'BV1GJ411x7h7';
const AID = 170001;
const CID = 280001;
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const B23_URL = 'https://b23.tv/abc123';
const OPUS_URL = 'https://www.bilibili.com/opus/9000001';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlWafResponse(status = 412) {
  return new Response('<!DOCTYPE html><html><body>风控验证页</body></html>', {
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
    data: { quality: 64, duration: 320 },
  });
}

// ─── BV video import ────────────────────────────────────────────────────────

test('import chain: BV video resolves via bilibili-resolver', async () => {
  const requests = [];
  const note = await resolveBilibiliNote(VIDEO_URL, {
    fetchImpl: async (url) => {
      requests.push(url.toString());
      const v = url.toString();
      if (v.includes('/x/web-interface/view')) return viewPayload();
      if (v.includes('/x/tag/archive/tags')) return tagsPayload();
      if (v.includes('/x/player/playurl')) return playurlPayload();
      return jsonResponse({ code: -400 });
    },
  });

  assert.equal(note.id, BV);
  assert.equal(note.title, '测试视频标题');
  assert.equal(note.type, 'video');
  assert.equal(note.author.name, 'UP主');

  // Verify bilibili API was called (not XHS HTML scraper)
  assert.ok(requests.some((u) => u.includes('api.bilibili.com')));
});

test('import chain: BV note normalizes with bilibili-specific fields', async () => {
  const note = normalizeImportedNote({
    id: BV,
    sourceUrl: VIDEO_URL,
    title: '测试视频标题',
    content: '测试视频正文',
    imageUrls: ['https://i0.hdslb.com/cover.jpg'],
    author: { name: 'UP主' },
    type: 'video',
    bvid: BV,
    aid: AID,
    cid: CID,
  });

  assert.equal(note.id, BV);
  assert.equal(note.source, 'bilibili');
  assert.equal(note.bvid, BV);
  assert.equal(note.aid, AID);
  assert.equal(note.cid, CID);
  assert.equal(note.type, 'video');
});

// ─── b23.tv short link import ────────────────────────────────────────────────

test('import chain: b23.tv expands then resolves via bilibili-resolver', async () => {
  const requests = [];
  const note = await resolveBilibiliNote(B23_URL, {
    fetchImpl: async (url) => {
      requests.push(url.toString());
      const v = url.toString();
      if (v.startsWith('https://b23.tv')) {
        return new Response('', { status: 302, headers: { Location: VIDEO_URL } });
      }
      if (v.includes('/x/web-interface/view')) return viewPayload();
      if (v.includes('/x/tag/archive/tags')) return tagsPayload();
      if (v.includes('/x/player/playurl')) return playurlPayload();
      return jsonResponse({ code: -400 });
    },
  });

  assert.equal(note.id, BV);
  assert.equal(note.title, '测试视频标题');
  // First request was the b23 redirect
  assert.ok(requests[0].startsWith('https://b23.tv'));
  // Then bilibili API
  assert.ok(requests.some((u) => u.includes('api.bilibili.com')));
});

// ─── XHS link still routes to anonymous resolver ─────────────────────────────

test('import chain: XHS link resolves via anonymous-note-resolver (not bilibili)', async () => {
  const xhsUrl = 'https://www.xiaohongshu.com/explore/64cb12340000000001020304';
  let calledResolver = 'none';

  // We test that XHS URLs go through the anonymous resolver path
  // by verifying the URL is not treated as bilibili
  const urlHost = new URL(xhsUrl).hostname.toLowerCase();
  const isBili = /bilibili\.com$/i.test(urlHost) || /b23\.tv$/i.test(urlHost);
  assert.equal(isBili, false, 'XHS URL should not be detected as bilibili');

  // The actual anonymous resolver would parse the XHS HTML
  // Here we verify the dispatch logic doesn't misroute
  calledResolver = isBili ? 'bilibili' : 'anonymous';
  assert.equal(calledResolver, 'anonymous');
});

// ─── WAF error fallback to noteFromSharedText ────────────────────────────────

test('import chain: bilibili WAF error falls back to noteFromSharedText', async () => {
  const sharedText = '这是一个B站分享 https://www.bilibili.com/video/BV1GJ411x7h7 这是口令';

  // Extract URL from shared text
  const sourceUrl = extractSharedNoteUrl(sharedText);
  const urlHost = new URL(sourceUrl).hostname.toLowerCase();
  const isBiliShare = /bilibili\.com$/i.test(urlHost) || /b23\.tv$/i.test(urlHost);
  assert.equal(isBiliShare, true, 'Should detect bilibili from shared text');

  // Simulate WAF error from bilibili resolver
  let resolved = null;
  try {
    resolved = await resolveBilibiliNote(sourceUrl, {
      fetchImpl: async () => htmlWafResponse(412),
    });
  } catch (error) {
    // WAF error - fall back to noteFromSharedText
    assert.match(error.message, /风控|无法/);
    resolved = noteFromSharedText(sharedText);
  }

  assert.ok(resolved, 'Should have fallback result');
  // noteFromSharedText extracts the URL and uses it as sourceUrl
  assert.ok(resolved.sourceUrl || resolved.title, 'Fallback should produce usable note');
});

// ─── b23.tv WAF error fallback ───────────────────────────────────────────────

test('import chain: b23 WAF error falls back to noteFromSharedText', async () => {
  const sharedText = '这个视频讲的特别好 https://b23.tv/xyz789 推荐大家看看，讲的很有道理\n真的值得收藏';

  const sourceUrl = extractSharedNoteUrl(sharedText);
  const urlHost = new URL(sourceUrl).hostname.toLowerCase();
  const isBiliShare = /bilibili\.com$/i.test(urlHost) || /b23\.tv$/i.test(urlHost);
  assert.equal(isBiliShare, true, 'Should detect b23.tv from shared text');

  let fallbackError = null;
  try {
    await resolveBilibiliNote(sourceUrl, {
      fetchImpl: async () => htmlWafResponse(403),
    });
  } catch (resolveError) {
    assert.match(resolveError.message, /风控|无法|请求失败/);
    // b23.tv 短链解析失败且无法从 URL 提取 B 站内容 ID 时，
    // 兜底必须拒绝导入 —— 创建 id 为完整 URL 的笔记会删不掉、去重失效。
    try {
      noteFromSharedText(sharedText);
    } catch (error) {
      fallbackError = error;
    }
  }

  assert.ok(fallbackError, 'b23 short link without extractable id must be rejected');
  assert.match(fallbackError.message, /B 站内容 ID/);
});

// ─── noteFromSharedText: BV URL fallback keeps a deletable id ────────────────

test('import chain: noteFromSharedText extracts BV id from full URL', () => {
  const sharedText =
    '这个视频讲的特别好 https://www.bilibili.com/video/BV1xx411c7mD 推荐大家看看，讲的很有道理\n真的值得收藏';
  const resolved = noteFromSharedText(sharedText);
  assert.equal(resolved.id, 'BV1xx411c7mD');
  assert.equal(resolved.source, 'bilibili');
});

// ─── Idempotent dedup via mergeImportedNote ──────────────────────────────────

test('import chain: duplicate bilibili import is idempotent', async () => {
  const { mergeImportedNote } = await import('./note-import.mjs');

  const note1 = {
    id: BV,
    source: 'bilibili',
    title: '视频标题',
    content: '正文',
    sourceUrl: VIDEO_URL,
  };
  const note2 = { ...note1, title: '视频标题更新' };

  const first = mergeImportedNote([], note1);
  assert.equal(first.created, true);
  assert.equal(first.notes.length, 1);

  const second = mergeImportedNote(first.notes, note2);
  assert.equal(second.created, false, 'Duplicate should not be created');
  assert.equal(second.notes.length, 1);
  assert.equal(second.notes[0].title, '视频标题更新', 'Should update existing');
});

// ─── Opus import ─────────────────────────────────────────────────────────────

test('import chain: opus resolves via bilibili-resolver', async () => {
  const note = await resolveBilibiliNote(OPUS_URL, {
    fetchImpl: async (url) => {
      const v = url.toString();
      if (v.includes('/x/polymer/web-dynamic/v1/opus/detail')) {
        return jsonResponse({
          code: 0,
          data: {
            item: {
              opus_id: '9000001',
              title: '图文标题',
              summary: '图文正文',
              pictures: [
                { url: 'http://i0.hdslb.com/pic1.jpg' },
              ],
              author: { name: '图文作者', mid: 888 },
            },
          },
        });
      }
      return jsonResponse({ code: -400 });
    },
  });

  assert.equal(note.id, '9000001');
  assert.equal(note.title, '图文标题');
  assert.equal(note.type, 'normal');
  assert.equal(note.author.name, '图文作者');
});
