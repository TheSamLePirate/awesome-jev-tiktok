import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { LANGS, detect, fill, getLang, locale, plural, setLang, tr, useLang, useT } from "../i18n";
import { COMMON } from "../i18n/common";
import { when } from "../lib/format";
import { defineValue } from "./setup";

const M = { en: { hi: "Hello {name}", only: "en only" }, fr: { hi: "Bonjour {name}", only: undefined as unknown as string } };

describe("i18n", () => {
  afterEach(() => { setLang("en"); localStorage.clear(); });
  test("defaults to English here, follows the browser for French, and remembers the choice", async () => {
    expect(getLang()).toBe("en"); expect(document.documentElement.lang).toBe("en"); expect(LANGS.map((l) => l.id)).toEqual(["en", "fr"]);
    expect(locale()).toBe("en-US");
    const { result } = renderHook(() => useLang());
    expect(result.current).toBe("en");
    act(() => setLang("fr"));
    expect(result.current).toBe("fr"); expect(localStorage.getItem("jev.lang")).toBe("fr"); expect(document.documentElement.lang).toBe("fr"); expect(locale()).toBe("fr-FR");
    act(() => setLang("fr")); // no-op
    expect(result.current).toBe("fr");
    // Boot reads the saved choice, else the browser language.
    expect(detect()).toBe("fr");
    localStorage.clear();
    expect(detect()).toBe("en");
    const undo = defineValue(navigator, "language", "fr-CA");
    expect(detect()).toBe("fr");
    undo();
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    expect(detect()).toBe("en");
    Storage.prototype.getItem = get;
  });
  test("tr / useT bind messages, fill placeholders, fall back to English; plural picks a form", () => {
    const t = tr(M);
    expect(t("hi", { name: "Bob" })).toBe("Hello Bob"); expect(t("only")).toBe("en only");
    setLang("fr");
    expect(t("hi", { name: "Bob" })).toBe("Bonjour Bob"); expect(t("only")).toBe("en only");
    expect(fill("{a} and {b} and {c}", { a: 1, b: "two" })).toBe("1 and two and {c}"); expect(fill("plain")).toBe("plain");
    expect(plural(1, "{n} flag", "{n} flags")).toBe("1 flag"); expect(plural(3, "{n} flag", "{n} flags")).toBe("3 flags"); expect(plural(0, "{n} flag {x}", "{n} flags {x}", { x: "!" })).toBe("0 flags !");
    const { result } = renderHook(() => useT(COMMON));
    expect(result.current("cancel")).toBe("Annuler");
    act(() => setLang("en"));
    expect(result.current("cancel")).toBe("Cancel");
    expect(Object.keys(COMMON.fr).sort()).toEqual(Object.keys(COMMON.en).sort());
  });
  test("dates follow the language", () => {
    const ts = Date.UTC(2026, 8, 21, 12, 0, 0);
    setLang("fr");
    expect(when(ts)).toMatch(/sept/i);
    setLang("en");
    expect(when(ts)).toMatch(/Sep/);
  });
  test("storage that throws never breaks a switch", () => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    setLang("fr"); expect(getLang()).toBe("fr");
    Storage.prototype.setItem = set;
  });
});
