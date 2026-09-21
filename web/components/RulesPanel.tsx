import { memo, useState } from "react";
import { ALL_SOURCES, type JevQuestion, type QuestionSet, type Rule, type Source, type WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { toast } from "../lib/store";
import { confirm } from "./Dialog";
import { Kbd, SOURCE_META, SourceBadges } from "./ui";

const EXAMPLES: { label: string; text: string; sources: Source[] }[] = [
  { label: "💬 pricing questions", text: "Tell me when someone in chat asks about price, cost, or how to buy.", sources: ["chat"] },
  { label: "🎙 host promises", text: "Tell me when the host promises to do something later (a giveaway, a follow-up, a link).", sources: ["transcript"] },
  { label: "🎥 host off camera", text: "Flag when nobody is visible on camera or the host has left the frame.", sources: ["video"] },
  { label: "✦ chat ignored", text: "Tell me when chat is asking things the host is not addressing at all.", sources: ["chat", "transcript"] },
];
const KEYWORD_EXAMPLES: { label: string; text: string; pattern: string }[] = [
  { label: "🔗 links", text: "Messages with a link", pattern: "https?://|www\\.|\\.(com|net|fr|io)\\b" },
  { label: "📞 phone numbers", text: "Messages with a phone number", pattern: "(\\+?\\d[\\d .-]{7,}\\d)" },
  { label: "💰 price words", text: "Price questions", pattern: "\\b(prix|price|combien|cost|coûte)\\b" },
];

const TYPE_ICON: Record<JevQuestion["type"], string> = { noul: "◐", choice: "☰", score: "▤" };

function QuestionDetail({ q }: { q: WatchQuestion }) {
  const [open, setOpen] = useState(false);
  const instr = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  return (
    <div className={`qd ${open ? "open" : ""}`}>
      <button className="qd-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="qd-type" title={q.local ? "local regex" : q.question.type}>{q.local ? "⌘" : TYPE_ICON[q.question.type]}</span>
        <span className="qd-label">{q.label}</span>
        <span className="muted">{q.scope === "message" ? "per message" : "room"}{q.local ? " · local" : ""}</span>
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

const RuleItem = memo(function RuleItem({ r, qs, compiling }: { r: Rule; qs: WatchQuestion[]; compiling: boolean }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      const res = await api.removeRule(r.id);
      toast({ kind: "undo", title: "Rule removed", body: r.text.slice(0, 80), durationMs: Math.min(res.undoMs, 15_000), action: { label: "Undo", run: () => void api.restoreRule(r.id).catch(() => {}) } });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  const pause = async () => { setBusy(true); try { await api.pauseRule(r.id, !r.paused); } catch { /* toasted */ } finally { setBusy(false); } };
  return (
    <li className={`rule ${r.paused ? "paused" : ""}`}>
      <div className="rule-top">
        <SourceBadges sources={r.sources} compact />
        <div className="rule-text">{r.text}{r.kind === "keyword" && <span className="chip" title="local regex, no model call"> local</span>}{r.paused && <span className="badge mod"> paused</span>}</div>
        <button className="icon" disabled={busy} onClick={pause} title={r.paused ? "resume: the server evaluates this rule again" : "pause: the server skips this rule (no jev call, no alert)"} aria-label={r.paused ? "resume rule" : "pause rule"} aria-pressed={!!r.paused}>{r.paused ? "▶" : "⏸"}</button>
        <button className="icon" disabled={busy} onClick={remove} title="remove rule (undo for 60 s)" aria-label="remove rule">✕</button>
      </div>
      <div className="rule-qs">
        {qs.map((q) => <QuestionDetail key={q.id} q={q} />)}
        {qs.length === 0 && <div className={`shimmer ${compiling ? "" : "muted"}`}>{compiling ? "GLM is writing the questions…" : "no questions"}</div>}
      </div>
    </li>
  );
});

export const RulesPanel = memo(function RulesPanel({ rules, questions, compiling }: { rules: Rule[]; questions: QuestionSet | null; compiling: boolean }) {
  const [text, setText] = useState("");
  const [sources, setSources] = useState<Source[]>([...ALL_SOURCES]);
  const [kind, setKind] = useState<"jev" | "keyword">("jev");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (s: Source) => setSources((cur) => (cur.includes(s) ? (cur.length > 1 ? cur.filter((x) => x !== s) : cur) : [...cur, s]));
  const all = sources.length === ALL_SOURCES.length;
  let patternError: string | null = null;
  if (kind === "keyword" && pattern) { try { new RegExp(pattern, "i"); } catch (e) { patternError = (e as Error).message; } }
  const canSubmit = !!text.trim() && !busy && (kind === "jev" || (!!pattern.trim() && !patternError));
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      await api.addRule(kind === "keyword" ? { text: text.trim(), sources, kind, pattern: pattern.trim(), flags: "i", label: text.trim().slice(0, 24) } : { text: text.trim(), sources });
      setText(""); setPattern("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const applyExample = async (t: string, s: Source[], p?: string) => { if (text.trim() && text !== t && !(await confirm({ title: "Replace the text you typed?", confirmLabel: "Replace" }))) return; setText(t); setSources(s); if (p !== undefined) { setKind("keyword"); setPattern(p); } };
  return (
    <div className="rules">
      <div className="rule-compose panel">
        <div className="seg" role="group" aria-label="rule kind">
          <button className={kind === "jev" ? "on" : ""} aria-pressed={kind === "jev"} onClick={() => setKind("jev")}>✦ jev rule</button>
          <button className={kind === "keyword" ? "on" : ""} aria-pressed={kind === "keyword"} onClick={() => setKind("keyword")}>⌘ keyword / regex</button>
        </div>
        <textarea name="rule-text" value={text} onChange={(e) => setText(e.target.value)} rows={kind === "jev" ? 3 : 2} autoComplete="off" data-1p-ignore="true" data-lpignore="true" placeholder={kind === "jev" ? "Describe what to watch, in plain language. GLM turns it into jev questions." : "Name for this rule (e.g. links in chat)"} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} aria-label="new rule" />
        {kind === "keyword" && (
          <div className="field-row">
            <input className="mono" name="rule-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="regular expression (case-insensitive)" aria-label="pattern" aria-invalid={!!patternError} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
            {patternError && <span className="error small">{patternError}</span>}
          </div>
        )}
        <div className="source-picker" role="group" aria-label="media sources">
          <span className="muted">reads</span>
          <button className={`src-btn ${all ? "on" : ""}`} onClick={() => setSources([...ALL_SOURCES])}>✦ all</button>
          {ALL_SOURCES.map((s) => <button key={s} className={`src-btn ${SOURCE_META[s].cls} ${sources.includes(s) ? "on" : ""}`} aria-pressed={sources.includes(s)} onClick={() => toggle(s)}>{SOURCE_META[s].icon} {SOURCE_META[s].label}</button>)}
          <span className="grow" />
          <button className="primary" disabled={!canSubmit} onClick={submit} title="⌘⏎">{busy ? <><span className="spinner sm" /> {kind === "jev" ? "GLM writing" : "adding"}</> : <>Add rule <Kbd k="⌘⏎" /></>}</button>
        </div>
        <div className="examples">
          {kind === "jev" ? EXAMPLES.map((e) => <button key={e.label} className="chip-btn" onClick={() => void applyExample(e.text, e.sources)}>{e.label}</button>) : KEYWORD_EXAMPLES.map((e) => <button key={e.label} className="chip-btn" onClick={() => void applyExample(e.text, ["chat"], e.pattern)}>{e.label}</button>)}
        </div>
        <p className="muted small">{kind === "jev" ? "A jev rule costs one GLM compile (≈ $0.0003) and then shares a jev call with every other rule reading the same sources." : "A keyword rule runs in-process on every chat message (or the transcript for room rules). It costs nothing."}</p>
        {error && <div className="error">{error}</div>}
      </div>
      <ul className="rule-list">
        {rules.map((r) => <RuleItem key={r.id} r={r} qs={questions?.questions.filter((q) => q.ruleId === r.id) ?? []} compiling={compiling} />)}
      </ul>
    </div>
  );
});
