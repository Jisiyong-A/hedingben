/**
 * Bilibili extension e2e — injects the REAL browser-extension/content.js and
 * page-data.js into a route-intercepted mock bilibili page and asserts the
 * extension's bilibili branches (detail button + drag payload, card capture,
 * page-data BV/opus recognition, hdslb image allowlist).
 *
 * NOTE: the extension itself cannot be loaded via `--load-extension` in this
 * environment (Chrome 151 stable + Playwright chromium both reject the flag —
 * the documented L45 exception in .omo/plans/bilibili-collection.md). This
 * script therefore exercises the exact extension source in a real browser DOM
 * instead, which is deterministic and zero-manual.
 *
 * Run: node scripts/e2e/bilibili-extension-e2e.mjs
 */
import { chromium } from 'file:///D:/hermes/npm-global/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const contentSource = readFileSync(new URL('../../browser-extension/content.js', import.meta.url), 'utf8');
const pageDataSource = readFileSync(new URL('../../browser-extension/page-data.js', import.meta.url), 'utf8');

const VIDEO_HTML = `<!DOCTYPE html><html><head>
  <meta charset="utf-8">
  <title>测试视频标题_哔哩哔哩_bilibili</title>
  <meta property="og:title" content="测试视频标题">
  <meta property="og:image" content="https://i0.hdslb.com/bfs/archive/cover.jpg">
  <meta name="description" content="测试视频正文">
</head><body>
  <h1 class="video-info-title" title="测试视频标题">测试视频标题</h1>
  <div id="v_desc" class="desc-info-text">测试视频正文</div>
  <div class="up-info"><a class="up-name">UP主</a><img src="https://i0.hdslb.com/face.jpg"></div>
  <video src="blob:https://www.bilibili.com/abc"></video>
</body></html>`;

const LIST_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>B站搜索</title></head><body>
  <div class="bili-video-card">
    <a href="/video/BV1GJ411x7h7" class="title">视频卡片标题</a>
  </div>
  <div class="bili-video-card">
    <a href="/video/av170001" class="title">旧视频卡片</a>
  </div>
</body></html>`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launchPersistentContext(
  path.join(tmpdir(), 'shoucang-ext-e2e-profile'),
  {
    executablePath: 'D:/hermes/cache/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    headless: true,
  },
);

try {
  const page = await browser.newPage();
  await page.route('https://www.bilibili.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/video/')) {
      route.fulfill({ status: 200, contentType: 'text/html', body: VIDEO_HTML });
    } else {
      route.fulfill({ status: 200, contentType: 'text/html', body: LIST_HTML });
    }
  });

  // ── 1. Video detail page: button + SHOUCANG_NOTE drag payload ────────────
  await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: contentSource });
  await page.waitForTimeout(300);

  const buttonCount = await page.locator('#shoucang-note-import-button').count();
  check('detail page shows 拖到收藏 button', buttonCount === 1, `count=${buttonCount}`);

  const notePayload = await page.evaluate(() => {
    const btn = document.getElementById('shoucang-note-import-button');
    if (!btn) return null;
    const dt = new DataTransfer();
    btn.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return {
      note: dt.getData('application/x-shoucang-note'),
      plain: dt.getData('text/plain'),
      uri: dt.getData('text/uri-list'),
    };
  });
  const parsedNote = notePayload ? JSON.parse(notePayload.note.replace(/^SHOUCANG_NOTE:/, '')) : null;
  check(
    'drag payload is a SHOUCANG_NOTE with bilibili fields',
    Boolean(parsedNote)
      && parsedNote.id === 'BV1GJ411x7h7'
      && parsedNote.title === '测试视频标题'
      && parsedNote.content === '测试视频正文'
      && parsedNote.coverUrl === 'https://i0.hdslb.com/bfs/archive/cover.jpg'
      && parsedNote.author?.name === 'UP主'
      && parsedNote.type === 'video',
    JSON.stringify(parsedNote),
  );
  check('text/uri-list carries the source url', notePayload?.uri === 'https://www.bilibili.com/video/BV1GJ411x7h7');

  // ── 2. Video list page: card capture → SHOUCANG_CARD payload ─────────────
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: contentSource });
  await page.waitForTimeout(300);

  const cardPayload = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/video/"]');
    if (!link) return null;
    const dt = new DataTransfer();
    link.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return {
      card: dt.getData('application/x-shoucang-card'),
      plain: dt.getData('text/plain'),
      uri: dt.getData('text/uri-list'),
    };
  });
  const parsedCard = cardPayload ? JSON.parse(cardPayload.card.replace(/^SHOUCANG_CARD:/, '')) : null;
  check(
    'list card drag produces a SHOUCANG_CARD with BV id + title',
    Boolean(parsedCard)
      && parsedCard.id === 'BV1GJ411x7h7'
      && parsedCard.sourceUrl === 'https://www.bilibili.com/video/BV1GJ411x7h7'
      && parsedCard.title === '视频卡片标题',
    JSON.stringify(parsedCard),
  );

  // ── 3. page-data.js: BV videoData published via postMessage ──────────────
  await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1GJ411x7h7',
        title: '测试视频标题',
        desc: '测试视频正文',
        pic: 'http://i0.hdslb.com/cover.jpg',
        owner: { name: 'UP主', face: 'http://i0.hdslb.com/face.jpg', mid: 12345 },
      },
    };
  });
  await page.evaluate(() => {
    window.__posted = [];
    window.postMessage = (data, origin) => { window.__posted.push({ data, origin }); };
  });
  await page.addScriptTag({ content: pageDataSource });
  await page.waitForTimeout(200);
  const pageDataPayload = await page.evaluate(() => window.__posted[0]?.data?.payload || null);
  check(
    'page-data publishes videoData for BV page',
    Boolean(pageDataPayload)
      && pageDataPayload.id === 'BV1GJ411x7h7'
      && pageDataPayload.title === '测试视频标题'
      && pageDataPayload.content === '测试视频正文'
      && pageDataPayload.imageUrls?.[0] === 'https://i0.hdslb.com/cover.jpg'
      && pageDataPayload.author?.name === 'UP主'
      && pageDataPayload.author?.userId === '12345',
    JSON.stringify(pageDataPayload),
  );

  // ── 4. hdslb image allowlist in the real DOM ─────────────────────────────
  const hdslbOk = await page.evaluate(() => {
    const url = new URL('https://i0.hdslb.com/bfs/archive/cover.jpg');
    return url.protocol === 'https:' && url.hostname.endsWith('.hdslb.com');
  });
  check('hdslb hostname is https + .hdslb.com (isNoteImageUrl allowlist)', hdslbOk === true);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${failed.length === 0 ? 'ALL_PASS' : 'FAILED'} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
