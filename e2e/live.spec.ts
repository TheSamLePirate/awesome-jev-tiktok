import { expect, test } from "@playwright/test";

/**
 * Against a real TikTok live. The account must be streaming when the suite runs (E2E_LIVE, default @equinoxerpfr);
 * an offline account skips the test with the server's reason. Paid calls are capped by the session budget set below.
 */
const USER = (process.env.E2E_LIVE ?? "equinoxerpfr").replace(/^@/, "");

test.describe("live stream", () => {
  test.skip(!!process.env.E2E_SKIP_LIVE, "E2E_SKIP_LIVE is set");

  test(`connects to @${USER}, watches chat, speech, scene and decisions, then disconnects`, async ({ page, request, context }) => {
    test.setTimeout(300_000);
    const budget = await request.put("/api/settings", { data: { budget: { sessionUsd: 0.5 }, replay: { dryRun: false } } });
    expect(budget.ok()).toBeTruthy();
    await page.goto("/");
    await page.getByLabel("tiktok username").fill(USER);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator(".status-pill .status-state")).toHaveText(/live|error|offline/, { timeout: 120_000 });
    const state = await page.locator(".status-pill .status-state").textContent();
    if (state !== "live") {
      const detail = (await page.locator(".conn-error").textContent().catch(() => null)) ?? (await page.locator(".status-pill").getAttribute("title"));
      test.skip(true, `@${USER} is not live: ${detail ?? state}`);
    }

    await expect(page.locator(".hud-live")).toHaveText("LIVE");
    await expect(page.locator(".replaybar .rb-tag.live")).toHaveText("LIVE");
    await expect(page.locator(".kpis")).toContainText("viewers");
    await expect(page.locator(".kpi", { hasText: "viewers" }).locator("b")).not.toHaveText("–", { timeout: 60_000 });
    // Video: the HLS player is attached and receives segments.
    await expect(page.locator(".video video")).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(async () => page.evaluate(() => { const v = document.querySelector<HTMLVideoElement>(".video video"); return v ? v.readyState : -1; }), { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
    // Signals: chat and speech usually within a minute on an active stream; the scene caption comes from the vision model.
    await expect(page.locator(".msg-group, .transcript .line").first()).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".caption-text")).not.toContainText("waiting for first frame", { timeout: 120_000 });
    // Decisions: at least one room meter shows an answer (a jev call happened), the KPI has a latency.
    await expect(page.locator(".gauge .g-hero, .gauge .g-rows, .gauge .g-score").first()).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".kpi", { hasText: "jev" }).locator("b")).not.toHaveText("—");
    await expect(page.locator("#tab-log")).toBeVisible();
    await page.keyboard.press("5");
    await expect(page.locator(".log-row.jev").first()).toBeVisible();
    await page.keyboard.press("1");

    const director = await context.newPage();
    await director.goto("/?view=director");
    await expect(director.locator(".d-live.on")).toHaveText("LIVE", { timeout: 30_000 });
    await expect(director.locator(".d-meters .dm").first()).toBeVisible();
    await director.close();

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.locator(".status-pill .status-state")).toHaveText("offline", { timeout: 60_000 });
    await expect(page.locator(".summary")).toContainText("Session ended", { timeout: 60_000 });
    await page.keyboard.press("6");
    await expect(page.locator(".rec", { hasText: `@${USER}` }).first()).toBeVisible({ timeout: 30_000 });
  });
});
