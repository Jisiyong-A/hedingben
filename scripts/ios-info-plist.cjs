#!/usr/bin/env node
/**
 * iOS CI 辅助：tauri ios init 生成工程后，给 Info.plist 补：
 *  1. CFBundleURLTypes —— 注册 hedingben:// scheme（系统分享/快捷指令入口）
 *  2. NSAppTransportSecurity.NSAllowsLocalNetworking —— 本地 sidecar (127.0.0.1:4318)
 *  3. UILaunchScreen —— iOS 13+ 无 storyboard 启动屏声明
 *
 * 仅在 macOS CI 上运行（依赖 plutil）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const genDir = path.join(__dirname, '..', 'src-tauri', 'gen', 'apple');
if (!fs.existsSync(genDir)) {
  console.error(`[ios-info-plist] not found: ${genDir} (run "tauri ios init" first)`);
  process.exit(1);
}

function findInfoPlists(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findInfoPlists(full));
    else if (entry.name === 'Info.plist') out.push(full);
  }
  return out;
}

const plists = findInfoPlists(genDir);
if (plists.length === 0) {
  console.error('[ios-info-plist] no Info.plist found under gen/apple');
  process.exit(1);
}

function plistHas(plist, keyPath) {
  try {
    const raw = execFileSync('plutil', ['-extract', keyPath, 'json', '-o', '-', plist], {
      encoding: 'utf8',
    });
    return raw.trim() !== 'null';
  } catch {
    return false;
  }
}

function plistInsertForce(plist, keyPath, jsonValue) {
  execFileSync('plutil', [
    '-insert', keyPath, '-json', JSON.stringify(jsonValue), plist,
  ], { stdio: 'inherit' });
}

for (const plist of plists) {
  const name = path.basename(path.dirname(plist));
  console.log(`[ios-info-plist] patching ${name}`);

  // 1. URL scheme（幂等：先探测）
  if (!plistHas(plist, 'CFBundleURLTypes')) {
    plistInsertForce(plist, 'CFBundleURLTypes', [
      {
        CFBundleURLName: 'com.patrick.shoucang.hedingben',
        CFBundleURLSchemes: ['hedingben'],
      },
    ]);
  } else {
    console.log(`[ios-info-plist] ${name}: CFBundleURLTypes already set, skip`);
  }

  // 2. ATS 本地网络放行（sidecar 127.0.0.1:4318 是 http）
  if (!plistHas(plist, 'NSAppTransportSecurity')) {
    plistInsertForce(plist, 'NSAppTransportSecurity', { NSAllowsLocalNetworking: true });
  } else {
    console.log(`[ios-info-plist] ${name}: NSAppTransportSecurity already set, skip`);
  }

  // 3. UILaunchScreen（空 dict 即全屏默认启动屏，iOS 13+ 必需）
  if (!plistHas(plist, 'UILaunchScreen')) {
    plistInsertForce(plist, 'UILaunchScreen', {});
  } else {
    console.log(`[ios-info-plist] ${name}: UILaunchScreen already set, skip`);
  }
}

console.log(`[ios-info-plist] patched ${plists.length} plist(s)`);
