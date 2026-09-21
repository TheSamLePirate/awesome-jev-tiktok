// The stream panels (chat, flagged, transcript, gauges, video, timeline) in French: each component re-renders on a language switch.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatFeed } from "../components/ChatFeed";
import { Flagged, removeWithUndo } from "../components/Flagged";
import { ScenePanel, Transcript } from "../components/Transcript";
import { Gauges } from "../components/Gauges";
import { ReviewStrip, Timeline } from "../components/Timeline";
import { api } from "../lib/api";
import { getState } from "../lib/store";
import { setLang } from "../i18n";
import { chat, choiceQ, decision, highlight, localQ, messageDecision, messageQ, question, replayInfo, roomHl, sceneHl, timeline, transcriptHl, T0 } from "./fixtures";

class FakeHls {
  static isSupported = () => true;
  static Events = { MANIFEST_PARSED: "manifestParsed", LEVEL_UPDATED: "levelUpdated", ERROR: "error" };
  static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
  levels: any[] = []; currentLevel = 0; liveSyncPosition = 10; playingDate: Date | null = null;
  loadSource = mock(() => {}); attachMedia = mock(() => {}); startLoad = mock(() => {}); recoverMediaError = mock(() => {}); swapAudioCodec = mock(() => {}); destroy = mock(() => {});
  on() {}
}
mock.module("hls.js", () => ({ default: FakeHls }));
const { VideoPane } = await import("../components/VideoPane");

const scrollBox = (el: Element, top: number) => { Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true }); Object.defineProperty(el, "clientHeight", { value: 100, configurable: true }); el.scrollTop = top; fireEvent.scroll(el); };
const sources = (video: any, transcript: any) => ({ transcript, video, chat: { state: "available", ageMs: 1 } });

