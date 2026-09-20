import { useState } from "react";
import type { QuestionSet, WatchQuestion } from "@shared/protocol";
import { ago, fmtTime, useNow } from "./ui";

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const criteriaLines = (q: WatchQuestion): string[] => {
  const c = q.question;
  if (c.type === "choice") return Object.entries(c.criteria).map(([k, v]) => `${k}: ${text(v)}`);
  if (c.type === "score") return c.criteria.map((v, i) => `${i}: ${text(v)}`);
  return [c.criteria?.true ? `yes: ${text(c.criteria.true)}` : "", c.criteria?.false ? `no: ${text(c.criteria.false)}` : ""].filter(Boolean);
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
  const q = after ?? before!;
  const bi = before ? text(before.question.instructions) : undefined, ai = after ? text(after.question.instructions) : undefined;
  const bc = before ? criteriaLines(before) : [], ac = after ? criteriaLines(after) : [];
  const n = Math.max(bc.length, ac.length);
  return (
    <div className="diff-q">
      <div className="diff-q-head"><span className="chip">{q.question.type}</span><b>{q.label}</b> <span className="muted">{q.id}</span>{!before && <span className="badge add">added</span>}{!after && <span className="badge del">removed</span>}</div>
      <Field name="instructions" before={bi} after={ai} />
      {Array.from({ length: n }, (_, i) => <Field key={i} name={i === 0 ? "criteria" : ""} before={bc[i]} after={ac[i]} />)}
    </div>
  );
}

export function Versions({ history }: { history: QuestionSet[] }) {
  const [open, setOpen] = useState<number | null>(history.at(-1)?.version ?? null);
  const now = useNow(10_000);
  return (
    <div className="versions">
      {[...history].reverse().map((set, i) => {
        const prev = history[history.length - 2 - i];
        const p = new Map((prev?.questions ?? []).map((q) => [q.id, q]));
        const c = new Map(set.questions.map((q) => [q.id, q]));
        const added = set.questions.filter((q) => !p.has(q.id));
        const removed = (prev?.questions ?? []).filter((q) => !c.has(q.id));
        const changed = set.questions.filter((q) => p.has(q.id) && JSON.stringify(p.get(q.id)) !== JSON.stringify(q));
        const isOpen = open === set.version;
        return (
          <div key={set.version} className={`version ${isOpen ? "open" : ""}`}>
            <button className="version-head" onClick={() => setOpen(isOpen ? null : set.version)} aria-expanded={isOpen}>
              <span className="chip v">v{set.version}</span>
              <span className="version-reason">{set.reason}</span>
              <span className="version-meta">
                {added.length > 0 && <span className="badge add">+{added.length}</span>}
                {changed.length > 0 && <span className="badge mod">~{changed.length}</span>}
                {removed.length > 0 && <span className="badge del">−{removed.length}</span>}
                <span className="muted mono" title={fmtTime(set.createdAt)}>{ago(set.createdAt, now)}</span>
              </span>
            </button>
            {isOpen && (
              <div className="version-body">
                {added.map((q) => <ChangedQuestion key={q.id} after={q} />)}
                {changed.map((q) => <ChangedQuestion key={q.id} before={p.get(q.id)} after={q} />)}
                {removed.map((q) => <ChangedQuestion key={q.id} before={q} />)}
                {!added.length && !changed.length && !removed.length && <div className="muted">{set.questions.length} questions: {set.questions.map((q) => q.label).join(", ")}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
