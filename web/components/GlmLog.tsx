import type { GlmActivity } from "@shared/protocol";

export function GlmLog({ items }: { items: GlmActivity[] }) {
  return (
    <div className="glm-log">
      {[...items].reverse().slice(0, 20).map((a) => (
        <div key={a.id} className={`glm-item ${a.status}`}>
          <span className="chip">{a.kind}</span>
          <span className={`dot ${a.status}`} />
          <span>{a.summary}</span>
          {a.tokens ? <span className="muted"> · {a.tokens} tok</span> : null}
        </div>
      ))}
      {items.length === 0 && <div className="muted">GLM is idle. It only wakes up when you add a rule, disagree with an answer, or jev stays unsure.</div>}
    </div>
  );
}
