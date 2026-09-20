import { memo, useState } from "react";
import type { Decision, JevAnswer, Snapshot, WatchQuestion } from "@shared/protocol";
import { api } from "../useSocket";
import { Ring, SourceBadges, Spark, pct, useTween } from "./ui";

const confidenceOf = (a: JevAnswer) => (a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence);

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

/** One option wins: ranked thin bars, winner in ink, others muted. */
function Choice({ a }: { a: Extract<JevAnswer, { type: "choice" }> }) {
  const rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 6);
  return (
    <div className="g-rows">
      {rows.map(([k, p]) => (
        <div key={k} className={`g-row ${k === a.choice ? "pick" : ""}`} title={`${k.replace(/_/g, " ")}: ${pct(p)}`}>
          <span className="g-row-label">{k.replace(/_/g, " ")}</span>
          <span className="g-track thin"><span className="g-fill" style={{ width: pct(p) }} /></span>
          <span className="g-row-val">{pct(p)}</span>
        </div>
      ))}
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

const Gauge = memo(function Gauge({ q, answer, history, fired, snapshot }: { q: WatchQuestion; answer?: JevAnswer; history: number[]; fired: boolean; snapshot: Snapshot | null }) {
  const [busy, setBusy] = useState(false);
  const disagree = async () => {
    if (!answer) return;
    const note = window.prompt(`You disagree with "${q.label}". What should the answer have been, and why?`) ?? undefined;
    setBusy(true);
    await api.feedback({ questionId: q.id, answer, note, stateExcerpt: snapshot ? { transcript: snapshot.transcript_last_30s.slice(-500), chat: snapshot.chat_recent.slice(-6), scene: snapshot.scene, activity: snapshot.activity } : null });
    setBusy(false);
  };
  const conf = answer ? confidenceOf(answer) : 0;
  const instructions = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  const max = answer?.type === "score" ? Math.max(1, Object.keys(answer.legend).length - 1) : 1;
  return (
    <article className={`gauge ${fired ? "fired" : ""} ${answer && conf < 0.35 ? "unsure" : ""}`} aria-live="polite">
      <header className="gauge-head">
        <span className="gauge-label">{q.label}</span>
        <SourceBadges sources={q.sources} compact />
        <span className="grow" />
        {answer && <Ring value={conf} title={`confidence ${pct(conf)}`} />}
        <button className="icon" disabled={!answer || busy} onClick={disagree} title="Disagree · GLM rewrites this question" aria-label="disagree">{busy ? "…" : "👎"}</button>
      </header>
      {!answer && <div className="skeleton" />}
      {answer?.type === "noul" && <Noul a={answer} threshold={q.alert?.noulAbove} />}
      {answer?.type === "choice" && <Choice a={answer} />}
      {answer?.type === "score" && <Score a={answer} />}
      <footer className="gauge-foot">
        <Spark values={history} max={max} />
        <span className="gauge-type">{q.question.type}</span>
      </footer>
      <p className="gauge-q" title={instructions}>{instructions}</p>
      {fired && <span className="fire-badge">firing</span>}
    </article>
  );
});

export function Gauges({ questions, decisions, snapshot }: { questions: WatchQuestion[]; decisions: Decision[]; snapshot: Snapshot | null }) {
  const last = decisions.at(-1);
  const series = (id: string) => decisions.slice(-60).map((d) => { const a = d.answers[id]; return !a ? 0 : a.type === "noul" ? a.noul : a.type === "score" ? a.score : a.confidence; });
  if (questions.length === 0) return <div className="empty">No room rules yet. Add one in <b>Rules</b>.</div>;
  return (
    <div className="gauges">
      {questions.map((q) => <Gauge key={q.id} q={q} answer={last?.answers[q.id]} history={series(q.id)} fired={last?.fired.includes(q.id) ?? false} snapshot={snapshot} />)}
    </div>
  );
}
