import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';

import { resolveBilibiliNote } from './lib/bilibili-resolver.mjs';
import { normalizeImportedNote } from './lib/note-import.mjs';
import { localizeNoteMedia } from './lib/media-import.mjs';

// 真实管线：resolver → normalizeImportedNote（补 source 字段）→ localizeNoteMedia
const raw = await resolveBilibiliNote('https://www.bilibili.com/video/BV1TiuZ6TEQw', {});
raw.sourceUrl = 'https://www.bilibili.com/video/BV1TiuZ6TEQw';
const note = normalizeImportedNote(raw);
console.log('[pipeline] source =', note.source, '| id =', note.id);

// Instrument fetch to trace video download
const tracedFetch = async (url, init) => {
  const u = String(url);
  if (u.includes('bilivideo') || u.includes('upos') || u.includes('.mp4')) {
    console.log('[fetch-VIDEO]', u.slice(0, 80) + '...');
    console.log('[fetch-VIDEO] referer:', init?.headers?.Referer);
  }
  const t0 = Date.now();
  try {
    const resp = await fetch(url, init);
    if (u.includes('bilivideo') || u.includes('.mp4')) {
      console.log('[fetch-VIDEO] status:', resp.status, 'in', Date.now() - t0, 'ms');
    }
    return resp;
  } catch (e) {
    if (u.includes('bilivideo') || u.includes('.mp4')) {
      console.log('[fetch-VIDEO] THREW in', Date.now() - t0, 'ms:', e.message);
      if (e.cause) console.log('[fetch-VIDEO] cause:', e.cause.message || String(e.cause));
    }
    throw e;
  }
};

const mediaDir = await mkdtemp(path.join(tmpdir(), 'bili-debug-'));
const localized = await localizeNoteMedia(note, {
  mediaDirectory: mediaDir,
  publicBaseUrl: 'http://127.0.0.1:4318',
  fetchImpl: tracedFetch,
});

console.log('---');
console.log('videoLocalPath:', localized.videoLocalPath || '(empty)');
console.log('mediaError:', localized.mediaError);

const files = await readdir(path.join(mediaDir, note.id));
for (const f of files) {
  const s = await stat(path.join(mediaDir, note.id, f));
  console.log('file:', f, (s.size / 1024).toFixed(0) + 'KB');
}
