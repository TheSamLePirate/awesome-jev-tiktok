import { useEffect, useRef } from "react";


export interface Hotkey { key: string; label: string; help: string; when?: () => boolean; run: (e: KeyboardEvent) => void; /** allow while typing in an input */ global?: boolean }

const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); };

/**
 * One keyboard map for the whole view. A shortcut only fires for a bare key: Cmd/Ctrl/Alt combinations belong to the
 * browser (⌘S, ⌘D, ⌘1…) and never trigger app actions. The map is read through a ref, so the listener is registered once.
 */
export function useHotkeys(keys: Hotkey[]) {
  const ref = useRef(keys);
  useEffect(() => { ref.current = keys; }, [keys]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.repeat) return;
      const typing = isTyping(e.target);
      for (const k of ref.current) {
        if (k.key !== e.key) continue;
        if (typing && !k.global) continue;
        if (k.when && !k.when()) continue;
        e.preventDefault();
        k.run(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
