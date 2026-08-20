import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAnonymousNote } from './anonymous-note-resolver.mjs';

const noteId = '64cb12340000000001020304';
const sourceUrl = `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=temporary-token`;

function buildHtml() {
  const state = {
    note: {
      noteDetailMap: {
        [noteId]: {
          note: {
            noteId,
            title: '匿名解析标题',
            desc: '匿名解析正文',
            imageList: [
              { urlDefault: 'https://sns-webpic-qc.xhscdn.com/first.webp' },
              { urlList: ['https://sns-webpic-qc.xhscdn.com/second.webp'] },
            ],
            user: {
              nickname: '作者',
              userId: 'author-id',
            },
            tagList: [{ name: '设计' }],
          },
        },
      },
    },
  };
  return `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script></html>`;
}

test('anonymous resolver keeps the dragged token but never sends account credentials', async () => {
  let requestedUrl = '';
  let requestInit;
  const note = await resolveAnonymousNote(sourceUrl, {
    expectedNoteId: noteId,
    fetchImpl: async (url, init) => {
      requestedUrl = url.toString();
      requestInit = init;
      return new Response(buildHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });

  assert.equal(requestedUrl, sourceUrl);
  assert.equal(requestInit.credentials, 'omit');
  assert.doesNotThrow(() => new Headers(requestInit.headers));
  assert.equal(
    Object.keys(requestInit.headers).some((name) => name.toLowerCase() === 'cookie'),
    false,
  );
  assert.equal(note.title, '匿名解析标题');
  assert.equal(note.content, '匿名解析正文');
  assert.deepEqual(note.imageUrls, [
    'https://sns-webpic-qc.xhscdn.com/first.webp',
    'https://sns-webpic-qc.xhscdn.com/second.webp',
  ]);
  assert.deepEqual(note.tags, ['设计']);
});

test('anonymous resolver expands xhslink.cn short links before parsing', async () => {
  const shortUrl = 'https://xhslink.cn/o/8hQar8EEdkE';
  const requests = [];
  const note = await resolveAnonymousNote(shortUrl, {
    fetchImpl: async (url) => {
      requests.push(url.toString());
      if (url.toString().startsWith('https://xhslink.cn')) {
        return new Response('', {
          status: 302,
          headers: { Location: sourceUrl },
        });
      }
      return new Response(buildHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });

  assert.deepEqual(requests, [shortUrl, sourceUrl]);
  assert.equal(note.id, noteId);
  assert.equal(note.title, '匿名解析标题');
});

test('anonymous resolver rejects a short link that redirects off-origin', async () => {
  await assert.rejects(
    resolveAnonymousNote('https://xhslink.cn/o/8hQar8EEdkE', {
      fetchImpl: async () => new Response('', {
        status: 302,
        headers: { Location: 'https://evil.example.com/steal' },
      }),
    }),
    /只允许访问受支持的笔记页面/,
  );
});

test('anonymous resolver rejects a short link with too many redirects', async () => {
  await assert.rejects(
    resolveAnonymousNote('https://xhslink.cn/o/8hQar8EEdkE', {
      fetchImpl: async () => new Response('', {
        status: 302,
        headers: { Location: 'https://xhslink.cn/o/loop' },
      }),
    }),
    /重定向次数过多|只允许访问受支持的笔记页面/,
  );
});

test('anonymous resolver refuses to leave the Xiaohongshu page origin on redirect', async () => {
  await assert.rejects(
    resolveAnonymousNote(sourceUrl, {
      expectedNoteId: noteId,
      fetchImpl: async () => new Response('', {
        status: 302,
        headers: { Location: 'https://example.com/collect-account' },
      }),
    }),
    /只允许访问受支持的笔记页面/,
  );
});

test('anonymous resolver fails closed instead of falling back to a logged-in browser', async () => {
  await assert.rejects(
    resolveAnonymousNote(sourceUrl, {
      expectedNoteId: noteId,
      fetchImpl: async () => new Response('<html><h1>无法浏览</h1></html>', { status: 200 }),
    }),
    /拖到收藏/,
  );
});
