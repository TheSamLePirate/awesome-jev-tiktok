import { memo, useMemo } from "react";
import type { SocialEvent } from "../lib/store";
import { ago, useNow } from "./ui";
import { useT } from "../i18n";

const M = {
  en: { label: "gifts and social events", diamonds: "diamonds this session", followed: "followed", shared: "shared", joined: "joined" },
  fr: { label: "cadeaux et événements sociaux", diamonds: "diamants cette session", followed: "s'est abonné", shared: "a partagé", joined: "a rejoint" },
};

/** Gifts, follows, shares and joins, plus the top gifters of the session so far. Engagement, kept apart from moderation. */
export const EventsFeed = memo(function EventsFeed({ events }: { events: SocialEvent[] }) {
  const t = useT(M);
  const now = useNow(5000);
  const top = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) if (e.kind === "gift") m.set(e.handle, (m.get(e.handle) ?? 0) + e.diamonds * e.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [events]);
  // Newest first. A ticker shows the first few; the wide layout lists them vertically and scrolls.
  const recent = events.slice(-24).reverse();
  if (!events.length) return null;
  return (
    <div className="events" aria-label={t("label")}>
      {top.length > 0 && <div className="events-top">{top.map(([h, d]) => <span key={h} className="chip" title={t("diamonds")}>💎 {h} · {d}</span>)}</div>}
      <div className="events-list">
        {recent.map((e, i) => (
          <span key={`${e.ts}-${i}`} className={`ev ${e.kind}`}>
            {e.kind === "gift" ? `🎁 ${e.handle} · ${e.giftName}${e.count > 1 ? ` ×${e.count}` : ""}` : e.kind === "social" ? `${e.action === "follow" ? "➕" : e.action === "share" ? "🔁" : "✦"} ${e.handle} ${e.action === "follow" ? t("followed") : e.action === "share" ? t("shared") : ""}` : `👋 ${e.nickname || e.handle} ${t("joined")}`}
            <small>{ago(e.ts, now)}</small>
          </span>
        ))}
      </div>
    </div>
  );
});
