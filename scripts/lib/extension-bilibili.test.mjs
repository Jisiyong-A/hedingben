import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { parseDraggedCardInput } from './note-import.mjs';

const contentSource = readFileSync(new URL('../../browser-extension/content.js', import.meta.url), 'utf8');
const pageDataSource = readFileSync(new URL('../../browser-extension/page-data.js', import.meta.url), 'utf8');

const BUTTON_ID = 'shoucang-note-import-button';

/** Strip vm-realm prototypes so deepStrictEqual compares plain values. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function findClosest(start, selector) {
  let node = start;
  while (node) {
    if (node._matches && node._matches(selector)) return node;
    node = node.parent;
  }
  return null;
}

/** Minimal Element stand-in injected into the vm context as the global Element. */
class MockElement {
  constructor() {
    this.attrs = {};
    this.textContent = '';
    this.parent = null;
    this.src = '';
    this._closest = null;
    this._querySelector = null;
  }
  closest(selector) {
    if (this._closest) return this._closest(selector);
    return findClosest(this, selector);
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  querySelector(selector) {
    return this._querySelector ? this._querySelector(selector) : null;
  }
}

/**
 * Load content.js in a fresh vm context with mocked browser globals.
 * The script runs its installButton()/heartbeat() bootstrapping, so the
 * mocks must tolerate those calls; pure functions are then reachable via
 * vm.runInContext.
 */
function loadContent({ pathname, hostname = 'www.bilibili.com', href, origin, queryMap = {}, queryAllMap = {} }) {
  const fullHref = href || `https://${hostname}${pathname}`;
  const fullOrigin = origin || `https://${hostname}`;
  const context = {
    console,
    URL,
    location: { pathname, hostname, href: fullHref, origin: fullOrigin },
    document: {
      title: '',
      querySelector: (selector) => queryMap[selector] || null,
      querySelectorAll: (selector) => queryAllMap[selector] || [],
      getElementById: () => null,
      createElement: () => ({
        style: {},
        addEventListener: () => {},
        textContent: '',
        title: '',
        draggable: false,
        id: '',
        type: '',
      }),
      documentElement: { appendChild: () => {} },
      addEventListener: () => {},
      dispatchEvent: () => true,
    },
    window: {
      addEventListener: () => {},
      postMessage: () => {},
      dispatchEvent: () => true,
    },
    fetch: async () => ({ ok: true }),
    chrome: { runtime: { sendMessage: () => {} } },
    setInterval: () => 0,
    setTimeout: () => 0,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    Element: MockElement,
  };
  context.__makeElement = (props) => {
    const el = new MockElement();
    Object.assign(el, props);
    return el;
  };
  vm.createContext(context);
  vm.runInContext(contentSource, context);
  return context;
}

/** Load page-data.js (an IIFE) and capture the postMessage it publishes. */
function loadPageData({ pathname, hostname = 'www.bilibili.com', initialData = null }) {
  const posted = [];
  const context = {
    console,
    URL,
    location: {
      pathname,
      hostname,
      href: `https://${hostname}${pathname}`,
      origin: `https://${hostname}`,
    },
    document: { addEventListener: () => {} },
    window: {
      postMessage: (data, origin) => posted.push({ data, origin }),
      __INITIAL_STATE__: initialData,
    },
  };
  vm.createContext(context);
  vm.runInContext(pageDataSource, context);
  return { context, posted };
}

// ── getNoteId: BV / av / opus / XHS ────────────────────────────────────────

test('getNoteId recognizes bilibili BV, av and opus paths', () => {
  const bv = loadContent({ pathname: '/video/BV1GJ411x7h7' });
  assert.equal(vm.runInContext('getNoteId()', bv), 'BV1GJ411x7h7');

  const av = loadContent({ pathname: '/video/av170001' });
  assert.equal(vm.runInContext('getNoteId()', av), 'av170001');

  const opus = loadContent({ pathname: '/opus/9000001' });
  assert.equal(vm.runInContext('getNoteId()', opus), '9000001');

  const trailing = loadContent({ pathname: '/video/BV1GJ411x7h7/' });
  assert.equal(vm.runInContext('getNoteId()', trailing), 'BV1GJ411x7h7');
});

test('getNoteId still resolves xiaohongshu paths', () => {
  const xhs = loadContent({ pathname: '/explore/64cb12340000000001020304', hostname: 'www.xiaohongshu.com' });
  assert.equal(vm.runInContext('getNoteId()', xhs), '64cb12340000000001020304');
});

// ── noteCardFromDragTarget: bilibili card dispatch ─────────────────────────

test('noteCardFromDragTarget extracts BV id + title from a bilibili card', () => {
  const ctx = loadContent({ pathname: '/', hostname: 'www.bilibili.com' });
  const card = ctx.__makeElement({
    _querySelector: (selector) => (selector.includes('title') ? { textContent: '卡片标题' } : null),
  });
  const link = ctx.__makeElement({
    attrs: { href: '/video/BV1GJ411x7h7' },
    textContent: '视频标题',
    _closest: (selector) => (selector.includes('video-card') || selector.includes('section') ? card : null),
  });
  const target = ctx.__makeElement({
    _closest: (selector) => (selector.includes(BUTTON_ID) ? null : link),
  });
  ctx.__target = target;

  assert.deepEqual(plain(vm.runInContext('noteCardFromDragTarget(__target)', ctx)), {
    id: 'BV1GJ411x7h7',
    sourceUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '卡片标题',
  });
});

test('noteCardFromDragTarget extracts legacy av id from a bilibili card', () => {
  const ctx = loadContent({ pathname: '/', hostname: 'www.bilibili.com' });
  const link = ctx.__makeElement({
    attrs: { href: '/video/av170001' },
    textContent: '旧视频',
    _closest: (selector) => (selector.includes('video-card') || selector.includes('section') ? ctx.__makeElement({}) : null),
  });
  const target = ctx.__makeElement({
    _closest: (selector) => (selector.includes(BUTTON_ID) ? null : link),
  });
  ctx.__target = target;

  const card = vm.runInContext('noteCardFromDragTarget(__target)', ctx);
  assert.equal(card.id, 'av170001');
  assert.equal(card.sourceUrl, 'https://www.bilibili.com/video/av170001');
  assert.equal(card.title, '旧视频');
});

test('noteCardFromDragTarget rejects off-platform links', () => {
  const ctx = loadContent({ pathname: '/', hostname: 'www.bilibili.com' });
  const link = ctx.__makeElement({
    attrs: { href: 'https://example.com/video/BV1GJ411x7h7' },
    textContent: '外部',
    _closest: () => null,
  });
  const target = ctx.__makeElement({
    _closest: (selector) => (selector.includes(BUTTON_ID) ? null : link),
  });
  ctx.__target = target;
  assert.equal(vm.runInContext('noteCardFromDragTarget(__target)', ctx), null);
});

// ── isNoteImageUrl: hdslb allowlist ────────────────────────────────────────

test('isNoteImageUrl allows hdslb and existing xhs CDNs, rejects others', () => {
  const ctx = loadContent({ pathname: '/', hostname: 'www.bilibili.com' });
  const check = (value) => vm.runInContext(`isNoteImageUrl(${JSON.stringify(value)})`, ctx);
  assert.equal(check('https://i0.hdslb.com/bfs/archive/cover.jpg'), true);
  assert.equal(check('https://i1.hdslb.com/bfs/opus/pic.jpg'), true);
  assert.equal(check('https://sns-webpic-qc.xhscdn.com/a.jpg'), true);
  assert.equal(check('https://sns-img-qc.xhsimg.com/a.jpg'), true);
  assert.equal(check('https://evil.example.com/a.jpg'), false);
  assert.equal(check('http://i0.hdslb.com/cover.jpg'), false, 'http is normalized upstream, not allowed raw');
});

// ── captureCurrentNote: bilibili detail page branch ────────────────────────

test('captureCurrentNote captures a bilibili video page (title/desc/cover/UP主)', () => {
  const ctx = loadContent({
    pathname: '/video/BV1GJ411x7h7',
    hostname: 'www.bilibili.com',
    queryMap: {
      'h1': { textContent: '测试视频标题' },
      '#v_desc': { textContent: '测试视频正文' },
      'meta[property="og:image"]': { content: 'https://i0.hdslb.com/cover.jpg' },
      '.up-name': { textContent: 'UP主' },
      '.up-info img, [class*="up-info"] img, .opus-author img': { src: 'https://i0.hdslb.com/face.jpg' },
    },
  });
  const note = plain(vm.runInContext('captureCurrentNote()', ctx));
  assert.equal(note.id, 'BV1GJ411x7h7');
  assert.equal(note.sourceUrl, 'https://www.bilibili.com/video/BV1GJ411x7h7');
  assert.equal(note.title, '测试视频标题');
  assert.equal(note.content, '测试视频正文');
  assert.deepEqual(note.imageUrls, ['https://i0.hdslb.com/cover.jpg']);
  assert.equal(note.coverUrl, 'https://i0.hdslb.com/cover.jpg');
  assert.equal(note.author.name, 'UP主');
  assert.equal(note.author.avatar, 'https://i0.hdslb.com/face.jpg');
  assert.equal(note.type, 'normal');
});

test('captureCurrentNote marks a bilibili page with a <video> as video type', () => {
  const ctx = loadContent({
    pathname: '/video/BV1GJ411x7h7',
    hostname: 'www.bilibili.com',
    queryMap: {
      'h1': { textContent: '视频标题' },
      '#v_desc': { textContent: '视频正文' },
      'video': { src: 'blob:https://www.bilibili.com/abc' },
    },
  });
  const note = vm.runInContext('captureCurrentNote()', ctx);
  assert.equal(note.type, 'video');
  assert.equal(note.videoUrl, '', 'blob: src is not a direct https stream; resolver fetches it server-side');
});

// ── page-data.js: BV / opus recognition ────────────────────────────────────

test('page-data publishes videoData for a bilibili video page', () => {
  const { posted } = loadPageData({
    pathname: '/video/BV1GJ411x7h7',
    initialData: {
      videoData: {
        bvid: 'BV1GJ411x7h7',
        title: '测试视频标题',
        desc: '测试视频正文',
        pic: 'http://i0.hdslb.com/cover.jpg',
        owner: { name: 'UP主', face: 'http://i0.hdslb.com/face.jpg', mid: 12345 },
      },
    },
  });
  assert.equal(posted.length, 1);
  assert.deepEqual(plain(posted[0].data.payload), {
    id: 'BV1GJ411x7h7',
    title: '测试视频标题',
    content: '测试视频正文',
    imageUrls: ['https://i0.hdslb.com/cover.jpg'],
    author: { name: 'UP主', avatar: 'https://i0.hdslb.com/face.jpg', userId: '12345' },
  });
});

test('page-data publishes opus item for a bilibili opus page', () => {
  const { posted } = loadPageData({
    pathname: '/opus/9000001',
    initialData: {
      opusData: {
        item: {
          opus_id: '9000001',
          title: '图文标题',
          summary: '图文正文',
          pictures: [{ url: 'http://i0.hdslb.com/opus-pic-1.jpg' }],
          author: { name: '作者名', face: 'http://i0.hdslb.com/face.jpg', mid: 999 },
        },
      },
    },
  });
  assert.equal(posted.length, 1);
  assert.deepEqual(plain(posted[0].data.payload), {
    id: '9000001',
    title: '图文标题',
    content: '图文正文',
    imageUrls: ['https://i0.hdslb.com/opus-pic-1.jpg'],
    author: { name: '作者名', avatar: 'https://i0.hdslb.com/face.jpg', userId: '999' },
  });
});

test('page-data still publishes xiaohongshu note data', () => {
  const { posted } = loadPageData({
    pathname: '/explore/64cb12340000000001020304',
    hostname: 'www.xiaohongshu.com',
    initialData: {
      note: {
        noteDetailMap: {
          '64cb12340000000001020304': {
            note: {
              noteId: '64cb12340000000001020304',
              title: '小红书标题',
              desc: '小红书正文',
              imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/a.jpg' }],
              user: { nickname: '作者', avatar: 'https://sns-avatar.qhscdn.com/av.jpg', userId: 'u1' },
            },
          },
        },
      },
    },
  });
  assert.equal(posted.length, 1);
  const payload = plain(posted[0].data.payload);
  assert.equal(payload.id, '64cb12340000000001020304');
  assert.equal(payload.title, '小红书标题');
  assert.equal(payload.content, '小红书正文');
  assert.deepEqual(payload.imageUrls, ['https://sns-webpic-qc.xhscdn.com/a.jpg']);
});

// ── card payload round-trip through the server-side parser ─────────────────

test('bilibili BV card payload round-trips through parseDraggedCardInput', () => {
  const payload = `SHOUCANG_CARD:${JSON.stringify({
    id: 'BV1GJ411x7h7',
    sourceUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '卡片标题',
  })}`;
  assert.deepEqual(parseDraggedCardInput(payload), {
    id: 'BV1GJ411x7h7',
    sourceUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '卡片标题',
  });
});

test('bilibili av and opus card payloads round-trip through parseDraggedCardInput', () => {
  const av = `SHOUCANG_CARD:${JSON.stringify({
    id: 'av170001',
    sourceUrl: 'https://www.bilibili.com/video/av170001',
    title: '旧视频',
  })}`;
  assert.equal(parseDraggedCardInput(av).id, 'av170001');

  const opus = `SHOUCANG_CARD:${JSON.stringify({
    id: '9000001',
    sourceUrl: 'https://www.bilibili.com/opus/9000001',
    title: '图文',
  })}`;
  assert.equal(parseDraggedCardInput(opus).id, '9000001');
});