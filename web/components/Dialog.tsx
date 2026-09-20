import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * In-app modal dialogs on the native <dialog> element: focus trapped by the browser, Escape closes, styled, usable in OBS.
 * Imperative API: `await confirm({...})`, `await prompt({...})`; a cancel resolves to null / false and triggers nothing.
 */
export interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
export interface PromptOptions extends ConfirmOptions { placeholder?: string; initial?: string; multiline?: boolean; choices?: { value: string; label: string }[]; choiceLabel?: string }
export interface PromptResult { text: string; choice?: string }

type Pending =
  | { id: number; kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: "prompt"; opts: PromptOptions; resolve: (v: PromptResult | null) => void };

let current: Pending | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const set = (p: Pending | null) => { current = p; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const cancelCurrent = () => { if (!current) return; if (current.kind === "confirm") current.resolve(false); else current.resolve(null); };

export const confirm = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => { cancelCurrent(); set({ id: ++seq, kind: "confirm", opts, resolve }); });
export const prompt = (opts: PromptOptions) => new Promise<PromptResult | null>((resolve) => { cancelCurrent(); set({ id: ++seq, kind: "prompt", opts, resolve }); });

/** The form is keyed on the request id, so its state starts fresh for every dialog without effects. */
function DialogForm({ pending }: { pending: Pending }) {
  const [text, setText] = useState(pending.kind === "prompt" ? pending.opts.initial ?? "" : "");
  const [choice, setChoice] = useState(pending.kind === "prompt" ? pending.opts.choices?.[0]?.value ?? "" : "");
  const o = pending.opts;
  const cancel = () => { cancelCurrent(); set(null); };
  const ok = () => { if (pending.kind === "confirm") pending.resolve(true); else pending.resolve({ text: text.trim(), choice: choice || undefined }); set(null); };
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form method="dialog" onSubmit={(e) => { e.preventDefault(); ok(); }} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ok(); } }}>
      <h3 id="dlg-title">{o.title}</h3>
      {o.body && <p className="dlg-body">{o.body}</p>}
      {pending.kind === "prompt" && pending.opts.choices && (
        <label className="dlg-field">{pending.opts.choiceLabel ?? "Which"}<select value={choice} onChange={(e) => setChoice(e.target.value)}>{pending.opts.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      )}
      {pending.kind === "prompt" && (pending.opts.multiline !== false
        ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={pending.opts.placeholder} aria-label={o.title} />
        : <input value={text} onChange={(e) => setText(e.target.value)} placeholder={pending.opts.placeholder} aria-label={o.title} />)}
      <div className="dlg-actions">
        <button type="button" onClick={cancel}>{o.cancelLabel ?? "Cancel"}</button>
        <button type="submit" className={`primary ${o.danger ? "danger" : ""}`}>{o.confirmLabel ?? "OK"}</button>
      </div>
    </form>
  );
}

export function DialogHost() {
  const pending = useSyncExternalStore(subscribe, () => current, () => current);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    else if (!pending && d.open) d.close();
  }, [pending]);
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog ref={ref} className={`dlg ${pending?.opts.danger ? "danger" : ""}`} onCancel={(e) => { e.preventDefault(); cancelCurrent(); set(null); }} onClick={(e) => { if (e.target === ref.current) { cancelCurrent(); set(null); } }} aria-labelledby="dlg-title">
      {pending && <DialogForm key={pending.id} pending={pending} />}
    </dialog>
  );
}
