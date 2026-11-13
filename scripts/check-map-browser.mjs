// Read-only published-map browser check. Credentials stay in memory and are never logged.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 30000 });
const baseURL = process.env.TILWA_BASE_URL;
const codePath = process.env.TILWA_WORKSPACE_CODE_FILE;
if (!baseURL || !codePath)
  throw new Error("Set TILWA_BASE_URL and TILWA_WORKSPACE_CODE_FILE.");
const code = (await fs.readFile(codePath, "utf8")).trim();
const out = path.resolve(
  process.env.TILWA_MAP_OUTPUT || ".tilwa-private/browser/map-evidence",
);
await fs.mkdir(out, { recursive: true });
const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? {
      "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    }
  : {};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY } }
    : {}),
});
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1305, height: 936 },
  acceptDownloads: true,
});
const appOrigin = new URL(baseURL).origin;
await context.route(`${appOrigin}/**`, (route) =>
  route.continue({ headers: { ...route.request().headers(), ...headers } }),
);
const page = await context.newPage();
const report = {
  mode: "Real browser + Neon, published map only",
  at: new Date().toISOString(),
  checks: [],
  downloads: [],
  screenshots: [],
  errors: [],
  providerCalls: 0,
};
page.on("pageerror", (e) => report.errors.push(e.message));
page.on("request", (r) => {
  if (new URL(r.url()).pathname === "/api/tutor") report.providerCalls++;
});
function pass(name, detail = {}) {
  report.checks.push({ name, status: "passed", ...detail });
  console.log("PASS " + name);
}
async function shot(name) {
  const file = path.join(out, name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}
try {
  await page.goto("/");
  await page.getByLabel("رمز مساحة سابقة (اختياري)").fill(code);
  await page.getByRole("button", { name: /طالب.*دخول تجريبي/ }).click();
  await expect(
    page.getByRole("button", { name: "تسجيل الخروج", exact: true }),
  ).toBeVisible();
  const workspace = await (
    await context.request.get("/api/workspace", { headers })
  ).json();
  assert.equal(workspace.mode, "neon");
  const response = await context.request.get("/api/knowledge/map", { headers });
  assert(response.ok(), "Published map API must succeed");
  const map = await response.json();
  assert.equal(map.status, "published");
  assert(
    map.concepts.length > 12,
    "This test requires the complete map, not the old twelve-node fixture",
  );
  assert.equal(map.coverage.length, 6);
  assert.equal(map.totals.reviewedPages, 137);
  assert(map.coverage.every((c) => c.status === "complete"));
  assert(
    map.concepts.every(
      (c) =>
        c.status === "approved" &&
        c.lectureEvidence.length &&
        c.umbrellaEvidence.length,
    ),
  );
  assert(
    map.coverage.every((c) => c.conceptCount > 0),
    "Each real lecture must contribute concepts",
  );
  report.releaseId = map.releaseId;
  report.concepts = map.concepts.length;
  report.relationships = map.edges.length;
  await page
    .getByRole("button", { name: "خريطة المفاهيم", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "خريطة المفاهيم الكاملة" }),
  ).toBeVisible();
  await expect(page.locator(".concept-choice")).toHaveCount(
    map.concepts.length,
  );
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  pass("All published concepts render without the former twelve-node cap", {
    concepts: map.concepts.length,
    edges: map.edges.length,
  });
  for (let i = 1; i <= 6; i++) {
    const key = `CET351-L${i}`;
    const expected = map.concepts.filter((c) =>
      c.lectureEvidence.some((e) => e.sourceKey === key),
    );
    await page
      .locator(".lecture-filters")
      .getByRole("button")
      .filter({ hasText: new RegExp(`^L${i}`) })
      .click();
    await expect(page.locator(".concept-choice")).toHaveCount(expected.length);
    await expect(page.locator(".concept-inspector h2")).toContainText(
      expected[0].label.ar,
    );
  }
  pass(
    "L1–L6 filters show every matching concept and select a matching detail",
  );
  await page
    .locator(".lecture-filters")
    .getByRole("button")
    .filter({ hasText: "كل المحاضرات" })
    .click();
  const concept =
    map.concepts.find(
      (c) =>
        c.status === "approved" &&
        c.lectureEvidence.length &&
        c.umbrellaEvidence.length &&
        /recall/i.test(c.label.en),
    ) ||
    map.concepts.find(
      (c) =>
        c.status === "approved" &&
        c.lectureEvidence.length &&
        c.umbrellaEvidence.length,
    );
  assert(concept, "An approved concept must have both source types");
  const search = page.getByRole("textbox", {
    name: "بحث المفاهيم",
    exact: true,
  });
  await search.fill(concept.label.en);
  await expect(
    page.locator(".concept-choice").filter({ hasText: concept.label.ar }),
  ).toBeVisible();
  await search.fill(concept.label.ar);
  await page
    .locator(".concept-choice")
    .filter({ hasText: concept.label.en })
    .first()
    .click();
  await expect(page.locator(".concept-inspector h2")).toContainText(
    concept.label.ar,
  );
  await expect(
    page.locator('.concept-inspector a[href*="?page="]').first(),
  ).toBeVisible();
  await expect(
    page.locator('.concept-inspector a[href*="?section="]').first(),
  ).toBeVisible();
  for (const source of [
    concept.lectureEvidence[0],
    concept.umbrellaEvidence[0],
  ]) {
    const viewer = await context.newPage();
    await viewer.goto(
      `/sources/${source.versionId}?${source.page ? `page=${source.page}` : `section=${encodeURIComponent(source.section)}`}`,
    );
    await expect(viewer.locator("blockquote")).not.toBeEmpty();
    await viewer.close();
  }
  pass(
    "Arabic and English search select a concept with working exact lecture and Umbrella locators",
  );
  await search.fill("");
  await page.getByRole("button", { name: "قائمة ميسّرة", exact: true }).click();
  await expect(page.locator(".map-table tbody tr")).toHaveCount(
    map.concepts.length,
  );
  pass("Accessible table contains the complete published concept map");
  await page.getByRole("button", { name: "استكشاف", exact: true }).click();
  await shot("concept-map-desktop-ar");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { name: "The complete concept map" }),
  ).toBeVisible();
  await expect(page.locator(".concept-inspector h2")).toContainText(
    concept.label.en,
  );
  await shot("concept-map-desktop-en");
  pass("English/LTR retains the selected concept and map state");
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 1508 });
  assert(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390,
    "Map must not cause horizontal viewport overflow",
  );
  await shot("concept-map-mobile-ar");
  pass(
    "Arabic mobile map renders at 390px without horizontal viewport overflow",
  );
  await page.setViewportSize({ width: 1305, height: 936 });
  await page
    .locator(".lecture-filters")
    .getByRole("button")
    .filter({ hasText: /^L1/ })
    .click();
  for (const [label, extension] of [
    ["JSON", "json"],
    ["CSV", "csv"],
    ["تقرير ثنائي اللغة", "html"],
  ]) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const download = await downloadPromise;
    const output = path.join(out, `Tilwa-CET351-approved-map.${extension}`);
    await download.saveAs(output);
    report.downloads.push(output);
  }
  const exported = JSON.parse(
    await fs.readFile(path.join(out, "Tilwa-CET351-approved-map.json"), "utf8"),
  );
  const approved = map.concepts.filter((c) => c.status === "approved");
  assert.equal(exported.concepts.length, approved.length);
  assert.equal(exported.pages.length, 137);
  assert.equal(
    exported.edges.length,
    map.edges.filter(
      (e) =>
        e.status === "approved" &&
        approved.some((c) => c.id === e.from) &&
        approved.some((c) => c.id === e.to),
    ).length,
  );
  const origin = new URL(baseURL).origin;
  for (const c of exported.concepts)
    for (const s of [...c.lectureEvidence, ...c.umbrellaEvidence])
      assert(s.url.startsWith(origin + "/sources/"));
  const forbiddenKeys = new Set([
    "key",
    "answerKey",
    "text_content",
    "passage",
    "sourceText",
    "rubric",
  ]);
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenKeys.has(key), `Private property ${key} in export`);
      inspect(child);
    }
  }
  inspect(exported);
  assert(
    (
      await fs.readFile(path.join(out, "Tilwa-CET351-approved-map.csv"), "utf8")
    ).includes("coverage_level"),
  );
  const reportPage = await context.newPage();
  await reportPage.goto(
    pathToFileURL(path.join(out, "Tilwa-CET351-approved-map.html")).href,
  );
  await expect(reportPage.locator("article[id]")).toHaveCount(approved.length);
  assert.equal(
    await reportPage.locator('a[href^="/sources/"]').count(),
    0,
    "Offline report must use absolute Preview URLs",
  );
  await reportPage.close();
  pass(
    "Filtered UI exports the entire approved map as JSON, CSV and bilingual HTML with absolute source URLs and no private source text/keys",
    {
      approvedConcepts: exported.concepts.length,
      approvedRelationships: exported.edges.length,
    },
  );
  assert.equal(report.errors.length, 0);
  assert.equal(report.providerCalls, 0);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.message).replaceAll(code, "[redacted]");
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log("Report: .tilwa-private/browser/map-evidence/report.json");
}
