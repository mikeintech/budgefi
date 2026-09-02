import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const candidates = [process.env.POSTGRES_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/local/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin", "/Library/PostgreSQL/17/bin"].filter(Boolean);
const postgresBin = candidates.find((candidate) => existsSync(join(candidate, "initdb")));
if (!postgresBin) throw new Error("PostgreSQL 17 binaries not found. Set POSTGRES_BIN.");

const cluster = await mkdtemp(join(tmpdir(), "budgefi-e2e-pg17-"));
const [databasePort, apiPort, webPort] = await Promise.all([freePort(), freePort(), freePort()]);
const databaseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/budgefi_e2e`;
const baseUrl = `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const children = [];
let databaseStarted = false;
let browser;

try {
  run(join(postgresBin, "initdb"), ["-A", "trust", "-U", "postgres", "-D", cluster]);
  run(join(postgresBin, "pg_ctl"), ["-D", cluster, "-o", `-h 127.0.0.1 -p ${databasePort} -F`, "-w", "start"]);
  databaseStarted = true;
  run(join(postgresBin, "createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "postgres", "budgefi_e2e"]);
  run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
  run("npm", ["run", "db:seed"], { DATABASE_URL: databaseUrl });

  children.push(
    spawn("npm", ["run", "start:api"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ALLOW_DEV_AUTH: "true",
        ALLOW_USER_PROVISIONING: "true",
        OPENAI_FINANCE_ENABLED: "false",
        FEATURE_ONBOARDING_AI: "false",
        FEATURE_HOUSEHOLD_MODE: "false",
        NODE_ENV: "development",
        API_PORT: String(apiPort),
        API_HOST: "127.0.0.1",
        WEB_ORIGIN: baseUrl,
      },
    }),
  );
  children.push(
    spawn("npm", ["run", "dev", "--", "--port", String(webPort)], {
      stdio: "ignore",
      env: {
        ...process.env,
        VITE_API_BASE_URL: `${apiUrl}/v1`,
        VITE_CLERK_PUBLISHABLE_KEY: "",
      },
    }),
  );
  await waitFor(`${apiUrl}/v1/health`);
  await waitFor(baseUrl);

  const executablePath = await installedChromium();
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().startsWith(apiUrl) && !response.ok()) errors.push(`${response.status()} ${response.url()}`);
  });

  const firstLoginSubject = `dev|first-login-${Date.now()}`;
  await page.setExtraHTTPHeaders({ "x-dev-auth-subject": firstLoginSubject });
  await page.goto(`${baseUrl}/today`, { waitUntil: "networkidle" });
  const reachedFirstLogin = await page
    .waitForURL((url) => url.pathname === "/onboarding" && url.searchParams.get("from") === "first-login", { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!reachedFirstLogin) {
    const canonical = await (
      await fetch(`${apiUrl}/v1/bootstrap`, {
        headers: { "x-dev-auth-subject": firstLoginSubject },
      })
    ).json();
    throw new Error(`First login was not gated. URL: ${page.url()} Errors: ${errors.join(" | ")} Canonical onboarding: ${canonical?.household?.onboardingCompleted} UI: ${(await page.locator("body").innerText()).slice(0, 1200)}`);
  }
  await page.getByRole("heading", { name: "Start with the numbers you have." }).waitFor();
  await page.getByRole("button", { name: "Set up your plan" }).click();
  await page.getByRole("heading", { name: "How should Budgefi learn your numbers?" }).waitFor();
  if (await page.getByRole("radio", { name: /My household/ }).count()) throw new Error("Disabled household selection remained in onboarding");
  await page.getByRole("button", { name: /Enter everything manually/ }).click();
  await page
    .getByRole("heading", {
      name: "How much spendable cash is available today?",
    })
    .waitFor();
  const zeroContinue = page.getByRole("button", { name: /Continue/ });
  if (!(await zeroContinue.isDisabled())) throw new Error("Unconfirmed $0 cash was allowed through onboarding");
  await page.getByRole("switch", { name: "Confirm zero spendable cash" }).click();
  await zeroContinue.click();
  await page.getByRole("heading", { name: "When is money coming in?" }).waitFor();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("heading", { name: "What must be paid?" }).waitFor();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("heading", { name: "What should stay protected?" }).waitFor();
  await page.getByLabel("Keep untouched").waitFor();
  await page.getByText(/^Safe to spend through /).waitFor();
  await page.getByRole("button", { name: "Use this plan" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Save plan and open Today" }).click();
  await page.waitForURL("**/today");
  await page.getByRole("navigation", { name: "Primary navigation" }).waitFor();
  await page.setExtraHTTPHeaders({ "x-dev-auth-subject": "dev|maya" });

  await page.route(`${apiUrl}/v1/bootstrap`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto(`${baseUrl}/today`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Loading your plan" }).waitFor();
  if (await page.getByText("$1,284", { exact: true }).count()) throw new Error("Financial defaults appeared before canonical bootstrap");
  await page.getByText("$1,284", { exact: true }).waitFor();
  await page.unroute(`${apiUrl}/v1/bootstrap`);
  await page.goto(`${baseUrl}/connections`, { waitUntil: "networkidle" });
  const unavailableBankButton = page.getByRole("button", {
    name: "Bank connections unavailable",
  });
  await unavailableBankButton.waitFor();
  if (!(await unavailableBankButton.isDisabled())) throw new Error("Unconfigured bank connection was presented as available");
  await page
    .getByText("Bank connections are temporarily unavailable.", {
      exact: false,
    })
    .waitFor();
  if (await page.getByText("Try demo bank data", { exact: true }).count()) throw new Error("Retired demo entry point remained visible");
  await page.goto(`${baseUrl}/manual`, { waitUntil: "networkidle" });
  const cash = page.getByLabel("Current spendable total");
  await cash.fill("0");
  await cash.press("Backspace");
  if ((await cash.inputValue()) !== "") throw new Error("Money input restored zero while the user was clearing it");
  await cash.fill("5000.25");
  await page.getByRole("button", { name: "Update balance" }).click();
  await page.getByRole("button", { name: "Balance updated" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  if ((await cash.inputValue()) !== "5000.25") throw new Error("Manual balance did not survive reload");
  await page.getByLabel("Merchant or description").fill("Public fixture coffee");
  await page.locator("#manual-actual-amount").fill("12.34");
  await page.getByRole("button", { name: "Record charge" }).click();
  await page.getByRole("button", { name: "Charge recorded" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Public fixture coffee", { exact: true }).waitFor();
  await page.getByLabel("Name").fill("Phone bill");
  await page.locator("#manual-commitment-amount").fill("89.12");
  if ((await page.getByLabel("Due date").inputValue()) !== "") throw new Error("Custom commitment invented a due date");
  await page.getByLabel("Due date").fill("2026-09-08");
  await page.getByRole("button", { name: "Add to plan" }).click();
  await page.getByRole("button", { name: "Commitment added" }).waitFor();
  await page.getByRole("heading", { name: "Your commitments" }).waitFor();
  await page.getByText("Phone bill", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Phone bill" }).waitFor();
  await page.goto(`${baseUrl}/onboarding`, { waitUntil: "networkidle" });
  // The manual writes advanced the household revision, so the older
  // onboarding draft must not replay over canonical commitments.
  await page.getByRole("heading", { name: "Start with the numbers you have." }).waitFor();
  await page.getByRole("button", { name: /Set up your plan/ }).click();
  await page.getByRole("button", { name: /Enter everything manually/ }).click();
  await page
    .getByRole("heading", {
      name: "How much spendable cash is available today?",
    })
    .waitFor();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("heading", { name: "When is money coming in?" }).waitFor();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Phone bill due date").waitFor();
  if ((await page.getByLabel("Phone bill due date").inputValue()) !== "2026-09-08") throw new Error("Saved manual commitment did not carry its due date into onboarding");
  await page.goto(`${baseUrl}/plan`, { waitUntil: "networkidle" });
  await page.getByText("Phone bill", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Phone bill" }).click();
  await page.getByLabel("Name").fill("Mobile phone");
  await page.getByLabel("Expected amount").fill("90.12");
  await page.getByLabel("Due date").fill("2026-09-09");
  await page.getByRole("button", { name: "Save commitment" }).click();
  await page.getByText("Mobile phone", { exact: true }).waitFor();
  await page.getByText("$90.12", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name").fill("Flexible goal");
  await page.locator("#new-commitment-amount").fill("25");
  await page.getByRole("button", { name: "Add commitment" }).click();
  await page.getByText("Flexible goal", { exact: true }).waitFor();
  await page.getByText("Not reserved · add a due date", { exact: false }).waitFor();
  await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Upcoming" }).click();
  const phoneUpcoming = page.getByText("Mobile phone", { exact: true }).locator("..");
  await phoneUpcoming.waitFor();
  await phoneUpcoming.getByText("Sep 9", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByText("Plan inputs confirmed", { exact: true }).waitFor();
  await page.goto(`${baseUrl}/more`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Manual workspace/ }).waitFor();
  if (await page.getByText("Notifications", { exact: true }).count()) throw new Error("Inactive notification configuration remained in More");
  await page.goto(`${baseUrl}/review/not-a-case`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "This path does not match a Budgefi page." }).waitFor();
  if (errors.length) throw new Error(`Browser errors before offline simulation: ${errors.join(" | ")}`);
  errors.length = 0;
  await page.route(`${apiUrl}/v1/bootstrap`, (route) => route.abort("failed"));
  await page.goto(`${baseUrl}/today`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "We can’t load your money data" }).waitFor();
  if (await page.getByText("$5,000.25", { exact: true }).count()) throw new Error("Cached financial values remained visible after bootstrap failure");
  await page.unroute(`${apiUrl}/v1/bootstrap`);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByText("$5,000.25", { exact: true }).waitFor();
  process.stdout.write("Frontend E2E passed: first-login manual setup → explicit zero confirmation → honest loading → manual writes → commitment edit → real activity → More cleanup → 404 → offline recovery\n");
} finally {
  if (browser) await browser.close();
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  await Promise.all(children.map(waitForExit));
  if (databaseStarted) spawnSync(join(postgresBin, "pg_ctl"), ["-D", cluster, "-m", "fast", "-w", "stop"], { stdio: "inherit" });
  await rm(cluster, { recursive: true, force: true });
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function installedChromium() {
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return null;
  const entries = await readdir(cache, { recursive: true });
  const relative = entries.find((entry) => entry.endsWith("chrome-headless-shell-mac-arm64/chrome-headless-shell") || entry.endsWith("chrome-headless-shell-mac-x64/chrome-headless-shell"));
  return relative ? join(cache, relative) : null;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
