import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = "assets/brand/budgefi-mark.svg";
const manifestPath = "assets/brand/generated-assets.json";
const source = readFileSync(resolve(root, sourcePath), "utf8");
const markPaths = [...source.matchAll(/<path\b[^>]*\/>/g)]
  .map(([path]) => path)
  .join("\n    ");

const textOutputs = new Map([
  ["public/brand/budgefi-mark.svg", source],
  ["public/favicon.svg", iconSvg(64, 64, 0.72, true)],
  ["assets/icon-only.svg", iconSvg(1024, 1024, 12, true)],
  ["assets/splash.svg", splashSvg()],
  ["public/social-card.svg", socialCardSvg()],
  ["android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml", androidVector("#3155C6")],
  ["android/app/src/main/res/drawable/ic_launcher_monochrome.xml", androidVector("#000000")],
  ["android/app/src/main/res/drawable/ic_launcher_background.xml", androidBackgroundVector()],
  ["android/app/src/main/res/values/ic_launcher_background.xml", androidBackgroundColor()],
  ["android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", androidAdaptiveIcon()],
  ["android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml", androidAdaptiveIcon()],
]);

const rasterOutputs = [
  ["public/favicon.svg", "public/favicon-32x32.png", "32x32"],
  ["assets/icon-only.svg", "public/apple-touch-icon.png", "180x180"],
  ["assets/icon-only.svg", "public/icons/icon-192.png", "192x192"],
  ["assets/icon-only.svg", "public/icons/icon-512.png", "512x512"],
  ["assets/icon-only.svg", "public/icons/icon-maskable-512.png", "512x512"],
  ["public/social-card.svg", "public/social-card.png", "1200x630"],
  ["assets/icon-only.svg", "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", "1024x1024"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png", "2732x2732"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png", "2732x2732"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png", "2732x2732"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/Default@1x~universal~anyany.png", "2732x2732"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/Default@2x~universal~anyany.png", "2732x2732"],
  ["assets/splash.svg", "ios/App/App/Assets.xcassets/Splash.imageset/Default@3x~universal~anyany.png", "2732x2732"],
];

const androidIconSizes = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(androidIconSizes)) {
  rasterOutputs.push(["assets/icon-only.svg", `android/app/src/main/res/mipmap-${density}/ic_launcher.png`, `${size}x${size}`]);
  rasterOutputs.push(["assets/icon-only.svg", `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, `${size}x${size}`]);
}

const androidForegroundSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [density, size] of Object.entries(androidForegroundSizes)) {
  rasterOutputs.push(["assets/icon-only.svg", `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, `${size}x${size}`]);
}

const androidSplashSizes = {
  "drawable": [480, 800],
  "drawable-land-ldpi": [320, 240],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [800, 480],
  "drawable-land-xhdpi": [1280, 720],
  "drawable-land-xxhdpi": [1600, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
  "drawable-port-ldpi": [240, 320],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 800],
  "drawable-port-xhdpi": [720, 1280],
  "drawable-port-xxhdpi": [960, 1600],
  "drawable-port-xxxhdpi": [1280, 1920],
};
for (const [directory, [width, height]] of Object.entries(androidSplashSizes)) {
  rasterOutputs.push(["assets/splash.svg", `android/app/src/main/res/${directory}/splash.png`, `${width}x${height}`]);
}

const generatedPaths = [
  ...textOutputs.keys(),
  ...rasterOutputs.map(([, output]) => output),
  "public/favicon.ico",
];

if (process.argv.includes("--check")) {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), "utf8"));
  const actual = buildManifest();
  if (JSON.stringify(manifest) !== JSON.stringify(actual)) {
    console.error("Brand assets have drifted. Run npm run brand:generate and review the generated files.");
    process.exit(1);
  }
  console.log(`Brand assets verified (${generatedPaths.length} outputs).`);
  process.exit(0);
}

try {
  execFileSync("magick", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ImageMagick 7 is required to generate Budgefi brand assets. Install it, then rerun npm run brand:generate.");
  process.exit(1);
}

for (const [path, content] of textOutputs) write(path, content);
for (const [input, output, size] of rasterOutputs) {
  ensureDirectory(output);
  const args = [resolve(root, input), "-background", "none", "-resize", `${size}!`, "-strip"];
  if (output.includes("AppIcon.appiconset")) args.push("-alpha", "off", "-type", "TrueColor");
  args.push(resolve(root, output));
  execFileSync("magick", args);
}
ensureDirectory("public/favicon.ico");
execFileSync("magick", [resolve(root, "public/favicon.svg"), "-background", "none", "-define", "icon:auto-resize=16,32,48", "-strip", resolve(root, "public/favicon.ico")]);
write(manifestPath, `${JSON.stringify(buildManifest(), null, 2)}\n`);
console.log(`Generated ${generatedPaths.length} brand assets from ${sourcePath}.`);

function write(path, content) {
  ensureDirectory(path);
  writeFileSync(resolve(root, path), content.endsWith("\n") ? content : `${content}\n`);
}

function ensureDirectory(path) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
}

