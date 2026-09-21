import { useState } from "react";
import { api } from "../lib/api";

/**
 * The sign-in screen of a server started with JEV_TOKEN. The token is posted once; the server answers with an
 * HttpOnly session cookie, so nothing secret stays in the page, its URL or its storage.
 */
export function Login({ onDone, reason }: { onDone: () => void; reason?: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(reason ?? null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true); setError(null);
    try { await api.login(token.trim()); setToken(""); onDone(); }
    catch (err) { setError((err as Error).message === "wrong token" ? "That token was refused." : (err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="login" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <form className="login-card panel" onSubmit={(e) => void submit(e)} autoComplete="off">
        <div className="brand" aria-hidden><span className="logo">◎</span><span className="brand-name">tiktok<span className="brand-sep">:</span>jev</span></div>
        <h2 id="login-title">This console is protected</h2>
        <p className="muted">Enter the access token of the server (its <code>JEV_TOKEN</code>). This browser then stays signed in for 30 days; sign out from the settings.</p>
        <label className="login-field">Access token
          <input type="password" name="jev-access-token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" aria-label="access token" aria-invalid={!!error} />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="primary" disabled={!token.trim() || busy}>{busy ? <><span className="spinner sm" /> Signing in</> : "Sign in"}</button>
      </form>
    </div>
  );
}
