#!/usr/bin/env node
/**
 * iOS CI 辅助：把 tauri.conf.json 的 productName 临时换成 ASCII。
 *
 * Xcode 工程名 / scheme 名直接取 productName；中文「合订本」在
 * xcodebuild -scheme 传参和某些 CI 环境里有编码风险。CI 里先执行
 * 本脚本再 tauri ios init，工程与 scheme 即为 Hedingben / Hedingben_iOS。
 * 显示名不受影响 —— 应用内标题与 iOS 桌面显示走 Info.plist 与前端。
 */
const fs = require('node:fs');
const path = require('node:path');

const confPath = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

if (/^[\x20-\x7E]+$/.test(conf.productName)) {
  console.log(`[ios-product-name] productName already ASCII: ${conf.productName}`);
  process.exit(0);
}

conf.productName = 'Hedingben';
fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
console.log('[ios-product-name] productName -> Hedingben (CI-local change only)');
