import { memo, useCallback, useMemo, useState } from "react";
import type { Decision, JevAnswer, Snapshot, WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { confidenceOf } from "../lib/format";
import { prompt } from "./Dialog";
import { Ring, SourceBadges, Spark, pct, useTween } from "./ui";
import { getState, toast } from "../lib/store";

/** Yes/no probability: hero number, single-hue track, threshold tick where the alert fires. */
function Noul({ a, threshold }: { a: Extract<JevAnswer, { type: "noul" }>; threshold?: number }) {
  const v = useTween(a.noul);
  return (
    <div className="g-noul">
      <div className="g-hero" aria-label={`${pct(a.noul)} yes`}>{Math.round(v * 100)}<span className="g-unit">%</span></div>
      <div className="g-track" title={`${pct(a.noul)} probability of yes${threshold !== undefined ? ` · fires at ${pct(threshold)}` : ""}`}>
        <span className="g-fill" style={{ width: `${v * 100}%` }} />
        {threshold !== undefined && <span className="g-tick" style={{ left: `${threshold * 100}%` }} />}
      </div>
    </div>
  );
}

/** One option wins: ranked thin bars, winner in ink, others muted. Beyond 6, the rest are folded behind a toggle. */
function Choice({ a }: { a: Extract<JevAnswer, { type: "choice" }> }) {
  const [all, setAll] = useState(false);
  const rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div className="g-rows">
      {shown.map(([k, p]) => (
        <div key={k} className={`g-row ${k === a.choice ? "pick" : ""}`} title={`${k.replace(/_/g, " ")}: ${pct(p)}`}>
          <span className="g-row-label">{k.replace(/_/g, " ")}</span>
          <span className="g-track thin"><span className="g-fill" style={{ width: pct(p) }} /></span>
          <span className="g-row-val">{pct(p)}</span>
        </div>
      ))}
      {rows.length > 6 && <button className="icon g-more" onClick={() => setAll((v) => !v)}>{all ? "fewer" : `+${rows.length - 6} more`}</button>}
    </div>
  );
}

/** Ordered levels: a segmented meter with a marker at the (interpolated) score. */
function Score({ a }: { a: Extract<JevAnswer, { type: "score" }> }) {
  const levels = Object.entries(a.legend).sort((x, y) => Number(x[0]) - Number(y[0]));
  const n = levels.length;
  const v = useTween(a.score);
  const pos = n > 1 ? (v / (n - 1)) * 100 : 0;
  const current = levels[Math.round(a.score)]?.[1] ?? "";
  return (
    <div className="g-score" title={`score ${a.score.toFixed(2)} of ${n - 1}`}>
      <div className="g-score-name">{current.split(/[:.]/)[0]}</div>
      <div className="g-segments" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {levels.map(([i, name]) => <span key={i} className="g-seg" style={{ opacity: 0.25 + 0.75 * (a.probabilities[i] ?? 0) }} title={`${name}: ${pct(a.probabilities[i] ?? 0)}`} />)}
        <span className="g-marker" style={{ left: `${pos}%` }} />
      </div>
      <div className="g-seg-labels" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {levels.map(([i, name]) => <span key={i} className={Number(i) === Math.round(a.score) ? "on" : ""}>{name.split(/[:.]/)[0]}</span>)}
      </div>
    </div>
  );
}

