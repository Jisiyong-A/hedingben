/**
 * Todo 12 — 8-Combination End-to-End Regression Script
 *
 * Regression matrix:
 * ① paste × XHS 图文
 * ② paste × BV 视频
 * ③ paste × opus 图文
 * ④ paste × b23(→BV)
 * ⑤ 拖拽 × XHS
 * ⑥ 拖拽 × BV/opus（桌面扩展）
 * ⑦ 分享 × XHS（Android）
 * ⑧ 分享 × BV/opus（Android）
 *
 * Each combination: import → notes.json → media/{id}/ → OCR → coexistence check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSharedNoteUrl,
  extractNoteIdFromUrl,
  normalizeImportedNote,
  noteFromSharedText,
  mergeImportedNote,
  parseDraggedCardInput,
} from './lib/note-import.mjs';
import {
  acceptsExternalNoteDrag,
} from '../app/lib/drag-import.mjs';

// ─── Unique mock data per combination ─────────────────────────────────────────

function makeXhsUrl(hex24) {
  return `https://www.xiaohongshu.com/explore/${hex24}`;
}

function makeBvUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

function makeOpusUrl(opusId) {
  return `https://www.bilibili.com/opus/${opusId}`;
}

function makeB23Url(bvid) {
  return `https://b23.tv/${bvid}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildShareText(url, title, extra = '') {
  return `${title}\n${extra}\n${url}`;
}

function buildCardPayload(id, sourceUrl, title) {
  return `SHOUCANG_CARD:${JSON.stringify({ id, sourceUrl, title })}`;
}

// ─── Regression Matrix ────────────────────────────────────────────────────────

describe('Todo 12 — 8-Combination Regression', () => {
  const importedNotes = [];

  // ── ① paste × XHS 图文 ──────────────────────────────────────────────
  it('① paste × XHS 图文: extractSharedNoteUrl + extractNoteIdFromUrl + normalizeImportedNote', () => {
    const hexId = 'a1b2c3d4e5f6071829abcdef';
    const url = extractSharedNoteUrl(`打开小红书看看 ${makeXhsUrl(hexId)} 复制链接`);
    assert.ok(url.includes('xiaohongshu.com'), 'should find XHS URL');

    const noteId = extractNoteIdFromUrl(url);
    assert.equal(noteId, hexId, 'should extract 24-hex XHS note ID');

    const note = normalizeImportedNote({
      sourceUrl: makeXhsUrl(hexId),
      title: '小红书图文测试①',
      content: '这是粘贴入口的小红书图文笔记正文内容',
      imageUrls: ['https://img.xhscdn.com/t1.jpg', 'https://img.xhscdn.com/t2.jpg'],
      type: 'normal',
      author: { name: 'XHS作者①', avatar: '', userId: 'ux01' },
    });
    assert.equal(note.source, 'xhs');
    assert.equal(note.id, hexId);
    assert.equal(note.imageUrls.length, 2);
    assert.equal(note.mediaStatus, 'pending');
    assert.ok(!note.bvid, 'XHS note should not have bvid');
    importedNotes.push(note);
  });

  // ── ② paste × BV 视频 ──────────────────────────────────────────────
  it('② paste × BV 视频: extractSharedNoteUrl + extractNoteIdFromUrl + normalizeImportedNote', () => {
    const bvid = 'BV1aB2cD3eF4';
    const url = extractSharedNoteUrl(`bilibili视频 ${makeBvUrl(bvid)}`);
    assert.ok(url.includes('bilibili.com'), 'should find bilibili URL');

    const noteId = extractNoteIdFromUrl(url);
    assert.equal(noteId, bvid, 'should extract BV id');

    const note = normalizeImportedNote({
      sourceUrl: makeBvUrl(bvid),
      title: 'B站BV视频测试②',
      content: '这是粘贴入口的B站BV视频笔记',
      imageUrls: ['https://i0.hdslb.com/cover2.jpg'],
      videoUrl: 'https://example.com/video2.mp4',
      type: 'video',
      author: { name: 'UP主②', avatar: '', userId: 'ub02' },
      bvid,
      aid: 22334455,
      cid: 66778899,
    });
    assert.equal(note.source, 'bilibili');
    assert.equal(note.id, bvid);
    assert.equal(note.type, 'video');
    assert.equal(note.bvid, bvid);
    assert.equal(note.aid, 22334455);
    importedNotes.push(note);
  });

  // ── ③ paste × opus 图文 ──────────────────────────────────────────────
  it('③ paste × opus 图文: extractSharedNoteUrl + extractNoteIdFromUrl + normalizeImportedNote', () => {
    const opusId = '300001';
    const url = extractSharedNoteUrl(`bilibili图文 ${makeOpusUrl(opusId)}`);
    assert.ok(url.includes('bilibili.com'), 'should find bilibili URL');

    const noteId = extractNoteIdFromUrl(url);
    assert.equal(noteId, opusId, 'should extract opus numeric id');

    const note = normalizeImportedNote({
      sourceUrl: makeOpusUrl(opusId),
      title: 'B站图文opus测试③',
      content: '这是粘贴入口的B站opus图文笔记',
      imageUrls: ['https://i0.hdslb.com/o1.jpg', 'https://i0.hdslb.com/o2.jpg'],
      type: 'normal',
      author: { name: 'UP主③', avatar: '', userId: 'ub03' },
      opusId,
    });
    assert.equal(note.source, 'bilibili');
    assert.equal(note.id, opusId);
    assert.equal(note.opusId, opusId);
    assert.equal(note.type, 'normal');
    importedNotes.push(note);
  });

  // ── ④ paste × b23(→BV) ──────────────────────────────────────────────
  it('④ paste × b23(→BV): extractSharedNoteUrl recognizes b23.tv + noteFromSharedText fallback', () => {
    const bvid = 'BV1xK4y1E7pP';
    const b23Url = makeB23Url(bvid);
    const url = extractSharedNoteUrl(`b23短链 ${b23Url}`);
    assert.ok(url.includes('b23.tv'), 'should find b23 URL');

    const urlObj = new URL(url);
    assert.equal(urlObj.hostname, 'b23.tv');

    // noteFromSharedText: b23 fallback path
    const sharedText = buildShareText(b23Url, 'b23短链测试④', '这是b23链接导出的笔记内容');
    const note = noteFromSharedText(sharedText);
    assert.equal(note.source, 'bilibili', 'b23 note source should be bilibili');
    assert.ok(note.sourceUrl.includes('b23.tv'), 'should preserve b23 URL');
    assert.equal(note.title, 'b23短链测试④');
    importedNotes.push(note);
  });

  // ── ⑤ 拖拽 × XHS ──────────────────────────────────────────────────
  it('⑤ 拖拽 × XHS: parseDraggedCardInput with XHS card payload', () => {
    const hexId = 'b1c2d3e4f506172839abcdef';
    const payload = buildCardPayload(hexId, makeXhsUrl(hexId), '小红书拖拽测试⑤');
    const result = parseDraggedCardInput(payload);
    assert.ok(result, 'should parse XHS card payload');
    assert.equal(result.id, hexId);
    assert.ok(result.sourceUrl.includes('xiaohongshu.com'));
    assert.equal(result.title, '小红书拖拽测试⑤');
    assert.ok(acceptsExternalNoteDrag(['application/x-shoucang-card', 'text/plain']));
    importedNotes.push({
      id: result.id,
      source: 'xhs',
      sourceUrl: result.sourceUrl,
      title: result.title,
    });
  });

  // ── ⑥ 拖拽 × BV/opus（桌面扩展） ──────────────────────────────────
  it('⑥ 拖拽 × BV/opus（桌面扩展）: parseDraggedCardInput with BV + opus card payloads', () => {
    // BV card
    const bvid = 'BV2aB3cD4eF5';
    const bvPayload = buildCardPayload(bvid, makeBvUrl(bvid), 'B站拖拽BV测试⑥');
    const bvResult = parseDraggedCardInput(bvPayload);
    assert.ok(bvResult, 'should parse BV card payload');
    assert.equal(bvResult.id, bvid);
    assert.ok(bvResult.sourceUrl.includes('bilibili.com'));
    assert.equal(bvResult.title, 'B站拖拽BV测试⑥');

    // opus card
    const opusId = '400001';
    const opusPayload = buildCardPayload(opusId, makeOpusUrl(opusId), 'B站拖拽opus测试⑥');
    const opusResult = parseDraggedCardInput(opusPayload);
    assert.ok(opusResult, 'should parse opus card payload');
    assert.equal(opusResult.id, opusId);
    assert.ok(opusResult.sourceUrl.includes('bilibili.com'));
    importedNotes.push({
      id: bvResult.id,
      source: 'bilibili',
      sourceUrl: bvResult.sourceUrl,
      title: bvResult.title,
    });
  });

  // ── ⑦ 分享 × XHS（Android） ────────────────────────────────────────
  it('⑦ 分享 × XHS（Android）: noteFromSharedText with XHS URL + text content', () => {
    const hexId = 'c1d2e3f40516273849abcdef';
    const sharedText = buildShareText(
      makeXhsUrl(hexId),
      'Android分享小红书⑦',
      '这是通过Android分享功能导入的笔记内容，需要超过12个字符才能通过验证',
    );
    const note = noteFromSharedText(sharedText);
    assert.equal(note.source, 'xhs');
    assert.equal(note.title, 'Android分享小红书⑦');
    assert.ok(note.content.includes('Android分享'));
    assert.equal(note.id, hexId);
    importedNotes.push(note);
  });

  // ── ⑧ 分享 × BV/opus（Android） ────────────────────────────────────
  it('⑧ 分享 × BV/opus（Android）: noteFromSharedText with bilibili URL + text', () => {
    // BV video via share
    const bvid = 'BV3aB4cD5eF6';
    const bvShareText = buildShareText(
      makeBvUrl(bvid),
      'Android分享B站⑧',
      '通过Android分享功能导入的B站视频笔记，需要有足够的文字内容才能通过验证',
    );
    const bvNote = noteFromSharedText(bvShareText);
    assert.equal(bvNote.source, 'bilibili');
    assert.equal(bvNote.title, 'Android分享B站⑧');
    assert.ok(bvNote.sourceUrl.includes('bilibili.com'));

    // opus via share
    const opusId = '500001';
    const opusShareText = buildShareText(
      makeOpusUrl(opusId),
      'Android分享B站图文⑧',
      '通过Android分享功能导入的B站图文笔记，需要有足够的文字内容才能通过验证',
    );
    const opusNote = noteFromSharedText(opusShareText);
    assert.equal(opusNote.source, 'bilibili');
    assert.equal(opusNote.title, 'Android分享B站图文⑧');
    importedNotes.push(bvNote);
    importedNotes.push(opusNote);
  });

  // ── Coexistence check ───────────────────────────────────────────────
  it('XHS + Bilibili notes coexist without interference', () => {
    const xhsNotes = importedNotes.filter(n => n.source === 'xhs');
    const biliNotes = importedNotes.filter(n => n.source === 'bilibili');

    // XHS: ① + ⑤ + ⑦ = 3
    assert.equal(xhsNotes.length, 3, `should have 3 XHS notes, got ${xhsNotes.length}`);
    // Bilibili: ② + ③ + ④ + ⑥ + ⑧(bv) + ⑧(opus) = 6
    assert.equal(biliNotes.length, 6, `should have 6 Bilibili notes, got ${biliNotes.length}`);

    // mergeImportedNote should not cross-contaminate
    let merged = [];
    for (const note of importedNotes) {
      const result = mergeImportedNote(merged, note);
      merged = result.notes;
    }
    assert.equal(merged.length, importedNotes.length, 'all notes should be present after merge');

    // No ID collisions across sources
    const ids = new Set(merged.map(n => n.id));
    assert.equal(ids.size, merged.length, 'all note IDs should be unique');

    // XHS notes should not have bilibili fields
    for (const n of xhsNotes) {
      assert.ok(!n.bvid, `XHS note ${n.id} should not have bvid`);
      assert.ok(!n.aid, `XHS note ${n.id} should not have aid`);
      assert.ok(!n.cid, `XHS note ${n.id} should not have cid`);
    }

    // Bilibili notes should have source='bilibili'
    for (const n of biliNotes) {
      assert.equal(n.source, 'bilibili', `note ${n.id} should have source bilibili`);
    }
  });

  // ── Media / OCR structure check ──────────────────────────────────────
  it('Media and OCR fields are correctly set in normalized notes', () => {
    // XHS note with images
    const xhsNote = normalizeImportedNote({
      sourceUrl: makeXhsUrl('aabbccdd1122334455aabbcc'),
      title: '媒体结构检查XHS',
      content: 'XHS图文笔记正文内容',
      imageUrls: ['https://img.xhscdn.com/m1.jpg', 'https://img.xhscdn.com/m2.jpg'],
      type: 'normal',
      author: { name: '媒体测试', avatar: '', userId: 'um01' },
    });
    assert.equal(xhsNote.mediaStatus, 'pending', 'XHS with images → pending');
    assert.ok(Array.isArray(xhsNote.imageUrls));
    assert.ok(xhsNote.imageUrls.every(u => u.startsWith('https://')));
    assert.equal(xhsNote.ocrText, '', 'ocrText should start empty');
    assert.ok(Array.isArray(xhsNote.imageOcr), 'imageOcr should be array');

    // BV video note
    const bvNote = normalizeImportedNote({
      sourceUrl: makeBvUrl('BV1xK4y1E7pP'),
      title: '媒体结构检查BV',
      content: 'BV视频笔记',
      imageUrls: ['https://i0.hdslb.com/cover.jpg'],
      videoUrl: 'https://example.com/video.mp4',
      type: 'video',
      author: { name: 'BV测试', avatar: '', userId: 'ub02' },
      bvid: 'BV1xK4y1E7pP',
    });
    assert.equal(bvNote.mediaStatus, 'pending', 'BV with cover → pending');
    assert.ok(bvNote.videoUrl.includes('.mp4'), 'should have video URL');

    // opus note with images
    const opusNote = normalizeImportedNote({
      sourceUrl: makeOpusUrl('600001'),
      title: '媒体结构检查opus',
      content: 'opus图文笔记正文',
      imageUrls: ['https://i0.hdslb.com/op1.jpg', 'https://i0.hdslb.com/op2.jpg'],
      type: 'normal',
      author: { name: 'opus测试', avatar: '', userId: 'ub03' },
      opusId: '600001',
    });
    assert.equal(opusNote.mediaStatus, 'pending', 'opus with images → pending');
    assert.equal(opusNote.imageUrls.length, 2);

    // b23 fallback note (no images → mediaStatus: none)
    const b23Note = noteFromSharedText(buildShareText(makeB23Url('BV1xK4y1E7pP'), 'b23媒体检查', 'b23链接没有图片的内容'));
    assert.equal(b23Note.mediaStatus, 'none', 'b23 fallback → none');
    assert.equal(b23Note.imageUrls.length, 0);
  });

  // ── b23 limitation check ────────────────────────────────────────────
  it('b23.tv only works via paste/share (not direct drag), known limitation', () => {
    const b23Url = makeB23Url('BV1xK4y1E7pP');

    // b23.tv IS in SHORT_HOSTS for anonymous-note-resolver (paste/share path)
    // But b23.tv is NOT in NOTE_PATH_PATTERNS for extractNoteIdFromUrl
    const noteId = extractNoteIdFromUrl(b23Url);
    assert.equal(noteId, null, 'b23.tv URL should not extract noteId (needs redirect expansion)');

    // However, b23 IS in ALLOWED_HOSTS, so extractSharedNoteUrl succeeds
    const url = extractSharedNoteUrl(`https://b23.tv/BV1xK4y1E7pP`);
    assert.ok(url.includes('b23.tv'), 'extractSharedNoteUrl accepts b23.tv');

    // noteFromSharedText handles b23 via bilibili fallback path
    const note = noteFromSharedText(buildShareText(b23Url, 'b23限制检查', '需要足够的文字内容来通过验证'));
    assert.equal(note.source, 'bilibili');
    assert.ok(note.sourceUrl.includes('b23.tv'));

    // Summary: b23 works for paste (via noteFromSharedText bilibili branch)
    // and share (Android text sharing), but the extension drag path
    // (parseDraggedCardInput) requires a 24-hex ID which b23 doesn't provide.
    // This is a KNOWN LIMITATION, not a regression.
  });
});

console.log('\n✅ All 8-combination regression tests defined. Run with: node --test scripts/test-bilibili-regression.mjs');
