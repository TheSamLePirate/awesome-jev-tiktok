import { useState } from "react";
import type { Decision, JevAnswer, Snapshot, WatchQuestion } from "@shared/protocol";
import { api } from "../useSocket";
import { SourceBadges, pct } from "./ui";

function Dist({ probabilities, legend, pick }: { probabilities: Record<string, number>; legend?: Record<string, string>; pick: string }) {
  return (
    <div className="dist">
      {Object.entries(probabilities).map(([k, p]) => (
        <div key={k} className={`dist-row ${k === pick ? "pick" : ""}`} title={legend?.[k] ?? k}>
          <span className="dist-label">{legend ? legend[k]?.split(/[:.]/)[0] : k.replace(/_/g, " ")}</span>
          <span className="dist-bar"><span style={{ width: pct(p) }} /></span>
          <span className="dist-val">{pct(p)}</span>
        </div>
      ))}
    </div>
  );
}

function Spark({ values, max = 1 }: { values: number[]; max?: number }) {
  const w = 140, h = 26;
  if (values.length < 2) return <svg className="spark" width={w} height={h} />;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (Math.min(v, max) / max) * (h - 3) - 1.5] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg className="spark" width={w} height={h}>
      <polygon points={area} className="spark-area" />
      <polyline points={line} fill="none" className="spark-line" strokeWidth="1.5" />
    </svg>
  );
}

function Gauge({ q, answer, history, fired, snapshot }: { q: WatchQuestion; answer?: JevAnswer; history: number[]; fired: boolean; snapshot: Snapshot | null }) {
  const [busy, setBusy] = useState(false);
  const disagree = async () => {
    if (!answer) return;
    const note = window.prompt(`You disagree with "${q.label}". What should the answer have been, and why?`) ?? undefined;
    setBusy(true);
    await api.feedback({ questionId: q.id, answer, note, stateExcerpt: snapshot ? { transcript: snapshot.transcript_last_30s.slice(-500), chat: snapshot.chat_recent.slice(-6), scene: snapshot.scene, activity: snapshot.activity } : null });
    setBusy(false);
  };
  const conf = answer ? (answer.type === "noul" ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence) : 0;
  const instructions = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  return (
    <div className={`gauge ${fired ? "fired" : ""} ${answer && conf < 0.35 ? "unsure" : ""}`}>
      <div className="gauge-head">
        <span className="gauge-label">{q.label}</span>
        <SourceBadges sources={q.sources} compact />
        <span className="gauge-type">{q.question.type}</span>
        <button className="icon" disabled={!answer || busy} onClick={disagree} title="Disagree: GLM rewrites this question">{busy ? "…" : "👎"}</button>
      </div>
      {!answer && <div className="muted">waiting for first decision…</div>}
      {answer?.type === "noul" && (
        <div className="noul">
          <div className="noul-big">{pct(answer.noul)}</div>
          <div className="noul-bar"><span style={{ width: pct(answer.noul) }} /></div>
        </div>
      )}
      {answer?.type === "choice" && <Dist probabilities={answer.probabilities} pick={answer.choice} />}
      {answer?.type === "score" && <Dist probabilities={answer.probabilities} legend={answer.legend} pick={String(Math.round(answer.score))} />}
      <div className="gauge-foot">
        <Spark values={history} max={answer?.type === "score" ? Math.max(1, Object.keys(answer.legend).length - 1) : 1} />
        {answer && answer.type !== "noul" && <span className="conf" title="jev confidence">{pct(answer.confidence)}</span>}
        {answer?.type === "noul" && <span className="conf" title="yes probability">noul</span>}
      </div>
      <div className="gauge-q" title={instructions}>{instructions}</div>
    </div>
  );
}

export function Gauges({ questions, decisions, snapshot }: { questions: WatchQuestion[]; decisions: Decision[]; snapshot: Snapshot | null }) {
  const last = decisions.at(-1);
  const series = (id: string) =>
    decisions.slice(-60).map((d) => { const a = d.answers[id]; return !a ? 0 : a.type === "noul" ? a.noul : a.type === "score" ? a.score : a.confidence; });
  if (questions.length === 0) return <div className="empty">No room rules yet. Add one on the right.</div>;
  return (
    <div className="gauges">
      {questions.map((q) => <Gauge key={q.id} q={q} answer={last?.answers[q.id]} history={series(q.id)} fired={last?.fired.includes(q.id) ?? false} snapshot={snapshot} />)}
    </div>
  );
}
