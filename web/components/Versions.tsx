import { useState } from "react";
import type { QuestionSet, WatchQuestion } from "@shared/protocol";

function diff(prev: QuestionSet | undefined, cur: QuestionSet): { added: WatchQuestion[]; removed: WatchQuestion[]; changed: { before: WatchQuestion; after: WatchQuestion }[] } {
  const p = new Map((prev?.questions ?? []).map((q) => [q.id, q]));
  const c = new Map(cur.questions.map((q) => [q.id, q]));
  const added = cur.questions.filter((q) => !p.has(q.id));
  const removed = (prev?.questions ?? []).filter((q) => !c.has(q.id));
  const changed = cur.questions.filter((q) => p.has(q.id) && JSON.stringify(p.get(q.id)) !== JSON.stringify(q)).map((q) => ({ before: p.get(q.id)!, after: q }));
  return { added, removed, changed };
}

export function Versions({ history }: { history: QuestionSet[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="versions">
      {[...history].reverse().map((set, i) => {
        const prev = history[history.length - 2 - i];
        const d = diff(prev, set);
        const isOpen = open === set.version;
        return (
          <div key={set.version} className="version">
            <div className="version-head" onClick={() => setOpen(isOpen ? null : set.version)}>
              <span className="chip">v{set.version}</span>
              <span className="version-reason">{set.reason}</span>
              <span className="muted">{d.added.length ? `+${d.added.length} ` : ""}{d.changed.length ? `~${d.changed.length} ` : ""}{d.removed.length ? `-${d.removed.length}` : ""}</span>
            </div>
            {isOpen && (
              <div className="version-body">
                {d.added.map((q) => <pre key={q.id} className="add">+ {JSON.stringify(q.question, null, 1)}</pre>)}
                {d.removed.map((q) => <pre key={q.id} className="del">- {q.id}</pre>)}
                {d.changed.map(({ before, after }) => (
                  <div key={after.id}>
                    <pre className="del">- {JSON.stringify(before.question, null, 1)}</pre>
                    <pre className="add">+ {JSON.stringify(after.question, null, 1)}</pre>
                  </div>
                ))}
                {!d.added.length && !d.changed.length && !d.removed.length && <pre>{JSON.stringify(set.questions.map((q) => q.id), null, 1)}</pre>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
