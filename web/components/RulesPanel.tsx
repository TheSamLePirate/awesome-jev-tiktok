import { useState } from "react";
import { ALL_SOURCES, type QuestionSet, type Rule, type Source } from "@shared/protocol";
import { api } from "../useSocket";
import { SOURCE_META, SourceBadges } from "./ui";

const EXAMPLES: Record<string, { text: string; sources: Source[] }> = {
  "💬 pricing questions": { text: "Tell me when someone in chat asks about price, cost, or how to buy.", sources: ["chat"] },
  "🎙 host promises": { text: "Tell me when the host promises to do something later (a giveaway, a follow-up, a link).", sources: ["transcript"] },
  "🎥 host off camera": { text: "Flag when nobody is visible on camera or the host has left the frame.", sources: ["video"] },
  "✦ chat ignored": { text: "Tell me when chat is asking things the host is not addressing at all.", sources: ["chat", "transcript"] },
};

export function RulesPanel({ rules, questions }: { rules: Rule[]; questions: QuestionSet | null }) {
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
      <div className="rule-compose">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Describe what to watch in plain language. GLM turns it into jev questions." onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
        <div className="source-picker">
          <span className="muted">reads</span>
          <button className={`src-btn ${all ? "on" : ""}`} onClick={() => setSources([...ALL_SOURCES])}>✦ all</button>
          {ALL_SOURCES.map((s) => (
            <button key={s} className={`src-btn ${SOURCE_META[s].cls} ${sources.includes(s) ? "on" : ""}`} onClick={() => toggle(s)}>{SOURCE_META[s].icon} {SOURCE_META[s].label}</button>
          ))}
          <span className="grow" />
          <button className="primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? "GLM writing…" : "Add rule"}</button>
        </div>
        <div className="examples">
          {Object.entries(EXAMPLES).map(([k, v]) => <button key={k} className="chip-btn" onClick={() => { setText(v.text); setSources(v.sources); }}>{k}</button>)}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <ul className="rule-list">
        {rules.map((r) => {
          const qs = questions?.questions.filter((q) => q.ruleId === r.id) ?? [];
          return (
            <li key={r.id}>
              <div className="rule-top">
                <SourceBadges sources={r.sources} compact />
                <div className="rule-text">{r.text}</div>
                <button className="icon" onClick={() => api.removeRule(r.id)} title="remove rule">✕</button>
              </div>
              <div className="rule-qs">
                {qs.map((q) => <span key={q.id} className="chip" title={JSON.stringify(q.question, null, 1)}>{q.label} · {q.question.type} · {q.scope === "message" ? "per message" : "room"}</span>)}
                {qs.length === 0 && <span className="muted">compiling…</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
