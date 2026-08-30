import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = "http://127.0.0.1:4411";
const output = "work/qa";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Users/mikeyottled/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

async function capture(name) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

async function metrics(name) {
  const result = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll("button, a")].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 40 || rect.height < 40);
    }).map((node) => ({ text: node.textContent?.trim().slice(0, 36), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) })),
  }));
  return [name, result];
}

const reports = [];
await page.goto(base, { waitUntil: "networkidle" });
reports.push(await metrics("landing"));
await capture("00-landing");
await page.getByRole("link", { name: /Partial-data preview/ }).click();
await page.waitForURL("**/plan");
await page.goto(base, { waitUntil: "networkidle" });
await page.getByRole("link", { name: /4 reviewed commitments/ }).click();
await page.waitForURL("**/connections");
await page.goto(`${base}/today`, { waitUntil: "networkidle" });
reports.push(await metrics("today"));
await capture("01-today");

await page.getByRole("link", { name: /Review the evidence/ }).click();
await page.getByRole("radio", { name: /No, this is unexpected/ }).click();
await capture("02-review-decision");
await page.getByRole("button", { name: /Continue/ }).click();
await page.getByRole("radio", { name: /I’ll contact MetroNet/ }).click();
await capture("03-review-plan");
await page.getByRole("button", { name: /Save plan/ }).click();
await capture("04-review-saved");

await page.getByRole("link", { name: /Review queue/ }).click();
await capture("05-review-queue-after-save");
await page.getByRole("link", { name: /Green Basket/ }).click();
await page.getByRole("radio", { name: /One may be a duplicate/ }).click();
await page.getByRole("button", { name: /Save answer/ }).click();
await capture("06-grocery-complete");
await page.getByRole("link", { name: /View proof trail/ }).click();
reports.push(await metrics("activity-complete"));
await capture("07-activity-complete");

await page.getByRole("link", { name: "Plan", exact: true }).click();
await page.getByRole("button", { name: /Edit range/ }).click();
const electric = page.getByLabel("Maximum expected bill");
await electric.fill("165");
await page.waitForTimeout(250);
await capture("07-electric-edit");
await page.getByRole("button", { name: /Save estimate/ }).click();
reports.push(await metrics("plan-edited"));
await capture("08-plan-edited");

await page.getByRole("link", { name: "More", exact: true }).click();
await page.getByRole("link", { name: /Accounts & data health/ }).click();
await page.getByRole("button", { name: /MetroCard/ }).click();
await page.getByRole("button", { name: /Refresh connection/ }).click();
await page.waitForTimeout(1100);
await capture("09-source-restored");
await page.getByRole("button", { name: "Close" }).click();
await page.goto(`${base}/today`, { waitUntil: "networkidle" });
await capture("10-today-after-save");

await page.setViewportSize({ width: 320, height: 700 });
reports.push(await metrics("today-320"));
await capture("11-today-320");

console.log(JSON.stringify({ errors, reports }, null, 2));
await browser.close();
