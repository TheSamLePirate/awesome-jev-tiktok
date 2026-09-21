import { memo, useEffect, useState } from "react";
import { ALL_SOURCES, type JevQuestion, type PatternTest, type QuestionSet, type RecordingInfo, type Rule, type Source, type WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { toast, useStore } from "../lib/store";
import { fmtTime, when } from "../lib/format";
import { plural, useT } from "../i18n";
import { COMMON } from "../i18n/common";
import { confirm } from "./Dialog";
import { Avatar, Kbd, SOURCE_META, SourceBadges } from "./ui";

const M = {
  en: {
    exPricing: "💬 pricing questions", exPricingText: "Tell me when someone in chat asks about price, cost, or how to buy.",
    exPromises: "🎙 host promises", exPromisesText: "Tell me when the host promises to do something later (a giveaway, a follow-up, a link).",
    exOffCam: "🎥 host off camera", exOffCamText: "Flag when nobody is visible on camera or the host has left the frame.",
    exIgnored: "✦ chat ignored", exIgnoredText: "Tell me when chat is asking things the host is not addressing at all.",
    kwLinks: "🔗 links", kwLinksText: "Messages with a link",
    kwPhones: "📞 phone numbers", kwPhonesText: "Messages with a phone number",
    kwPrice: "💰 price words", kwPriceText: "Price questions",
    localRegex: "local regex", firesWhen: "fires when {cond}", condNoul: "yes ≥ {p}%", condChoice: "answer is {a}", condScore: "level ≥ {n}",
    reads: "reads", allSources: "✦ all",
    patternTest: "pattern test", testTitle: "run this pattern on a past session: nothing is billed", testing: "testing", testOn: "▶ Test on", testSource: "test source",
    defaultSource: "current session, else the latest recording", msgs: " · {n} msgs",
    matchMessages: "of {total} messages match", matchLines: "of {total} host lines match", thisSession: "this session",
    nothingMatched: "Nothing matched. Broaden the pattern, or test on another recording.",
    noChat: "That session has no chat to test on.", noSpeech: "That session has no host speech to test on.",
    editRule: "edit rule", ruleText: "rule text", patternPh: "regular expression (case-insensitive)", editPattern: "edit pattern", labelPh: "label", editLabel: "edit label", editSources: "edit media sources",
    saving: "saving", glmRewriting: "GLM rewriting",
    recompileNote: "Saving recompiles this rule's questions with GLM (≈ $0.0003). The rule keeps its id, so the flags it already produced stay attached to it.",
    ruleRewritten: "Rule rewritten", ruleUpdated: "Rule updated", wroteOne: "GLM wrote {n} question for “{text}”", wroteMany: "GLM wrote {n} questions for “{text}”",
    localChip: " local", localChipTitle: "local regex, no model call", pausedChip: " paused",
    editKwTitle: "edit: text, pattern, label, sources", editJevTitle: "edit: text and sources (GLM rewrites the questions)",
    resumeTitle: "resume: the server evaluates this rule again", pauseTitle: "pause: the server skips this rule (no jev call, no alert)", resumeRule: "resume rule", pauseRule: "pause rule",
    removeTitle: "remove rule (undo for 60 s)", removeRule: "remove rule", ruleRemoved: "Rule removed",
    glmWriting: "GLM is writing the questions…", noQuestions: "no questions",
    ruleKind: "rule kind", jevRule: "✦ jev rule", keywordRule: "⌘ keyword / regex",
    jevPh: "Describe what to watch, in plain language. GLM turns it into jev questions.", kwPh: "Name for this rule (e.g. links in chat)", newRule: "new rule", pattern: "pattern", mediaSources: "media sources",
    glmWritingShort: "GLM writing", adding: "adding", addRule: "Add rule", replaceTitle: "Replace the text you typed?", replace: "Replace",
    adviceRefine: "jev suggests: rewrite it", advicePause: "jev suggests: pause it", adviceRemove: "jev suggests: remove it", adviceApply: "apply", adviceDismiss: "dismiss",
    jevBlurb: "A jev rule costs one GLM compile (≈ $0.0003) and then shares a jev call with every other rule reading the same sources.",
    kwBlurb: "A keyword rule runs in-process on every chat message (or the transcript for room rules). It costs nothing. Test it on a past session before adding it.",
  },
  fr: {
    exPricing: "💬 questions de prix", exPricingText: "Préviens-moi quand quelqu'un dans le chat demande le prix, le coût ou comment acheter.",
    exPromises: "🎙 promesses du streamer", exPromisesText: "Préviens-moi quand le streamer promet de faire quelque chose plus tard (un giveaway, un suivi, un lien).",
    exOffCam: "🎥 streamer hors champ", exOffCamText: "Signale quand personne n'est visible à l'écran ou que le streamer a quitté le cadre.",
    exIgnored: "✦ chat ignoré", exIgnoredText: "Préviens-moi quand le chat pose des questions auxquelles le streamer ne répond pas du tout.",
    kwLinks: "🔗 liens", kwLinksText: "Messages avec un lien",
    kwPhones: "📞 numéros de téléphone", kwPhonesText: "Messages avec un numéro de téléphone",
    kwPrice: "💰 mots de prix", kwPriceText: "Questions de prix",
    localRegex: "regex locale", firesWhen: "se déclenche quand {cond}", condNoul: "oui ≥ {p}%", condChoice: "la réponse est {a}", condScore: "niveau ≥ {n}",
    reads: "lit", allSources: "✦ tout",
    patternTest: "test du motif", testTitle: "lance ce motif sur une session passée : rien n'est facturé", testing: "test en cours", testOn: "▶ Tester sur", testSource: "source du test",
    defaultSource: "session en cours, sinon le dernier enregistrement", msgs: " · {n} msgs",
    matchMessages: "sur {total} messages correspondent", matchLines: "sur {total} phrases du streamer correspondent", thisSession: "cette session",
    nothingMatched: "Aucune correspondance. Élargis le motif ou teste sur un autre enregistrement.",
    noChat: "Cette session n'a pas de chat à tester.", noSpeech: "Cette session n'a pas de parole du streamer à tester.",
    editRule: "modifier la règle", ruleText: "texte de la règle", patternPh: "expression régulière (insensible à la casse)", editPattern: "modifier le motif", labelPh: "libellé", editLabel: "modifier le libellé", editSources: "modifier les sources média",
    saving: "enregistrement", glmRewriting: "GLM réécrit",
    recompileNote: "Enregistrer recompile les questions de cette règle avec GLM (≈ 0,0003 $). La règle garde son id : les signalements déjà produits lui restent attachés.",
    ruleRewritten: "Règle réécrite", ruleUpdated: "Règle mise à jour", wroteOne: "GLM a écrit {n} question pour « {text} »", wroteMany: "GLM a écrit {n} questions pour « {text} »",
    localChip: " locale", localChipTitle: "regex locale, aucun appel au modèle", pausedChip: " en pause",
    editKwTitle: "modifier : texte, motif, libellé, sources", editJevTitle: "modifier : texte et sources (GLM réécrit les questions)",
    resumeTitle: "reprendre : le serveur évalue à nouveau cette règle", pauseTitle: "mettre en pause : le serveur ignore cette règle (pas d'appel jev, pas d'alerte)", resumeRule: "reprendre la règle", pauseRule: "mettre la règle en pause",
    removeTitle: "supprimer la règle (annulable pendant 60 s)", removeRule: "supprimer la règle", ruleRemoved: "Règle supprimée",
    glmWriting: "GLM écrit les questions…", noQuestions: "aucune question",
    ruleKind: "type de règle", jevRule: "✦ règle jev", keywordRule: "⌘ mot-clé / regex",
    jevPh: "Décris ce qu'il faut surveiller, en langage courant. GLM le transforme en questions jev.", kwPh: "Nom de cette règle (ex. liens dans le chat)", newRule: "nouvelle règle", pattern: "motif", mediaSources: "sources média",
    glmWritingShort: "GLM écrit", adding: "ajout", addRule: "Ajouter la règle", replaceTitle: "Remplacer le texte que tu as saisi ?", replace: "Remplacer",
    adviceRefine: "jev suggère : la réécrire", advicePause: "jev suggère : la mettre en pause", adviceRemove: "jev suggère : la supprimer", adviceApply: "appliquer", adviceDismiss: "ignorer",
    jevBlurb: "Une règle jev coûte une compilation GLM (≈ 0,0003 $) puis partage un appel jev avec toutes les autres règles qui lisent les mêmes sources.",
    kwBlurb: "Une règle mot-clé s'exécute localement sur chaque message du chat (ou sur la transcription pour les règles de salle). Elle ne coûte rien. Teste-la sur une session passée avant de l'ajouter.",
  },
};
type MK = keyof typeof M.en;

const EXAMPLES: { label: MK; text: MK; sources: Source[] }[] = [
  { label: "exPricing", text: "exPricingText", sources: ["chat"] },
  { label: "exPromises", text: "exPromisesText", sources: ["transcript"] },
  { label: "exOffCam", text: "exOffCamText", sources: ["video"] },
  { label: "exIgnored", text: "exIgnoredText", sources: ["chat", "transcript"] },
];
const KEYWORD_EXAMPLES: { label: MK; text: MK; pattern: string }[] = [
  { label: "kwLinks", text: "kwLinksText", pattern: "https?://|www\\.|\\.(com|net|fr|io)\\b" },
  { label: "kwPhones", text: "kwPhonesText", pattern: "(\\+?\\d[\\d .-]{7,}\\d)" },
  { label: "kwPrice", text: "kwPriceText", pattern: "\\b(prix|price|combien|cost|coûte)\\b" },
];

const TYPE_ICON: Record<JevQuestion["type"], string> = { noul: "◐", choice: "☰", score: "▤" };
const NOFILL = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false, "data-1p-ignore": "true", "data-lpignore": "true", "data-form-type": "other" } as const;

