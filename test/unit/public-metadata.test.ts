import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("public discovery and brand surface", () => {
  it("ships complete, truthful root metadata and crawlable fallback content", () => {
    const html = read("index.html");
    expect(html).toContain('<link rel="canonical" href="https://budgefi.com/"');
    expect(html).toContain('property="og:image" content="https://budgefi.com/social-card.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('name="robots" content="index, follow"');
    expect(html).toContain('"@type": "WebApplication"');
    expect(html).not.toMatch(/ratingValue|reviewCount|customer|"price"/i);
    expect(html).toContain("Finding the charge is the easy part.");
    expect(html).toContain('href="/privacy.html"');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain("html,body,#root{min-height:100%;background:#f3eedf");
    expect(html).toContain(".app-boot{min-height:100vh;min-height:100dvh;background:#f3eedf");
  });

  it("keeps only intentional public pages in discovery files", () => {
    const robots = read("public/robots.txt");
    const sitemap = read("public/sitemap.xml");
    expect(robots).toContain("Disallow: /onboarding");
    expect(robots).toContain("Disallow: /today");
    expect(robots).toContain("Sitemap: https://budgefi.com/sitemap.xml");
    expect(sitemap).toContain("https://budgefi.com/privacy.html");
    expect(sitemap).toContain("https://budgefi.com/terms.html");
    expect(sitemap).not.toMatch(/\/today|\/sign-in|\/onboarding/);
  });

  it("serves only known SPA routes and leaves unknown paths as real 404s", () => {
    const config = read("netlify.toml");
    expect(config).not.toContain('from = "/*"');
    expect(config).toContain('from = "/review/*"');
    expect(config).toContain('from = "/settings/*"');
    expect(config).toContain('X-Robots-Tag = "noindex, nofollow"');
    expect(read("public/404.html")).toContain('name="robots" content="noindex, nofollow"');
  });

  it("uses the canonical in-app Budgefi mark and contains no default Android mascot art", () => {
    const source = read("assets/brand/budgefi-mark.svg");
    const component = read("src/components/brand.tsx");
    const android = read("android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml");
    expect(source).toContain("folded lowercase b mark");
    expect(component).toContain('assets/brand/budgefi-mark.svg');
    expect(android).toContain("M5,3h10v10h6.5");
    expect(android).not.toMatch(/M66\.94,46\.02|#FFFFFF/);

    const iosIcon = readFileSync("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(iosIcon.subarray(1, 4).toString()).toBe("PNG");
    expect(iosIcon[25]).toBe(2);
  });

  it("links all public and auth legal labels to actual documents", () => {
    const landing = read("src/pages/landing.tsx");
    const auth = read("src/pages/auth.tsx");
    expect(landing).toContain('href="/privacy.html"');
    expect(landing).toContain('href="/terms.html"');
    expect(auth).toContain('href="/privacy.html"');
    expect(auth).toContain('href="/terms.html"');
  });

  it("embeds Clerk routes and isolates financial state by concrete session", () => {
    const auth = read("src/pages/auth.tsx");
    const provider = read("src/components/clerk-provider-active.tsx");
    const routes = read("src/App.tsx");
    expect(auth).toContain('<SignIn\n            routing="path"');
    expect(auth).toContain('<SignUp\n            routing="path"');
    expect(auth).not.toContain('@clerk/react/legacy');
    expect(provider).toContain('key={isSignedIn && sessionId ? sessionId : "anonymous"}');
    expect(routes).toContain('path="/native-auth/*"');
  });
});
