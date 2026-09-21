import { memo, useCallback, useMemo, useState } from "react";
import type { Decision, JevAnswer, Snapshot, WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { confidenceOf } from "../lib/format";
import { prompt } from "./Dialog";
import { Ring, SourceBadges, Spark, pct, useTween } from "./ui";
import { getState, toast } from "../lib/store";
import { useT } from "../i18n";
import { COMMON } from "../i18n/common";

const M = {
  en: {
    yes: "{p} yes", probYes: "{p} probability of yes", firesAt: " · fires at {p}",
    fewer: "fewer", more: "+{n} more", scoreOf: "score {score} of {max}",
    answered: "\"{label}\" answered {value}", body: "Tell GLM what jev should have answered and why. It rewrites the question with your note as evidence.",
    placeholder: "What should the answer have been, and why?", sendRewrite: "Send and rewrite",
    wrong: "This answer is wrong", missed: "It should have fired and did not", correct: "Correct (just record it)", verdict: "Verdict",
    rewrote: "GLM rewrote \"{label}\"", recorded: "Feedback recorded",
    firing: "firing", notEvaluated: "not evaluated", quiet: "quiet", localRule: "local rule: no jev call", confidence: "confidence {p}",
    disagreeTitle: "Disagree · GLM rewrites this question", disagree: "disagree with {label}",
    paused: "rule paused", skipped: "not evaluated this tick (source failed or budget)",
    noRules: "No room rules yet. Add one in {rules}.", rules: "Rules",
  },
  fr: {
    yes: "{p} oui", probYes: "{p} de probabilité de oui", firesAt: " · se déclenche à {p}",
    fewer: "moins", more: "+{n} de plus", scoreOf: "score {score} sur {max}",
    answered: "« {label} » a répondu {value}", body: "Dis à GLM ce que jev aurait dû répondre et pourquoi. Il réécrit la question avec ta note comme preuve.",
    placeholder: "Quelle aurait dû être la réponse, et pourquoi ?", sendRewrite: "Envoyer et réécrire",
    wrong: "Cette réponse est fausse", missed: "Ça aurait dû se déclencher et ne l'a pas fait", correct: "Correct (juste l'enregistrer)", verdict: "Verdict",
    rewrote: "GLM a réécrit « {label} »", recorded: "Avis enregistré",
    firing: "déclenchée", notEvaluated: "non évaluée", quiet: "calme", localRule: "règle locale : aucun appel à jev", confidence: "confiance {p}",
    disagreeTitle: "Pas d'accord · GLM réécrit cette question", disagree: "pas d'accord avec {label}",
    paused: "règle en pause", skipped: "non évaluée à ce tick (source en panne ou budget)",
    noRules: "Pas encore de règle de salle. Ajoutes-en une dans {rules}.", rules: "Règles",
  },
};

/** Yes/no probability: hero number, single-hue track, threshold tick where the alert fires. */
function Noul({ a, threshold }: { a: Extract<JevAnswer, { type: "noul" }>; threshold?: number }) {
  const t = useT(M);
  const v = useTween(a.noul);
  return (
    <div className="g-noul">
      <div className="g-hero" aria-label={t("yes", { p: pct(a.noul) })}>{Math.round(v * 100)}<span className="g-unit">%</span></div>
      <div className="g-track" title={`${t("probYes", { p: pct(a.noul) })}${threshold !== undefined ? t("firesAt", { p: pct(threshold) }) : ""}`}>
        <span className="g-fill" style={{ width: `${v * 100}%` }} />
        {threshold !== undefined && <span className="g-tick" style={{ left: `${threshold * 100}%` }} />}
      </div>
    </div>
  );
}

/** One option wins: ranked thin bars, winner in ink, others muted. Beyond 3, the rest are folded behind a toggle. */
const CHOICE_ROWS = 3;
function Choice({ a }: { a: Extract<JevAnswer, { type: "choice" }> }) {
  const t = useT(M);
  const [all, setAll] = useState(false);
  const rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const shown = all ? rows : rows.slice(0, CHOICE_ROWS);
  return (
    <div className="g-rows">
      {shown.map(([k, p]) => (
        <div key={k} className={`g-row ${k === a.choice ? "pick" : ""}`} title={`${k.replace(/_/g, " ")}: ${pct(p)}`}>
          <span className="g-row-label">{k.replace(/_/g, " ")}</span>
          <span className="g-track thin"><span className="g-fill" style={{ width: pct(p) }} /></span>
          <span className="g-row-val">{pct(p)}</span>
        </div>
      ))}
      {rows.length > CHOICE_ROWS && <button className="icon g-more" onClick={() => setAll((v) => !v)}>{all ? t("fewer") : t("more", { n: rows.length - CHOICE_ROWS })}</button>}
    </div>
  );
}

/** Ordered levels: a segmented meter with a marker at the (interpolated) score. */
function Score({ a }: { a: Extract<JevAnswer, { type: "score" }> }) {
  const t = useT(M);
  const levels = Object.entries(a.legend).sort((x, y) => Number(x[0]) - Number(y[0]));
  const n = levels.length;
  const v = useTween(a.score);
  const pos = n > 1 ? (v / (n - 1)) * 100 : 0;
  const current = levels[Math.round(a.score)]?.[1] ?? "";
  return (
    <div className="g-score" title={t("scoreOf", { score: a.score.toFixed(2), max: n - 1 })}>
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
  const t = useT(M), tc = useT(COMMON);
  const [busy, setBusy] = useState(false);
  const disagree = useCallback(async () => {
    if (!answer) return;
    const r = await prompt({ title: t("answered", { label: q.label, value: answer.type === "noul" ? pct(answer.noul) : answer.type === "choice" ? answer.choice : answer.score.toFixed(1) }), body: t("body"), placeholder: t("placeholder"), confirmLabel: t("sendRewrite"), choices: [{ value: "wrong", label: t("wrong") }, { value: "missed", label: t("missed") }, { value: "correct", label: t("correct") }], choiceLabel: t("verdict") });
    if (!r) return;
    setBusy(true);
    try {
      const snapshot: Snapshot | null = getState().snapshot;
      const res = await api.feedback({ questionId: q.id, verdict: r.choice ?? "wrong", answer, note: r.text || undefined, expected: r.text || undefined, stateExcerpt: snapshot ? { transcript: snapshot.transcript_last_30s.slice(-500), chat: snapshot.chat_recent.slice(-6), scene: snapshot.scene, activity: snapshot.activity } : null });
      toast({ kind: "info", title: res.rewritten ? t("rewrote", { label: q.label }) : t("recorded") });
    } catch { /* toasted by the api layer */ }
    finally { setBusy(false); }
  }, [q.id, q.label, answer, t]);
  const conf = answer ? confidenceOf(answer) : 0;
  const instructions = typeof q.question.instructions === "string" ? q.question.instructions : JSON.stringify(q.question.instructions);
  const max = answer?.type === "score" ? Math.max(1, Object.keys(answer.legend).length - 1) : 1;
  return (
    // Three subgrid rows (head / value / trend) that line up across the cards of a row; the question text lives in the tooltip.
    <article className={`gauge ${fired ? "fired" : ""} ${answer && conf < unsureBelow ? "unsure" : ""} ${skipped || paused ? "skipped" : ""}`} aria-label={`${q.label}: ${fired ? t("firing") : skipped ? t("notEvaluated") : t("quiet")}`} title={instructions}>
      <header className="gauge-head">
        <span className="gauge-label">{q.label}</span>
        <SourceBadges sources={q.sources} compact />
        {q.local && <span className="chip" title={t("localRule")}>{tc("local")}</span>}
        {fired && <span className="fire-badge">{t("firing")}</span>}
        <span className="grow" />
        {answer && !q.local && <Ring value={conf} size={18} title={t("confidence", { p: pct(conf) })} />}
        {!q.local && <button className="icon" disabled={!answer || busy} onClick={disagree} title={t("disagreeTitle")} aria-label={t("disagree", { label: q.label })}>{busy ? "…" : "👎"}</button>}
      </header>
      <div className="gauge-body">
        {!answer && !skipped && !paused && <div className="skeleton" />}
        {paused && <div className="g-note">{t("paused")}</div>}
        {!paused && skipped && <div className="g-note warn">{t("skipped")}</div>}
        {answer?.type === "noul" && <Noul a={answer} threshold={q.alert?.noulAbove} />}
        {answer?.type === "choice" && <Choice a={answer} />}
        {answer?.type === "score" && <Score a={answer} />}
      </div>
      <footer className="gauge-foot">
        <Spark values={history} max={max} h={16} stretch />
        <span className="gauge-type">{q.local ? "regex" : q.question.type}</span>
      </footer>
    </article>
  );
});

export const Gauges = memo(function Gauges({ questions, decisions, pausedRuleIds, unsureBelow, live }: { questions: WatchQuestion[]; decisions: Decision[]; pausedRuleIds: Set<string>; unsureBelow: number; live: boolean }) {
  const t = useT(M);
  const last = decisions.at(-1);
  // Series per question, computed once per decisions change (not once per gauge per render).
  const series = useMemo(() => {
    const out: Record<string, number[]> = {};
    const recent = decisions.slice(-60);
    for (const q of questions) out[q.id] = recent.map((d) => { const a = d.answers[q.id]; return !a ? 0 : a.type === "noul" ? a.noul : a.type === "score" ? a.score : a.confidence; });
    return out;
  }, [decisions, questions]);
  if (questions.length === 0) { const [before, after] = t("noRules", { rules: " " }).split(" "); return <div className="empty">{before}<b>{t("rules")}</b>{after}</div>; }
  return (
    <div className="gauges">
      {questions.map((q) => <Gauge key={q.id} q={q} answer={last?.answers[q.id]} history={series[q.id]} fired={last?.fired.includes(q.id) ?? false} skipped={live && (last?.skipped?.includes(q.id) ?? false)} paused={pausedRuleIds.has(q.ruleId)} unsureBelow={unsureBelow} />)}
    </div>
  );
});
