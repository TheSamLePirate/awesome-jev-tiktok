import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Login } from "../components/Login";
import { api } from "../lib/api";
import { getState } from "../lib/store";

describe("Login", () => {
  test("posts the token, reports a refusal, and calls onDone on success", async () => {
    const login = spyOn(api, "login").mockRejectedValue(new Error("wrong token"));
    const onDone = mock(() => {});
    const { container } = render(<Login onDone={onDone} reason="The token in the link was refused." />);
    expect(container.querySelector(".error")?.textContent).toBe("The token in the link was refused.");
    const input = screen.getByLabelText("access token") as HTMLInputElement;
    expect(input.type).toBe("password"); expect(input.getAttribute("autocomplete")).toBe("off");
    const btn = screen.getByText("Sign in").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.submit(container.querySelector("form")!); expect(login).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " s3cret " } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(login).toHaveBeenCalledWith("s3cret"));
    await waitFor(() => expect(container.querySelector(".error")?.textContent).toBe("That token was refused."));
    login.mockRejectedValue(new Error("network error: down"));
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(container.querySelector(".error")?.textContent).toBe("network error: down"));
    login.mockResolvedValue({ ok: true, required: true });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(input.value).toBe("");
    login.mockRestore();
  });
});

describe("boot", () => {
  const realFetch = globalThis.fetch;
  const savedWs = (globalThis as any).WebSocket;
  // main.tsx binds its root to #root once, at import: one host for every boot scenario.
  let host: HTMLElement;
  beforeAll(() => { host = document.createElement("div"); host.id = "root"; document.body.appendChild(host); });
  afterAll(() => host.remove());
  const answers = new Map<string, () => Response>();
  beforeEach(() => {
    (globalThis as any).WebSocket = class { onopen = null; onmessage = null; onclose = null; onerror = null; close() {} constructor(public url: string) {} };
    (globalThis as any).fetch = mock(async (url: string) => { const path = new URL(url, "http://x").pathname; const a = answers.get(path); if (!a) throw new Error("ECONNREFUSED"); return a(); });
    spyOn(api, "recordings").mockResolvedValue([]); spyOn(api, "timeline").mockResolvedValue(null);
  });
  afterEach(() => { (globalThis as any).fetch = realFetch; (globalThis as any).WebSocket = savedWs; answers.clear(); window.happyDOM.setURL("http://localhost:5173/"); localStorage.clear(); });
  const json = (o: unknown, status = 200) => () => new Response(JSON.stringify(o), { status });

  test("unreachable server: the console boots anyway; a protected server without a session shows the sign-in; a session boots the console", async () => {
    const { root, boot } = await import("../main");
    await waitFor(() => expect(document.querySelector("#root .app, #root .login")).not.toBeNull());
    expect(document.querySelector("#root .app")).not.toBeNull();
    answers.set("/api/auth", json({ ok: true, required: true, authenticated: false }));
    await boot();
    await waitFor(() => expect(document.querySelector("#root .login")).not.toBeNull());
    expect(getState().authProtected).toBe(true);
    answers.set("/api/auth", json({ ok: true, required: true, authenticated: true }));
    await boot();
    await waitFor(() => expect(document.querySelector("#root .app")).not.toBeNull());
    void root;
  });

  test("a token in the link is exchanged for a cookie and stripped from the address; a refused one shows why; a stored token is retried then forgotten", async () => {
    const { root, boot } = await import("../main");
    const calls: string[] = [];
    answers.set("/api/auth/login", () => { calls.push("login"); return new Response(JSON.stringify({ ok: true, required: true }), { status: 200 }); });
    answers.set("/api/auth", json({ ok: true, required: true, authenticated: true }));
    window.happyDOM.setURL("http://localhost:5173/?view=director&token=abc");
    await boot();
    await waitFor(() => expect(document.querySelector("#root .app")).not.toBeNull()); // the view is fixed at module load; the token handling is what this checks
    expect(calls).toEqual(["login"]); expect(location.search).toBe("?view=director");
    // Refused: the sign-in explains it.
    answers.set("/api/auth/login", json({ ok: false, error: "wrong token" }, 401));
    window.happyDOM.setURL("http://localhost:5173/?token=bad");
    await boot();
    await waitFor(() => expect(document.querySelector("#root .login")).not.toBeNull());
    expect(document.querySelector("#root .login .error")?.textContent).toBe("The token in the link was refused."); expect(location.search).toBe("");
    // A token stored by an older console: tried once, forgotten whatever the answer, then the normal check decides.
    window.happyDOM.setURL("http://localhost:5173/");
    localStorage.setItem("jev.token", "old");
    answers.set("/api/auth", json({ ok: true, required: true, authenticated: false }));
    await boot();
    await waitFor(() => expect(document.querySelector("#root .login")).not.toBeNull());
    expect(localStorage.getItem("jev.token")).toBeNull();
    // Signing in from that screen boots the console.
    answers.set("/api/auth/login", json({ ok: true, required: true }));
    fireEvent.change(screen.getByLabelText("access token"), { target: { value: "abc" } });
    fireEvent.submit(document.querySelector("#root form")!);
    await waitFor(() => expect(document.querySelector("#root .app")).not.toBeNull());
    act(() => root.unmount());
  });
});
