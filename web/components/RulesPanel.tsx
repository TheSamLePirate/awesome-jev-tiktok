import { useState } from "react";
import { ALL_SOURCES, type JevQuestion, type QuestionSet, type Rule, type Source, type WatchQuestion } from "@shared/protocol";
import { api } from "../useSocket";
import { Kbd, SOURCE_META, SourceBadges } from "./ui";

const EXAMPLES: { label: string; text: string; sources: Source[] }[] = [
  { label: "💬 pricing questions", text: "Tell me when someone in chat asks about price, cost, or how to buy.", sources: ["chat"] },
  { label: "🎙 host promises", text: "Tell me when the host promises to do something later (a giveaway, a follow-up, a link).", sources: ["transcript"] },
  { label: "🎥 host off camera", text: "Flag when nobody is visible on camera or the host has left the frame.", sources: ["video"] },
  { label: "✦ chat ignored", text: "Tell me when chat is asking things the host is not addressing at all.", sources: ["chat", "transcript"] },
];

const TYPE_ICON: Record<JevQuestion["type"], string> = { noul: "◐", choice: "☰", score: "▤" };

function QuestionDetail({ q }: { q: WatchQuestion }) {
  const [open, setOpen] = useState(false);
  const instr = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  return (
    <div className={`qd ${open ? "open" : ""}`}>
      <button className="qd-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="qd-type" title={q.question.type}>{TYPE_ICON[q.question.type]}</span>
        <span className="qd-label">{q.label}</span>
        <span className="muted">{q.scope === "message" ? "per message" : "room"}</span>
        <span className="grow" />
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="qd-body">
          <p className="qd-instr">{instr}</p>
          {q.question.type === "choice" && <ul className="qd-list">{Object.entries(q.question.criteria).map(([k, v]) => <li key={k}><b>{k.replace(/_/g, " ")}</b> <span>{typeof v === "string" ? v : JSON.stringify(v)}</span></li>)}</ul>}
          {q.question.type === "score" && <ol className="qd-list">{q.question.criteria.map((v, i) => <li key={i}><span>{typeof v === "string" ? v : JSON.stringify(v)}</span></li>)}</ol>}
          {q.question.type === "noul" && q.question.criteria && <ul className="qd-list">{(["true", "false"] as const).map((k) => q.question.type === "noul" && q.question.criteria?.[k] ? <li key={k}><b>{k === "true" ? "yes" : "no"}</b> <span>{typeof q.question.criteria[k] === "string" ? String(q.question.criteria[k]) : JSON.stringify(q.question.criteria[k])}</span></li> : null)}</ul>}
          {q.alert && <p className="muted qd-alert">fires when {q.alert.noulAbove !== undefined ? `yes ≥ ${Math.round(q.alert.noulAbove * 100)}%` : q.alert.choices ? `answer is ${q.alert.choices.join(" / ")}` : q.alert.scoreAtLeast !== undefined ? `level ≥ ${q.alert.scoreAtLeast}` : "—"}</p>}
        </div>
      )}
    </div>
  );
}

export function RulesPanel({ rules, questions, compiling }: { rules: Rule[]; questions: QuestionSet | null; compiling: boolean }) {
  const [text, setText] = useState("");
  const [sources, setSources] = useState<Source[]>([...ALL_SOURCES]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (s: Source) => setSources((cur) => (cur.includes(s) ? (cur.length > 1 ? cur.filter((x) => x !== s) : cur) : [...cur, s]));
  const all = sources.length === ALL_SOURCES.length;
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    const r = await api.addRule(text.trim(), sources);
    setBusy(false);
    if (r.ok) setText(""); else setError(r.error ?? "failed");
  };
  return (
    <div className="rules">
      <div className="rule-compose panel">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Describe what to watch, in plain language. GLM turns it into jev questions." onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} aria-label="new rule" />
        <div className="source-picker" role="group" aria-label="media sources">
          <span className="muted">reads</span>
          <button className={`src-btn ${all ? "on" : ""}`} onClick={() => setSources([...ALL_SOURCES])}>✦ all</button>
          {ALL_SOURCES.map((s) => <button key={s} className={`src-btn ${SOURCE_META[s].cls} ${sources.includes(s) ? "on" : ""}`} aria-pressed={sources.includes(s)} onClick={() => toggle(s)}>{SOURCE_META[s].icon} {SOURCE_META[s].label}</button>)}
          <span className="grow" />
          <button className="primary" disabled={busy || !text.trim()} onClick={submit} title="⌘⏎">{busy ? <><span className="spinner sm" /> GLM writing</> : <>Add rule <Kbd k="⌘⏎" /></>}</button>
        </div>
        <div className="examples">{EXAMPLES.map((e) => <button key={e.label} className="chip-btn" onClick={() => { setText(e.text); setSources(e.sources); }}>{e.label}</button>)}</div>
        {error && <div className="error">{error}</div>}
      </div>
      <ul className="rule-list">
        {rules.map((r) => {
          const qs = questions?.questions.filter((q) => q.ruleId === r.id) ?? [];
          return (
            <li key={r.id} className="rule">
              <div className="rule-top">
                <SourceBadges sources={r.sources} compact />
                <div className="rule-text">{r.text}</div>
                <button className="icon" onClick={() => api.removeRule(r.id)} title="remove rule" aria-label="remove rule">✕</button>
              </div>
              <div className="rule-qs">
                {qs.map((q) => <QuestionDetail key={q.id} q={q} />)}
                {qs.length === 0 && <div className={`shimmer ${compiling ? "" : "muted"}`}>{compiling ? "GLM is writing the questions…" : "no questions"}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
