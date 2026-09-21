import { memo, useMemo, useState } from "react";
import type { QuestionSet, WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { toast } from "../lib/store";
import { confirm } from "./Dialog";
import { ago, fmtTime, useNow } from "./ui";
import { tr, useT } from "../i18n";
import { COMMON } from "../i18n/common";

const M = {
  en: {
    instructions: "instructions", criteria: "criteria", added: "added", removed: "removed",
    restoreTitle: "Restore version {v}?", restoreBody: "The questions of that version become a new version (history stays intact). Questions of rules deleted since are not resurrected.", restore: "Restore", restored: "Restored v{v} as a new version",
    from: " (from v{v})", restoreThis: "↺ restore this version", unchanged: "{n} questions: {list}",
  },
  fr: {
    instructions: "instructions", criteria: "critères", added: "ajoutée", removed: "supprimée",
    restoreTitle: "Restaurer la version {v} ?", restoreBody: "Les questions de cette version deviennent une nouvelle version (l'historique reste intact). Les questions des règles supprimées depuis ne sont pas ressuscitées.", restore: "Restaurer", restored: "v{v} restaurée comme nouvelle version",
    from: " (depuis la v{v})", restoreThis: "↺ restaurer cette version", unchanged: "{n} questions : {list}",
  },
};
const tc = tr(COMMON);

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const criteriaLines = (q: WatchQuestion): string[] => {
  const c = q.question;
  if (c.type === "choice") return Object.entries(c.criteria).map(([k, v]) => `${k}: ${text(v)}`);
  if (c.type === "score") return c.criteria.map((v, i) => `${i}: ${text(v)}`);
  return [c.criteria?.true ? `${tc("yes")}: ${text(c.criteria.true)}` : "", c.criteria?.false ? `${tc("no")}: ${text(c.criteria.false)}` : ""].filter(Boolean);
};

function Field({ name, before, after }: { name: string; before?: string; after?: string }) {
  if (before === after) return null;
  return (
    <div className="diff-field">
      <div className="diff-name">{name}</div>
      {before !== undefined && <div className="diff del">− {before}</div>}
      {after !== undefined && <div className="diff add">+ {after}</div>}
    </div>
  );
}

function ChangedQuestion({ before, after }: { before?: WatchQuestion; after?: WatchQuestion }) {
  const t = useT(M);
  const q = after ?? before!;
  const bi = before ? text(before.question.instructions) : undefined, ai = after ? text(after.question.instructions) : undefined;
  const bc = before ? criteriaLines(before) : [], ac = after ? criteriaLines(after) : [];
  const n = Math.max(bc.length, ac.length);
  return (
    <div className="diff-q">
      <div className="diff-q-head"><span className="chip">{q.question.type}</span><b>{q.label}</b> <span className="muted">{q.id}</span>{!before && <span className="badge add">{t("added")}</span>}{!after && <span className="badge del">{t("removed")}</span>}</div>
      <Field name={t("instructions")} before={bi} after={ai} />
      {Array.from({ length: n }, (_, i) => <Field key={i} name={i === 0 ? t("criteria") : ""} before={bc[i]} after={ac[i]} />)}
    </div>
  );
}

interface Diff { set: QuestionSet; prev: Map<string, WatchQuestion>; added: WatchQuestion[]; removed: WatchQuestion[]; changed: WatchQuestion[] }

export const Versions = memo(function Versions({ history }: { history: QuestionSet[] }) {
  const t = useT(M);
  const [open, setOpen] = useState<number | null>(history.at(-1)?.version ?? null);
  const now = useNow(10_000);
  // Diffs are computed once per history change, not once per render.
  const diffs = useMemo<Diff[]>(() => [...history].reverse().map((set, i) => {
    const prev = history[history.length - 2 - i];
    const p = new Map((prev?.questions ?? []).map((q) => [q.id, q]));
    const c = new Map(set.questions.map((q) => [q.id, q]));
    const key = (q: WatchQuestion) => JSON.stringify(q);
    return { set, prev: p, added: set.questions.filter((q) => !p.has(q.id)), removed: (prev?.questions ?? []).filter((q) => !c.has(q.id)), changed: set.questions.filter((q) => p.has(q.id) && key(p.get(q.id)!) !== key(q)) };
  }), [history]);
  const latest = history.at(-1)?.version;
  const restore = async (v: number) => {
    if (!(await confirm({ title: t("restoreTitle", { v }), body: t("restoreBody"), confirmLabel: t("restore") }))) return;
    try { await api.restoreVersion(v); toast({ kind: "info", title: t("restored", { v }) }); } catch { /* toasted */ }
  };
  return (
    <div className="versions">
      {diffs.map(({ set, prev, added, removed, changed }) => {
        const isOpen = open === set.version;
        return (
          <div key={set.version} className={`version ${isOpen ? "open" : ""}`}>
            <button className="version-head" onClick={() => setOpen(isOpen ? null : set.version)} aria-expanded={isOpen}>
              <span className="chip v">v{set.version}</span>
              <span className="version-reason">{set.reason}{set.restoredFrom !== undefined && <span className="muted">{t("from", { v: set.restoredFrom })}</span>}</span>
              <span className="version-meta">
                {added.length > 0 && <span className="badge add">+{added.length}</span>}
                {changed.length > 0 && <span className="badge mod">~{changed.length}</span>}
                {removed.length > 0 && <span className="badge del">−{removed.length}</span>}
                <span className="muted mono" title={fmtTime(set.createdAt)}>{ago(set.createdAt, now)}</span>
              </span>
            </button>
            {isOpen && (
              <div className="version-body">
                {set.version !== latest && <div className="row"><button className="chip-btn" onClick={() => restore(set.version)}>{t("restoreThis")}</button></div>}
                {added.map((q) => <ChangedQuestion key={q.id} after={q} />)}
                {changed.map((q) => <ChangedQuestion key={q.id} before={prev.get(q.id)} after={q} />)}
                {removed.map((q) => <ChangedQuestion key={q.id} before={q} />)}
                {!added.length && !changed.length && !removed.length && <div className="muted">{t("unchanged", { n: set.questions.length, list: set.questions.map((q) => q.label).join(", ") })}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
