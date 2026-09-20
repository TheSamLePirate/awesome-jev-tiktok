import { useEffect, useMemo, useState } from "react";
import type { PublicSettings } from "@shared/protocol";
import { api } from "../useSocket";
import { Kbd } from "./ui";

type Sec = "tiktok" | "keys" | "models" | "timing" | "decisions" | "autoRefine" | "media" | "glm";
type Draft = Record<Sec, Record<string, string | number | boolean>>;

interface FieldDef { sec: Sec; key: string; label: string; help: string; type: "text" | "secret" | "number" | "bool" | "select" | "range"; unit?: string; min?: number; max?: number; step?: number; options?: string[]; fmt?: (v: number) => string }
interface Section { id: Sec; title: string; icon: string; blurb: string; fields: FieldDef[] }

const ms = (v: number) => (v >= 60_000 ? `${(v / 60_000).toFixed(v % 60_000 ? 1 : 0)} min` : v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `${v} ms`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

const SECTIONS: Section[] = [
  { id: "tiktok", title: "TikTok", icon: "🎬", blurb: "Which live to watch. Reading a live needs no login; the session id only helps with rate limits.", fields: [
    { sec: "tiktok", key: "username", label: "Username", help: "The @handle of the streamer. Used by Connect when the field in the header is empty.", type: "text" },
    { sec: "tiktok", key: "sessionId", label: "Session id", help: "Optional TikTok `sessionid` cookie. Stored on this machine only.", type: "secret" },
  ] },
  { id: "keys", title: "API keys", icon: "🔑", blurb: "Secrets are stored in runtime/settings.json on this machine and never sent to the browser in full.", fields: [
    { sec: "keys", key: "openrouter", label: "OpenRouter", help: "Pays for jev, GLM and vision. Applies to the next call immediately.", type: "secret" },
    { sec: "keys", key: "deepgram", label: "Deepgram", help: "Live speech-to-text. Applied on the next stream connection.", type: "secret" },
  ] },
  { id: "models", title: "Models", icon: "🧠", blurb: "jev makes the decisions. GLM writes the questions. The vision model captions frames. All via OpenRouter, except Deepgram.", fields: [
    { sec: "models", key: "jev", label: "jev (decisions)", help: "TypeSafe System One model id on OpenRouter.", type: "select", options: ["typesafe/jev-1.13"] },
    { sec: "models", key: "glm", label: "GLM (prompt writer)", help: "Writes and rewrites jev questions. Only called when rules change or feedback arrives.", type: "select", options: ["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flashx", "z-ai/glm-5.3", "z-ai/glm-5.2", "z-ai/glm-4.7-flash"] },
    { sec: "models", key: "vision", label: "Vision (captions)", help: "Describes a video frame as text so jev can reason about the picture.", type: "select", options: ["z-ai/glm-4.6v", "z-ai/glm-4.5v", "z-ai/glm-5v-turbo", "google/gemini-2.5-flash-lite", "google/gemini-3.1-flash-lite"] },
    { sec: "models", key: "deepgram", label: "Deepgram model", help: "nova-3 handles multilingual audio best.", type: "select", options: ["nova-3", "nova-2", "nova-3-general"] },
    { sec: "models", key: "language", label: "Speech language", help: "`multi` auto-detects and can switch mid-sentence. Set a code like `fr` or `en` for a single-language stream.", type: "select", options: ["multi", "fr", "en", "es", "de", "it", "pt", "nl", "ja", "ko", "zh"] },
  ] },
  { id: "timing", title: "Timing", icon: "⏱", blurb: "The rhythm of the loop. Faster ticks cost proportionally more; jev itself answers in ~300–500 ms.", fields: [
    { sec: "timing", key: "tickMs", label: "jev tick", help: "How often the room questions are asked.", type: "range", min: 250, max: 10_000, step: 250, fmt: ms },
    { sec: "timing", key: "captionEveryMs", label: "Vision caption", help: "How often a frame is described. This is the most expensive call per minute.", type: "range", min: 1000, max: 60_000, step: 1000, fmt: ms },
    { sec: "timing", key: "windowMs", label: "Window", help: "How much recent transcript and chat jev sees on each tick.", type: "range", min: 5000, max: 120_000, step: 5000, fmt: ms },
    { sec: "timing", key: "highlightGapMs", label: "Highlight gap", help: "Minimum time between two flags of the same room question.", type: "range", min: 0, max: 600_000, step: 10_000, fmt: ms },
    { sec: "timing", key: "excerptMs", label: "Excerpt", help: "How much host speech is attached to a flagged moment.", type: "range", min: 2000, max: 60_000, step: 1000, fmt: ms },
    { sec: "timing", key: "toastMs", label: "Toast", help: "How long a new-flag notification stays on screen.", type: "range", min: 1000, max: 20_000, step: 500, fmt: ms },
  ] },
  { id: "decisions", title: "Decisions", icon: "◎", blurb: "How answers become alerts.", fields: [
    { sec: "decisions", key: "fireConfidenceFloor", label: "Confidence floor", help: "Choice and score alerts only fire when jev's confidence is at least this. Noul alerts use their own probability threshold.", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "decisions", key: "unsureBelow", label: "Unsure below", help: "Gauges are drawn dashed under this confidence, and the sample is kept for auto-refine.", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "decisions", key: "judgeMessages", label: "Judge chat messages", help: "Run the per-message questions on every incoming chat message.", type: "bool" },
    { sec: "decisions", key: "messageConcurrency", label: "Message concurrency", help: "Parallel jev calls for chat messages. Applied on the next connection.", type: "number", min: 1, max: 16, step: 1 },
  ] },
  { id: "autoRefine", title: "Auto-refine", icon: "✎", blurb: "When jev stays unsure about a question, GLM rewrites it without you.", fields: [
    { sec: "autoRefine", key: "enabled", label: "Enabled", help: "Turn the watchdog on or off.", type: "bool" },
    { sec: "autoRefine", key: "emaBelow", label: "Trigger below", help: "Moving average of confidence that triggers a rewrite.", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "autoRefine", key: "minSamples", label: "Min samples", help: "Uncertain states to collect before asking GLM.", type: "number", min: 1, max: 20, step: 1 },
    { sec: "autoRefine", key: "cooldownMs", label: "Cooldown", help: "Minimum time between two rewrites of the same question.", type: "range", min: 10_000, max: 1_800_000, step: 10_000, fmt: ms },
    { sec: "autoRefine", key: "intervalMs", label: "Check every", help: "How often the watchdog looks at question health.", type: "range", min: 5000, max: 300_000, step: 5000, fmt: ms },
  ] },
  { id: "media", title: "Media", icon: "🎥", blurb: "What ffmpeg extracts from the stream. Applied on the next connection.", fields: [
    { sec: "media", key: "transcription", label: "Transcription", help: "Send audio to Deepgram.", type: "bool" },
    { sec: "media", key: "vision", label: "Vision captions", help: "Extract frames and caption them.", type: "bool" },
    { sec: "media", key: "hls", label: "Video in browser", help: "Write HLS segments for the player. Disable to save disk and CPU.", type: "bool" },
    { sec: "media", key: "frameWidth", label: "Frame width", help: "Pixels. Smaller frames are cheaper to caption.", type: "range", min: 128, max: 1280, step: 64, fmt: (v) => `${v} px` },
    { sec: "media", key: "frameEverySec", label: "Frame every", help: "How often ffmpeg refreshes the frame on disk (captioning has its own period).", type: "range", min: 0.5, max: 30, step: 0.5, fmt: (v) => `${v} s` },
    { sec: "media", key: "audioKeepAlive", label: "Deepgram keep-alive", help: "Ping the socket during silence so it is not closed.", type: "bool" },
  ] },
  { id: "glm", title: "GLM", icon: "🛠", blurb: "Generation parameters for the prompt writer.", fields: [
    { sec: "glm", key: "temperature", label: "Temperature", help: "Lower is more literal. 0.3 is a good default for schema-bound output.", type: "range", min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { sec: "glm", key: "maxTokens", label: "Max tokens", help: "Ceiling for one GLM answer, reasoning included.", type: "number", min: 256, max: 32_000, step: 256 },
  ] },
];

const toDraft = (s: PublicSettings): Draft => ({ tiktok: { ...s.tiktok }, keys: { ...s.keys }, models: { ...s.models }, timing: { ...s.timing }, decisions: { ...s.decisions }, autoRefine: { ...s.autoRefine }, media: { ...s.media }, glm: { ...s.glm } });

function Field({ f, value, onChange, dirty, reconnect, test }: { f: FieldDef; value: string | number | boolean; onChange: (v: string | number | boolean) => void; dirty: boolean; reconnect: boolean; test?: () => void }) {
  const [reveal, setReveal] = useState(false);
  const id = `set-${f.sec}-${f.key}`;
  return (
    <div className={`field ${dirty ? "dirty" : ""}`}>
      <div className="field-head">
        <label htmlFor={id}>{f.label}</label>
        {reconnect && <span className="badge mod" title="applies on the next stream connection">reconnect</span>}
        {dirty && <span className="badge add">unsaved</span>}
        <span className="grow" />
        {f.type === "range" && <span className="mono field-val">{f.fmt ? f.fmt(Number(value)) : String(value)}</span>}
      </div>
      {f.type === "text" && <input id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} />}
      {f.type === "secret" && (
        <div className="secret">
          <input id={id} type={reveal ? "text" : "password"} value={String(value)} onChange={(e) => onChange(e.target.value)} placeholder="not set" autoComplete="off" spellCheck={false} onFocus={(e) => { if (String(value).startsWith("••••")) { onChange(""); e.currentTarget.value = ""; } }} />
          <button type="button" className="icon" onClick={() => setReveal((v) => !v)} title={reveal ? "hide" : "show"}>{reveal ? "🙈" : "👁"}</button>
          {test && <button type="button" className="icon" onClick={test} title="test this key">test</button>}
        </div>
      )}
      {f.type === "number" && <input id={id} type="number" value={Number(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(Number(e.target.value))} />}
      {f.type === "range" && <input id={id} type="range" value={Number(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(Number(e.target.value))} />}
      {f.type === "bool" && <label className="switch"><input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /><span className="track" /><span className="switch-label">{Boolean(value) ? "on" : "off"}</span></label>}
      {f.type === "select" && (
        <>
          <input id={id} list={`${id}-opts`} value={String(value)} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          <datalist id={`${id}-opts`}>{(f.options ?? []).map((o) => <option key={o} value={o} />)}</datalist>
        </>
      )}
      <p className="field-help">{f.help}</p>
    </div>
  );
}

export function SettingsPanel({ settings, live, sound, setSound, muted, setMuted }: { settings: PublicSettings | null; live: boolean; sound: boolean; setSound: (v: boolean) => void; muted: boolean; setMuted: (v: boolean) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<PublicSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [active, setActive] = useState<Sec>("tiktok");

  // Adopt server settings when they change and there is nothing unsaved.
  useEffect(() => {
    if (!settings) return;
    if (!draft || !base || JSON.stringify(toDraft(base)) === JSON.stringify(draft)) { setDraft(toDraft(settings)); setBase(settings); }
    else setBase(settings);
  }, [settings]);

  const dirtyKeys = useMemo(() => {
    if (!draft || !base) return new Set<string>();
    const b = toDraft(base);
    const d = new Set<string>();
    for (const sec of Object.keys(draft) as Sec[]) for (const k of Object.keys(draft[sec])) if (draft[sec][k] !== b[sec][k]) d.add(`${sec}.${k}`);
    return d;
  }, [draft, base]);
  const patch = useMemo(() => {
    if (!draft) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const key of dirtyKeys) { const [sec, k] = key.split(".") as [Sec, string]; (out[sec] ??= {})[k] = draft[sec][k]; }
    return out;
  }, [draft, dirtyKeys]);
  const needsReconnect = [...dirtyKeys].some((k) => settings?.reconnectFields.includes(k)) && live;

  const save = async () => {
    if (!dirtyKeys.size) return;
    setSaving(true); setMsg(null);
    const r = await api.saveSettings(patch);
    setSaving(false);
    if (r.ok) { setBase(r.settings); setDraft(toDraft(r.settings)); setMsg({ ok: true, text: `Saved ${dirtyKeys.size} setting${dirtyKeys.size > 1 ? "s" : ""}${needsReconnect ? " · reconnect the stream to apply the media changes" : ""}` }); }
    else setMsg({ ok: false, text: r.error ?? "save failed" });
  };
  const discard = () => { if (base) setDraft(toDraft(base)); setMsg(null); };
  const reset = async () => {
    if (!window.confirm("Reset every setting to the .env defaults? Keys typed here will be replaced by the .env values.")) return;
    const r = await api.resetSettings();
    if (r.ok) { setBase(r.settings); setDraft(toDraft(r.settings)); setMsg({ ok: true, text: "Reset to defaults" }); }
  };
  const test = async (which: "openrouter" | "deepgram" | "models") => {
    setTests((t) => ({ ...t, [which]: { ok: true, text: "testing…" } }));
    const value = which === "models" ? undefined : String(draft?.keys[which] ?? "");
    const r = await api.testSetting(which, value);
    setTests((t) => ({ ...t, [which]: { ok: r.ok, text: `${r.ok ? "✓" : "✗"} ${r.detail ?? ""}${r.ms ? ` · ${r.ms} ms` : ""}` } }));
  };
  const exportJson = () => {
    if (!base) return;
    const { keys: _k, tiktok, secrets: _s, reconnectFields: _r, updatedAt: _u, ...rest } = base;
    const blob = new Blob([JSON.stringify({ ...rest, tiktok: { username: tiktok.username } }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "awesome-jev-settings.json"; a.click(); URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try { const j = JSON.parse(await file.text()); const r = await api.saveSettings(j); if (r.ok) { setBase(r.settings); setDraft(toDraft(r.settings)); setMsg({ ok: true, text: `Imported ${file.name}` }); } else setMsg({ ok: false, text: r.error ?? "import failed" }); }
    catch (e) { setMsg({ ok: false, text: `Import failed: ${(e as Error).message}` }); }
  };

  if (!draft || !settings) return <div className="empty">Loading settings…</div>;
  const set = (sec: Sec, k: string, v: string | number | boolean) => setDraft((d) => (d ? { ...d, [sec]: { ...d[sec], [k]: v } } : d));
  const dirtyIn = (sec: Sec) => [...dirtyKeys].filter((k) => k.startsWith(`${sec}.`)).length;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="settings sections">
        {SECTIONS.map((s) => <button key={s.id} className={active === s.id ? "on" : ""} onClick={() => { setActive(s.id); document.getElementById(`sec-${s.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}><span>{s.icon}</span>{s.title}{dirtyIn(s.id) ? <span className="count new">{dirtyIn(s.id)}</span> : null}</button>)}
        <button className={active === "ui" as any ? "on" : ""} onClick={() => { setActive("ui" as any); document.getElementById("sec-ui")?.scrollIntoView({ block: "start", behavior: "smooth" }); }}><span>🖥</span>This browser</button>
        <span className="grow" />
        <div className="settings-io">
          <button className="chip-btn" onClick={exportJson} title="download settings without secrets">⤓ export</button>
          <label className="chip-btn" title="upload a settings JSON">⤒ import<input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.currentTarget.value = ""; }} /></label>
          <button className="chip-btn danger" onClick={reset}>reset</button>
        </div>
      </nav>
      <div className="settings-body">
        {SECTIONS.map((s) => (
          <section key={s.id} id={`sec-${s.id}`} className="settings-section panel">
            <header className="settings-head"><span className="settings-icon">{s.icon}</span><div><h3>{s.title}</h3><p>{s.blurb}</p></div></header>
            <div className="fields">
              {s.fields.map((f) => (
                <Field key={f.key} f={f} value={draft[s.id][f.key]} onChange={(v) => set(s.id, f.key, v)} dirty={dirtyKeys.has(`${s.id}.${f.key}`)} reconnect={settings.reconnectFields.includes(`${s.id}.${f.key}`)}
                  test={f.type === "secret" && (f.key === "openrouter" || f.key === "deepgram") ? () => test(f.key as "openrouter" | "deepgram") : undefined} />
              ))}
              {s.id === "keys" && (["openrouter", "deepgram"] as const).map((k) => tests[k] && <div key={k} className={`test-result ${tests[k].ok ? "ok" : "bad"}`}>{k}: {tests[k].text}</div>)}
              {s.id === "models" && <div className="field-row"><button className="chip-btn" onClick={() => test("models")}>check model ids on OpenRouter</button>{tests.models && <span className={`test-result ${tests.models.ok ? "ok" : "bad"}`}>{tests.models.text}</span>}</div>}
            </div>
          </section>
        ))}
        <section id="sec-ui" className="settings-section panel">
          <header className="settings-head"><span className="settings-icon">🖥</span><div><h3>This browser</h3><p>Preferences stored locally, not on the server.</p></div></header>
          <div className="fields">
            <div className="field"><div className="field-head"><label>Alert chime</label></div><label className="switch"><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /><span className="track" /><span className="switch-label">{sound ? "on" : "off"}</span></label><p className="field-help">Play a short tone when a new flag arrives. Shortcut <Kbd k="s" />.</p></div>
            <div className="field"><div className="field-head"><label>Stream audio</label></div><label className="switch"><input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} /><span className="track" /><span className="switch-label">{muted ? "muted" : "playing"}</span></label><p className="field-help">Whether the video player plays sound. Shortcut <Kbd k="m" />.</p></div>
          </div>
        </section>
        <div className="settings-meta muted mono">last saved {new Date(settings.updatedAt).toLocaleString()} · stored in runtime/settings.json · .env values are the defaults</div>
      </div>
      <div className={`savebar ${dirtyKeys.size ? "show" : ""}`} role="status">
        <span>{dirtyKeys.size} unsaved change{dirtyKeys.size === 1 ? "" : "s"}{needsReconnect ? " · some apply after reconnect" : ""}</span>
        <span className="grow" />
        <button onClick={discard} disabled={saving}>Discard</button>
        <button className="primary" onClick={save} disabled={saving || !dirtyKeys.size}>{saving ? <><span className="spinner sm" /> Saving</> : "Save"}</button>
      </div>
      {msg && !dirtyKeys.size && <div className={`savemsg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
    </div>
  );
}
