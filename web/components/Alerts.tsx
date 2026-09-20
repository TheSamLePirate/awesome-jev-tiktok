import type { WatchQuestion } from "@shared/protocol";
import type { Alert } from "../useSocket";
import { fmtTime, SourceBadges } from "./ui";

export function Alerts({ alerts, questions }: { alerts: Alert[]; questions: WatchQuestion[] }) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return (
    <div className="alerts">
      {[...alerts].reverse().slice(0, 12).map((a) => {
        const q = byId.get(a.questionId);
        return (
          <div key={a.id} className={`alert ${a.kind}`}>
            <span className="alert-time">{fmtTime(a.ts)}</span>
            {q && <SourceBadges sources={q.sources} compact />}
            <span className="alert-label">{q?.label ?? a.questionId}</span>
            {a.detail && <span className="alert-detail">{a.detail}</span>}
          </div>
        );
      })}
      {alerts.length === 0 && <div className="empty">Nothing fired yet.</div>}
    </div>
  );
}
