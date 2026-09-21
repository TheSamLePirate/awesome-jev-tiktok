import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RulesPanel } from "../components/RulesPanel";
import { Recordings } from "../components/Recordings";
import { ActivityLog } from "../components/ActivityLog";
import { SettingsPanel } from "../components/Settings";
import { api } from "../lib/api";
import { getLang, setLang } from "../i18n";
import { localQ, logEntry, qset, question, recording, rule, settings, totals, T0 } from "./fixtures";

class FakeIO {
  constructor(public cb: (entries: unknown[]) => void, public opts: unknown) {}
  observe = mock(() => {}); disconnect = mock(() => {});
}

describe("panels in French", () => {
  afterEach(() => { setLang("en"); });

  test("RulesPanel: composer, examples, rule items, question details and the pattern tester", async () => {
    setLang("fr");
    const recs = spyOn(api, "recordings").mockResolvedValue([]);
    const testPattern = spyOn(api, "testPattern").mockResolvedValue({ ok: true, source: { kind: "session", id: "s", username: "me" }, scope: "message", total: 40, matched: 2, sample: [{ ts: T0, text: "https://x.test", handle: "bob" }] });
    const rules = [rule(), rule({ id: "r3", text: "links", kind: "keyword", paused: true, sources: ["chat"] }), rule({ id: "r9", text: "no questions yet" })];
    const { container } = render(<RulesPanel rules={rules} questions={qset([question(), localQ({ ruleId: "r3" })])} compiling={false} />);
    expect(screen.getByText("✦ règle jev")).toBeTruthy(); expect(screen.getByText(/Ajouter la règle/)).toBeTruthy();
    expect((screen.getByLabelText("nouvelle règle") as HTMLTextAreaElement).placeholder).toContain("Décris ce qu'il faut surveiller");
    expect(container.textContent).toContain("Une règle jev coûte"); expect(screen.getByText("lit")).toBeTruthy(); expect(screen.getByText("✦ tout")).toBeTruthy();
    fireEvent.click(screen.getByText("💬 questions de prix"));
    expect((screen.getByLabelText("nouvelle règle") as HTMLTextAreaElement).value).toContain("Préviens-moi");
    expect(container.textContent).toContain("aucune question"); expect(container.textContent).toContain(" en pause"); expect(container.textContent).toContain(" locale");
    expect(container.querySelectorAll('[aria-label="modifier la règle"]').length).toBe(3); expect(container.querySelector('[aria-label="reprendre la règle"]')).not.toBeNull(); expect(container.querySelector('[aria-label="supprimer la règle"]')).not.toBeNull();
    for (const h of container.querySelectorAll(".qd-head")) fireEvent.click(h);
    expect(container.textContent).toContain("se déclenche quand oui ≥ 70%"); expect(container.textContent).toContain("salle"); expect(container.textContent).toContain("par message · local");
    expect(screen.getByText("oui")).toBeTruthy(); expect(screen.getByText("non")).toBeTruthy();
    // Keyword mode and the tester.
    fireEvent.click(screen.getByText("⌘ mot-clé / regex"));
    expect((screen.getByLabelText("motif") as HTMLInputElement).placeholder).toBe("expression régulière (insensible à la casse)");
    expect(container.textContent).toContain("Une règle mot-clé"); expect(screen.getByText("session en cours, sinon le dernier enregistrement")).toBeTruthy();
    expect(screen.getByText("🔗 liens")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("motif"), { target: { value: "https?://" } });
    fireEvent.click(screen.getByText(/Tester sur/));
    await waitFor(() => expect(testPattern).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".pt-count")?.textContent).toContain("2 sur 40 messages correspondent · cette session"));
    // The editor of a keyword rule.
    fireEvent.click(container.querySelectorAll('[aria-label="modifier la règle"]')[1]);
    expect(screen.getByLabelText("modifier le motif")).toBeTruthy(); expect(screen.getByLabelText("modifier le libellé")).toBeTruthy();
    expect(screen.getByText("Annuler")).toBeTruthy(); expect(screen.getAllByText("Enregistrer").length).toBe(1);
    fireEvent.click(screen.getByText("Annuler"));
    expect(container.querySelector(".rule-edit") === null).toBe(true);
    render(<RulesPanel rules={[rule({ id: "r8" })]} questions={null} compiling />);
    expect(screen.getByText("GLM écrit les questions…")).toBeTruthy();
    recs.mockRestore(); testPattern.mockRestore();
  });

  test("Recordings: toolbar, list, detail actions, empty state", async () => {
    setLang("fr");
    const list = spyOn(api, "recordings").mockResolvedValue([recording()]);
    const peek = spyOn(api, "peekRecording").mockResolvedValue({ chat: [{ ts: T0 + 100, handle: "alice", nickname: "Alice", text: "hi" }], transcript: [{ ts: T0 + 50, text: "welcome" }], captions: [], timeline: [] });
    const { container, rerender } = render(<Recordings live={false} currentBase="rec-1" active />);
    expect(container.textContent).toContain("Chargement…");
    await waitFor(() => expect(container.querySelectorAll(".rec").length).toBe(1));
    expect(container.textContent).toContain("1 sessions · 1 vidéos"); expect(container.textContent).toContain("en cours d'enregistrement"); expect(container.textContent).toContain("156 phrases");
    expect((screen.getByLabelText("chercher un enregistrement") as HTMLInputElement).placeholder).toBe("chercher un enregistrement…"); expect(screen.getByLabelText("rafraîchir")).toBeTruthy();
    fireEvent.click(container.querySelector(".rec-head")!);
    await waitFor(() => expect(container.querySelector(".rec-timeline")).not.toBeNull());
    expect(screen.getByText("Streamer")).toBeTruthy(); expect(screen.getByText("▶ Rejouer")).toBeTruthy(); expect(screen.getByText("⚙ Simuler le direct")).toBeTruthy(); expect(screen.getByText("⤓ événements")).toBeTruthy();
    expect((screen.getByText("🗑 supprimer") as HTMLButtonElement).title).toBe("session en cours");
    list.mockResolvedValue([]);
    rerender(<Recordings live={false} active={false} />);
    rerender(<Recordings live={false} active />);
    await waitFor(() => expect(container.textContent).toContain("Pas encore d'enregistrement"));
    list.mockRestore(); peek.mockRestore();
  });

  test("ActivityLog: totals, toolbar, table head, empty state", () => {
    setLang("fr");
    const { container } = render(<ActivityLog entries={[logEntry()]} totals={totals()} />);
    expect(screen.getAllByText("🎙 parole").length).toBe(2); expect(screen.getByText("⚙ système")).toBeTruthy(); expect(screen.getByText("erreurs")).toBeTruthy();
    expect(container.textContent).toContain("1 appels"); expect(container.textContent).toContain("depuis le démarrage"); expect(container.textContent).toContain("est.");
    expect(screen.getByText("heure")).toBeTruthy(); expect(screen.getByText("coût")).toBeTruthy(); expect(screen.getByTitle("exporter en CSV")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("filtrer le journal"), { target: { value: "zzz" } });
    expect(screen.getByText("Pas encore d'activité.")).toBeTruthy();
  });

  test("Settings: sections, fields, validation and the language switch", () => {
    (globalThis as any).IntersectionObserver = FakeIO;
    setLang("fr");
    const noop = mock(() => {});
    const { container, rerender } = render(<SettingsPanel settings={null} live={false} sound setSound={noop} muted={false} setMuted={noop} notify={false} setNotify={noop} />);
    expect(container.textContent).toContain("Chargement des réglages…");
    rerender(<SettingsPanel settings={settings()} live={false} sound setSound={noop} muted={false} setMuted={noop} notify={false} setNotify={noop} />);
    expect(screen.getByText("Nom d'utilisateur")).toBeTruthy(); expect(screen.getAllByText("Clés API").length).toBe(2); expect(screen.getAllByText("Ce navigateur").length).toBe(2);
    expect(screen.getByText("Carillon d'alerte")).toBeTruthy(); expect(screen.getByText("Audio du flux")).toBeTruthy(); expect(screen.getByText("en lecture")).toBeTruthy(); expect(screen.getByText("Langue")).toBeTruthy();
    expect(container.textContent).toContain("dernier enregistrement"); expect(screen.getByText("Abandonner")).toBeTruthy(); expect(screen.getByText("Enregistrer")).toBeTruthy();
    fireEvent.change(container.querySelector("#set-budget-sessionUsd")!, { target: { value: "0" } });
    expect(container.textContent).toContain("sans plafond"); expect(container.textContent).toContain("1 changement non enregistré"); expect(screen.getByText("non enregistré")).toBeTruthy();
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "1e999" } });
    expect(container.textContent).toContain("pas un nombre"); expect(container.textContent).toContain(" · 1 invalide(s)");
    // The switch is per browser and re-renders everything, including the validation message.
    const select = container.querySelector("#pref-lang") as HTMLSelectElement;
    expect(select.value).toBe("fr"); expect(select.getAttribute("aria-label")).toBe("language");
    fireEvent.change(select, { target: { value: "en" } });
    expect(getLang()).toBe("en"); expect(localStorage.getItem("jev.lang")).toBe("en");
    expect(screen.getByText("Username")).toBeTruthy(); expect(screen.getByText("Language")).toBeTruthy(); expect(container.textContent).toContain("not a number"); expect(container.textContent).toContain("no cap");
    fireEvent.change(select, { target: { value: "fr" } });
    expect(getLang()).toBe("fr"); expect(screen.getByText("Nom d'utilisateur")).toBeTruthy();
  });
});
