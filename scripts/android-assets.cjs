#!/usr/bin/env node
/** Android 构建辅助（构建环节）：
 *
 * 1. 语义模型同步：public/models → gen/android assets/models（Kotlin 首启拷到
 *    数据目录，Rust sidecar 经 GET /models/{path} 提供，transformers.js 本地加载）。
 * 2. pre-cargo / post-cargo：Android 模型走 assets 部署，不应嵌入 .so ——
 *    cargo build（generate_context!）前把 dist/models 移走，构建后恢复。
 *    桌面构建不需要此步骤（模型嵌入 exe 是桌面原设计）。
 *
 * 用法：node scripts/android-assets.cjs [pre-cargo|post-cargo]
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const modelSrc = path.join(root, 'public', 'models');
const modelDst = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'assets', 'models');
const distModels = path.join(distDir, 'models');
const distModelsBak = path.join(distDir, 'models.bak');

const mode = process.argv[2] || '';

if (mode === 'pre-cargo') {
  // 移走 dist/models，避免嵌入 .so（Android 走 assets 部署）
  if (fs.existsSync(distModels) && !fs.existsSync(distModelsBak)) {
    fs.renameSync(distModels, distModelsBak);
    console.log('[android-assets] dist/models moved aside (pre-cargo)');
  }
  process.exit(0);
}

if (mode === 'post-cargo') {
  if (fs.existsSync(distModelsBak) && !fs.existsSync(distModels)) {
    fs.renameSync(distModelsBak, distModels);
    console.log('[android-assets] dist/models restored (post-cargo)');
  }
  process.exit(0);
}

if (!fs.existsSync(distDir)) {
  console.log('[android-assets] no dist dir (skip)');
  process.exit(0);
}

// ONNX Runtime WASM：复制固定名到 public/models/（随模型同步到 assets 与 dist）。
// transformers.js 在无 SharedArrayBuffer/WebGPU 的 WebView 用 asyncify 变体，
// wasmPaths 指向模型目录；需同时提供 .mjs（JS glue）与 .wasm 两个文件。
const onnxDist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const wasmTarget = path.join(root, 'public', 'models');
if (fs.existsSync(onnxDist)) {
  fs.mkdirSync(wasmTarget, { recursive: true });
  for (const name of [
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]) {
    const src = path.join(onnxDist, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(wasmTarget, name));
      console.log(`[android-assets] wasm ${name} -> public/models/`);
    }
  }
}

// 语义模型同步到 Android assets
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const dstPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

if (fs.existsSync(modelSrc)) {
  const count = copyDir(modelSrc, modelDst);
  console.log(`[android-assets] models synced to assets/models (${count} files)`);
} else {
  console.log('[android-assets] no public/models (semantic model not bundled)');
}

// 浏览器扩展同步到 Android assets（供 ExtensionBridge 下载到 Downloads）
const extSrc = path.join(root, 'browser-extension');
const extDst = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'assets', 'browser-extension');
if (fs.existsSync(extSrc)) {
  const count = copyDir(extSrc, extDst);
  console.log(`[android-assets] browser-extension synced to assets/browser-extension (${count} files)`);
} else {
  console.log('[android-assets] no browser-extension (skip)');
}
