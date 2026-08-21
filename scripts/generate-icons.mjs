// 用用户设计好的原始 PNG 生成全套应用图标
// 源文件：用户提供的 ChatGPT Image PNG（深色玻璃质感 + LED 点阵 S）
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TAURI_ICONS = path.join(ROOT, 'src-tauri', 'icons');
const ANDROID_RES = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const SRC = String.raw`C:\Users\12155\Downloads\ScreenShot\ChatGPT Image 2026年8月12日 18_51_55.png`;
const MASTER = 1024;

async function masterPng() {
  // 居中裁方 → 缩放到 1024×1024（cover 保证铺满不留边）
  return sharp(SRC)
    .resize(MASTER, MASTER, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}

const resize = (master, s) => sharp(master).resize(s, s).png().toBuffer();

async function circleResize(master, s) {
  const mask = Buffer.alloc(s * s * 4);
  const r = s / 2;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      mask[(y * s + x) * 4 + 3] = Math.hypot(x - r + 0.5, y - r + 0.5) <= r ? 255 : 0;
    }
  }
  return sharp(master).resize(s, s)
    .composite([{ input: mask, raw: { width: s, height: s, channels: 4 } }])
    .png().toBuffer();
}

async function writeIco(pngBuffers, outFile) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngBuffers) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  await writeFile(outFile, Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]));
}

async function writeIcns(pngByType, outFile) {
  const chunks = [];
  let total = 8;
  for (const [type, data] of Object.entries(pngByType)) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
    total += data.length + 8;
  }
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  await writeFile(outFile, Buffer.concat([header, ...chunks]));
}

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`[icon] source ${meta.width}x${meta.height} -> master ${MASTER}x${MASTER}`);
  const master = await masterPng();

  const out = async (absPath, buffer) => {
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, buffer);
    console.log('[icon]', path.relative(ROOT, absPath), `${(buffer.length / 1024).toFixed(0)}KB`);
  };

  // Tauri 桌面 PNG
  await out(path.join(TAURI_ICONS, 'icon.png'), master);
  await out(path.join(TAURI_ICONS, 'icon-v4.png'), master);
  for (const s of [32, 64, 128]) await out(path.join(TAURI_ICONS, `${s}x${s}.png`), await resize(master, s));
  await out(path.join(TAURI_ICONS, '128x128@2x.png'), await resize(master, 256));
  for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    await out(path.join(TAURI_ICONS, `Square${s}x${s}Logo.png`), await resize(master, s));
  }
  await out(path.join(TAURI_ICONS, 'StoreLogo.png'), await resize(master, 50));

  // ICO（Windows + favicon）
  const icoEntries = [];
  for (const s of [16, 24, 32, 48, 64, 128, 256]) icoEntries.push({ size: s, data: await resize(master, s) });
  await writeIco(icoEntries, path.join(TAURI_ICONS, 'icon.ico'));
  console.log('[icon] src-tauri/icons/icon.ico');
  await writeIco(icoEntries, path.join(ROOT, 'app', 'favicon.ico'));
  console.log('[icon] app/favicon.ico');

  // ICNS（macOS）
  const icns = { ic07: await resize(master, 128), ic08: await resize(master, 256), ic09: await resize(master, 512), ic10: master };
  await writeIcns(icns, path.join(TAURI_ICONS, 'icon.icns'));
  await writeIcns(icns, path.join(TAURI_ICONS, 'icon-v4.icns'));
  console.log('[icon] src-tauri/icons/icon.icns (+v4)');

  // Android mipmap 启动图标
  const launcherSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const fgSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [dpi, s] of Object.entries(launcherSizes)) {
    const dir = path.join(ANDROID_RES, `mipmap-${dpi}`);
    await out(path.join(dir, 'ic_launcher.png'), await resize(master, s));
    await out(path.join(dir, 'ic_launcher_round.png'), await circleResize(master, s));
  }
  for (const [dpi, s] of Object.entries(fgSizes)) {
    const inner = Math.round(s * 0.66);
    const innerPng = await resize(master, inner);
    const canvas = sharp({
      create: { width: s, height: s, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: innerPng, left: Math.round((s - inner) / 2), top: Math.round((s - inner) / 2) }]);
    await out(path.join(ANDROID_RES, `mipmap-${dpi}`, 'ic_launcher_foreground.png'), await canvas.png().toBuffer());
  }

  // public/icon.svg —— 内嵌位图版（保持与设计稿完全一致）
  const b64 = master.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
<clipPath id="rr"><rect width="1000" height="1000" rx="224"/></clipPath>
<image clip-path="url(#rr)" width="1000" height="1000" preserveAspectRatio="xMidYMid slice"
 href="data:image/png;base64,${b64}"/>
</svg>
`;
  await out(path.join(ROOT, 'public', 'icon.svg'), Buffer.from(svg));

  console.log('[icon] ALL DONE from user-designed PNG');
}

main().catch((err) => { console.error(err); process.exit(1); });
