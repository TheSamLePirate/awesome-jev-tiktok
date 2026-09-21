import { describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Avatar, Highlighted, Kbd, Ring, SourceBadges, Spark, useNow, useTween } from "../components/ui";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { DialogHost, confirm, prompt } from "../components/Dialog";

describe("ui primitives", () => {
  test("SourceBadges: compact all, compact subset, full labels", () => {
    const { container, rerender } = render(<SourceBadges sources={["transcript", "video", "chat"]} compact />);
    expect(container.textContent).toContain("✦ all");
    rerender(<SourceBadges sources={["transcript", "video", "chat"]} />);
    expect(container.textContent).toContain("audio"); expect(container.textContent).toContain("video"); expect(container.textContent).toContain("chat");
    rerender(<SourceBadges sources={["chat"]} compact />);
    expect(container.querySelectorAll(".src").length).toBe(1); expect(container.textContent).not.toContain("chat");
  });
  test("Avatar falls back to initials when the image breaks or is missing", () => {
    const { container } = render(<Avatar src="https://x/a.png" name="Alice" handle="alice" size={20} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://x/a.png"); expect(img.style.width).toBe("20px");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull(); expect(container.textContent).toBe("AL");
    const { container: c2 } = render(<Avatar name="" handle="zed" />);
    expect(c2.textContent).toBe("ZE");
  });
  test("Ring, Spark, Kbd, Highlighted", () => {
    const { container } = render(<><Ring value={1.5} title="conf" /><Ring value={-1} size={30} /><Kbd k="⌘K" /><Highlighted text="Hello World" q="wor" /><Highlighted text="abc" q="" /><Highlighted text="abc" q="zz" /></>);
    expect(container.querySelectorAll("svg.ring").length).toBe(2); expect(container.querySelector("kbd")?.textContent).toBe("⌘K");
    expect(container.querySelector("mark")?.textContent).toBe("Wor"); expect(container.querySelectorAll("mark").length).toBe(1);
    const { container: s } = render(<><Spark values={[1]} /><Spark values={[0, 0.5, 1, 2]} max={1} /><Spark values={[0, 1]} stretch h={16} className="x" /></>);
    const svgs = s.querySelectorAll("svg.spark");
    expect(svgs.length).toBe(3); expect(svgs[0].querySelector("polyline")).toBeNull(); expect(svgs[1].querySelector("circle")).not.toBeNull();
    expect(svgs[2].querySelector("circle")).toBeNull(); expect(svgs[2].getAttribute("preserveAspectRatio")).toBe("none"); expect((svgs[2] as HTMLElement).style.width).toBe("100%");
  });
  test("useNow ticks and useTween eases toward the target (or jumps under reduced motion)", async () => {
    const { result } = renderHook(() => useNow(10));
    const first = result.current;
    await waitFor(() => expect(result.current).toBeGreaterThan(first));
    const tw = renderHook(({ v }) => useTween(v, 60), { initialProps: { v: 0 } });
    tw.rerender({ v: 1 });
    await waitFor(() => expect(tw.result.current).toBeCloseTo(1, 1), { timeout: 2000 });
    const mm = spyOn(window, "matchMedia").mockImplementation((() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any);
    const reduced = renderHook(({ v }) => useTween(v), { initialProps: { v: 0 } });
    reduced.rerender({ v: 0.7 });
    expect(reduced.result.current).toBe(0.7);
    mm.mockRestore();
  });
});

describe("ErrorBoundary", () => {
  test("shows a card, retries, reloads", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const Boom = () => { if (fail) throw new Error("kaboom"); return <p>fine</p>; };
    render(<ErrorBoundary name="Panel"><Boom /></ErrorBoundary>);
    expect(screen.getByText("Panel crashed")).toBeTruthy(); expect(screen.getByText("kaboom")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("fine")).toBeTruthy();
    fail = true;
    const { container } = render(<ErrorBoundary name="Root" full><Boom /></ErrorBoundary>);
    expect(container.querySelector(".error-card.full")).not.toBeNull();
    const reload = spyOn(location, "reload").mockImplementation(() => {});
    fireEvent.click(container.querySelector("button.primary")!);
    expect(reload).toHaveBeenCalled();
    reload.mockRestore(); err.mockRestore();
  });
});

describe("Dialog", () => {
  test("confirm resolves true / false, prompt returns text and choice, second dialog cancels the first", async () => {
    const { container } = render(<DialogHost />);
    const dlg = container.querySelector("dialog")!;
    const p1 = confirm({ title: "Sure?", body: "really", confirmLabel: "Yes", danger: true });
    await waitFor(() => expect(dlg.open).toBe(true));
    expect(screen.getByText("really")).toBeTruthy(); expect(dlg.className).toContain("danger");
    fireEvent.click(screen.getByText("Yes"));
    expect(await p1).toBe(true);
    await waitFor(() => expect(dlg.open).toBe(false));
    const p2 = confirm({ title: "Again?" });
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Cancel"));
    expect(await p2).toBe(false);
    const p3 = prompt({ title: "Rate", placeholder: "why", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }], choiceLabel: "Verdict" });
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.change(container.querySelector("select")!, { target: { value: "b" } });
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "  because  " } });
    fireEvent.keyDown(container.querySelector("form")!, { key: "Enter", metaKey: true });
    expect(await p3).toEqual({ text: "because", choice: "b" });
    const p4 = prompt({ title: "Single", multiline: false, initial: "x" });
    await waitFor(() => expect(dlg.open).toBe(true));
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("x");
    fireEvent.change(container.querySelector("input")!, { target: { value: "xy " } });
    fireEvent.submit(container.querySelector("form")!);
    expect(await p4).toEqual({ text: "xy", choice: undefined });
    const p5 = prompt({ title: "First" });
    await waitFor(() => expect(dlg.open).toBe(true));
    const p6 = confirm({ title: "Second" });
    expect(await p5).toBeNull();
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
    fireEvent(dlg, new Event("cancel", { cancelable: true }));
    expect(await p6).toBe(false);
    const p7 = confirm({ title: "Backdrop" });
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(dlg);
    expect(await p7).toBe(false);
    const p8 = prompt({ title: "Enter" });
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.keyDown(container.querySelector("form")!, { key: "Enter" });
    fireEvent.keyDown(container.querySelector("form")!, { key: "Enter", ctrlKey: true });
    expect(await p8).toEqual({ text: "", choice: undefined });
    act(() => {});
  });
});
