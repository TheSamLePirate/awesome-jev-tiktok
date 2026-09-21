import { useCallback, useState } from "react";

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** A piece of per-browser state persisted in localStorage (safe in private windows: falls back to memory). */
export function usePref<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  const set = useCallback((v: T | ((prev: T) => T)) => setValue((prev) => { const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v; write(key, next); return next; }), [key]);
  return [value, set];
}

/** A token handed over in the link (an OBS source, a first visit): exchanged for a session cookie at boot, then removed from the URL. */
export const urlToken = (): string => { try { return new URLSearchParams(location.search).get("token") ?? ""; } catch { return ""; } };
/** Take `?token=` out of the address bar so it never lands in history, screenshots or a shared link. */
export const stripTokenFromUrl = () => {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("token")) return;
    u.searchParams.delete("token");
    history.replaceState(history.state, "", u.pathname + (u.searchParams.size ? `?${u.searchParams}` : "") + u.hash);
  } catch { /* not a browser */ }
};
/** A token remembered by an older version of the console: exchanged once at boot, then forgotten. */
export const legacyToken = (): string => { try { return localStorage.getItem("jev.token") ?? ""; } catch { return ""; } };
export const forgetLegacyToken = () => { try { localStorage.removeItem("jev.token"); } catch { /* ignore */ } };
