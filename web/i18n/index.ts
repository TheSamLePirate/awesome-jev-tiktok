import { useSyncExternalStore } from "react";

/**
 * Two languages for the console and the director, chosen per browser (jev.lang, else the browser's language).
 * Messages live next to the component that shows them: `const M = { en: {...}, fr: {...} }` with the same keys,
 * `const t = useT(M)` inside a component (re-renders on a switch), `tr(M)` outside React (reads the language when called).
 */
export type Lang = "en" | "fr";
export const LANGS: { id: Lang; label: string }[] = [{ id: "en", label: "English" }, { id: "fr", label: "Français" }];
const KEY = "jev.lang";

/** The saved choice, else the browser language (exported for tests). */
export const detect = (): Lang => {
  try { const saved = localStorage.getItem(KEY); if (saved === "en" || saved === "fr") return saved; } catch { /* no storage */ }
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  return nav.toLowerCase().startsWith("fr") ? "fr" : "en";
};
let lang: Lang = detect();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = lang;

export const getLang = (): Lang => lang;
export const setLang = (l: Lang) => {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* private window */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
  listeners.forEach((f) => f());
};
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
/** The current language; the component re-renders when it changes. */
export const useLang = (): Lang => useSyncExternalStore(subscribe, getLang, getLang);
/** The Intl locale for dates and numbers. */
export const locale = () => (lang === "fr" ? "fr-FR" : "en-US");

export type Vars = Record<string, string | number>;
/** `{name}` placeholders; an unknown placeholder is left as is. */
export const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);
export type Messages<K extends string> = { en: Record<K, string>; fr: Record<K, string> };
/** Bound translator, outside React: reads the language at each call. */
export function tr<K extends string>(m: Messages<K>) {
  return (key: K, vars?: Vars) => fill(m[lang][key] ?? m.en[key], vars);
}
/** Bound translator inside a component: subscribes to the language. */
export function useT<K extends string>(m: Messages<K>) { useLang(); return tr(m); }
/** One of two forms by count, `{n}` filled: plural(n, "{n} flag", "{n} flags"). */
export const plural = (n: number, one: string, many: string, vars?: Vars) => fill(n === 1 ? one : many, { n, ...vars });
