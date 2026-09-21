import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Director } from "../Director";
import { api } from "../lib/api";
import { dispatch } from "../lib/store";
import { getLang, setLang } from "../i18n";
import { DEFAULT_PREFS, KIND, LAYOUTS, TIMING, cardTitle, meterText, parseNotes, type RuleRow } from "../director/model";
import { Countdown, NotesRail, RuleCard } from "../director/widgets";
import { DashboardView, OverlayView, RecapView, type ViewData } from "../director/views";
import { decision, health, hello, highlight, push, question, replayInfo, roomHl, sceneHl, snapshot, status, summary, transcriptHl, watchState, T0 } from "./fixtures";

TIMING.burstMs = 40; TIMING.timerLingerMs = 40; TIMING.leaveMs = 30;
const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const now = () => Date.now();
const ruleRow = (o: Partial<RuleRow> = {}): RuleRow => ({ id: "q1", label: "Host topic", scope: "window", sources: ["transcript"], local: false, paused: false, muted: false, answer: { type: "noul", noul: 0.8 }, fired: true, skipped: false, history: [0.2, 0.8], fires: 3, lastFire: T0, judged: 0, matched: 0, ...o });
const viewData = (o: Partial<ViewData> = {}): ViewData => {
  const t = now();
  return { cards: [], queueLength: 0, meters: [], rules: [], avatars: new Map(), stats: { elapsedMs: null, viewers: { current: null, peak: 0, delta: null, trend: "flat" }, viewerSeries: [], velocity: "steady", likes: "few", audience: { diamonds: 0, gifts: 0, follows: 0, shares: 1, joins: 2, leaders: [] }, decisionAgeSec: null, latencyMs: null }, chat: [], events: [{ kind: "social", ts: t, handle: "bo", action: "follow" }, { kind: "social", ts: t, handle: "cy", action: "share" }, { kind: "member", ts: t, handle: "ed", nickname: "" }], now: t, prefs: { ...DEFAULT_PREFS }, selectedId: null, live: true, idle: { title: "rien à traiter", detail: "" }, ...o };
};
const noActions = { onDone: () => {}, onPin: () => {}, onSnooze: () => {}, onSelect: () => {} };

