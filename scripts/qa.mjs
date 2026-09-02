import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = "http://127.0.0.1:4411";
const output = "work/qa";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});

async function capture(route, name) {
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

await capture("/", "00-landing");
await capture("/today", "01-today");
await capture("/plan", "02-plan");
await capture("/review", "03-review");
await capture("/activity", "04-activity");
await capture("/connections", "05-connections");
await capture("/manual", "06-manual");
await capture("/more", "07-more");

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
