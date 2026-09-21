import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PollView, startPollDialog, endPollNow, tally } from "../components/Poll";
import { Flagged } from "../components/Flagged";
import { DialogHost } from "../components/Dialog";
import { Director } from "../Director";
import { Card } from "../director/widgets";
import { cardBody, cardTitle } from "../director/model";
import { api } from "../lib/api";
import { dispatch, getState } from "../lib/store";
import { decision, hello, highlight, poll, push, question, snapshot, status, T0 } from "./fixtures";
import type { Highlight } from "@shared/protocol";

const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const noActions = { onDone: () => {}, onPin: () => {}, onSnooze: () => {}, onSelect: () => {} };
const thanks = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "t1", kind: "room", flags: [], message: undefined, assist: { kind: "thanks", handle: "rich.guy", nickname: "Rich Guy", avatar: "https://example.test/r.png", gift: "Lion", count: 2, diamonds: 60 }, ...o });
const promise = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "p1", kind: "transcript", flags: [], message: undefined, transcript: { from: T0, to: T0 + 1000, lines: [{ ts: T0, text: "in five minutes the giveaway" }] }, assist: { kind: "promise", text: "in five minutes the giveaway", dueAt: T0 + 300_000 }, ...o });
const faq = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "f1", assist: { kind: "faq", question: "what time do you stream", answer: "Every night at 9pm Paris time." }, ...o });

describe("polls", () => {
  test("tally: shares, leader, empty", () => {
    expect(tally(poll())).toEqual({ total: 4, rows: [{ option: "pizza", n: 3, pct: 75, leading: true }, { option: "burger", n: 1, pct: 25, leading: false }] });
    expect(tally(poll({ counts: {} })).rows.every((r) => !r.leading && r.pct === 0)).toBe(true);
  });
  test("PollView: empty with a start button, running with end / clear, ended shows the winner; the overlay hides the voters", () => {
    const clear = spyOn(api, "clearPoll").mockResolvedValue({ ok: true } as any);
    const end = spyOn(api, "endPoll").mockResolvedValue({ ok: true, poll: null } as any);
    const onStart = spyOn({ f: () => {} }, "f");
    const { container, rerender } = render(<PollView poll={null} />);
    expect(container.innerHTML).toBe("");
    rerender(<PollView poll={null} size="compact" onStart={onStart} />);
    fireEvent.click(screen.getByLabelText("📊 Poll")); expect(onStart).toHaveBeenCalled();
    rerender(<PollView poll={poll()} size="compact" controls onStart={onStart} />);
    expect(container.querySelector(".poll.running")).not.toBeNull(); expect(container.textContent).toContain("4 votes · 6 messages read"); expect(container.querySelectorAll(".poll-row").length).toBe(2); expect(container.querySelector(".poll-row.lead .poll-opt")?.textContent).toBe("pizza"); expect(container.querySelectorAll(".poll-avatar").length).toBe(2);
    fireEvent.click(screen.getByText("End")); expect(end).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("remove the poll")); expect(clear).toHaveBeenCalled();
    rerender(<PollView poll={poll({ endedAt: T0 + 9000, counts: { pizza: 1 }, voters: 1 })} size="compact" controls onStart={onStart} />);
    expect(container.querySelector(".poll.over")).not.toBeNull(); expect(container.textContent).toContain("1 vote"); expect(container.textContent).toContain("ended"); expect(container.querySelector(".poll-row.lead .poll-opt")?.textContent).toBe("pizza · leads"); expect(screen.queryByText("End") === null).toBe(true);
    fireEvent.click(screen.getByText("📊 Poll")); expect(onStart).toHaveBeenCalledTimes(2);
    rerender(<PollView poll={poll({ counts: {}, voters: 0, judged: 0 })} size="overlay" />);
    expect(container.textContent).toContain("no votes yet"); expect(container.querySelector(".poll-recent") === null).toBe(true);
    clear.mockRejectedValue(new Error("x")); rerender(<PollView poll={poll()} controls />); fireEvent.click(screen.getByLabelText("remove the poll"));
    clear.mockRestore(); end.mockRestore();
  });
  test("startPollDialog parses the question and options, refuses too few, and endPollNow toasts", async () => {
    const start = spyOn(api, "startPoll").mockResolvedValue({ ok: true, poll: poll() } as any);
    const end = spyOn(api, "endPoll").mockResolvedValue({ ok: true, poll: poll() } as any);
    render(<DialogHost />);
    const dlg = document.querySelector("dialog")!;
    let p = startPollDialog();
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.click(screen.getByText("Cancel"));
    expect(await p).toBe(false);
    p = startPollDialog();
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.change(dlg.querySelector("textarea")!, { target: { value: "Only a question" } });
    fireEvent.click(screen.getByText("Start the poll"));
    expect(await p).toBe(false);
    expect(getState().toasts.some((t) => t.title.includes("at least two options"))).toBe(true);
    p = startPollDialog();
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.change(dlg.querySelector("textarea")!, { target: { value: " Pizza or burger? \n pizza\n\nburger \n" } });
    fireEvent.click(screen.getByText("Start the poll"));
    expect(await p).toBe(true);
    expect(start).toHaveBeenCalledWith("Pizza or burger?", ["pizza", "burger"]);
    start.mockRejectedValue(new Error("nope"));
    p = startPollDialog();
    await waitFor(() => expect(dlg.open).toBe(true));
    fireEvent.change(dlg.querySelector("textarea")!, { target: { value: "q\na\nb" } });
    fireEvent.click(screen.getByText("Start the poll"));
    expect(await p).toBe(false);
    await endPollNow(); expect(getState().toasts.some((t) => t.title === "Poll ended")).toBe(true);
    end.mockRejectedValue(new Error("x")); await endPollNow();
    start.mockRestore(); end.mockRestore();
  });
});