const Gauge = memo(function Gauge({ q, answer, history, fired, skipped, paused, unsureBelow }: { q: WatchQuestion; answer?: JevAnswer; history: number[]; fired: boolean; skipped: boolean; paused: boolean; unsureBelow: number }) {
  const [busy, setBusy] = useState(false);
  const disagree = useCallback(async () => {
    if (!answer) return;
    const r = await prompt({ title: `"${q.label}" answered ${answer.type === "noul" ? pct(answer.noul) : answer.type === "choice" ? answer.choice : answer.score.toFixed(1)}`, body: "Tell GLM what jev should have answered and why. It rewrites the question with your note as evidence.", placeholder: "What should the answer have been, and why?", confirmLabel: "Send and rewrite", choices: [{ value: "wrong", label: "This answer is wrong" }, { value: "missed", label: "It should have fired and did not" }, { value: "correct", label: "Correct (just record it)" }], choiceLabel: "Verdict" });
    if (!r) return;
    setBusy(true);
    try {
      const snapshot: Snapshot | null = getState().snapshot;
      const res = await api.feedback({ questionId: q.id, verdict: r.choice ?? "wrong", answer, note: r.text || undefined, expected: r.text || undefined, stateExcerpt: snapshot ? { transcript: snapshot.transcript_last_30s.slice(-500), chat: snapshot.chat_recent.slice(-6), scene: snapshot.scene, activity: snapshot.activity } : null });
      toast({ kind: "info", title: res.rewritten ? `GLM rewrote "${q.label}"` : "Feedback recorded" });
    } catch { /* toasted by the api layer */ }
    finally { setBusy(false); }
  }, [q.id, q.label, answer]);
  const conf = answer ? confidenceOf(answer) : 0;
  const instructions = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  const max = answer?.type === "score" ? Math.max(1, Object.keys(answer.legend).length - 1) : 1;
  return (
    <article className={`gauge ${fired ? "fired" : ""} ${answer && conf < unsureBelow ? "unsure" : ""} ${skipped || paused ? "skipped" : ""}`} aria-label={`${q.label}: ${fired ? "firing" : skipped ? "not evaluated" : "quiet"}`}>
      <header className="gauge-head">
        <span className="gauge-label">{q.label}</span>
        <SourceBadges sources={q.sources} compact />
        {q.local && <span className="chip" title="local rule: no jev call">local</span>}
        <span className="grow" />
        {answer && !q.local && <Ring value={conf} title={`confidence ${pct(conf)}`} />}
        {!q.local && <button className="icon" disabled={!answer || busy} onClick={disagree} title="Disagree · GLM rewrites this question" aria-label={`disagree with ${q.label}`}>{busy ? "…" : "👎"}</button>}
      </header>
      {!answer && !skipped && !paused && <div className="skeleton" />}
      {paused && <div className="g-note">rule paused</div>}
      {!paused && skipped && <div className="g-note warn">not evaluated this tick (source failed or budget)</div>}
      {answer?.type === "noul" && <Noul a={answer} threshold={q.alert?.noulAbove} />}
      {answer?.type === "choice" && <Choice a={answer} />}
      {answer?.type === "score" && <Score a={answer} />}
      <footer className="gauge-foot">
        <Spark values={history} max={max} />
        <span className="gauge-type">{q.local ? "regex" : q.question.type}</span>
      </footer>
      <p className="gauge-q" title={instructions}>{instructions}</p>
      {fired && <span className="fire-badge">firing</span>}
    </article>
  );
});

export const Gauges = memo(function Gauges({ questions, decisions, pausedRuleIds, unsureBelow, live }: { questions: WatchQuestion[]; decisions: Decision[]; pausedRuleIds: Set<string>; unsureBelow: number; live: boolean }) {
  const last = decisions.at(-1);
  // Series per question, computed once per decisions change (not once per gauge per render).
  const series = useMemo(() => {
    const out: Record<string, number[]> = {};
    const recent = decisions.slice(-60);
    for (const q of questions) out[q.id] = recent.map((d) => { const a = d.answers[q.id]; return !a ? 0 : a.type === "noul" ? a.noul : a.type === "score" ? a.score : a.confidence; });
    return out;
  }, [decisions, questions]);
  if (questions.length === 0) return <div className="empty">No room rules yet. Add one in <b>Rules</b>.</div>;
  return (
    <div className="gauges">
      {questions.map((q) => <Gauge key={q.id} q={q} answer={last?.answers[q.id]} history={series[q.id]} fired={last?.fired.includes(q.id) ?? false} skipped={live && (last?.skipped?.includes(q.id) ?? false)} paused={pausedRuleIds.has(q.ruleId)} unsureBelow={unsureBelow} />)}
    </div>
  );
});
