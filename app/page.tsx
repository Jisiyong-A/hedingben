'use client';

import { useEffect, useRef } from 'react';
import { DeskView } from './components/DeskView';
import { useApp } from './lib/store';
import { registerInsets, registerShareReceive } from './lib/share-receive';
import { registerDeepLinkShare } from './lib/deep-link-share';
import { getNotes } from './lib/xhs-client';

export default function Home() {
  const { dispatch } = useApp();
  const notesSignatureRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    const load = async (showLoading = false) => {
      if (showLoading) dispatch({ type: 'SET_LOADING', payload: true });
      try {
        const notes = await getNotes();
        if (cancelled) return;
        const signature = notes.map((note) => `${note.id}:${note.savedAt.getTime()}`).join('|');
        if (signature !== notesSignatureRef.current) {
          notesSignatureRef.current = signature;
          dispatch({ type: 'SET_NOTES', payload: notes });
        }
      } catch {
        if (!cancelled) dispatch({ type: 'SET_ERROR', payload: '加载失败' });
      } finally {
        if (showLoading && !cancelled) dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    void load(true);
    const intervalId = window.setInterval(() => void load(), 2000);

    // Android 分享接收（桌面端 no-op）
    const unregisterShare = registerShareReceive(
      () => void load(),
      (message) => dispatch({ type: 'SET_ERROR', payload: message }),
    );
    // iOS 深链分享接收 hedingben://import?text=...（桌面端 no-op）
    let deepLinkCancelled = false;
    let unregisterDeepLink: (() => void) | null = null;
    void registerDeepLinkShare(
      () => void load(),
      (message) => dispatch({ type: 'SET_ERROR', payload: message }),
    ).then((unregister) => {
      if (deepLinkCancelled) unregister();
      else unregisterDeepLink = unregister;
    });
    // Android 系统栏 inset（状态栏/导航栏高度 → CSS 变量），桌面端 no-op
    const unregisterInsets = registerInsets();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      unregisterShare();
      deepLinkCancelled = true;
      unregisterDeepLink?.();
      unregisterInsets();
    };
  }, [dispatch]); // dispatch is stable, no infinite loop

  return (
    <>
      <DeskView />
    </>
  );
}
