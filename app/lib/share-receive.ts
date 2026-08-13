import { importSharedNote } from './xhs-client';

declare global {
  interface Window {
    __shoucangShareReceive?: (text: string) => void;
    ShoucangShareBridge?: {
      take: () => string;
    };
  }
}

/**
 * Android 分享接收：XHS App / 浏览器「分享到 收藏」→ 导入。
 * 双通道：
 *  1. Kotlin evaluateJavascript 直接调用 window.__shoucangShareReceive（热态）
 *  2. addJavascriptInterface 轮询 ShoucangShareBridge.take()（冷启动兜底）
 * 桌面端无此 bridge，函数安全 no-op。
 */
export function registerShareReceive(onImported: () => void, onError: (message: string) => void): () => void {
  const handle = (text: string) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    void (async () => {
      try {
        await importSharedNote(trimmed);
        onImported();
      } catch (error) {
        onError(error instanceof Error ? error.message : '导入失败');
      }
    })();
  };

  window.__shoucangShareReceive = handle;

  const intervalId = window.setInterval(() => {
    const pending = window.ShoucangShareBridge?.take?.();
    if (pending) handle(pending);
  }, 2000);

  return () => {
    delete window.__shoucangShareReceive;
    window.clearInterval(intervalId);
  };
}
