/** Opt-in, metered acceptance against an existing NON-PRODUCTION Neon + Gemini target.
 * Does not import, generate teaching items, publish content, or deploy resources.
 * Re-running resumes validated language checkpoints; LIVE_SMOKE_FRESH=1 starts a new run.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { db } from "../src/server/db";

const required = [
  "DATABASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "LIVE_BASE_URL",
  "LIVE_WORKSPACE_CODE",
];
const missing = required.filter((k) => !process.env[k]);
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
if (process.env.TILWA_ENV === "production")
  throw new Error("Live smoke is restricted to non-production.");
const baseUrl = new URL(process.env.LIVE_BASE_URL!);
if (
  baseUrl.username ||
  baseUrl.password ||
  baseUrl.search ||
  baseUrl.hash ||
  baseUrl.pathname !== "/"
)
  throw new Error(
    "LIVE_BASE_URL must be an origin, without credentials, path, query or fragment.",
  );
if (
  baseUrl.protocol !== "https:" &&
  !(
    baseUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(baseUrl.hostname)
  )
)
  throw new Error(
    "Use a secure non-production URL or local development server.",
  );
const base = baseUrl.origin;
const fingerprint = createHash("sha256")
  .update(
    [base, process.env.GEMINI_MODEL, process.env.LIVE_WORKSPACE_CODE].join(
      "\0",
    ),
  )
  .digest("hex")
  .slice(0, 24);
const checkpointPath = `.tilwa-private/live-smoke-${fingerprint}.json`;
type Client = { cookies: Map<string, string> };
type LanguageResult = {
  language: string;
  requestId: string;
  model: string;
  tokens: number;
  generationCalls: 1;
  status: "passed";
  evidence: { source: string; page: number | null; section?: string | null }[];
};
type Checkpoint = {
  version: 2;
  runId: string;
  startedAt: string;
  results: LanguageResult[];
  selection?: {
    deliveryId: string;
    itemId: string;
    familyId: string;
    objectiveId: string;
    attemptKey: string;
  };
  attemptId?: string;
  completedAt?: string;
};
const client = (): Client => ({ cookies: new Map() });
const cookieHeader = (c: Client) =>
  [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const student = client(),
  instructor = client(),
  secondStudent = client(),
  advisor = client(),
  unrelatedAdvisor = client();
let currentStep = "preflight",
  newGenerationCalls = 0,
  examStarted = false;
let activeTenant = "",
  studentId = "";
let checkpoint: Checkpoint = {
  version: 2,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  results: [],
};
const checks: {
  name: string;
  status: "passed";
  details?: Record<string, unknown>;
}[] = [];
function passed(name: string, details?: Record<string, unknown>) {
  checks.push({ name, status: "passed", details });
}
async function saveCheckpoint() {
  await mkdir(".tilwa-private", { recursive: true });
  const tmp = checkpointPath + ".tmp";
  await writeFile(tmp, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  await rename(tmp, checkpointPath);
}
async function req(
  c: Client,
  path: string,
  body?: unknown,
  expected = 200,
  language = "ar",
) {
  assert(
    path.startsWith("/") && !path.startsWith("//"),
    "API path must stay on the configured origin.",
  );
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": language,
      Origin: base,
      Cookie: cookieHeader(c),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
    redirect: "manual",
  });
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(";")[0],
      index = first.indexOf("=");
    if (index > 0) c.cookies.set(first.slice(0, index), first.slice(index + 1));
  }
  assert.equal(
    response.status,
    expected,
    `Request ${path} returned HTTP ${response.status}; expected ${expected}.`,
  );
  return response.json();
}
async function login(
  c: Client,
  role: "student" | "instructor" | "advisor",
  workspaceCode: string | null | undefined = process.env.LIVE_WORKSPACE_CODE,
) {
  const result = await req(c, "/api/auth/demo", {
    role,
    ...(workspaceCode ? { workspaceCode } : {}),
  });
  assert.equal(result.mode, "sandbox");
  assert.equal(result.synthetic, true);
  assert.equal(result.user.role, role);
  return result.user;
}
async function traceCounts() {
  const row = (
    await db
      .tenant(activeTenant)
      .query<{ n: number }>(
        "SELECT count(*)::int n FROM model_traces WHERE tenant_id=$1 AND user_id=$2 AND generated_at IS NOT NULL",
        [activeTenant, studentId],
      )
  ).rows[0];
  return row.n;
}
async function persistedTrace(id: string) {
  const row = (
    await db.tenant(activeTenant).query<{
      id: string;
      user_id: string;
      model_id: string;
      outcome: string;
      tokens: number;
      retrieved_at: Date;
      generated_at: Date;
    }>("SELECT id,user_id,model_id,outcome,tokens,retrieved_at,generated_at FROM model_traces WHERE tenant_id=$1 AND id=$2", [activeTenant, id])
  ).rows[0];
  assert(
    row,
    "The HTTP tutor trace must exist in the configured Neon database.",
  );
  assert.equal(row.user_id, studentId);
  assert.equal(row.outcome, "answered");
  assert.equal(row.model_id, process.env.GEMINI_MODEL);
  assert(
    row.tokens > 0,
    "A live generation must have measured provider tokens.",
  );
  assert(
    row.generated_at &&
      row.retrieved_at &&
      new Date(row.retrieved_at).getTime() <=
        new Date(row.generated_at).getTime(),
    "Persisted retrieval must precede generation.",
  );
  return row;
}
async function validateCitation(c: any) {
  const url = new URL(c.url, base);
  assert.equal(
    url.origin,
    base,
    "Citation must stay within authenticated material storage.",
  );
  const response = await fetch(url, {
    headers: { Cookie: cookieHeader(student) },
    signal: AbortSignal.timeout(30000),
    redirect: "manual",
  });
  assert.equal(
    response.status,
    200,
    "Citation must open without login redirects.",
  );
  const row = (
    await db.tenant(activeTenant).query<{
      text_content: string;
      page: number | null;
      section: string | null;
      source_key: string;
      status: string;
      current_version: boolean;
    }>("SELECT c.text_content,c.page,c.section,c.status,v.source_key,v.current_version FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.id=$2 AND c.course_id='CET351'", [activeTenant, c.id])
  ).rows[0];
  assert(
    row && row.status === "approved" && row.current_version,
    "Citation must resolve to current approved Neon evidence.",
  );
  assert.equal(row.source_key, c.sourceKey);
  assert.equal(row.page, c.page);
  assert(
    typeof c.text === "string" &&
      c.text.length > 0 &&
      row.text_content.startsWith(c.text),
    "The minimal retrieved excerpt must be an exact span of the persisted source.",
  );
}
function normalizedNumbers(value: string) {
  return value
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[٫،]/g, ".")
    .replace(/٪/g, "%");
}
function verifyMath(answer: string, language: string) {
  const normalized = normalizedNumbers(answer);
  // These prompts request this exact reviewed matrix, so a citation-only answer is insufficient.
  const percentages = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(
    (m) => Number(m[1]),
  );
  assert(
    percentages.some((p) => Math.abs(p - 60) < 0.01),
    `${language}: the reviewed Recall result must be 60%.`,
  );
  assert(
    percentages.some((p) => Math.abs(p - (6 / 26) * 100) < 0.15),
    `${language}: the corresponding Precision result must be approximately 23.1%.`,
  );
  assert(
    /\b6\b/.test(normalized) &&
      /\b4\b/.test(normalized) &&
      /\b20\b/.test(normalized),
    `${language}: explain the TP=6, FN=4, FP=20 counts.`,
  );
}
async function main() {
  if (process.env.LIVE_SMOKE_FRESH !== "1") {
    try {
      const previous = JSON.parse(await readFile(checkpointPath, "utf8"));
      if (previous.version === 2) checkpoint = previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const identity = await login(student, "student");
  activeTenant = identity.tenantId;
  studentId = identity.userId;
  const instructorIdentity = await login(instructor, "instructor");
  assert.equal(instructorIdentity.tenantId, activeTenant);
  const state = await req(student, "/api/workspace");
  assert.equal(
    state.mode,
    "neon",
    "Application must explicitly use Neon, not local storage.",
  );
  assert.equal(
    state.examMode,
    false,
    "Finish the existing exam before starting a live smoke; the script will not end an unrelated exam.",
  );
  const publishedSession = state.sessions.find(
    (r: any) =>
      r.data.approved === true &&
      r.data.fixture === false &&
      r.data.graphVersion,
  );
  assert(
    publishedSession,
    "Publish a nonfixture, instructor-reviewed lecture session before running live smoke.",
  );
  const staffState = await req(instructor, "/api/workspace");
  assert(
    staffState.items.some(
      (r: any) =>
        r.data.approved === true &&
        r.data.fixture === false &&
        !r.data.protected,
    ),
    "Publish at least one nonfixture reviewed practice item.",
  );
  const session = await db
    .tenant(activeTenant)
    .query(
      "SELECT id FROM records WHERE tenant_id=$1 AND id=$2 AND kind='session' AND data->>'approved'='true' AND data->>'fixture'='false'",
      [activeTenant, publishedSession.id],
    );
  assert.equal(session.rows.length, 1);
  passed("neon-backed-published-session", {
    sessionId: publishedSession.id,
    graphVersion: publishedSession.data.graphVersion,
  });
  await req(student, "/api/learning", {
    action: "complete-session",
    sessionId: publishedSession.id,
  });
  const queries = [
    {
      question:
        "ليه الـRecall هنا 60%؟ اشرح أرقام مثال الاحتيال TP=6 وFN=4 وFP=20 واحسب Precision كمان.",
      language: "ar",
    },
    {
      question:
        "Why is Recall 60% in the fraud example, with TP=6, FN=4 and FP=20? Calculate Precision too.",
      language: "en",
    },
    {
      question:
        "Explain Recall هنا ليه 60% مع TP=6 وFN=4 وFP=20، واحسب Precision بالـEnglish terms.",
      language: "mixed",
    },
  ];
  for (const q of queries) {
    currentStep = `tutor-${q.language}`;
    const cached = checkpoint.results.find((r) => r.language === q.language);
    if (cached) {
      await persistedTrace(cached.requestId);
      continue;
    }
    assert(
      newGenerationCalls < 3,
      "This invocation is limited to three tutor calls.",
    );
    const r = await req(
      student,
      "/api/tutor",
      q,
      200,
      q.language === "en" ? "en" : "ar",
    );
    newGenerationCalls++;
    assert.equal(
      r.disposition,
      "answered",
      `${q.language}: provider fallback, refusal and invalid output are not a live pass.`,
    );
    assert.equal(r.trace?.outcome, "answered");
    assert.equal(r.trace?.generationCalls, 1);
    assert.equal(r.trace?.modelId, process.env.GEMINI_MODEL);
    assert(
      !r.trace?.providerStatus,
      "A static/provider outage fallback cannot pass live acceptance.",
    );
    assert(r.trace.tokens > 0);
    assert(
      new Date(r.trace.retrievedAt).getTime() <=
        new Date(r.trace.generatedAt).getTime(),
    );
    assert(
      r.citations.some(
        (c: any) => c.sourceKey === "CET351-L4" && [18, 19].includes(c.page),
      ),
      "The actual reviewed L4 pages 18–19 must ground the answer.",
    );
    verifyMath(r.answer, q.language);
    await persistedTrace(r.trace.id);
    for (const citation of r.citations) await validateCitation(citation);
    checkpoint.results.push({
      language: q.language,
      requestId: r.trace.id,
      model: r.trace.modelId,
      tokens: r.trace.tokens,
      generationCalls: 1,
      evidence: r.citations.map((c: any) => ({
        source: c.sourceKey,
        page: c.page,
        section: c.section,
      })),
      status: "passed",
    });
    await saveCheckpoint();
  }
  passed("real-gemini-three-languages", {
    languages: checkpoint.results.map((r) => r.language),
    realGenerationCalls: checkpoint.results.reduce(
      (sum, r) => sum + r.generationCalls,
      0,
    ),
    newCallsThisInvocation: newGenerationCalls,
  });
  currentStep = "scope-denial";
  const countBeforeScope = await traceCounts();
  for (const q of [
    { question: "Write a restaurant marketing campaign", language: "en" },
    { question: "اكتب إعلانًا تجاريًا لمطعم", language: "ar" },
  ]) {
    const denial = await req(student, "/api/tutor", q, 200, q.language);
    assert.equal(denial.disposition, "out_of_scope");
    assert.equal(denial.trace?.generationCalls, 0);
    assert.equal(denial.citations.length, 0);
    assert(denial.answer.length > 0);
  }
  assert.equal(await traceCounts(), countBeforeScope);
  passed("bilingual-out-of-scope-zero-generation");
  currentStep = "fresh-reviewed-practice";
  const latestState = await req(student, "/api/workspace");
  if (!checkpoint.selection) {
    const unused = latestState.items.find(
      (r: any) =>
        r.data.fixture === false &&
        r.data.approved === true &&
        !r.data.protected &&
        !latestState.attempts.some(
          (a: any) => a.data.familyId === r.data.familyId,
        ),
    );
    assert(
      unused,
      "Publish a fresh, unused nonfixture practice family (or resume the existing checkpoint).",
    );
    const selection = await req(student, "/api/learning", {
      action: "select-practice",
      objectiveId: unused.data.objectiveId,
    });
    assert(selection.item, "A reviewed fresh family must be deliverable.");
    assert.equal(
      selection.item.data.fixture,
      false,
      "Fixture practice is not accepted by live smoke.",
    );
    assert.equal(selection.item.data.approved, true);
    assert(
      selection.item.data.key === undefined &&
        selection.item.data.rubric === undefined &&
        selection.item.data.feedback === undefined,
      "Student delivery must omit private keys, rubrics and answer feedback.",
    );
    assert(
      !latestState.attempts.some(
        (a: any) => a.data.familyId === selection.item.data.familyId,
      ),
    );
    checkpoint.selection = {
      deliveryId: selection.deliveryId,
      itemId: selection.item.id,
      familyId: selection.item.data.familyId,
      objectiveId: selection.item.data.objectiveId,
      attemptKey: randomUUID(),
    };
    await saveCheckpoint();
  }
  const selected = checkpoint.selection;
  const reviewedItem = staffState.items.find(
    (r: any) => r.id === selected.itemId,
  );
  assert(
    reviewedItem?.data.approved && reviewedItem.data.fixture === false,
    "Selected question must remain instructor-reviewed and nonfixture.",
  );
  const isOpen = reviewedItem.data.kind === "open";
  // The acceptance harness reads the instructor bank separately to exercise scoring.
  // This key is never returned to the student API, logs, report, or provider.
  const answer = isOpen
    ? "Prioritize missed positive cases when their cost is high, and monitor false alerts and review capacity."
    : reviewedItem.data.key;
  const attemptBody = {
    action: "attempt",
    deliveryId: selected.deliveryId,
    answer,
    explanation:
      reviewedItem.data.kind === "critique"
        ? "Use the actual positive group TP + FN for recall; predicted positives belong to precision."
        : undefined,
    idempotencyKey: selected.attemptKey,
  };
  const accepted = await req(student, "/api/learning", attemptBody);
  assert.equal(accepted.attempt.itemId, selected.itemId);
  if (!isOpen) assert.equal(accepted.attempt.correct, true);
  assert.equal(accepted.attempt.fixtureItem, false);
  assert.equal(accepted.attempt.assisted, false);
  const retry = await req(student, "/api/learning", attemptBody);
  assert(
    JSON.stringify(retry) === JSON.stringify(accepted),
    "Retries must return the same accepted result without duplicate evidence.",
  );
  checkpoint.attemptId = accepted.attempt.id;
  await saveCheckpoint();
  const counts = (
    await db
      .tenant(activeTenant)
      .query<{ attempts: number; events: number }>(
        "SELECT (SELECT count(*)::int FROM records WHERE tenant_id=$1 AND id=$2 AND kind='attempt') AS attempts,(SELECT count(*)::int FROM records WHERE tenant_id=$1 AND kind='event' AND data->>'attemptId'=$2 AND data->>'type'='answer') AS events",
        [activeTenant, accepted.attempt.id],
      )
  ).rows[0];
  assert.equal(counts.attempts, 1);
  assert.equal(counts.events, 1);
  passed("nonfixture-practice-idempotent", {
    itemId: selected.itemId,
    objective: selected.objectiveId,
    correct: accepted.attempt.correct,
    moderation: accepted.attempt.moderation,
    assisted: false,
    attempts: counts.attempts,
    answerEvents: counts.events,
  });
  currentStep = "signout-persistence";
  await req(student, "/api/auth/logout", {});
  const restoredClient = client();
  await login(restoredClient, "student");
  const restored = await req(restoredClient, "/api/workspace");
  assert(restored.attempts.some((a: any) => a.id === accepted.attempt.id));
  assert(
    restored.progress.some(
      (p: any) => p.data.sessionId === publishedSession.id && p.data.completed,
    ),
  );
  passed("neon-progress-after-new-login");
  currentStep = "exam-other-device";
  const secondIdentity = await login(secondStudent, "student");
  assert.equal(secondIdentity.userId, studentId);
  assert(
    secondStudent.cookies.get("tilwa_session") !==
      restoredClient.cookies.get("tilwa_session"),
    "Independent sign-ins must receive different signed sessions.",
  );
  const beforeExam = await traceCounts();
  try {
    await req(instructor, "/api/learning", { action: "start-exam", studentId });
    examStarted = true;
    const protectedAnswer = await req(secondStudent, "/api/tutor", {
      question: "ليه الـRecall هنا 60%؟",
      language: "ar",
    });
    assert.equal(protectedAnswer.disposition, "protected");
    assert.equal(protectedAnswer.citations.length, 0);
    if (protectedAnswer.trace)
      assert.equal(protectedAnswer.trace.generationCalls, 0);
    await req(
      secondStudent,
      "/api/learning",
      { action: "select-practice", objectiveId: selected.objectiveId },
      403,
    );
    const protectedWorkspace = await req(secondStudent, "/api/workspace");
    assert.equal(protectedWorkspace.examMode, true);
    assert.equal(protectedWorkspace.items.length, 0);
    assert.equal(await traceCounts(), beforeExam);
    passed("protected-exam-other-session-zero-generation");
  } finally {
    if (examStarted) {
      await req(instructor, "/api/learning", { action: "end-exam", studentId });
      examStarted = false;
    }
  }
  currentStep = "assigned-advisor";
  const advisorIdentity = await login(advisor, "advisor");
  assert.equal(advisorIdentity.tenantId, activeTenant);
  const permitted = await req(advisor, "/api/workspace");
  assert(permitted.students.includes(studentId));
  assert(
    permitted.events.some((r: any) => r.data.attemptId === accepted.attempt.id),
  );
  assert(
    permitted.recommendations.some(
      (r: any) =>
        r.ownerId === studentId && r.data.objectiveId === selected.objectiveId,
    ),
  );
  for (const field of [
    "events",
    "states",
    "recommendations",
    "portfolio",
    "attempts",
  ])
    for (const record of permitted[field] ?? [])
      assert(
        permitted.students.includes(record.ownerId),
        `Advisor ${field} must be restricted to assigned students.`,
      );
  const outsiderIdentity = await login(unrelatedAdvisor, "advisor", null); // A new synthetic workspace, not university data.
  assert.notEqual(outsiderIdentity.tenantId, activeTenant);
  const unrelated = await req(unrelatedAdvisor, "/api/workspace");
  assert(!unrelated.students.includes(studentId));
  assert(!unrelated.events.some((r: any) => r.ownerId === studentId));
  const sourceId = (
    await db
      .tenant(activeTenant)
      .query<{ id: string }>(
        "SELECT id FROM material_versions WHERE tenant_id=$1 AND source_key='CET351-L4' AND current_version=true",
        [activeTenant],
      )
  ).rows[0]?.id;
  assert(sourceId);
  await req(unrelatedAdvisor, `/api/materials/${sourceId}`, undefined, 404);
  passed("advisor-assignment-and-tenant-isolation");
  checkpoint.completedAt = new Date().toISOString();
  await saveCheckpoint();
  const report = {
    status: "passed",
    mode: "LIVE Neon + Gemini",
    target: base,
    runId: checkpoint.runId,
    at: checkpoint.completedAt,
    model: process.env.GEMINI_MODEL,
    results: checkpoint.results,
    checks,
    newGenerationCalls,
    totalVerifiedGenerationCalls: checkpoint.results.length,
    totalProviderTokens: checkpoint.results.reduce(
      (sum, r) => sum + r.tokens,
      0,
    ),
    environmentPublication: false,
    deployment: false,
  };
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    "docs/evidence/live-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
try {
  await main();
} catch (error) {
  const reason =
    error instanceof assert.AssertionError
      ? error.message
      : error instanceof Error && error.name === "TimeoutError"
        ? "Request timed out."
        : "Live acceptance operation failed; inspect the named step without exposing credentials.";
  const report = {
    status: "failed",
    mode: "LIVE Neon + Gemini",
    step: currentStep,
    reason,
    at: new Date().toISOString(),
    model: process.env.GEMINI_MODEL,
    newGenerationCalls,
    completedLanguages: checkpoint.results.map((r) => r.language),
    checks,
    resume:
      "Rerun the same opt-in command; successful language traces are checkpointed.",
  };
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    "docs/evidence/live-smoke-last-failure.json",
    JSON.stringify(report, null, 2),
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (examStarted && studentId) {
    try {
      await req(instructor, "/api/learning", { action: "end-exam", studentId });
    } catch {
      console.error(
        JSON.stringify({
          status: "blocked",
          action: "exam-cleanup",
          reason:
            "The synthetic learner exam remains active; end it from the instructor Next class screen.",
        }),
      );
      process.exitCode = 1;
    }
  }
  await db.close();
}