/** Validates a regex the way the server will; null when it compiles. */
const patternProblem = (pattern: string): string | null => { if (!pattern) return null; try { new RegExp(pattern, "i"); return null; } catch (e) { return (e as Error).message; } };

function QuestionDetail({ q }: { q: WatchQuestion }) {
  const t = useT(M); const c = useT(COMMON);
  const [open, setOpen] = useState(false);
  const instr = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  return (
    <div className={`qd ${open ? "open" : ""}`}>
      <button className="qd-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="qd-type" title={q.local ? t("localRegex") : q.question.type}>{q.local ? "⌘" : TYPE_ICON[q.question.type]}</span>
        <span className="qd-label">{q.label}</span>
        <span className="muted">{q.scope === "message" ? c("perMessage") : c("room")}{q.local ? ` · ${c("local")}` : ""}</span>
        <span className="grow" />
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="qd-body">
          <p className="qd-instr">{instr}</p>
          {q.question.type === "choice" && <ul className="qd-list">{Object.entries(q.question.criteria).map(([k, v]) => <li key={k}><b>{k.replace(/_/g, " ")}</b> <span>{typeof v === "string" ? v : JSON.stringify(v)}</span></li>)}</ul>}
          {q.question.type === "score" && <ol className="qd-list">{q.question.criteria.map((v, i) => <li key={i}><span>{typeof v === "string" ? v : JSON.stringify(v)}</span></li>)}</ol>}
          {q.question.type === "noul" && q.question.criteria && <ul className="qd-list">{(["true", "false"] as const).map((k) => q.question.type === "noul" && q.question.criteria?.[k] ? <li key={k}><b>{k === "true" ? c("yes") : c("no")}</b> <span>{typeof q.question.criteria[k] === "string" ? String(q.question.criteria[k]) : JSON.stringify(q.question.criteria[k])}</span></li> : null)}</ul>}
          {q.alert && <p className="muted qd-alert">{t("firesWhen", { cond: q.alert.noulAbove !== undefined ? t("condNoul", { p: Math.round(q.alert.noulAbove * 100) }) : q.alert.choices ? t("condChoice", { a: q.alert.choices.join(" / ") }) : q.alert.scoreAtLeast !== undefined ? t("condScore", { n: q.alert.scoreAtLeast }) : "—" })}</p>}
        </div>
      )}
    </div>
  );
}

