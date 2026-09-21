import { memo } from "react";
import type { GlmActivity } from "@shared/protocol";
import { ago, fmtTime, useNow } from "./ui";
import { useT } from "../i18n";

const M = {
  en: { ago: "{ago} ago", idle: "GLM is idle.", idleHint: "It wakes up when you add a rule or rate a flag as wrong. Auto-refine is off unless enabled in Settings." },
  fr: { ago: "il y a {ago}", idle: "GLM est au repos.", idleHint: "Il se réveille quand tu ajoutes une règle ou juges un signalement erroné. L'auto-affinage est désactivé sauf activation dans les réglages." },
};

export const GlmLog = memo(function GlmLog({ items }: { items: GlmActivity[] }) {
  const t = useT(M);
  const now = useNow(5000);
  return (
    <div className="glm-log">
      {[...items].reverse().slice(0, 30).map((a) => (
        <div key={a.id} className={`glm-item ${a.status}`}>
          <span className={`dot ${a.status}`} />
          <div className="glm-body">
            <div className="glm-head"><span className="chip">{a.kind}</span><span className="muted mono" title={fmtTime(a.ts)}>{t("ago", { ago: ago(a.ts, now) })}</span>{a.tokens ? <span className="muted mono">{a.tokens} tok</span> : null}</div>
            <div className="glm-summary">{a.summary}</div>
          </div>
        </div>
      ))}
      {items.length === 0 && <div className="empty">{t("idle")}<br /><span className="muted">{t("idleHint")}</span></div>}
    </div>
  );
});
