import { importSharedNote } from './xhs-client';
import { runAndroidOcr } from './android-ocr';

declare global {
  interface Window {
    __shoucangShareReceive?: (text: string) => void;
    ShoucangShareBridge?: {
      take: () => string;
    };
    /**
     * Kotlin 注入系统栏 inset（px，dp=CSS px）。
     * WebView edge-to-edge 绘制时系统栏覆盖在内容上，前端必须留出
     * 状态栏/导航栏空间，否则底部导航被手势条遮挡、顶部状态栏与 header 重叠。
     */
    __setInsets?: (top: number, bottom: number) => void;
  }
}

/**
 * 注册系统栏 inset 消费者：Kotlin onWebViewCreate 后周期性注入
 * window.__setInsets(top, bottom)，本函数把值写入 CSS 变量，
 * 供 header / MobileNavBar / safe-area 布局消费。
 * 桌面端无此调用，函数安全 no-op（CSS 变量回退 env(safe-area-inset-*)）。
 */
export function registerInsets(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!window.__setInsets) {
    window.__setInsets = (top: number, bottom: number) => {
      const root = document.documentElement;
      if (top > 0) root.style.setProperty('--inset-top', `${top}px`);
      if (bottom > 0) root.style.setProperty('--inset-bottom', `${bottom}px`);
    };
  }
  return () => {
    delete window.__setInsets;
  };
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
        const result = await importSharedNote(trimmed);
        void runAndroidOcr(result.note);
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
