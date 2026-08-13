'use client';

import { useEffect, useState } from 'react';

/**
 * Google Material 3 Window Size Classes (developer.android.com/develop/ui/views/layout/use-window-size-classes):
 *   compact  — width < 600dp  → Navigation bar (bottom), single column
 *   medium   — 600–839dp      → Navigation rail, 2 columns
 *   expanded — ≥840dp         → Navigation drawer/rail, multi column
 *
 * On desktop dp == CSS px at 100% zoom; on Android WebView the viewport is
 * density-independent so window.innerWidth maps directly to dp.
 */
export type WindowSizeClass = 'compact' | 'medium' | 'expanded';

export function useWindowSizeClass(): WindowSizeClass {
  const [wc, setWc] = useState<WindowSizeClass>('expanded');

  useEffect(() => {
    const update = () => {
      // Android WebView 中 innerWidth 是物理 CSS px（≈ dpr × dp），screen.width
      // 才是 dp 值；用二者较小值得到真实的密度无关宽度，避免手机被误判为
      // expanded（>840）而渲染桌面双栏布局。
      const w = window.innerWidth;
      const dp = Math.min(w, typeof screen !== 'undefined' ? screen.width : w) || (w / (window.devicePixelRatio || 1));
      setWc(dp < 600 ? 'compact' : dp < 840 ? 'medium' : 'expanded');
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return wc;
}
