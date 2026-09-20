import { useCallback, useState } from "react";

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** A piece of per-browser state persisted in localStorage (safe in private windows: falls back to memory). */
export function usePref<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  const set = useCallback((v: T | ((prev: T) => T)) => setValue((prev) => { const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v; write(key, next); return next; }), [key]);
  return [value, set];
}

/** Auth token for a server started with JEV_TOKEN: from `?token=` (remembered) or localStorage. */
export const authToken = (): string => {
  try {
    const q = new URLSearchParams(location.search).get("token");
    if (q) { localStorage.setItem("jev.token", q); return q; }
    return localStorage.getItem("jev.token") ?? "";
  } catch { return ""; }
};
/** Append the token to a media URL when one is set (HLS / MP4 requests cannot carry headers). */
export const withToken = (url: string) => { const t = authToken(); return t ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : url; };
