import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel, hasUnsavedSettings } from "../components/Settings";
import { DialogHost } from "../components/Dialog";
import { api } from "../lib/api";
import { getState } from "../lib/store";
import { settings } from "./fixtures";
import { FakeNotification } from "./setup";

class FakeIO {
  static last: FakeIO | null = null;
  constructor(public cb: (entries: any[]) => void, public opts: any) { FakeIO.last = this; }
  observe = mock(() => {}); disconnect = mock(() => {});
}

describe("SettingsPanel", () => {
  test("loading, editing every field type, save / discard / reset / tests / import / export, browser prefs", async () => {
    (globalThis as any).IntersectionObserver = FakeIO;
    const save = spyOn(api, "saveSettings").mockImplementation(async (patch: any) => ({ ok: true, settings: settings({ updatedAt: 99, budget: { ...settings().budget, ...(patch.budget ?? {}) } }) }) as any);
    const reset = spyOn(api, "resetSettings").mockResolvedValue({ ok: true, settings: settings({ updatedAt: 7 }) } as any);
    const testKey = spyOn(api, "testSetting").mockResolvedValue({ ok: true, detail: "valid", ms: 120 } as any);
    const clicks: string[] = []; const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    const setSound = mock(() => {}), setMuted = mock(() => {}), setNotify = mock(() => {});
    const { container, rerender } = render(<><SettingsPanel settings={null} live={false} sound={false} setSound={setSound} muted setMuted={setMuted} notify={false} setNotify={setNotify} /><DialogHost /></>);
    expect(container.textContent).toContain("Loading settings…");
    const s = settings();
    rerender(<><SettingsPanel settings={s} live sound={false} setSound={setSound} muted setMuted={setMuted} notify={false} setNotify={setNotify} /><DialogHost /></>);
    expect(container.querySelectorAll(".settings-section").length).toBe(11); expect(hasUnsavedSettings()).toBe(false);
    // Section nav follows the observer; clicking scrolls.
    act(() => FakeIO.last!.cb([{ isIntersecting: true, target: { id: "sec-budget" }, boundingClientRect: { top: 50 } }, { isIntersecting: true, target: { id: "sec-timing" }, boundingClientRect: { top: 10 } }, { isIntersecting: false, target: { id: "sec-glm" }, boundingClientRect: { top: 0 } }]));
    expect(container.querySelector(".settings-nav button.on")?.textContent).toContain("Timing");
    act(() => FakeIO.last!.cb([]));
    const scrollInto = spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.click(screen.getAllByText("This browser")[0]); expect(scrollInto).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Timing/ })); expect(container.querySelector(".settings-nav button.on")?.textContent).toContain("Timing");
    // text (reconnect field), number invalid → save disabled, range, bool, select, secret reveal / type.
    fireEvent.change(container.querySelector("#set-tiktok-username")!, { target: { value: "  someone " } });
    expect(container.textContent).toContain("1 unsaved change · some apply after reconnect"); expect(hasUnsavedSettings()).toBe(true);
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "99" } });
    expect(container.textContent).toContain("max 16"); expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "1e999" } });
    expect(container.textContent).toContain("not a number");
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "" } });
    expect(container.textContent).toContain("min 1");
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "0" } });
    expect(container.textContent).toContain("min 1");
    fireEvent.change(container.querySelector("#set-decisions-messageConcurrency")!, { target: { value: "8" } });
    fireEvent.change(container.querySelector("#set-budget-sessionUsd")!, { target: { value: "0" } });
    expect(container.textContent).toContain("no cap");
    fireEvent.change(container.querySelector("#set-timing-tickMs")!, { target: { value: "1500" } });
    expect(container.textContent).toContain("1.5 s");
    fireEvent.change(container.querySelector("#set-timing-highlightGapMs")!, { target: { value: "90000" } });
    expect(container.textContent).toContain("1.5 min");
    fireEvent.change(container.querySelector("#set-timing-toastMs")!, { target: { value: "2500" } });
    fireEvent.click(container.querySelector("#set-replay-dryRun")!);
    fireEvent.change(container.querySelector("#set-models-glm")!, { target: { value: "z-ai/glm-5.3" } });
    const secret = container.querySelector("#set-keys-openrouter") as HTMLInputElement;
    expect(secret.placeholder).toContain("…abcd"); expect(secret.type).toBe("password");
    fireEvent.click(secret.parentElement!.querySelector('[aria-label="show secret"]')!); expect(secret.type).toBe("text");
    fireEvent.change(secret, { target: { value: "sk-new" } });
    fireEvent.change(container.querySelector("#set-keys-deepgram")!, { target: { value: "dg" } });
    fireEvent.change(container.querySelector("#set-keys-deepgram")!, { target: { value: "" } });
    fireEvent.click(screen.getAllByTitle("test this key")[0]);
    await waitFor(() => expect(container.querySelector(".test-result.ok")?.textContent).toContain("valid · 120 ms"));
    expect(testKey).toHaveBeenCalledWith("openrouter", "sk-new");
    testKey.mockResolvedValue({ ok: false, detail: "bad key" } as any);
    fireEvent.click(screen.getAllByTitle("test this key")[1]);
    await waitFor(() => expect(container.querySelector(".test-result.bad")?.textContent).toContain("bad key"));
    testKey.mockRejectedValue(new Error("timeout"));
    fireEvent.click(screen.getByText("check model ids on OpenRouter"));
    await waitFor(() => expect(container.textContent).toContain("✗ timeout"));
    expect(container.querySelector(".count.new")).not.toBeNull();
    // Discard, then edit and save.
    fireEvent.click(screen.getByText("Discard"));
    expect(hasUnsavedSettings()).toBe(false); expect((container.querySelector("#set-tiktok-username") as HTMLInputElement).value).toBe("koursk1");
    fireEvent.change(container.querySelector("#set-budget-sessionUsd")!, { target: { value: "5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ budget: { sessionUsd: 5 } }));
    await waitFor(() => expect(container.querySelector(".savemsg.ok")?.textContent).toContain("Saved 1 setting"));
    // Server pushes new settings: adopted when nothing is unsaved, else only the base moves.
    rerender(<><SettingsPanel settings={settings({ updatedAt: 123, tiktok: { ...settings().tiktok, username: "pushed", sessionId: "" } })} live={false} sound setSound={setSound} muted={false} setMuted={setMuted} notify setNotify={setNotify} /><DialogHost /></>);
    expect((container.querySelector("#set-tiktok-username") as HTMLInputElement).value).toBe("pushed");
    fireEvent.change(container.querySelector("#set-tiktok-username")!, { target: { value: "draft" } });
    rerender(<><SettingsPanel settings={settings({ updatedAt: 124, tiktok: { ...settings().tiktok, username: "pushed2", sessionId: "" } })} live={false} sound setSound={setSound} muted={false} setMuted={setMuted} notify setNotify={setNotify} /><DialogHost /></>);
    expect((container.querySelector("#set-tiktok-username") as HTMLInputElement).value).toBe("draft");
    expect(container.textContent).not.toContain("some apply after reconnect");
    // A failed save keeps the draft (still dirty, so the bar stays and the error waits behind it); Discard clears both.
    save.mockRejectedValue(new Error("disk full"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false));
    expect(hasUnsavedSettings()).toBe(true); expect(container.querySelector(".savemsg")).toBeNull();
    fireEvent.click(screen.getByText("Discard"));
    expect(hasUnsavedSettings()).toBe(false); expect(container.querySelector(".savemsg")).toBeNull();
    // Reset through the dialog.
    fireEvent.click(screen.getByText("reset"));
    const dlg = container.querySelector("dialog")!;
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Reset"));
    await waitFor(() => expect(reset).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".savemsg.ok")?.textContent).toContain("Reset to defaults"));
    reset.mockRejectedValue(new Error("x"));
    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Reset"));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(2));
    // Export / import.
    fireEvent.click(screen.getByText("⤓ export"));
    expect(clicks).toEqual(["awesome-jev-settings.json"]);
    const file = new File([JSON.stringify({ budget: { sessionUsd: 9 } })], "s.json", { type: "application/json" });
    save.mockImplementation(async () => ({ ok: true, settings: settings({ updatedAt: 200 }) }) as any);
    fireEvent.change(screen.getByLabelText("import settings JSON"), { target: { files: [file] } });
    await waitFor(() => expect(container.querySelector(".savemsg.ok")?.textContent).toContain("Imported s.json"));
    fireEvent.change(screen.getByLabelText("import settings JSON"), { target: { files: [] } });
    const bad = new File(["{oops"], "bad.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("import settings JSON"), { target: { files: [bad] } });
    await waitFor(() => expect(container.querySelector(".savemsg.bad")?.textContent).toContain("Import failed"));
    // Browser prefs: chime, notifications (granted / blocked), stream audio.
    fireEvent.click(container.querySelector("#pref-sound")!); expect(setSound).toHaveBeenCalledWith(false);
    fireEvent.click(container.querySelector("#pref-muted")!); expect(setMuted).toHaveBeenCalledWith(true);
    // notify is on: the switch turns it off without asking the browser.
    fireEvent.click(container.querySelector("#pref-notify")!);
    await waitFor(() => expect(setNotify).toHaveBeenCalledWith(false));
    rerender(<><SettingsPanel settings={settings({ updatedAt: 124 })} live={false} sound setSound={setSound} muted={false} setMuted={setMuted} notify={false} setNotify={setNotify} /><DialogHost /></>);
    // notify is off: turning it on asks for permission; refused → toast, granted → enabled.
    fireEvent.click(container.querySelector("#pref-notify")!);
    await waitFor(() => expect(getState().toasts.some((t) => t.title === "Notifications blocked by the browser")).toBe(true));
    expect(setNotify).toHaveBeenCalledTimes(1);
    FakeNotification.permission = "granted";
    fireEvent.click(container.querySelector("#pref-notify")!);
    await waitFor(() => expect(setNotify).toHaveBeenLastCalledWith(true));
    FakeNotification.permission = "denied";
    rerender(<><SettingsPanel settings={settings({ updatedAt: 124 })} live={false} sound setSound={setSound} muted={false} setMuted={setMuted} notify={false} setNotify={setNotify} /><DialogHost /></>);
    expect(container.textContent).toContain("blocked");
    save.mockRestore(); reset.mockRestore(); testKey.mockRestore(); click.mockRestore(); scrollInto.mockRestore();
  });
});
