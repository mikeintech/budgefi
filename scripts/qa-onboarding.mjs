import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = "http://127.0.0.1:4411";
const output = "work/qa-onboarding";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Users/mikeyottled/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
const reports = [];
page.on("pageerror", error => errors.push(`page: ${error.message}`));
page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

async function capture(name) { await page.screenshot({ path: `${output}/${name}.png`, fullPage: true }); }
async function inspect(name) {
  const result = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    unlabeledButtons: [...document.querySelectorAll("button")].filter(node => !node.textContent?.trim() && !node.getAttribute("aria-label")).length,
    smallTargets: [...document.querySelectorAll("button,a,input,select")].filter(node => { const r=node.getBoundingClientRect(); return r.width>0&&r.height>0&&(r.width<44||r.height<44); }).map(node => ({ text: (node.getAttribute("aria-label")||node.textContent||"").trim().slice(0,30), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) })),
  }));
  reports.push([name, result]);
}

await page.goto(`${base}/more`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: /Replay onboarding and connection/ }).click();
await inspect("welcome");
await capture("01-welcome");
await page.getByRole("button", { name: /Set up Budgefi/ }).click();
await page.getByRole("radio", { name: /My household/ }).click();
await page.getByRole("button", { name: /Continue/ }).click();
await capture("02-connect-choice");
await page.getByRole("button", { name: /Chase sample connection/ }).click();
await capture("03-consent");
await page.getByRole("button", { name: /Approve and connect/ }).click();
await page.waitForTimeout(1250);
await capture("04-connected");
await page.getByRole("button", { name: /Review plan inputs/ }).click();
await inspect("calibration-cash");
await capture("05-calibration-cash");
await page.getByRole("button", { name: /Continue/ }).click();
await page.getByLabel("Next expected date").fill("2026-09-05");
await capture("06-calibration-income");
await page.getByRole("button", { name: /Continue/ }).click();
const electric = page.getByRole("spinbutton", { name: "Electric maximum amount" });
await electric.fill("145");
await page.getByRole("button", { name: /Add missing commitment/ }).click();
await page.getByLabel("Custom commitment name").fill("Pet care");
await page.getByRole("spinbutton", { name: "Pet care amount" }).fill("25");
if (!await page.getByRole("button", { name: "Remove Pet care" }).isVisible()) errors.push("custom commitment was not added or editable");
await page.getByRole("button", { name: "Remove Pet care" }).click();
if (await page.getByLabel("Custom commitment name").count()) errors.push("custom commitment was not removed");
await page.getByRole("button", { name: /Continue/ }).click();
await capture("07-calibration-guardrails-edited");
if (!await page.getByText("$1,294", { exact: true }).isVisible()) errors.push("electric maximum regression did not produce $1,294");
await page.locator("main").getByRole("button", { name: "Back" }).click();
await page.getByRole("spinbutton", { name: "Electric maximum amount" }).fill("155");
await page.getByRole("button", { name: /Continue/ }).click();
if (!await page.getByText("$1,284", { exact: true }).isVisible()) errors.push("default calibration did not restore $1,284");
await page.getByRole("button", { name: /Use this plan/ }).click();
await page.getByRole("radio", { name: /One daily summary/ }).click();
await capture("08-alerts");
await page.getByRole("button", { name: /Save preference preview/ }).click();
await inspect("ready");
await capture("09-ready");
await page.getByRole("button", { name: /Save (and open preview|plan and open Today)/ }).click();

await page.getByRole("link", { name: "More", exact: true }).click();
await page.getByRole("link", { name: /Accounts & data health/ }).click();
await inspect("connections");
await capture("10-connections");
await page.getByRole("button", { name: /MetroCard/ }).click();
await page.getByRole("button", { name: /Refresh connection/ }).click();
await page.waitForTimeout(1050);
await page.getByRole("button", { name: "Close" }).click();
await capture("11-connections-restored");

await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
await inspect("settings-index");
await capture("12-settings-index");
await page.getByRole("link", { name: /Notifications/ }).click();
await page.getByRole("radio", { name: /All detected changes/ }).click();
await page.getByRole("switch", { name: /Weekly proof digest/ }).click();
await capture("13-notifications");
await page.getByRole("button", { name: "Back" }).click();
await page.getByRole("link", { name: /Household/ }).click();
await page.getByRole("radio", { name: /Personal plan/ }).click();
await capture("14-household");
await page.getByRole("button", { name: "Back" }).click();
await page.getByRole("link", { name: /Privacy & data/ }).click();
await inspect("privacy");
await capture("15-privacy");
await page.getByRole("button", { name: "Back" }).click();
await page.getByRole("link", { name: /Planning rules/ }).click();
const buffer = page.getByLabel("Safety buffer");
await buffer.fill("350");
await capture("16-planning-consequence");
await page.getByRole("button", { name: /Save planning rule/ }).click();
await page.getByRole("link", { name: /View updated plan/ }).click();
await capture("17-plan-updated");
const planText = await page.locator("body").innerText();
if (!planText.includes("$1,214")) errors.push(`planning buffer did not update available amount to $1,214; rendered: ${planText.slice(0, 180)}`);

await page.setViewportSize({ width: 320, height: 700 });
await page.goto(`${base}/onboarding`, { waitUntil: "networkidle" });
await inspect("welcome-320");
await capture("18-welcome-320");

console.log(JSON.stringify({ errors, reports }, null, 2));
await browser.close();