describe("stream panels in French", () => {
  beforeEach(() => act(() => setLang("fr")));
  afterEach(() => act(() => setLang("en")));

  test("ChatFeed: filters, empty states, verdict chips, user card and the unread jump", () => {
    const now = Date.now();
    const onOpenFlag = mock(() => {});
    const { container, rerender } = render(<ChatFeed chat={[]} decisions={{}} questions={[]} focusId={null} onOpenFlag={onOpenFlag} />);
    expect(screen.getByText("Pas encore de chat.")).toBeTruthy();
    expect(screen.getByPlaceholderText("filtrer le chat…")).toBeTruthy(); expect(screen.getByLabelText("filtre du chat")).toBeTruthy();
    expect(screen.getByText("tout")).toBeTruthy(); expect(screen.getByText("signalés")).toBeTruthy();
    const msgs = [chat({ id: "c1", ts: now - 5000, text: "hello?", isFollower: true }), chat({ id: "c2", ts: now - 3000, text: "http://spam.example" }), chat({ id: "c3", ts: now - 1000, userId: "u2", handle: "bob", nickname: "Bob", text: "yo" })];
    const decisions = { c1: messageDecision({ messageId: "c1", answers: { m1: { type: "noul", noul: 0.9 } }, fired: ["m1"], skipped: ["k1"] }) };
    rerender(<ChatFeed chat={msgs} decisions={decisions} questions={[messageQ(), localQ()]} focusId={null} onOpenFlag={onOpenFlag} />);
    expect(screen.getByText("ouvrir ↗")).toBeTruthy(); expect(container.querySelector(".flag.pending")?.textContent).toContain("analyse");
    expect(container.querySelector(".flag.skipped")?.getAttribute("title")).toBe("non évalué (source en panne, budget, ou règle en pause)");
    expect(screen.getByTitle("suit l'hôte").textContent).toBe(" abonné");
    fireEvent.change(screen.getByLabelText("filtrer le chat"), { target: { value: "zzz" } }); expect(screen.getByText("Aucun message ne correspond.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("filtrer le chat"), { target: { value: "" } });
    fireEvent.click(screen.getAllByTitle("détails du spectateur")[0]);
    const card = container.querySelector(".user-card")!;
    expect(card.getAttribute("aria-label")).toBe("spectateur alice"); expect(card.textContent).toContain("2 messages en mémoire · 1 signalé(s)"); expect(card.textContent).toContain("· abonné");
    fireEvent.click(screen.getByText("🔔 couper les alertes de ce spectateur ici")); expect(screen.getByText("🔕 alertes coupées dans cette console")).toBeTruthy();
    fireEvent.click(card.querySelector('[aria-label="fermer"]')!); expect(container.querySelector(".user-card") === null).toBe(true);
    fireEvent.click(screen.getAllByTitle("détails du spectateur")[1]);
    expect(container.querySelector(".user-card")?.textContent).toContain("1 message en mémoire · 0 signalé(s)");
    const log = container.querySelector(".chat")!;
    scrollBox(log, 0); expect(screen.getByText("plus récents ↓")).toBeTruthy();
    rerender(<ChatFeed chat={[...msgs, chat({ id: "c4", ts: now, text: "a" }), chat({ id: "c5", ts: now, text: "b" })]} decisions={decisions} questions={[messageQ()]} focusId={null} onOpenFlag={onOpenFlag} />);
    expect(screen.getByText("2 nouveaux ↓")).toBeTruthy();
    fireEvent.click(screen.getByText("2 nouveaux ↓"));
    scrollBox(log, 0);
    rerender(<ChatFeed chat={[...msgs, chat({ id: "c4", ts: now, text: "a" }), chat({ id: "c5", ts: now, text: "b" }), chat({ id: "c6", ts: now, text: "c" })]} decisions={decisions} questions={[messageQ()]} focusId={null} onOpenFlag={onOpenFlag} />);
    expect(screen.getByText("1 nouveau ↓")).toBeTruthy();
    // A switch back to English re-renders the memoised rows too.
    act(() => setLang("en"));
    expect(screen.getByText("open ↗")).toBeTruthy(); expect(screen.getByText("1 new ↓")).toBeTruthy();
  });

  test("Flagged: kinds, state filter, card actions, empty states, and the toasts of a delete", async () => {
    spyOn(api, "removeHighlight").mockResolvedValue({ ok: true, undoMs: 60_000 } as any);
    const { container, rerender } = render(<Flagged highlights={[]} questions={[question(), messageQ()]} focusId={null} onJump={() => {}} onWatch={() => {}} canWatch />);
    expect(container.textContent).toContain("Rien de signalé pour l'instant.");
    expect(screen.getByLabelText("chercher dans les signalements").getAttribute("placeholder")).toBe("chercher dans les signalements…  /"); expect(screen.getByLabelText("filtre d'état des signalements")).toBeTruthy();
    expect(screen.getByText(/l'hôte a dit/)).toBeTruthy(); expect(screen.getByText(/à l'écran/)).toBeTruthy(); expect(screen.getByText(/✦ salle/)).toBeTruthy();
    expect(screen.getByText("ouverts")).toBeTruthy(); expect(screen.getByText("épinglés")).toBeTruthy(); expect(screen.getByText("traités")).toBeTruthy(); expect(screen.getByText("tous")).toBeTruthy();
    rerender(<Flagged highlights={[highlight(), transcriptHl({ resolved: true }), roomHl({ pinned: true }), sceneHl()]} questions={[question(), messageQ()]} focusId={null} onJump={() => {}} onWatch={() => {}} canWatch />);
    expect(screen.getAllByLabelText("épingler").length).toBe(2); expect(screen.getByLabelText("désépingler")).toBeTruthy();
    expect(screen.getAllByLabelText("marquer comme traité").length).toBe(3); expect(screen.getAllByLabelText("revoir ce moment").length).toBe(3); expect(screen.getByLabelText("voir dans le chat")).toBeTruthy();
    expect(screen.getAllByLabelText("noter ce signalement").length).toBe(3); expect(screen.getAllByLabelText("supprimer").length).toBe(3);
    expect(container.querySelector(".hl-activity")?.textContent).toBe("chat busy · 120 spectateurs (rising) · likes many");
    expect(screen.getByText("effacer les traités")).toBeTruthy();
    fireEvent.click(screen.getByText("traités")); expect(screen.getByLabelText("rouvrir")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("chercher dans les signalements"), { target: { value: "zzz" } });
    expect(container.textContent).toContain("Aucun signalement ne correspond à ces filtres.");
    await removeWithUndo(highlight());
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Signalement supprimé")).toBe(true));
    expect(getState().toasts.find((t) => t.title === "Signalement supprimé")!.action!.label).toBe("Annuler la suppression");
  });

  test("Transcript and ScenePanel: headers, source pills, empty states", () => {
    const { container, rerender } = render(<ScenePanel captions={[]} highlights={[]} onOpen={() => {}} />);
    expect(container.textContent).toContain("🎥 Scène"); expect(container.textContent).toContain("en attente de la première image…"); expect(screen.getByLabelText("scène")).toBeTruthy();
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "available", ageMs: 500 }, undefined) as any} onOpen={() => {}} />);
    expect(container.querySelector(".live-pill.ok")?.textContent).toBe("en direct"); expect(container.querySelector(".live-pill")?.getAttribute("title")).toBe("dernières données il y a 1 s");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "stale", ageMs: 9000 }, undefined) as any} onOpen={() => {}} />);
    expect(container.querySelector(".live-pill.warn")?.textContent).toBe("périmé · 9 s");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "missing", ageMs: -1 }, undefined) as any} onOpen={() => {}} />);
    expect(container.querySelector(".live-pill.bad")?.textContent).toBe("aucune donnée"); expect(container.querySelector(".live-pill")?.getAttribute("title")).toBe("dernières données : jamais");
    rerender(<ScenePanel captions={[{ ts: T0, text: "x" }]} highlights={[]} sources={sources({ state: "error", ageMs: 5 }, undefined) as any} onOpen={() => {}} />);
    expect(container.querySelector(".live-pill.bad")?.textContent).toBe("erreur");
    const tr = render(<Transcript lines={[]} interim="" highlights={[]} onOpen={() => {}} />);
    expect(tr.container.textContent).toContain("🎙 Hôte"); expect(tr.container.textContent).toContain("À l'écoute…"); expect(screen.getByLabelText("parole de l'hôte")).toBeTruthy(); expect(screen.getByTitle("silence")).toBeTruthy();
    tr.rerender(<Transcript lines={[{ id: "l1", ts: T0, text: "bonjour" }, { id: "l2", ts: T0 + 1000, text: "à tous" }]} interim="et" highlights={[]} onOpen={() => {}} />);
    expect(tr.container.textContent).toContain("2 lignes"); expect(screen.getByTitle("parle")).toBeTruthy();
    scrollBox(tr.container.querySelector(".transcript")!, 0); expect(screen.getByText("plus récent ↓")).toBeTruthy();
  });

  test("Gauges: empty state, badges, notes, choice fold and the disagree tooltip", () => {
    const { container, rerender } = render(<Gauges questions={[]} decisions={[]} pausedRuleIds={new Set()} unsureBelow={0.3} live />);
    expect(container.querySelector(".empty")?.textContent).toBe("Pas encore de règle de salle. Ajoutes-en une dans Règles."); expect(container.querySelector(".empty b")?.textContent).toBe("Règles");
    rerender(<Gauges questions={[question(), choiceQ(), localQ({ ruleId: "r9" }), question({ id: "q5", label: "Skipped", ruleId: "r5" })]} decisions={[decision({ skipped: ["q5"] })]} pausedRuleIds={new Set(["r9"])} unsureBelow={0.3} live />);
    expect(container.querySelector(".fire-badge")?.textContent).toBe("déclenchée"); expect(screen.getByLabelText("Host topic: déclenchée")).toBeTruthy();
    expect(screen.getByLabelText("Mood: calme")).toBeTruthy(); expect(screen.getByLabelText("Skipped: non évaluée")).toBeTruthy();
    expect(screen.getByText("règle en pause")).toBeTruthy(); expect(screen.getByText("non évaluée à ce tick (source en panne ou budget)")).toBeTruthy();
    expect(screen.getByTitle("règle locale : aucun appel à jev").textContent).toBe("local");
    expect(screen.getByLabelText("pas d'accord avec Host topic").getAttribute("title")).toBe("Pas d'accord · GLM réécrit cette question");
    expect(screen.getByLabelText("82% oui")).toBeTruthy(); expect(container.querySelector(".g-noul .g-track")?.getAttribute("title")).toBe("82% de probabilité de oui · se déclenche à 70%");
    fireEvent.click(screen.getByText("+1 de plus")); expect(screen.getByText("moins")).toBeTruthy();
  });

  test("VideoPane: idle messages, HUD chips and control labels", () => {
    const { container, rerender } = render(<VideoPane source={null} live={false} muted onToggleMute={() => {}} />);
    expect(container.textContent).toContain("non connecté");
    rerender(<VideoPane source={null} live muted onToggleMute={() => {}} viewers={3} recording={{ active: false, finalizing: true }} onRecord={() => {}} onToggleSize={() => {}} />);
    expect(container.textContent).toContain("en attente du stream"); expect(screen.getByTitle("spectateurs").textContent).toBe("👁 3"); expect(screen.getByTitle("le segment arrêté est remuxé en un fichier navigable").textContent).toBe("finalisation…");
    expect(screen.getByLabelText("grand lecteur").getAttribute("title")).toBe("grand lecteur (v)"); expect(screen.getByText("REC").getAttribute("title")).toBe("enregistrer la vidéo à partir de maintenant (r)");
    rerender(<VideoPane source={{ kind: "hls", url: "/hls/live.m3u8", startTs: T0 }} live muted={false} onToggleMute={() => {}} size="large" onToggleSize={() => {}} reviewTs={T0} recording={{ active: true, since: Date.now() - 5000, finalizing: false }} onRecord={() => {}} />);
    expect(screen.getByLabelText("vidéo du stream")).toBeTruthy(); expect(container.querySelector(".hud-chip.dvr")?.textContent).toBe("⏪ REVUE");
    expect(screen.getByLabelText("couper le son").getAttribute("title")).toBe("couper le son (m)"); expect(screen.getByLabelText("lecteur compact")).toBeTruthy();
    expect(container.querySelector(".hud-btn.rec")?.getAttribute("title")).toBe("arrêter l'enregistrement (r)");
    rerender(<VideoPane source={{ kind: "hls", url: "/hls/live.m3u8", startTs: T0 }} live muted onToggleMute={() => {}} />);
    expect(container.querySelector(".hud-live")?.textContent).toBe("LIVE"); expect(screen.getByLabelText("activer le son")).toBeTruthy();
    rerender(<VideoPane source={{ kind: "file", t0: T0, startedAt: Date.now(), segments: [] }} live={false} muted onToggleMute={() => {}} />);
    expect(container.textContent).toContain("pas de vidéo pour ce moment"); expect(screen.getByTitle("vidéo enregistrée, synchronisée avec les événements rejoués").textContent).toBe("▶ replay");
  });

  test("Timeline and ReviewStrip: tags, tooltips, search results and the review header", async () => {
    spyOn(api, "search").mockResolvedValue([{ ts: T0 + 1000, offsetMs: 1000, kind: "chat", text: "hello", handle: "alice", nickname: "Alice" }]);
    const now = Date.now();
    const tl = timeline({ startTs: now - 100_000, endTs: now, dvrStartTs: now - 50_000 });
    const props = { highlights: [], onSeek: () => {}, onLive: () => {}, onReview: () => {}, onQuery: () => {} };
    const { container, rerender } = render(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now, behindSec: 0, reviewTs: null }} query="" {...props} />);
    expect(screen.getByLabelText("chronologie de la session")).toBeTruthy(); expect(container.querySelector(".rb-tag.live")?.textContent).toBe("LIVE");
    expect(container.querySelector(".rb-remaining")?.textContent).toBe("en direct"); expect(container.querySelector(".rb-remaining")?.getAttribute("title")).toBe("retard sur le direct");
    expect(container.querySelector(".rb-elapsed")?.getAttribute("title")).toBe("position dans la session"); expect(screen.getByLabelText("position dans la session").getAttribute("title")).toBe("clic pour se déplacer · ← → 10 s · Début / Fin");
    expect(container.querySelector(".rb-nodvr")?.getAttribute("title")).toBe("vidéo sortie de la fenêtre DVR"); expect(container.querySelector(".rb-video span")?.getAttribute("title")).toBe("vidéo disponible");
    expect(container.querySelector(".rb-total small")?.textContent).toBe("session"); expect(container.textContent).toContain("à");
    expect(screen.getByPlaceholderText("chercher dans le chat et la parole…")).toBeTruthy(); expect(screen.getByLabelText("chercher dans la session")).toBeTruthy();
    rerender(<Timeline mode={{ kind: "live", timeline: tl, playingTs: now - 30_000, behindSec: 30, reviewTs: now - 30_000 }} query="hello" {...props} />);
    expect(screen.getByText("⏪ REVUE · retour au direct").getAttribute("title")).toBe("retour au direct (l)");
    await waitFor(() => expect(screen.getByLabelText("résultats de recherche")).toBeTruthy());
    expect(container.querySelector(".rb-results-head span")?.textContent).toBe("1 résultat"); expect(screen.getByText("🎙 parole")).toBeTruthy(); expect(screen.getByText("aller ↵")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("fermer")); expect(container.querySelector(".rb-results") === null).toBe(true);
    rerender(<Timeline mode={{ kind: "replay", replay: replayInfo({ dryRun: true }) }} query="" {...props} />);
    expect(container.querySelector(".rb-tag")?.textContent).toBe("REPLAY · à blanc"); expect(screen.getByTitle("aucun appel payant pendant ce replay")).toBeTruthy();
    expect(container.querySelector(".rb-remaining")?.getAttribute("title")).toBe("restant"); expect(container.querySelector(".rb-total small")?.textContent).toBe("total");
    const rs = render(<ReviewStrip ctx={{ ts: T0, transcript: [], chat: [], captions: [] }} live inDvr={false} onClose={() => {}} onLive={() => {}} />);
    expect(screen.getByLabelText("moment en revue")).toBeTruthy(); expect(rs.container.textContent).toContain("±30 s autour de ce moment");
    expect(screen.getByText("vidéo hors de la fenêtre DVR").getAttribute("title")).toBe("le lecteur ne garde que la dernière fenêtre DVR de vidéo ; le MP4 archivé l'a");
    expect(screen.getByText("● Retour au direct")).toBeTruthy(); expect(screen.getByLabelText("fermer la revue")).toBeTruthy();
    expect(rs.container.textContent).toContain("🎙 Hôte"); expect(rs.container.textContent).toContain("💬 Chat"); expect(screen.getByText("silence")).toBeTruthy(); expect(screen.getByText("calme")).toBeTruthy();
  });
});
