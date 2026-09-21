import { memo } from "react";
import type { PollState } from "@shared/protocol";
import { api } from "../lib/api";
import { toast } from "../lib/store";
import { plural, tr, useT } from "../i18n";
import { prompt } from "./Dialog";
import { Avatar } from "./ui";

const M = {
  en: {
    title: "Live poll", body: "First line: the question. One option per line (2 to 8). jev reads every chat message as a vote; the first vote of each viewer counts.",
    placeholder: "Pizza or burger?\npizza\nburger", start: "Start the poll", tooFew: "A poll needs a question and at least two options.",
    startBtn: "📊 Poll", startTip: "start a live poll counted from chat (p)", end: "End", endTip: "close the poll; the result stays on screen", clear: "✕", clearTip: "remove the poll",
    votesOne: "{n} vote", votesMany: "{n} votes", judged: "{n} messages read", ended: "ended", noVotes: "no votes yet", started: "Poll started", pollEnded: "Poll ended",
    aria: "live poll", winner: "leads",
  },
  fr: {
    title: "Sondage en direct", body: "Première ligne : la question. Une option par ligne (2 à 8). jev lit chaque message du chat comme un vote ; le premier vote de chaque spectateur compte.",
    placeholder: "Pizza ou burger ?\npizza\nburger", start: "Lancer le sondage", tooFew: "Un sondage a besoin d'une question et d'au moins deux options.",
    startBtn: "📊 Sondage", startTip: "lancer un sondage compté depuis le chat (p)", end: "Clôturer", endTip: "clôturer le sondage ; le résultat reste affiché", clear: "✕", clearTip: "retirer le sondage",
    votesOne: "{n} vote", votesMany: "{n} votes", judged: "{n} messages lus", ended: "clôturé", noVotes: "pas encore de vote", started: "Sondage lancé", pollEnded: "Sondage clôturé",
    aria: "sondage en direct", winner: "en tête",
  },
};

/** Ask for the question and options, then start the poll; false when cancelled or malformed. */
export async function startPollDialog(): Promise<boolean> {
  const t = tr(M);
  const r = await prompt({ title: t("title"), body: t("body"), placeholder: t("placeholder"), multiline: true, confirmLabel: t("start") });
  if (!r) return false;
  const [question, ...options] = r.text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!question || options.length < 2) { toast({ kind: "error", title: t("tooFew") }); return false; }
  try { await api.startPoll(question, options); toast({ kind: "info", title: t("started"), body: question }); return true; }
  catch { return false; }
}
export const endPollNow = async () => { const t = tr(M); try { await api.endPoll(); toast({ kind: "info", title: t("pollEnded") }); } catch { /* toasted */ } };

export const tally = (p: PollState) => {
  const total = p.options.reduce((a, o) => a + (p.counts[o] ?? 0), 0);
  const rows = p.options.map((o) => ({ option: o, n: p.counts[o] ?? 0, pct: total ? Math.round(((p.counts[o] ?? 0) / total) * 100) : 0 }));
  const max = Math.max(0, ...rows.map((r) => r.n));
  return { total, rows: rows.map((r) => ({ ...r, leading: max > 0 && r.n === max })) };
};

/** The poll as bars, for the console (compact) and the director (big). `controls` shows end / clear. */
export const PollView = memo(function PollView({ poll, size, controls, onStart }: { poll: PollState | null; size?: "compact" | "big" | "overlay"; controls?: boolean; onStart?: () => void }) {
  const t = useT(M);
  if (!poll) {
    if (!onStart) return null;
    return <div className={`poll empty ${size ?? ""}`}><button className="chip-btn" onClick={onStart} title={t("startTip")} aria-label={t("startBtn")}>{t("startBtn")}</button></div>;
  }
  const { total, rows } = tally(poll);
  const over = poll.endedAt !== null;
  return (
    <section className={`poll ${size ?? ""} ${over ? "over" : "running"}`} aria-label={t("aria")}>
      <header className="poll-head">
        <span className="poll-q">📊 {poll.question}</span>
        <span className="poll-meta">{total ? plural(total, t("votesOne"), t("votesMany")) : t("noVotes")}{poll.judged ? ` · ${t("judged", { n: poll.judged })}` : ""}{over ? ` · ${t("ended")}` : ""}</span>
        {controls && (
          <span className="poll-actions">
            {!over && <button className="chip-btn" onClick={() => void endPollNow()} title={t("endTip")}>{t("end")}</button>}
            {onStart && over && <button className="chip-btn" onClick={onStart} title={t("startTip")}>{t("startBtn")}</button>}
            <button className="icon" onClick={() => api.clearPoll().catch(() => {})} title={t("clearTip")} aria-label={t("clearTip")}>{t("clear")}</button>
          </span>
        )}
      </header>
      <ol className="poll-rows">
        {rows.map((r) => (
          <li key={r.option} className={`poll-row ${r.leading ? "lead" : ""}`}>
            <span className="poll-opt">{r.option}{r.leading && over && <em> · {t("winner")}</em>}</span>
            <span className="poll-bar"><i style={{ width: `${r.pct}%` }} /></span>
            <span className="poll-n">{r.n}<small>{total ? ` ${r.pct}%` : ""}</small></span>
          </li>
        ))}
      </ol>
      {size !== "overlay" && poll.recent.length > 0 && (
        <div className="poll-recent" aria-hidden>
          {[...poll.recent].reverse().slice(0, 8).map((v, i) => <span key={`${v.handle}-${i}`} title={`${v.nickname || v.handle}: ${v.option}`}><Avatar src={v.avatar} name={v.nickname || v.handle} handle={v.handle} size={18} className="poll-avatar" /></span>)}
        </div>
      )}
    </section>
  );
});
