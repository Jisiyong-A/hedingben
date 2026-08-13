#!/usr/bin/env node
/** Android assets 适配（当前为空操作）。
 *
 * 历史：Android AGP mergeAssets 会忽略 "_" 开头的 assets 目录（Next 的
 * _next 打包时丢失），曾尝试 publicPath 改名 + 内容替换。实测发现 Tauri 2
 * Android 的前端资源由 Rust 侧 custom protocol（tauri/custom-protocol
 * feature）在编译期嵌入 libshoucang.so 提供，不经 Android assets 目录，
 * 不存在该问题 —— 故保持 dist 原样（/_next/）。
 *
 * 保留本脚本作为构建环节占位：若未来切回 WebViewAssetLoader 路径
 * （withAssetLoader），需重新处理 _next 目录。 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

if (!fs.existsSync(distDir)) {
  console.log('[android-assets] no dist dir (skip)');
  process.exit(0);
}
console.log('[android-assets] no-op: frontend served from Rust embedded assets (/_next/)');
