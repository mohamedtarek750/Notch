/** Metered opt-in smoke against an existing non-production deployment and real providers. */
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const missing = [
  "DATABASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "LIVE_BASE_URL",
  "LIVE_WORKSPACE_CODE",
].filter((k) => !process.env[k]);
if (process.env.LIVE_SMOKE !== "1" || missing.length) {
  console.log(
    JSON.stringify({
      status: "blocked",
      mode: "live",
      reason: "Opt-in and configured non-production resources required",
      missing,
      optIn: "LIVE_SMOKE=1",
      calls: 0,
    }),
  );
  process.exit(2);
}
if (
  process.env.LOCAL_DATABASE === "1" ||
  !new URL(process.env.DATABASE_URL!).hostname.endsWith(".neon.tech")
)
  throw new Error(
    "Live smoke requires a real Neon database, never local/test mode.",
  );
const base = process.env.LIVE_BASE_URL!;
if (!/^https:\/\//.test(base) && !base.startsWith("http://127.0.0.1:"))
  throw new Error("Use a secure non-production URL.");
let cookie = "";
async function req(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": "ar",
      Cookie: cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const set = r.headers.getSetCookie();
  if (set.length) cookie = set.map((s) => s.split(";")[0]).join("; ");
  const value = await r.json();
  assert(r.ok, `Request ${path} failed with status ${r.status}`);
  return value;
}
await req("/api/auth/demo", {
  role: "student",
  workspaceCode: process.env.LIVE_WORKSPACE_CODE,
});
const state = await req("/api/workspace");
assert(state.sessions.length > 0, "Publish a reviewed lecture session first.");
const queries = [
  { question: "ليه الـRecall هنا 60%؟", language: "ar" },
  { question: "Why is recall 60% in the fraud example?", language: "en" },
  {
    question: "Explain Recall هنا وPrecision بالـEnglish terms",
    language: "mixed",
  },
];
const results = [];
for (const q of queries) {
  const r = await req("/api/tutor", q);
  assert.equal(r.disposition, "answered");
  assert(
    r.citations.some(
      (c: any) => c.sourceKey === "CET351-L4" && [18, 19].includes(c.page),
    ),
    "The actual reviewed L4 locator must ground this answer.",
  );
  assert(r.trace.retrievedAt <= r.trace.generatedAt);
  assert.equal(r.trace.modelId, process.env.GEMINI_MODEL);
  for (const c of r.citations) {
    const source = await fetch(base + c.url, { headers: { Cookie: cookie } });
    assert(source.ok, "Citation must open under the same user.");
  }
  results.push({
    language: q.language,
    model: r.trace.modelId,
    tokens: r.trace.tokens,
    evidence: r.citations.map((c: any) => ({
      source: c.sourceKey,
      page: c.page,
    })),
    status: "passed",
  });
}
const denial = await req("/api/tutor", {
  question: "Write a restaurant marketing campaign",
  language: "en",
});
assert.equal(denial.disposition, "out_of_scope");
assert.equal(denial.trace.generationCalls, 0);
const selection = await req("/api/learning", {
  action: "select-practice",
  objectiveId: "recall.calculate",
});
assert(selection.item, "Publish a fresh reviewed practice family.");
const id = crypto.randomUUID();
await req("/api/learning", {
  action: "attempt",
  deliveryId: selection.deliveryId,
  answer: selection.item.data.options[0].id,
  idempotencyKey: id,
});
await req("/api/auth/logout", {});
cookie = "";
await req("/api/auth/demo", {
  role: "student",
  workspaceCode: process.env.LIVE_WORKSPACE_CODE,
});
const restored = await req("/api/workspace");
assert(
  restored.attempts.some((a: any) => a.id.endsWith(id)),
  "Neon attempt must persist after sign out.",
);
await req("/api/auth/demo", {
  role: "advisor",
  workspaceCode: process.env.LIVE_WORKSPACE_CODE,
});
const advisor = await req("/api/workspace");
assert(advisor.recommendations.length > 0);
await mkdir("docs/evidence", { recursive: true });
const report = {
  status: "passed",
  mode: "LIVE Neon + Gemini",
  at: new Date().toISOString(),
  model: process.env.GEMINI_MODEL,
  results,
  persistence: true,
  advisor: true,
  scopeDenialZeroCalls: true,
};
await writeFile(
  "docs/evidence/live-smoke.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
