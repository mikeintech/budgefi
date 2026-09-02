import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const applePath = resolve(root, "public/.well-known/apple-app-site-association");
const androidPath = resolve(root, "public/.well-known/assetlinks.json");
const checking = process.argv.includes("--check");
const optional = process.argv.includes("--if-configured");
const teamId = process.env.APPLE_TEAM_ID?.trim();
const fingerprints = (process.env.ANDROID_SHA256_FINGERPRINTS ?? process.env.ANDROID_SHA256_FINGERPRINT ?? "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);

if (checking) {
  if (!existsSync(applePath) || !existsSync(androidPath)) {
    console.error("Final association files are absent. Configure signing identifiers and run npm run app-links:generate.");
    process.exit(1);
  }
  validateApple(JSON.parse(readFileSync(applePath, "utf8")));
  validateAndroid(JSON.parse(readFileSync(androidPath, "utf8")));
  console.log("Apple Universal Links and Android App Links files verified.");
  process.exit(0);
}

if (!teamId && fingerprints.length === 0 && optional) {
  console.log("Native association identifiers are not configured; skipping association-file generation.");
  process.exit(0);
}

if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) {
  console.error("APPLE_TEAM_ID must be the 10-character Apple Developer Team ID.");
  process.exit(1);
}
if (fingerprints.length === 0 || fingerprints.some((value) => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))) {
  console.error("ANDROID_SHA256_FINGERPRINTS must contain one or more colon-delimited release signing SHA-256 fingerprints.");
  process.exit(1);
}

const apple = {
  applinks: {
    details: [
      {
        appIDs: [`${teamId}.com.budgefi.app`],
        components: [
          { "/": "/open/*" },
          { "/": "/today" },
          { "/": "/review*" },
          { "/": "/plan" },
          { "/": "/activity" },
          { "/": "/more" },
          { "/": "/connections*" },
          { "/": "/manual*" },
          { "/": "/settings*" },
        ],
      },
    ],
  },
};
const android = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.budgefi.app",
      sha256_cert_fingerprints: fingerprints,
    },
  },
];

validateApple(apple);
validateAndroid(android);
writeFileSync(applePath, `${JSON.stringify(apple)}\n`);
writeFileSync(androidPath, `${JSON.stringify(android)}\n`);
console.log("Generated production association files for com.budgefi.app.");

function validateApple(value) {
  const appId = value?.applinks?.details?.[0]?.appIDs?.[0];
  if (!/^[A-Z0-9]{10}\.com\.budgefi\.app$/.test(appId ?? "")) throw new Error("Invalid Apple app association.");
}

function validateAndroid(value) {
  const target = value?.[0]?.target;
  if (target?.package_name !== "com.budgefi.app") throw new Error("Invalid Android package association.");
  if (!Array.isArray(target.sha256_cert_fingerprints) || target.sha256_cert_fingerprints.length === 0) throw new Error("Missing Android signing fingerprint.");
}
