import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_ID, FIXTURE_USER, LINK_MESSAGE } from "./fixture-recording";

/** Fails the test on any uncaught page error; console errors are collected for the layout assertions. */
const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
};

/** Layout invariants of the dense console: nothing scrolls sideways, the tab bar fits, the chat reaches the bottom of its column. */
async function expectDenseLayout(page: Page) {
  const m = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect();
    const tabs = document.querySelector(".tabs")!;
    return { docSW: document.documentElement.scrollWidth, winW: innerWidth, tabsOverflow: tabs.scrollWidth - tabs.clientWidth, mid: r(".col.mid")?.bottom, chat: r(".chat-block")?.bottom, right: r(".col.right")?.bottom, tabBody: r(".tab-body")?.bottom };
  });
  expect(m.docSW).toBeLessThanOrEqual(m.winW);
  expect(m.tabsOverflow).toBeLessThanOrEqual(1);
  if (m.winW > 1100) { expect(Math.abs(m.mid! - m.chat!)).toBeLessThanOrEqual(1); expect(Math.abs(m.right! - m.tabBody!)).toBeLessThanOrEqual(1); }
}

test.describe("console", () => {
  test("boots idle: header, tabs, empty stream, dense layout, no errors", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await expect(page.locator(".brand-name")).toHaveText("tiktok:jev");
    await expect(page.locator(".status-pill .status-state")).toHaveText("offline");
    await expect(page.locator(".video")).toContainText("not connected");
    await expect(page.locator('[role="tab"]')).toHaveCount(8);
    await expect(page.locator("#tab-flagged")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".gauges .gauge")).toHaveCount(4);
    await expectDenseLayout(page);
    for (const [w, h] of [[1280, 800], [900, 900], [600, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expectDenseLayout(page);
    }
    expect(errors).toEqual([]);
  });

  test("keyboard: panels by number, settings, help sheet, video size", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("2");
    await expect(page.locator("#panel-rules")).toBeVisible();
    await expect(page.locator("#panel-flagged")).toBeHidden();
    await page.keyboard.press("5");
    await expect(page.locator("#panel-log")).toBeVisible();
    await page.keyboard.press(",");
    await expect(page.locator("#panel-settings")).toBeVisible();
    await expect(page.locator("#set-tiktok-username")).toBeVisible();
    await page.keyboard.press("?");
    await expect(page.locator(".sheet")).toContainText("Keyboard");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sheet")).toHaveCount(0);
    await page.keyboard.press("v");
    await expect(page.locator(".stream-top.large")).toHaveCount(1);
    await page.keyboard.press("v");
    await expect(page.locator(".stream-top.compact")).toHaveCount(1);
    await page.keyboard.press("1");
    await expect(page.locator("#panel-flagged")).toBeVisible();
    // Watching an account: the header shows who it waits for, and stops on ✕.
    await page.getByLabel("tiktok username").fill("e2e_nobody");
    await page.getByLabel("connect when live").click();
    await expect(page.locator(".watch-pill")).toContainText("waiting for @e2e_nobody");
    await page.getByLabel("stop watching").click();
    await expect(page.locator(".watch-pill")).toHaveCount(0);
    await expect(page.getByLabel("connect when live")).toBeVisible();
  });

  test("rules panel: keyword rule added, paused, removed and restored", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("2");
    await page.getByRole("button", { name: "⌘ keyword / regex" }).click();
    await page.getByLabel("new rule").fill("phone numbers");
    await page.getByLabel("pattern", { exact: true }).fill("(\\+?\\d[\\d .-]{7,}\\d)");
    await page.getByRole("button", { name: /Add rule/ }).click();
    const rule = page.locator(".rule", { hasText: "phone numbers" });
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText("local");
    await rule.getByLabel("pause rule").click();
    await expect(rule).toHaveClass(/paused/);
    await rule.getByLabel("resume rule").click();
    await expect(rule).not.toHaveClass(/paused/);
    // Edit in place: the pattern and the label change, the rule keeps its place and its text.
    await rule.getByLabel("edit rule").click();
    await rule.getByLabel("edit pattern").fill("\\b0[67]\\d{8}\\b");
    await rule.getByLabel("edit label").fill("FR mobiles");
    await rule.getByRole("button", { name: "Save" }).click();
    await expect(rule.locator(".rule-edit")).toHaveCount(0);
    await expect(rule.locator(".qd-label")).toHaveText("FR mobiles");
    await expect(page.locator(".toast", { hasText: "Rule updated" })).toHaveCount(1);
    await rule.getByLabel("remove rule").click();
    await expect(rule).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".rule", { hasText: "phone numbers" })).toHaveCount(1);
  });

  test("settings: a draft shows the save bar, discard clears it", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press(",");
    await page.locator("#set-decisions-messageConcurrency").fill("6");
    await expect(page.locator(".savebar.show")).toContainText("1 unsaved change");
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.locator(".savebar.show")).toHaveCount(0);
    await expect(page.locator("#set-decisions-messageConcurrency")).toHaveValue("4");
  });

  test("replay (dry run) feeds every panel; a keyword rule flags a message; the director shows it", async ({ page, request, context }) => {
    const errors = watchErrors(page);
    const settings = await request.put("/api/settings", { data: { replay: { dryRun: true } } });
    expect(settings.ok()).toBeTruthy();
    const rule = await request.post("/api/rules", { data: { text: "links in chat", kind: "keyword", pattern: "https?://", flags: "i", sources: ["chat"], label: "links" } });
    expect(rule.ok()).toBeTruthy();
    await page.goto("/");
    await expect(page.locator(".rule", { hasText: "links in chat" })).toHaveCount(1);
    await page.keyboard.press("1");

    const connect = await request.post("/api/connect", { data: { username: "replay", replay: FIXTURE_ID } });
    expect(connect.ok()).toBeTruthy();
    await expect(page.locator(".status-pill .status-state")).toHaveText("live");
    await expect(page.locator(".replaybar .rb-tag")).toContainText("REPLAY");
    await expect(page.locator(".rb-who")).toContainText(`@${FIXTURE_USER}`);
    await expect(page.locator(".msg-group").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".transcript .line").first()).toBeVisible();
    await expect(page.locator(".caption-text")).toContainText("desk");
    await expect(page.locator(".gauge").first()).toContainText("not evaluated");
    await expect(page.locator(".events")).toContainText("joined");
    // The keyword rule fires on the link message: a flag, a toast, a count on the tab, a card in Flagged.
    await expect(page.locator(".msg", { hasText: LINK_MESSAGE }).locator(".flag.fired")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator("#tab-flagged .count")).toHaveText(/[1-9]/);
    await expect(page.locator(".hl.message", { hasText: "example.test" })).toHaveCount(1);
    await expect(page.locator(".toast.message")).toContainText("links");
    await expectDenseLayout(page);
    // A pattern can be tried on the running session before it becomes a rule: free, with the matching messages.
    await page.keyboard.press("2");
    await page.getByRole("button", { name: "⌘ keyword / regex" }).click();
    await page.getByLabel("pattern", { exact: true }).fill("example\\.test");
    await page.getByRole("button", { name: /Test on/ }).click();
    await expect(page.locator(".pt-count")).toContainText(/1 of \d+ messages match · this session/);
    await expect(page.locator(".pt-sample li").first()).toContainText("example.test");
    await page.locator("#tab-flagged").click();

    // A live poll started from the API shows in the console above the chat and in every director layout.
    const started = await request.post("/api/poll", { data: { question: "Pizza or burger?", options: ["pizza", "burger"] } });
    expect(started.ok()).toBeTruthy();
    await expect(page.locator(".chat-block .poll.running .poll-q")).toContainText("Pizza or burger?");
    await expect(page.locator(".chat-block .poll-row")).toHaveCount(2);
    // The director (second screen) shows the same flag as a card; every layout renders it, featuring it fills the overlay.
    const director = await context.newPage();
    await director.goto("/?view=director");
    await expect(director.locator(".d-live.on")).toHaveText("LIVE");
    await expect(director.locator(".dc.message").first()).toContainText("Reply to");
    await expect(director.locator(".d-top")).toContainText("👁");
    await expect(director.locator(".layout-stage .poll.big")).toContainText("Pizza or burger?");
    await director.keyboard.press("2");
    await expect(director.locator(".layout-focus .dc.big")).toContainText("example.test");
    await director.keyboard.press("3");
    await expect(director.locator(".layout-dashboard .d-tile")).toHaveCount(6);
    await expect(director.locator(".d-events")).toContainText("joined");
    await expect(director.locator(".d-events .d-ev-avatar").first()).toBeVisible();
    // Every rule of the set is on the dashboard; the keyword rule shows what it matched.
    await expect(director.locator(".d-rules .d-rule")).toHaveCount(await request.get("/api/state").then(async (r) => ((await r.json()) as { questions: { questions: unknown[] } }).questions.questions.length));
    await expect(director.locator('.d-rule[aria-label="links"] .d-rule-foot')).toContainText("fired ×1");
    await expect(director.locator('.d-rule[aria-label="links"] .d-rule-last')).toContainText("example.test");
    await director.keyboard.press("1");
    await director.keyboard.press("f");
    await expect(director.locator(".dc.pinned")).toHaveCount(1);
    await director.keyboard.press("4");
    await expect(director.locator(".layout-overlay .d-lt-text")).toContainText("example.test");
    await expect(director.locator(".layout-overlay .poll.overlay")).toHaveCount(1);
    await director.getByRole("button", { name: "exit overlay" }).click();
    await expect(director.locator(".layout-stage")).toHaveCount(1);
    await director.keyboard.press("f");
    await expect(director.locator(".dc.pinned")).toHaveCount(0);
    await director.close();

    await page.locator(".chat-block .poll").getByRole("button", { name: "End" }).click();
    await expect(page.locator(".chat-block .poll.over")).toHaveCount(1);
    await page.locator(".toast.message .toast-main").click();
    await expect(page.locator(".hl.focused")).toHaveCount(1);
    // Marking it handled moves it out of the "open" filter into "resolved".
    await page.locator(".hl.focused").getByLabel("mark handled").click();
    const filters = page.locator(".hl-toolbar .seg button");
    await expect(filters.nth(0)).toContainText("open 0");
    await expect(filters.nth(2)).toContainText("resolved 1");
    await filters.nth(2).click();
    await expect(page.locator(".hl.resolved", { hasText: "example.test" })).toHaveCount(1);
    await filters.nth(3).click();

    const disconnect = await request.post("/api/disconnect");
    expect(disconnect.ok()).toBeTruthy();
    await expect(page.locator(".status-pill .status-state")).toHaveText("offline");
    await expect(page.locator(".summary")).toContainText("Session ended");
    await page.keyboard.press("6");
    await expect(page.locator(".rec", { hasText: `@${FIXTURE_USER}` })).toHaveCount(1);
    expect(errors.filter((e) => !e.includes("hls"))).toEqual([]);
  });
});