function SourcePicker({ sources, onChange }: { sources: Source[]; onChange: (s: Source[]) => void }) {
  const t = useT(M);
  const all = sources.length === ALL_SOURCES.length;
  const toggle = (s: Source) => onChange(sources.includes(s) ? (sources.length > 1 ? sources.filter((x) => x !== s) : sources) : [...sources, s]);
  return (
    <>
      <span className="muted">{t("reads")}</span>
      <button className={`src-btn ${all ? "on" : ""}`} onClick={() => onChange([...ALL_SOURCES])}>{t("allSources")}</button>
      {ALL_SOURCES.map((s) => <button key={s} className={`src-btn ${SOURCE_META[s].cls} ${sources.includes(s) ? "on" : ""}`} aria-pressed={sources.includes(s)} onClick={() => toggle(s)}>{SOURCE_META[s].icon} {SOURCE_META[s].label}</button>)}
    </>
  );
}

/**
 * Try a pattern before (or after) it becomes a rule: on the live session when there is one, else on a recording.
 * Free: the server runs the regex on the recorded chat (or the transcript for room rules) and returns a sample.
 */
function PatternTester({ pattern, scope }: { pattern: string; scope: "message" | "window" }) {
  const t = useT(M);
  const [recordings, setRecordings] = useState<RecordingInfo[] | null>(null);
  const [recording, setRecording] = useState("");
  const [result, setResult] = useState<PatternTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (recordings === null) void api.recordings().then(setRecordings).catch(() => setRecordings([])); }, [recordings]);
  const run = async () => {
    setBusy(true); setError(null);
    try { setResult(await api.testPattern({ pattern, flags: "i", scope, recording: recording || undefined })); }
    catch (e) { setResult(null); setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const disabled = !pattern.trim() || !!patternProblem(pattern) || busy;
  return (
    <div className="pt" aria-label={t("patternTest")}>
      <div className="field-row">
        <button className="chip-btn" disabled={disabled} onClick={() => void run()} title={t("testTitle")}>{busy ? <><span className="spinner sm" /> {t("testing")}</> : t("testOn")}</button>
        <select className="pt-source" value={recording} onChange={(e) => setRecording(e.target.value)} aria-label={t("testSource")}>
          <option value="">{t("defaultSource")}</option>
          {(recordings ?? []).map((r) => <option key={r.id} value={r.id}>@{r.username} · {when(r.createdAt)}{r.chatCount ? t("msgs", { n: r.chatCount }) : ""}</option>)}
        </select>
      </div>
      {error && <div className="error small">{error}</div>}
      {result && (
        <div className="pt-result">
          <p className={`pt-count ${result.matched ? "hit" : ""}`}>
            <b>{result.matched}</b> {t(result.scope === "message" ? "matchMessages" : "matchLines", { total: result.total })} · {result.source.kind === "session" ? t("thisSession") : `@${result.source.username}`}
            {result.total > 0 && <span className="muted"> · {Math.round((result.matched / result.total) * 100)}%</span>}
          </p>
          {result.matched === 0 && result.total > 0 && <p className="muted small">{t("nothingMatched")}</p>}
          {result.total === 0 && <p className="muted small">{t(result.scope === "message" ? "noChat" : "noSpeech")}</p>}
          <ul className="pt-sample">
            {result.sample.map((m, i) => (
              <li key={`${m.ts}-${i}`}>
                {m.handle && <Avatar src={m.avatar} name={m.nickname || m.handle} handle={m.handle} size={18} className="pt-avatar" />}
                {m.handle && <b>{m.nickname || m.handle}</b>}
                <span>{m.text}</span>
                <small>{fmtTime(m.ts)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Inline editor of one rule. Saving a jev rule recompiles its questions with GLM; a keyword rule keeps its question id. */
function RuleEditor({ r, q, onClose }: { r: Rule; q: WatchQuestion | undefined; onClose: () => void }) {
  const t = useT(M); const c = useT(COMMON);
  const keyword = r.kind === "keyword";
  const [text, setText] = useState(r.text);
  const [sources, setSources] = useState<Source[]>([...r.sources]);
  const [pattern, setPattern] = useState(q?.local?.pattern ?? "");
  const [label, setLabel] = useState(q?.label ?? r.text.slice(0, 24));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = keyword ? patternProblem(pattern) : null;
  const changed = text.trim() !== r.text || sources.join() !== r.sources.join() || (keyword && (pattern.trim() !== (q?.local?.pattern ?? "") || label.trim() !== (q?.label ?? "")));
  const canSave = !!text.trim() && !busy && changed && (!keyword || (!!pattern.trim() && !problem));
  const save = async () => {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      const res = await api.editRule(r.id, keyword ? { text: text.trim(), sources, pattern: pattern.trim(), flags: "i", label: label.trim() || text.trim().slice(0, 24) } : { text: text.trim(), sources });
      toast({ kind: "info", title: res.recompiled ? t("ruleRewritten") : t("ruleUpdated"), body: res.recompiled ? plural(res.questions.length, t("wroteOne"), t("wroteMany"), { text: text.trim().slice(0, 60) }) : text.trim().slice(0, 80) });
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="rule-edit" aria-label={t("editRule")}>
      <textarea name="rule-edit-text" value={text} rows={keyword ? 1 : 3} onChange={(e) => setText(e.target.value)} aria-label={t("ruleText")} autoComplete="off" data-1p-ignore="true" data-lpignore="true" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); if (e.key === "Escape") onClose(); }} />
      {keyword && (
        <>
          <div className="field-row">
            <input className="mono grow" name="rule-edit-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("patternPh")} aria-label={t("editPattern")} aria-invalid={!!problem} {...NOFILL} />
            <input name="rule-edit-label" value={label} maxLength={24} onChange={(e) => setLabel(e.target.value)} placeholder={t("labelPh")} aria-label={t("editLabel")} {...NOFILL} />
          </div>
          {problem && <span className="error small">{problem}</span>}
          <PatternTester pattern={pattern} scope={q?.scope ?? (sources.includes("chat") ? "message" : "window")} />
        </>
      )}
      <div className="source-picker" role="group" aria-label={t("editSources")}>
        <SourcePicker sources={sources} onChange={setSources} />
        <span className="grow" />
        <button onClick={onClose} disabled={busy}>{c("cancel")}</button>
        <button className="primary" disabled={!canSave} onClick={() => void save()} title="⌘⏎">{busy ? <><span className="spinner sm" /> {keyword ? t("saving") : t("glmRewriting")}</> : c("save")}</button>
      </div>
      {!keyword && <p className="muted small">{t("recompileNote")}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const RuleItem = memo(function RuleItem({ r, qs, compiling }: { r: Rule; qs: WatchQuestion[]; compiling: boolean }) {
  const t = useT(M); const c = useT(COMMON);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const advice = useStore((s) => s.assist?.ruleAdvice[r.id] ?? null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const showAdvice = advice && dismissed !== advice.at && !(advice.advice === "pause" && r.paused);
  const applyAdvice = async () => {
    if (!advice) return;
    setBusy(true);
    try {
      if (advice.advice === "pause") await api.pauseRule(r.id, true);
      else if (advice.advice === "remove") { const res = await api.removeRule(r.id); toast({ kind: "undo", title: t("ruleRemoved"), body: r.text.slice(0, 80), durationMs: Math.min(res.undoMs, 15_000), action: { label: c("undo"), run: () => void api.restoreRule(r.id).catch(() => {}) } }); }
      else setEditing(true);
      setDismissed(advice.at);
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const res = await api.removeRule(r.id);
      toast({ kind: "undo", title: t("ruleRemoved"), body: r.text.slice(0, 80), durationMs: Math.min(res.undoMs, 15_000), action: { label: c("undo"), run: () => void api.restoreRule(r.id).catch(() => {}) } });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  const pause = async () => { setBusy(true); try { await api.pauseRule(r.id, !r.paused); } catch { /* toasted */ } finally { setBusy(false); } };
  return (
    <li className={`rule ${r.paused ? "paused" : ""} ${editing ? "editing" : ""}`}>
      <div className="rule-top">
        <SourceBadges sources={r.sources} compact />
        <div className="rule-text">{r.text}{r.kind === "keyword" && <span className="chip" title={t("localChipTitle")}>{t("localChip")}</span>}{r.paused && <span className="badge mod">{t("pausedChip")}</span>}</div>
        <button className={`icon ${editing ? "on" : ""}`} disabled={busy} onClick={() => setEditing((v) => !v)} title={r.kind === "keyword" ? t("editKwTitle") : t("editJevTitle")} aria-label={t("editRule")} aria-pressed={editing}>✎</button>
        <button className="icon" disabled={busy} onClick={pause} title={r.paused ? t("resumeTitle") : t("pauseTitle")} aria-label={r.paused ? t("resumeRule") : t("pauseRule")} aria-pressed={!!r.paused}>{r.paused ? "▶" : "⏸"}</button>
        <button className="icon" disabled={busy} onClick={remove} title={t("removeTitle")} aria-label={t("removeRule")}>✕</button>
      </div>
      {showAdvice && (
        <div className={`rule-advice ${advice.advice}`} role="status">
          <span title={advice.reason}>💡 {t(advice.advice === "refine" ? "adviceRefine" : advice.advice === "pause" ? "advicePause" : "adviceRemove")} <small className="muted">· {advice.reason}</small></span>
          <button className="chip-btn" disabled={busy} onClick={() => void applyAdvice()}>{t("adviceApply")}</button>
          <button className="chip-btn" onClick={() => setDismissed(advice.at)}>{t("adviceDismiss")}</button>
        </div>
      )}
      {editing && <RuleEditor r={r} q={qs.find((q) => q.local) ?? qs[0]} onClose={() => setEditing(false)} />}
      <div className="rule-qs">
        {qs.map((q) => <QuestionDetail key={q.id} q={q} />)}
        {qs.length === 0 && <div className={`shimmer ${compiling ? "" : "muted"}`}>{compiling ? t("glmWriting") : t("noQuestions")}</div>}
      </div>
    </li>
  );
});

export const RulesPanel = memo(function RulesPanel({ rules, questions, compiling }: { rules: Rule[]; questions: QuestionSet | null; compiling: boolean }) {
  const t = useT(M);
  const [text, setText] = useState("");
  const [sources, setSources] = useState<Source[]>([...ALL_SOURCES]);
  const [kind, setKind] = useState<"jev" | "keyword">("jev");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patternError = kind === "keyword" ? patternProblem(pattern) : null;
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
  const applyExample = async (txt: string, s: Source[], p?: string) => { if (text.trim() && text !== txt && !(await confirm({ title: t("replaceTitle"), confirmLabel: t("replace") }))) return; setText(txt); setSources(s); if (p !== undefined) { setKind("keyword"); setPattern(p); } };
  return (
    <div className="rules">
      <div className="rule-compose panel">
        <div className="seg" role="group" aria-label={t("ruleKind")}>
          <button className={kind === "jev" ? "on" : ""} aria-pressed={kind === "jev"} onClick={() => setKind("jev")}>{t("jevRule")}</button>
          <button className={kind === "keyword" ? "on" : ""} aria-pressed={kind === "keyword"} onClick={() => setKind("keyword")}>{t("keywordRule")}</button>
        </div>
        <textarea name="rule-text" value={text} onChange={(e) => setText(e.target.value)} rows={kind === "jev" ? 3 : 2} autoComplete="off" data-1p-ignore="true" data-lpignore="true" placeholder={kind === "jev" ? t("jevPh") : t("kwPh")} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} aria-label={t("newRule")} />
        {kind === "keyword" && (
          <>
            <div className="field-row">
              <input className="mono" name="rule-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("patternPh")} aria-label={t("pattern")} aria-invalid={!!patternError} {...NOFILL} />
              {patternError && <span className="error small">{patternError}</span>}
            </div>
            <PatternTester pattern={pattern} scope={sources.includes("chat") ? "message" : "window"} />
          </>
        )}
        <div className="source-picker" role="group" aria-label={t("mediaSources")}>
          <SourcePicker sources={sources} onChange={setSources} />
          <span className="grow" />
          <button className="primary" disabled={!canSubmit} onClick={submit} title="⌘⏎">{busy ? <><span className="spinner sm" /> {kind === "jev" ? t("glmWritingShort") : t("adding")}</> : <>{t("addRule")} <Kbd k="⌘⏎" /></>}</button>
        </div>
        <div className="examples">
          {kind === "jev" ? EXAMPLES.map((e) => <button key={e.label} className="chip-btn" onClick={() => void applyExample(t(e.text), e.sources)}>{t(e.label)}</button>) : KEYWORD_EXAMPLES.map((e) => <button key={e.label} className="chip-btn" onClick={() => void applyExample(t(e.text), ["chat"], e.pattern)}>{t(e.label)}</button>)}
        </div>
        <p className="muted small">{kind === "jev" ? t("jevBlurb") : t("kwBlurb")}</p>
        {error && <div className="error">{error}</div>}
      </div>
      <ul className="rule-list">
        {rules.map((r) => <RuleItem key={r.id} r={r} qs={questions?.questions.filter((q) => q.ruleId === r.id) ?? []} compiling={compiling} />)}
      </ul>
    </div>
  );
});