describe("assist on flag cards", () => {
  test("provenance badges, duplicates, thanks, promise due / overdue, prepared answer", () => {
    const onJump = () => {}, onWatch = () => {};
    const hs = [
      highlight({ id: "a", resolved: true, resolvedBy: "answered", resolvedAt: T0 + 5000, duplicates: { ids: ["b", "c"], handles: ["bob", "cy"] } }),
      highlight({ id: "b", resolved: true, resolvedBy: "duplicate", duplicateOf: "a" }),
      highlight({ id: "u", resolved: true, resolvedBy: "user" }),
      thanks(), thanks({ id: "t2", resolved: true, resolvedBy: "thanked", assist: { kind: "thanks", handle: "amy", gift: "Rose", count: 1, diamonds: 1 } }),
      // The panel's clock is the real one: due times are relative to now.
      promise({ assist: { kind: "promise", text: "in five minutes the giveaway", dueAt: Date.now() + 300_400 } }), promise({ id: "p2", assist: { kind: "promise", text: "overdue one", dueAt: Date.now() - 120_400 } }), promise({ id: "p3", resolved: true, resolvedBy: "expired", assist: { kind: "promise", text: "no due" } }),
      faq(),
    ];
    const { container } = render(<Flagged highlights={hs} questions={[question()]} focusId={null} onJump={onJump} onWatch={onWatch} canWatch={false} />);
    fireEvent.click(screen.getByText(/^all/));
    expect(container.querySelectorAll(".badge.by-answered").length).toBe(1); expect(container.textContent).toContain("answered by the host"); expect(container.textContent).toContain("+2 asked the same");
    expect(container.querySelector(".badge.dup")?.getAttribute("title")).toBe("@bob, @cy");
    expect(container.querySelectorAll(".badge.by-duplicate").length).toBe(1); expect(container.textContent).toContain("same as another");
    expect(container.querySelectorAll(".badge.by-user").length).toBe(0); // a person's own action is not badged
    expect(container.querySelectorAll(".hl-thanks").length).toBe(2); expect(container.textContent).toContain("Thank Rich Guy for Lion ×2"); expect(container.textContent).toContain("💎 60"); expect(container.textContent).toContain("Thank amy for Rose"); expect(container.textContent).toContain("thanked");
    expect(container.querySelectorAll(".hl-kind").length).toBe(9); expect([...container.querySelectorAll(".hl-kind")].map((k) => k.textContent)).toEqual(expect.arrayContaining(["🎁 gift", "📌 promise"]));
    expect(container.querySelectorAll(".hl-promise").length).toBe(3); expect(container.textContent).toContain("due in 5:00"); expect(container.textContent).toContain("overdue by 2:00"); expect(container.textContent).toContain("expired");
    expect(container.querySelector(".hl-faq p")?.textContent).toBe("Every night at 9pm Paris time."); expect(container.textContent).toContain("for “what time do you stream”");
  });
});