function hash(path) {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}

function buildManifest() {
  return {
    source: sourcePath,
    sourceSha256: hash(sourcePath),
    outputs: Object.fromEntries([...generatedPaths].sort().map((path) => [path, hash(path)])),
  };
}

function iconSvg(width, height, scale, background) {
  const translateX = width === 64 ? 1.8 : 122;
  const translateY = width === 64 ? 4.1 : 152;
  const actualScale = width === 64 ? 1.55 : 20;
  const radius = width === 64 ? 14 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${background ? `<rect width="${width}" height="${height}" rx="${radius}" fill="#F3EEDF"/>` : ""}
  <g transform="translate(${translateX} ${translateY}) scale(${actualScale})">
    ${markPaths}
  </g>
</svg>`;
}

function splashSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="#F3EEDF"/>
  <g transform="translate(1041 1066) scale(16.6667)">
    ${markPaths}
  </g>
</svg>`;
}

function socialCardSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#F3EEDF"/>
  <rect x="64" y="55" width="1072" height="520" rx="34" fill="#FFFCF4" stroke="#C9C5B9" stroke-width="2"/>
  <g transform="translate(107 92) scale(2.15)">${markPaths}</g>
  <text x="196" y="150" fill="#191C1B" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="700">budgefi</text>
  <text x="108" y="280" fill="#191C1B" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700">Financial clarity</text>
  <text x="108" y="354" fill="#191C1B" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700">you can trace.</text>
  <text x="110" y="418" fill="#565B57" font-family="Arial, Helvetica, sans-serif" font-size="26">Cash planning · account coverage · unusual-charge review</text>
  <g transform="translate(830 194)">
    <rect width="240" height="264" rx="26" fill="#3155C6"/><rect x="22" y="24" width="196" height="46" rx="12" fill="#FFFCF4"/><circle cx="49" cy="47" r="10" fill="#DDF07A"/><rect x="70" y="39" width="107" height="7" rx="3.5" fill="#191C1B" opacity=".72"/><rect x="70" y="52" width="76" height="5" rx="2.5" fill="#565B57" opacity=".5"/>
    <rect x="22" y="84" width="196" height="66" rx="12" fill="#FFFCF4"/><rect x="39" y="103" width="105" height="7" rx="3.5" fill="#191C1B" opacity=".72"/><rect x="39" y="118" width="148" height="5" rx="2.5" fill="#565B57" opacity=".48"/><rect x="39" y="132" width="75" height="5" rx="2.5" fill="#A63E31" opacity=".8"/>
    <rect x="22" y="164" width="196" height="76" rx="12" fill="#191C1B"/><rect x="39" y="184" width="77" height="6" rx="3" fill="#DDF07A"/><rect x="39" y="202" width="133" height="10" rx="5" fill="#FFFCF4"/><rect x="39" y="220" width="96" height="5" rx="2.5" fill="#FFFCF4" opacity=".45"/>
  </g>
</svg>`;
}

function androidVector(color) {
  const primary = color === "#000000" ? color : "#3155C6";
  const secondary = color === "#000000" ? color : "#5574D7";
  const cutout = color === "#000000" ? color : "#FFFCF4";
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <group android:translateX="19" android:translateY="22" android:scaleX="1.8" android:scaleY="1.8">
    <path android:pathData="M5,3h10v10h6.5C29,13 34,17.5 34,24s-5,9 -12.5,9H5V3 M15,20.5V27h6.5c3.8,0 6.5,-1.1 6.5,-3.3 0,-2.1 -2.7,-3.2 -6.5,-3.2H15Z" android:fillColor="${primary}" android:fillType="evenOdd"/>
    <path android:pathData="M5,3h10v10L5,18V3Z" android:fillColor="${secondary}"/>
    <path android:pathData="M15,13l5.2,7.5H15V13Z" android:fillColor="${cutout}"/>
  </group>
</vector>`;
}

function androidBackgroundColor() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources><color name="ic_launcher_background">#F3EEDF</color></resources>`;
}

function androidBackgroundVector() {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#F3EEDF" android:pathData="M0,0h108v108h-108z"/>
</vector>`;
}

function androidAdaptiveIcon() {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@drawable/ic_launcher_foreground"/>
  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>`;
}
