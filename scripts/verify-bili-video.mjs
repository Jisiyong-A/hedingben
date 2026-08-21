import { mkdtempSync } from 'node:fs';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveBilibiliNote } from './lib/bilibili-resolver.mjs';
import { localizeNoteMedia } from './lib/media-import.mjs';

const BV_URL = 'https://www.bilibili.com/video/BV1F4411S7NX';

const note = await resolveBilibiliNote(BV_URL, {});
console.log('[1] resolved:', note.id, '| type:', note.type);
const vu = note.videoUrl || '';
console.log('[2] videoUrl:', vu ? vu.slice(0, 100) : '(empty)');
console.log('[3] is mp4 (not m4s):', /\.mp4(\?|$)/i.test(vu));

if (!vu) {
  console.error('FAIL: videoUrl empty');
  process.exit(1);
}

const mediaDir = await mkdtemp(path.join(tmpdir(), 'bili-video-test-'));
const localized = await localizeNoteMedia(note, {
  mediaDirectory: mediaDir,
  publicBaseUrl: 'http://127.0.0.1:4318',
});

console.log('[4] videoLocalPath:', localized.videoLocalPath || '(empty)');
console.log('[5] mediaStatus:', localized.mediaStatus);
console.log('[6] mediaError:', localized.mediaError || '(none)');

if (localized.videoLocalPath) {
  const filePath = path.join(mediaDir, note.id, 'video.mp4');
  const s = await stat(filePath);
  console.log(`[7] video.mp4 on disk: ${(s.size / 1024 / 1024).toFixed(1)} MB`);
  console.log('=== PASS: Bilibili video downloaded locally ===');
} else {
  console.error('=== FAIL: videoLocalPath still empty ===');
  process.exit(1);
}
