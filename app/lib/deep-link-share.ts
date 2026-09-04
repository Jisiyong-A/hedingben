import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { importSharedNote } from './xhs-client';
import { runAndroidOcr } from './android-ocr';
import type { Note } from '../types/xiaohongshu';

/**
 * iOS 系统分享接收（深链版）。
 *
 * iOS 没有 Android 的 SEND intent 广播，分享链路走 URL scheme：
 *   快捷指令/浏览器 → hedingben://import?text=<URL 编码的分享文本>
 * Info.plist 里的 CFBundleURLTypes 注册了 hedingben scheme
 * （由 scripts/ios-info-plist.cjs 在 tauri ios init 后写入）。
 *
 * 典型用法（iOS 快捷指令「分享到 合订本」）：
 *   接收「共享表单」输入 → 以 URL 打开：
 *   hedingben://import?text=[URL 编码的快捷指令输入]
 *
 * 冷启动：App 未运行时点深链，iOS 先拉起 App 再投递 URL，
 * getCurrent() 取回首条；热态由 onOpenUrl 监听。桌面端 no-op。
 */
export async function registerDeepLinkShare(
  onImported: () => void,
  onError: (message: string) => void,
): Promise<() => void> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) return () => {};

  const handleUrl = (rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'hedingben:' || parsed.host !== 'import') return;
    const text = parsed.searchParams.get('text') ?? '';
    const trimmed = text.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        const result = await importSharedNote(trimmed);
        void runAndroidOcr(result.note as Note);
        onImported();
      } catch (error) {
        onError(error instanceof Error ? error.message : '导入失败');
      }
    })();
  };

  const isMobilePlatform = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobilePlatform) {
    // 桌面 Tauri（Windows/macOS）：插件行为一致，但没有深链来源，
    // 直接跳过监听，避免无谓的调用（getCurrent 在桌面可能抛错）。
    return () => {};
  }

  let unlisten: (() => void) | null = null;
  try {
    // 冷启动兜底：先取回启动时投递的 URL
    const pending = await getCurrent();
    for (const url of pending ?? []) handleUrl(url.toString());
    unlisten = await onOpenUrl((urls) => {
      for (const url of urls) handleUrl(url.toString());
    });
  } catch {
    // 插件未就绪（如旧版 App 壳）——深链接收是 best-effort
    return () => {};
  }

  return () => {
    unlisten?.();
  };
}
