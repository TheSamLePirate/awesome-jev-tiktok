import type { GlmActivity } from "@shared/protocol";
import { ago, fmtTime, useNow } from "./ui";

export function GlmLog({ items }: { items: GlmActivity[] }) {
  const now = useNow(5000);
  return (
    <div className="glm-log">
      {[...items].reverse().slice(0, 30).map((a) => (
        <div key={a.id} className={`glm-item ${a.status}`}>
          <span className={`dot ${a.status}`} />
          <div className="glm-body">
            <div className="glm-head"><span className="chip">{a.kind}</span><span className="muted mono" title={fmtTime(a.ts)}>{ago(a.ts, now)} ago</span>{a.tokens ? <span className="muted mono">{a.tokens} tok</span> : null}</div>
            <div className="glm-summary">{a.summary}</div>
          </div>
        </div>
      ))}
      {items.length === 0 && <div className="empty">GLM is idle.<br /><span className="muted">It wakes up when you add a rule, disagree with an answer, or jev stays unsure.</span></div>}
    </div>
  );
}