describe("director in French", () => {
  const spies: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    setLang("fr");
    spies.push(spyOn(api, "patchHighlight").mockResolvedValue({ ok: true } as any));
    window.happyDOM.setURL("http://localhost:5173/?view=director");
    const t = now();
    act(() => dispatch({ type: "ws", msg: hello({ status: status({ ts: t - 65_000 }), decisions: [decision({ ts: t, skipped: ["q3"] })], highlights: [highlight({ ts: t - 1000 }), transcriptHl({ ts: t - 2000 }), sceneHl({ ts: t - 3000 }), roomHl({ ts: t - 4000, pinned: true })] }) }));
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "missing", ageMs: -1 }, chat: { state: "available", ageMs: 1 } } }) });
    push({ type: "event", event: { kind: "viewers", ts: t - 6 * 60_000, count: 50 } });
    push({ type: "event", event: { kind: "viewers", ts: t, count: 67 } });
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); setLang("en"); localStorage.removeItem("jev.lang"); window.happyDOM.setURL("http://localhost:5173/"); });

  test("model helpers read the language when called", () => {
    expect(LAYOUTS.map((l) => l.label)).toEqual(["Scène", "Focus", "Tableau de bord", "Overlay"]); expect(LAYOUTS[0].hint).toContain("jauges");
    expect(KIND.message.verb).toBe("Réponds à"); expect(KIND.room.verb).toBe("Salle"); expect(KIND.scene.verb).toBe("À l'image"); expect(KIND.transcript.verb).toBe("Tu as dit");
    expect(cardTitle(highlight())).toBe("💬 Réponds à Alice"); expect(cardTitle(highlight({ severity: "warn" }))).toBe("⚠ Surveille Alice"); expect(cardTitle(transcriptHl())).toBe("🎙 Tu as dit"); expect(cardTitle(sceneHl())).toBe("🎥 Regarde la caméra"); expect(cardTitle(roomHl())).toBe("✦ Salle");
    expect(meterText(undefined, true)).toBe("n/d");
    setLang("en");
    expect(LAYOUTS[2].label).toBe("Dashboard"); expect(cardTitle(roomHl())).toBe("✦ Room"); expect(meterText(undefined, true)).toBe("n/a");
  });

  test("every layout, the help sheet, the notes rail, the countdown and the bursts speak French", async () => {
    const { container } = render(<Director />);
    expect(container.querySelector(".d-live.on")?.textContent).toBe("EN DIRECT"); expect(container.textContent).toContain("1 en attente"); expect(container.textContent).toContain("🎙 🎥 indisponible");
    expect(container.querySelector(".d-clock")?.getAttribute("title")).toBe("à l'antenne"); expect(container.querySelector(".d-stat.up")?.getAttribute("title")).toBe("+17 en 5 min · pic 67");
    expect([...container.querySelectorAll(".d-switch-label")].map((l) => l.textContent)).toEqual(["Scène", "Focus", "Tableau de bord", "Overlay"]);
    expect(container.querySelector('.d-switch button[title^="Scène : "]')).not.toBeNull(); expect(screen.getByLabelText("disposition")).toBeTruthy();
    expect([...container.querySelectorAll(".dc")].map((c) => c.getAttribute("aria-label"))).toEqual(["✦ Salle", "🎥 Regarde la caméra", "💬 Réponds à Alice", "🎙 Tu as dit"]);
    expect(container.querySelector('.dc.pinned [aria-label="retirer de l\'avant"]')).not.toBeNull(); expect(container.querySelectorAll("[aria-label='terminé']").length).toBe(4); expect(container.querySelector("[aria-label='reporter']")?.getAttribute("title")).toContain("quelques minutes");
    expect(screen.getByLabelText("derniers messages")).toBeTruthy(); expect(screen.getByLabelText("jauges de la salle")).toBeTruthy(); expect(container.querySelector(".dm.skipped b")?.textContent).toBe("n/d");
    expect(screen.getByLabelText("son").getAttribute("title")).toBe("son à chaque nouveau prompt désactivé (s)"); expect(screen.getByLabelText("écran allumé").getAttribute("title")).toContain("désactivé (w)");
    key("s"); expect(screen.getByLabelText("son").getAttribute("title")).toBe("son à chaque nouveau prompt activé (s)"); key("s");
    // Focus, dashboard, overlay.
    key("2"); expect(container.querySelector(".d-focus-hint")?.textContent).toContain("terminé"); expect(container.querySelector(".d-focus-hint")?.textContent).toContain("suivant / précédent"); expect(container.querySelector(".d-next h4")?.textContent).toContain("À suivre");
    key("3"); expect(container.querySelector(".d-rules h4")?.textContent).toContain("Règles"); expect(container.querySelector(".d-rules h4")?.textContent).toContain("1 en alerte"); expect(container.querySelector(".d-events h4")?.textContent).toBe("Événements");
    expect(container.textContent).toContain("spectateurs"); expect(container.textContent).toContain("nouveaux abonnés"); expect(container.textContent).toContain("dernière décision il y a 0 s"); expect(container.querySelector(".d-rule.window.fired .d-rule-foot")?.textContent).toMatch(/^déclenchée ×1/);
    expect(container.querySelector('.d-rule[aria-label="links"] .d-rule-tag')?.getAttribute("title")).toContain("mot-clé"); expect(container.querySelector(".d-rule-tag.warn")?.textContent).toBe("en pause");
    key("4"); expect(container.querySelector(".d-lt-name")?.textContent).toBe("Sur scène"); fireEvent.click(screen.getByLabelText("quitter l'overlay")); expect(container.querySelector(".layout-stage")).not.toBeNull();
    // Notes, help, settings.
    key("n"); expect(container.querySelector(".d-notes-head span")?.textContent).toBe("📋 Conducteur"); expect(container.textContent).toContain("Écris ton plan"); fireEvent.click(screen.getByLabelText("masquer les notes"));
    key("?"); expect(screen.getByText("Clavier")).toBeTruthy(); const sheet = container.querySelector(".d-help-sheet")!; expect(sheet.textContent).toContain("vue Scène"); expect(sheet.textContent).toContain("cette aide"); expect(sheet.textContent).toContain("fermer"); key("Escape");
    key("t"); const dlg = container.querySelector("dialog")!; await waitFor(() => expect(dlg.open).toBe(true)); expect(dlg.textContent).toContain("Compte à rebours"); expect(dlg.textContent).toContain("ou secondes");
    fireEvent.change(dlg.querySelector("input")!, { target: { value: "2" } }); fireEvent.click(screen.getByText("Lancer"));
    await waitFor(() => expect(container.querySelector(".d-timer")).not.toBeNull()); expect(screen.getByLabelText("effacer le compte à rebours").getAttribute("title")).toBe("effacer (t)"); key("t");
    push({ type: "event", event: { kind: "gift", id: "g9", ts: now(), handle: "amy", giftName: "Rose", count: 2, diamonds: 5 } });
    push({ type: "event", event: { kind: "social", ts: now(), handle: "alice", nickname: "Alice", action: "follow" } });
    expect([...container.querySelectorAll(".d-burst-text")].map((b) => b.textContent)).toEqual(["amy a envoyé Rose ×2 · 💎 10", "Alice s'est abonné"]);
    await waitFor(() => expect(container.querySelector(".d-burst") === null).toBe(true));
  });

  test("the settings panel has a language switch; the screen follows it", () => {
    const { container } = render(<Director />);
    key("g");
    expect(screen.getByText("Vue réalisateur")).toBeTruthy(); expect(container.textContent).toContain("Ordre de la file"); expect(container.textContent).toContain("plus récents d'abord"); expect(container.textContent).toContain("Durée de vie d'un prompt");
    expect([...container.querySelectorAll(".d-panel-grid label")].map((l) => l.textContent?.trim())).toEqual(["jauges de la salle", "ticker du chat", "horloge d'antenne", "son à chaque nouveau prompt", "célébrer cadeaux et abonnements", "avertissements de modération (à désactiver pour un overlay public)", "fond transparent (OBS)"]); expect(container.querySelector("textarea")?.getAttribute("placeholder")).toContain("Dire bonjour");
    expect(container.textContent).toContain("Afficher les prompts de"); expect([...container.querySelectorAll(".d-qs small")].map((s) => s.textContent)).toContain("salle"); expect(container.querySelector(".d-help")?.textContent).toContain("OBS : ajoute");
    const langs = screen.getByLabelText("Langue").querySelectorAll("button");
    expect([...langs].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`)).toEqual(["English", "Français*"]);
    fireEvent.click(langs[0]);
    expect(getLang()).toBe("en"); expect(screen.getByText("Director view")).toBeTruthy(); expect(container.querySelector(".d-live.on")?.textContent).toBe("LIVE"); expect(container.querySelector(".d-help")?.textContent).toContain("OBS: add");
    expect([...screen.getByLabelText("Language").querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    fireEvent.click(screen.getByLabelText("Language").querySelectorAll("button")[1]);
    expect(getLang()).toBe("fr"); expect(screen.getByText("Vue réalisateur")).toBeTruthy(); expect(screen.getByLabelText("fermer les réglages")).toBeTruthy();
  });

  test("state labels, idle texts, replay and recap in French", () => {
    act(() => dispatch({ type: "ws", msg: hello({ seq: 2, decisions: [], highlights: [], questions: { version: 1, createdAt: T0, reason: "x", questions: [question()] }, replay: replayInfo() }) }));
    push({ type: "snapshot", snapshot: snapshot({ sources: { transcript: { state: "error", ageMs: 1 }, video: { state: "missing", ageMs: -1 }, chat: { state: "available", ageMs: 1 } } }) });
    const { container } = render(<Director />);
    expect(container.querySelector(".d-replay")?.textContent).toBe("RELECTURE"); expect(container.querySelector(".d-live.warn")?.textContent).toBe("aucune décision"); expect(container.querySelector(".d-idle span")?.textContent).toBe("en attente de décisions");
    push({ type: "decision", decision: decision({ ts: now() }) });
    expect(container.querySelector(".d-idle span")?.textContent).toBe("rien à traiter"); expect(container.querySelector(".d-idle small")?.textContent).toBe("dernière décision il y a 0 s · transcript, video indisponible");
    push({ type: "health", health: health({ breaker: { until: now() + 10_000, reason: "402" } }) });
    expect(container.querySelector(".d-live.warn")?.textContent).toBe("appels payants en pause"); expect(container.querySelector(".d-idle span")?.textContent).toBe("décisions en pause");
    push({ type: "event", event: status({ state: "offline", detail: "stream ended" }) });
    expect(container.querySelector(".d-live")?.textContent).toBe("hors ligne");
    push({ type: "reset", reason: "ended", summary: summary() });
    expect(container.querySelector(".d-recap-tag")?.textContent).toBe("■ Live terminé"); expect(container.textContent).toContain("1 avertissements"); expect(container.textContent).toContain("30 lignes de parole");
    act(() => dispatch({ type: "connected", value: false }));
    expect(container.querySelector(".d-live")?.textContent).toBe("console hors ligne");
    act(() => dispatch({ type: "ws", msg: hello({ seq: 9, status: null as any, decisions: [], summary: null, highlights: [] }) }));
    push({ type: "watch", watch: watchState({ armed: true, username: "amy" }) });
    expect(container.querySelector(".d-idle span")?.textContent).toBe("en attente de @amy"); expect(container.querySelector(".d-idle small")?.textContent).toBe("la console se connecte toute seule quand le live démarre");
  });

  test("views and widgets on their own", () => {
    const { container, rerender } = render(<DashboardView data={viewData()} actions={noActions} />);
    expect(container.textContent).toContain("pas encore d'historique"); expect(container.textContent).toContain("0 cadeaux"); expect(container.textContent).toContain("1 partages · 2 arrivées"); expect(container.textContent).toContain("pas encore de décision");
    expect(container.textContent).toContain("Pas encore de règle"); expect(container.textContent).toContain("👋 ed est arrivé"); expect(container.textContent).toContain("bo s'est abonné"); expect(container.textContent).toContain("cy a partagé");
    rerender(<DashboardView data={viewData({ events: [], rules: [ruleRow({ id: "m1", scope: "message", fired: false, fires: 0, lastFire: null, judged: 12, matched: 3, muted: true })] })} actions={noActions} />);
    expect(container.textContent).toContain("s'affichent ici"); expect(container.querySelector(".d-rule-foot")?.textContent).toBe("pas encore déclenchée· 12 jugés"); expect(container.querySelector(".d-rule-tag")?.textContent).toBe("masquée");
    rerender(<OverlayView data={viewData()} onExit={mock(() => {})} />);
    expect(container.querySelector(".d-exit")?.textContent).toBe("✕ Quitter l'overlay"); expect(container.textContent).toContain("Mets un prompt en avant");
    rerender(<OverlayView data={viewData({ cards: [{ item: transcriptHl({ pinned: true }), leaving: false }] })} />);
    expect(container.querySelector(".d-lt-name")?.textContent).toBe("Tu as dit");
    rerender(<RecapView summary={summary({ warnings: 0, topFired: [] })} status={null} chart={[]} />);
    expect(container.textContent).toContain("aucun avertissement"); expect(container.textContent).toContain("rien de déclenché"); expect(container.textContent).toContain("En attente du prochain live"); expect(container.textContent).toContain("dépense");
    rerender(<Countdown endAt={T0} now={T0 + 1} onClear={() => {}} />);
    expect(container.querySelector(".d-timer-value")?.textContent).toBe("TEMPS");
    rerender(<NotesRail items={parseNotes("- a")} done={new Set()} onToggle={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText("notes du direct")).toBeTruthy(); expect(screen.getByLabelText("masquer les notes").getAttribute("title")).toBe("masquer (n)");
    rerender(<RuleCard r={ruleRow({ paused: true, local: true })} now={T0} />);
    expect(container.querySelector(".d-rule-scope")?.getAttribute("title")).toBe("règle de salle : jugée à chaque tick"); expect(container.querySelector(".d-rule-foot")?.textContent).toContain("déclenchée ×3");
  });
});
