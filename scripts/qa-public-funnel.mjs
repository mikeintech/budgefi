import { chromium } from "playwright";

const base = "http://127.0.0.1:4411";
const browser = await chromium.launch({ headless: true });
const errors = [];
const reports = [];

async function inspect(page, name) {
  const report = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    unlabeledButtons: [...document.querySelectorAll("button")].filter(
      (element) =>
        !element.textContent?.trim() && !element.getAttribute("aria-label"),
    ).length,
    smallTargets: [
      ...document.querySelectorAll(
        "button,a,input:not([type=checkbox]),select",
      ),
    ].filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        (rect.width < 44 || rect.height < 44)
      );
    }).length,
  }));
  reports.push([name, report]);
  if (report.scrollWidth > report.width)
    errors.push(`${name}: horizontal overflow`);
  if (report.unlabeledButtons) errors.push(`${name}: unlabeled buttons`);
  if (report.smallTargets) errors.push(`${name}: small touch targets`);
}

for (const width of [320, 390, 430, 1280]) {
  const context = await browser.newContext({
    viewport: { width, height: width >= 1000 ? 900 : 844 },
    isMobile: width < 1000,
    hasTouch: width < 1000,
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await inspect(page, `landing-${width}`);
  await context.close();
}

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
await page.goto(`${base}/sign-in`, { waitUntil: "networkidle" });
await page
  .getByRole("heading", { name: "Sign-in is temporarily unavailable" })
  .waitFor();
await inspect(page, "auth-fail-closed");
await context.close();

console.log(JSON.stringify({ errors, reports }, null, 2));
await browser.close();
