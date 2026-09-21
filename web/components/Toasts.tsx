import { memo, useEffect } from "react";
import type { Highlight } from "@shared/protocol";
import { answerText } from "../lib/format";
import { dismissToast, useStore, type Toast } from "../lib/store";
import { tr, useT } from "../i18n";

const M = {
  en: { roomActivity: "room activity", open: "open in Flagged", watch: "watch this moment", dismiss: "dismiss" },
  fr: { roomActivity: "activité de la salle", open: "ouvrir dans Signalés", watch: "revoir ce moment", dismiss: "fermer" },
};
const tt = tr(M);

const bodyOf = (h: Highlight) => (h.message ? `${h.message.nickname || h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ").slice(-140) : h.scene?.text ?? tt("roomActivity"));

const Item = memo(function Item({ t, durationMs, onOpen, onWatch }: { t: Toast; durationMs: number; onOpen: (h: Highlight) => void; onWatch?: (ts: number) => void }) {
  const tx = useT(M);
  const life = t.durationMs ?? (t.kind === "error" ? Math.max(durationMs, 8000) : t.kind === "undo" ? 10_000 : durationMs);
  // One timer per toast, keyed on its id: re-renders of the console never restart it (W1).
  useEffect(() => { const timer = setTimeout(() => dismissToast(t.id), life); return () => clearTimeout(timer); }, [t.id, life]);
  const h = t.highlight;
  const cls = `toast ${t.kind} ${h?.kind ?? ""} ${t.severity === "warn" ? "warn" : ""}`;
  return (
    <div className={cls} role={t.kind === "error" ? "alert" : "status"}>
      {h ? (
        <button className="toast-main" onClick={() => onOpen(h)} title={tx("open")}>
          <div className="toast-head">{t.severity === "warn" ? "⚠ " : ""}{h.flags.map((f) => `${f.label} ${answerText(f.answer)}`).join(" · ")}</div>
          <div className="toast-body">{bodyOf(h)}</div>
        </button>
      ) : (
        <div className="toast-main static">
          <div className="toast-head">{t.title}</div>
          {t.body && <div className="toast-body">{t.body}</div>}
        </div>
      )}
      <div className="toast-side">
        {h && onWatch && <button className="icon" onClick={() => onWatch(h.ts)} title={tx("watch")} aria-label={tx("watch")}>⏪</button>}
        {t.action && <button className="chip-btn on" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
        <button className="icon" onClick={() => dismissToast(t.id)} aria-label={tx("dismiss")}>✕</button>
      </div>
      <span className="toast-bar" style={{ animationDuration: `${life}ms` }} />
    </div>
  );
});

export function Toasts({ onOpen, onWatch }: { onOpen: (h: Highlight) => void; onWatch?: (ts: number) => void }) {
  const toasts = useStore((s) => s.toasts);
  const durationMs = useStore((s) => s.settings?.timing.toastMs ?? 4500);
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => <Item key={t.id} t={t} durationMs={durationMs} onOpen={onOpen} onWatch={onWatch} />)}
    </div>
  );
}
