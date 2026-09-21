// The console shell in French: every converted component renders its `fr` messages, and follows a switch at runtime.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../App";
import { SOURCE_META, SourceBadges } from "../components/ui";
import { Toasts } from "../components/Toasts";
import { HealthBar } from "../components/HealthBar";
import { SessionSummary } from "../components/SessionSummary";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { DialogHost, confirm, prompt } from "../components/Dialog";
import { EventsFeed } from "../components/EventsFeed";
import { GlmLog } from "../components/GlmLog";
import { Versions } from "../components/Versions";
import { setLang } from "../i18n";
import { api } from "../lib/api";
import { dispatch, getState, toast } from "../lib/store";
import { choiceQ, decision, glm, health, hello, highlight, push, qset, question, recording, roomHl, scoreQ, summary, timeline, watchState, T0 } from "./fixtures";

/** Keys land on the focused element (or the body), as in a browser; they bubble to the window listeners. */
const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const spies: { mockRestore: () => void }[] = [];
const spy = <T extends object, K extends keyof T>(o: T, k: K) => { const s = spyOn(o, k as any); spies.push(s); return s; };

describe("console shell in French", () => {
  beforeEach(() => setLang("fr"));
  afterEach(() => { setLang("en"); for (const s of spies.splice(0)) s.mockRestore(); });

  test("App: header, tabs, room, help sheet, banners, replay picker dates; switches back to English live", async () => {
    spy(api, "recordings").mockResolvedValue([recording({ createdAt: Date.UTC(2026, 8, 21, 12, 0, 0) })]);
    spy(api, "timeline").mockResolvedValue(timeline());
    spy(api, "connect").mockResolvedValue({ ok: true, sessionId: "s" } as any);
    spy(api, "watch").mockResolvedValue({ ok: true } as any);
    act(() => dispatch({ type: "ws", msg: hello({ status: { kind: "stream", ts: T0, state: "offline", username: "koursk1" }, watch: watchState({ armed: true, nextCheck: Date.now() + 30_000, lastCheck: Date.now() - 5000 }) }) }));
    act(() => dispatch({ type: "clearToasts" }));
    const { container } = render(<App />);
    expect(container.querySelector(".status-state")?.textContent).toBe("hors ligne");
    expect(screen.getByPlaceholderText("pseudo tiktok")).toBeTruthy(); expect(screen.getByText("Connecter")).toBeTruthy();
    expect(screen.getByRole("group", { name: "connexion au stream" })).toBeTruthy(); expect(screen.getByLabelText("métriques en direct")).toBeTruthy();
    expect(container.querySelector(".watch-text")?.textContent).toContain("en attente de @koursk1"); expect(container.querySelector(".watch-text")?.textContent).toContain("prochaine vérification dans");
    expect(container.querySelector(".watch-pill")?.getAttribute("title")).toContain("vérifie si @koursk1 est en direct · dernière vérification il y a");
    expect(screen.getByLabelText("arrêter la surveillance")).toBeTruthy();
    expect(screen.getByText("Salle")).toBeTruthy(); expect(container.textContent).toContain("questions · toutes les 1 s"); expect(screen.getByText("1 en alerte")).toBeTruthy();
    push({ type: "decision", decision: decision({ tick: 2, fired: [] }) });
    expect(screen.getByText("calme")).toBeTruthy();
    expect(container.textContent).toContain("chaque message jugé sur");
    expect(container.querySelector("#tab-flagged .tab-label")?.textContent).toBe("signalés"); expect(container.querySelector("#tab-settings")?.getAttribute("title")).toBe("réglages (,)"); expect(container.querySelector("#tab-log")?.getAttribute("title")).toBe("journal (5)");
    expect(screen.getByRole("tablist", { name: "panneaux" })).toBeTruthy(); expect(container.querySelector(".director-btn .label")?.textContent).toBe("réalisateur");
    expect(screen.getByTitle("ouvrir la vue réalisateur pour l'hôte (d)")).toBeTruthy(); expect(screen.getByLabelText("carillon d'alerte")).toBeTruthy(); expect(screen.getByLabelText("raccourcis clavier")).toBeTruthy();
    expect(screen.getByLabelText("connecté au serveur")).toBeTruthy();
    expect(container.querySelector(".kpis")!.textContent).toContain("au repos"); expect(container.querySelector(".kpis")!.textContent).toContain("dépense"); expect(container.querySelector(".kpis")!.textContent).toContain("spectateurs");
    // The replay picker formats its dates in French.
    await waitFor(() => expect(container.querySelector(".replay-picker")).not.toBeNull());
    expect(screen.getByLabelText("relire un enregistrement")).toBeTruthy(); expect(screen.getByText("relecture…")).toBeTruthy();
    const opt = container.querySelectorAll(".replay-picker option")[1]!.textContent!;
    expect(opt).toMatch(/sept/i); expect(opt).toContain("Mo"); expect(opt).toContain("min");
    // Help sheet and hotkey help texts.
    key("?");
    expect(screen.getByText("Clavier")).toBeTruthy(); expect(container.querySelector(".sheet")?.textContent).toContain("lecteur vidéo : compact / grand"); expect(container.querySelector(".sheet")?.textContent).toContain("changer de panneau");
    key("Escape");
    key("7"); expect(screen.getByText("pas encore d'instantané")).toBeTruthy();
    // Banners.
    act(() => dispatch({ type: "connected", value: false }));
    expect(screen.getByText("Connexion au serveur perdue. Reconnexion…")).toBeTruthy();
    act(() => dispatch({ type: "ws", msg: hello({ seq: 5, protocol: 99 }) }));
    expect(screen.getByText("Recharger la console")).toBeTruthy();
    // Live: the pill, the chime tooltip, the firing count and the state of the watch pill.
    act(() => dispatch({ type: "ws", msg: hello({ seq: 6, watch: watchState({ armed: true }) }) }));
    expect(container.querySelector(".status-state")?.textContent).toBe("en direct"); expect(screen.getByText("Déconnecter")).toBeTruthy(); expect(screen.getByText("1 en alerte")).toBeTruthy();
    expect(container.querySelector(".watch-text")?.textContent).toContain("reconnexion auto"); expect(container.querySelector(".watch-pill")?.getAttribute("title")).toContain("surveille @koursk1");
    expect(screen.getByTitle("carillon d'alerte désactivé (s)")).toBeTruthy();
    // A switch at runtime re-renders the shell.
    act(() => setLang("en"));
    expect(screen.getByText("Disconnect")).toBeTruthy(); expect(container.querySelector("#tab-flagged .tab-label")?.textContent).toBe("flagged");
    key("?"); expect(screen.getByText("Keyboard")).toBeTruthy(); expect(container.querySelector(".sheet")?.textContent).toContain("video player: compact / large");
  });

  test("App: the recording dialog, the rate-limit toast and the sign-in reason speak French", async () => {
    spy(api, "recordings").mockResolvedValue([]);
    spy(api, "timeline").mockResolvedValue(timeline());
    const stop = spy(api, "stopRecording").mockResolvedValue({ ok: true, file: "f" } as any);
    act(() => dispatch({ type: "ws", msg: hello({ recording: { active: true, segments: 1, finalizing: false } }) }));
    act(() => dispatch({ type: "clearToasts" }));
    render(<App />);
    key("r");
    await waitFor(() => expect(screen.getByText("Arrêter l'enregistrement ?")).toBeTruthy());
    fireEvent.click(screen.getByText("Arrêter"));
    await waitFor(() => expect(stop).toHaveBeenCalled());
    act(() => dispatch({ type: "auth", required: true, protected: true }));
    expect(screen.getByText("Ta session a expiré ou le jeton du serveur a changé. Reconnecte-toi.")).toBeTruthy();
  });

  test("ui: source badges and SOURCE_META labels", () => {
    expect(SOURCE_META.video.label).toBe("vidéo"); expect(SOURCE_META.transcript.label).toBe("audio");
    const { container, rerender } = render(<SourceBadges sources={["transcript", "video", "chat"]} compact />);
    expect(container.textContent).toContain("✦ tout"); expect(container.querySelector(".src-all")?.getAttribute("title")).toBe("lit l'audio, la vidéo et le chat");
    expect(container.querySelector(".src-badges")?.getAttribute("aria-label")).toBe("lit transcript, video, chat");
    rerender(<SourceBadges sources={["video"]} />);
    expect(container.textContent).toContain("vidéo"); expect(container.querySelector(".src")?.getAttribute("title")).toBe("lit vidéo");
    setLang("en");
    expect(SOURCE_META.video.label).toBe("video");
  });

  test("Toasts: room activity, tooltips and the dismiss label", async () => {
    act(() => dispatch({ type: "ws", msg: hello() }));
    act(() => dispatch({ type: "clearToasts" }));
    const { container } = render(<Toasts onOpen={() => {}} onWatch={() => {}} />);
    push({ type: "highlight", highlight: roomHl({ id: "fr1" }), fresh: true });
    await waitFor(() => expect(container.querySelectorAll(".toast").length).toBe(1));
    expect(container.textContent).toContain("activité de la salle");
    expect(container.querySelector(".toast-main")?.getAttribute("title")).toBe("ouvrir dans Signalés");
    expect(screen.getByLabelText("revoir ce moment")).toBeTruthy(); expect(screen.getByLabelText("fermer")).toBeTruthy();
    act(() => toast({ kind: "info", title: "Bonjour", durationMs: 20 }));
    await waitFor(() => expect(screen.queryByText("Bonjour") === null).toBe(true));
    act(() => dispatch({ type: "clearToasts" }));
  });

  test("HealthBar: one French pill per problem", () => {
    const now = T0 + 20_000;
    const { container, rerender } = render(<HealthBar health={health({ breaker: { until: now + 1000, reason: "401" }, budget: { spent: 2, cap: 2, stopped: true }, rateLimitedUntil: now + 3000, ffmpeg: "exited", deepgram: "backoff", deepgramDetail: "429", lastTickAt: now - 30_000, chatBacklog: 50, recorder: "finalizing", diskFreeBytes: 1e9 })} live now={now} />);
    const items = [...container.querySelectorAll(".health-item")].map((e) => e.textContent);
    expect(items).toEqual(["appels payants en pause : 401", "budget atteint ($2.00) · appels payants arrêtés", "débit limité · nouvel essai dans 3 s", "ffmpeg s'est arrêté", "reconnexion de la transcription · 429", "aucune décision depuis 30 s", "chat en retard : 50", "finalisation de l'enregistrement…", "disque : 1.00 GB libres"]);
    expect(container.querySelector(".health-item")?.getAttribute("title")).toContain("corrige la clé");
    rerender(<HealthBar health={health({ deepgram: "gave-up", deepgramDetail: "key" })} live now={now} />);
    expect(container.textContent).toContain("transcription coupée");
  });

  test("SessionSummary: labels and buttons", () => {
    const { container } = render(<SessionSummary s={summary()} highlights={[highlight({ sessionId: "s1" })]} onReplay={() => {}} />);
    expect(screen.getByLabelText("résumé de la dernière session")).toBeTruthy(); expect(screen.getByText("■ Session terminée")).toBeTruthy();
    expect(container.textContent).toContain("Le plus déclenché :"); expect(container.textContent).toContain("pic de spectateurs"); expect(container.textContent).toContain("30 lignes");
    expect(screen.getByText("▶ Revoir cette session")).toBeTruthy(); expect(screen.getByText("⤓ CSV des signalements")).toBeTruthy(); expect(screen.getByText("⤓ résumé .md")).toBeTruthy();
  });

  test("ErrorBoundary: the crash card", () => {
    const err = spy(console, "error").mockImplementation(() => {});
    const Boom = () => { throw new Error("kaboom"); };
    render(<ErrorBoundary name="Chat"><Boom /></ErrorBoundary>);
    expect(screen.getByText("Chat a planté")).toBeTruthy(); expect(screen.getByText("Réessayer")).toBeTruthy(); expect(screen.getByText("Recharger")).toBeTruthy();
    err.mockRestore();
  });

  test("Dialog: default labels", async () => {
    const { container } = render(<DialogHost />);
    const dlg = container.querySelector("dialog")!;
    const p1 = prompt({ title: "Note", choices: [{ value: "a", label: "A" }] });
    await waitFor(() => expect(dlg.open).toBe(true));
    expect(screen.getByText("Lequel")).toBeTruthy(); expect(screen.getByText("Annuler")).toBeTruthy(); expect(screen.getByText("OK")).toBeTruthy();
    fireEvent.click(screen.getByText("Annuler"));
    expect(await p1 === null).toBe(true);
    const p2 = confirm({ title: "Sûr ?" });
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("OK"));
    expect(await p2).toBe(true);
    await waitFor(() => expect(dlg.open).toBe(false));
  });

  test("EventsFeed: social verbs", () => {
    const { container } = render(<EventsFeed events={[
      { kind: "gift", id: "g1", ts: T0, handle: "bob", giftName: "Rose", count: 1, diamonds: 5 },
      { kind: "social", ts: T0, handle: "cy", action: "follow" }, { kind: "social", ts: T0, handle: "dee", action: "share" }, { kind: "member", ts: T0, handle: "gus", nickname: "Gus" },
    ]} />);
    expect(screen.getByLabelText("cadeaux et événements sociaux")).toBeTruthy(); expect(screen.getByTitle("diamants cette session")).toBeTruthy();
    const text = container.querySelector(".events-list")!.textContent!;
    expect(text).toContain("Gus a rejoint"); expect(text).toContain("cy s'est abonné"); expect(text).toContain("dee a partagé");
  });

  test("GlmLog: idle text and relative time", () => {
    const { container, rerender } = render(<GlmLog items={[]} />);
    expect(container.textContent).toContain("GLM est au repos."); expect(container.textContent).toContain("Il se réveille");
    rerender(<GlmLog items={[glm()]} />);
    expect(container.textContent).toContain("il y a ");
  });

  test("Versions: diff labels, restore dialog and toast", async () => {
    const restore = spy(api, "restoreVersion").mockResolvedValue({ ok: true } as any);
    const v1 = qset([question()], { version: 1, reason: "seed" });
    const v2 = qset([question({ question: { type: "noul", instructions: "changed", criteria: { true: "y", false: "n" } } }), choiceQ(), scoreQ()], { version: 2, reason: "rule added" });
    const v3 = qset([choiceQ(), scoreQ()], { version: 3, reason: "restored", restoredFrom: 1 });
    const v4 = qset([choiceQ(), scoreQ()], { version: 4, reason: "no-op" });
    const { container } = render(<><Versions history={[v1, v2, v3, v4]} /><DialogHost /></>);
    expect(container.textContent).toContain("2 questions : Mood, Hype");
    expect(container.textContent).toContain("(depuis la v1)"); expect(container.querySelector(".badge.del")?.textContent).toBe("−1");
    fireEvent.click(screen.getByText("v2"));
    expect(container.textContent).toContain("critères"); expect(container.textContent).toContain("oui: y"); expect(container.textContent).toContain("non: n");
    expect(screen.getAllByText("ajoutée").length).toBe(2);
    fireEvent.click(screen.getByText("↺ restaurer cette version"));
    await waitFor(() => expect(screen.getByText("Restaurer la version 2 ?")).toBeTruthy());
    expect(container.textContent).toContain("l'historique reste intact");
    fireEvent.click(screen.getByText("Restaurer"));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(2));
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "v2 restaurée comme nouvelle version")).toBe(true));
    fireEvent.click(screen.getByText("v3"));
    expect(container.textContent).toContain("supprimée");
    act(() => dispatch({ type: "clearToasts" }));
  });
});