describe("assist in the director", () => {
  test("card titles and bodies for thanks, promises, prepared answers and duplicates", () => {
    expect(cardTitle(thanks())).toBe("🎁 Thank Rich Guy"); expect(cardBody(thanks())).toBe("for Lion ×2 · 💎 60");
    expect(cardTitle(promise())).toBe("📌 You promised"); expect(cardBody(promise())).toBe("in five minutes the giveaway");
    expect(cardTitle(faq())).toBe("💬 Reply to Alice");
    const { container, rerender } = render(<Card h={thanks()} now={T0} ttlSec={45} actions={noActions} />);
    expect(container.querySelector(".dc-avatar")).not.toBeNull(); expect(container.querySelector(".dc-msg p")?.textContent).toBe("for Lion ×2 · 💎 60");
    rerender(<Card h={promise()} now={T0 + 60_000} ttlSec={45} actions={noActions} />);
    expect(container.querySelector(".dc-flag.due")?.textContent).toBe("in 4:00"); expect(container.querySelector(".dc-quote")?.textContent).toBe("in five minutes the giveaway");
    rerender(<Card h={promise({ assist: { kind: "promise", text: "late", dueAt: T0 - 30_000 } })} now={T0} ttlSec={45} actions={noActions} />);
    expect(container.querySelector(".dc-flag.late")?.textContent).toBe("overdue 0:30");
    rerender(<Card h={faq({ duplicates: { ids: ["x"], handles: ["bob"] } })} now={T0} ttlSec={45} actions={noActions} />);
    expect(container.querySelector(".dc-answer")?.textContent).toContain("Every night at 9pm"); expect(container.querySelector(".dc-flag.dup")?.textContent).toBe("+1 same");
    rerender(<Card h={faq({ duplicates: { ids: ["x", "y"], handles: ["bob", "cy"] } })} now={T0} ttlSec={45} actions={noActions} />);
    expect(container.querySelector(".dc-flag.dup")?.textContent).toBe("+2 same");
  });

  describe("poll tool", () => {
    beforeEach(() => {
      window.happyDOM.setURL("http://localhost:5173/?view=director");
      act(() => dispatch({ type: "ws", msg: hello({ status: status({ ts: Date.now() - 65_000 }), decisions: [decision({ ts: Date.now() })], highlights: [highlight({ ts: Date.now() - 1000 })] }) }));
      push({ type: "snapshot", snapshot: snapshot() });
    });
    afterEach(() => { window.happyDOM.setURL("http://localhost:5173/"); });
    test("p starts a poll through the dialog when none runs and ends it when one does; every layout shows it", async () => {
      const start = spyOn(api, "startPoll").mockResolvedValue({ ok: true, poll: poll() } as any);
      const end = spyOn(api, "endPoll").mockResolvedValue({ ok: true, poll: poll({ endedAt: Date.now() }) } as any);
      const { container } = render(<Director />);
      expect(container.querySelector(".poll") === null).toBe(true);
      key("p");
      const dlg = container.querySelector("dialog")!;
      await waitFor(() => expect(dlg.open).toBe(true));
      fireEvent.change(dlg.querySelector("textarea")!, { target: { value: "Pizza or burger?\npizza\nburger" } });
      fireEvent.click(screen.getByText("Start the poll"));
      await waitFor(() => expect(start).toHaveBeenCalledWith("Pizza or burger?", ["pizza", "burger"]));
      push({ type: "poll", poll: poll({ startedAt: Date.now() }) });
      expect(container.querySelector(".layout-stage .poll.big")).not.toBeNull(); expect(screen.getByLabelText("poll").getAttribute("aria-pressed")).toBe("true");
      key("3"); expect(container.querySelector(".layout-dashboard .poll.big")).not.toBeNull();
      key("4"); expect(container.querySelector(".layout-overlay .poll.overlay")).not.toBeNull();
      key("1");
      fireEvent.click(screen.getByLabelText("poll"));
      await waitFor(() => expect(end).toHaveBeenCalled());
      push({ type: "poll", poll: poll({ endedAt: Date.now() }) });
      expect(screen.getByLabelText("poll").getAttribute("aria-pressed")).toBe("false");
      // A session reset clears it; a seek keeps it.
      push({ type: "poll", poll: null });
      expect(container.querySelector(".poll") === null).toBe(true);
      start.mockRestore(); end.mockRestore();
    });
  });
});
