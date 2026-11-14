/** Hosted invite-only acceptance. Authentication creates/revokes sessions; curriculum and
 * learner progress stay read-only. HOSTED_PILOT_LIVE_TUTOR=1 explicitly permits one metered
 * tutor request and its trace/memory writes. No migrations, publication, practice or seeding.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { db } from "../src/server/db";
import { initializeNetwork } from "../src/server/network";

type Role = "student" | "instructor" | "advisor";
type Client = { cookies: Map<string, string> };
type Check = {
  name: string;
  status: "passed" | "skipped" | "failed";
  details?: Record<string, unknown>;
};
type Config = {
  base: string;
  code: string;
  stage: string;
  liveTutor: boolean;
  database: boolean;
  bypass?: string;
};
type Locator = {
  id: string;
  sourceKey: string;
  versionId?: string;
  page: number | null;
  section: string | null;
  url: string;
  text?: string;
};
type Report = {
  schemaVersion: 1;
  stage: string;
  target: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  checks: Check[];
  verification: {
    http: "real";
    database: "real-neon-read-only" | "not-configured";
    browser: "not-run-by-this-script";
    model: "not-requested" | "requested" | "real-gemini-verified";
  };
  boundaries: string[];
  tutorRequests: number;
  failure?: { code: string; step: string };
};
class CheckError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function ensure(value: unknown, code: string, message = code): asserts value {
  if (!value) throw new CheckError(code, message);
}
export function validateOrigin(value: string) {
  const url = new URL(value);
  ensure(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "invalid_origin",
    "TILWA_BASE_URL must be a bare origin without credentials or query parameters.",
  );
  ensure(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)),
    "insecure_origin",
  );
  return url.origin;
}
export function sameOriginUrl(base: string, path: string) {
  const url = new URL(path, base);
  ensure(
    url.origin === base && !url.username && !url.password,
    "external_request_blocked",
  );
  return url;
}
export function updateCookies(jar: Map<string, string>, headers: string[]) {
  for (const header of headers) {
    const [first, ...attributes] = header.split(";");
    const index = first.indexOf("=");
    if (index <= 0) continue;
    const name = first.slice(0, index).trim(),
      value = first.slice(index + 1);
    if (!value || attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)))
      jar.delete(name);
    else jar.set(name, value);
  }
}
function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
const progressKeys = [
  "states",
  "events",
  "recommendations",
  "progress",
  "attempts",
  "submissions",
  "portfolio",
  "grades",
  "preferences",
] as const;
export function progressFingerprint(workspace: Record<string, any>) {
  const projection = Object.fromEntries(
    progressKeys.map((key) => {
      const value = workspace[key];
      return [
        key,
        Array.isArray(value)
          ? [...value].sort((a, b) => canonical(a).localeCompare(canonical(b)))
          : (value ?? null),
      ];
    }),
  );
  return {
    sha256: createHash("sha256").update(canonical(projection)).digest("hex"),
    counts: Object.fromEntries(
      progressKeys.map((key) => [
        key,
        Array.isArray(workspace[key])
          ? workspace[key].length
          : workspace[key]
            ? 1
            : 0,
      ]),
    ),
  };
}
export function publicCitation(citation: Locator) {
  return {
    sourceKey: citation.sourceKey,
    page: citation.page ?? null,
    section: citation.section ?? null,
  };
}
function verifyNoPrivateMapFields(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    ensure(
      ![
        "text_content",
        "answerKey",
        "correctAnswer",
        "expectedAnswer",
        "scoringRubric",
        "sessionSecret",
        "workspaceCode",
      ].includes(key),
      "private_field_in_map",
    );
    verifyNoPrivateMapFields(child);
  }
}
function fresh(workspaceCookie?: string): Client {
  return {
    cookies: new Map(
      workspaceCookie ? [["tilwa_workspace", workspaceCookie]] : [],
    ),
  };
}
function localizedError(data: any, code: string, language: "ar" | "en") {
  ensure(data?.error?.code === code, "unexpected_auth_error");
  const error = data.error;
  ensure(
    typeof error.message === "string" &&
      error.message.length > 5 &&
      error.message === error.messages?.[language],
    "error_not_localized",
  );
  ensure(
    language === "ar"
      ? /\p{Script=Arabic}/u.test(error.message)
      : /[a-z]/i.test(error.message),
    "error_language_mismatch",
  );
}
async function tenantCount() {
  return Number(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tenants",
      )
    ).rows[0].count,
  );
}

export async function checkHostedPilot(config: Config): Promise<Report> {
  initializeNetwork();
  const report: Report = {
    schemaVersion: 1,
    stage: config.stage,
    target: config.base,
    startedAt: new Date().toISOString(),
    status: "running",
    checks: [],
    tutorRequests: 0,
    verification: {
      http: "real",
      database: config.database ? "real-neon-read-only" : "not-configured",
      browser: "not-run-by-this-script",
      model: config.liveTutor ? "requested" : "not-requested",
    },
    boundaries: [
      "This script verifies real HTTP responses. Source viewer HTML responses are checked; rendering and RTL/LTR interaction require the separate browser runner.",
      "Sign-in/sign-out creates and revokes authentication sessions. No workspace, curriculum, attempt, completion, exam or mastery mutation is requested.",
      config.liveTutor
        ? "One actual tutor request is explicitly enabled; it can write a model trace and tutor memory. No provider retry is performed."
        : "The tutor is not called; this run makes no Gemini availability or answer-quality claim.",
      config.database
        ? "Direct SQL checks use the configured Neon connection and never write application records."
        : "DATABASE_URL is absent: tenant counts, persisted model traces and direct assignment checks are not independently verified with SQL.",
    ],
  };
  let step = "preflight";
  const pass = (name: string, details?: Record<string, unknown>) => {
    report.checks.push({
      name,
      status: "passed",
      ...(details ? { details } : {}),
    });
    console.log(`PASS ${name}`);
  };
  const skip = (name: string, reason: string) =>
    report.checks.push({ name, status: "skipped", details: { reason } });
  const clients: Client[] = [];
  async function request(
    client: Client,
    path: string,
    body?: unknown,
    expected = 200,
    language: "ar" | "en" = "ar",
    html = false,
  ) {
    const url = sameOriginUrl(config.base, path);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(path === "/api/tutor" ? 70000 : 45000),
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": language,
          "x-language": language,
          Origin: config.base,
          Cookie: [...client.cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          ...(config.bypass
            ? { "x-vercel-protection-bypass": config.bypass }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CheckError(
        "http_transport_failed",
        "HTTP request failed; connection details are not logged.",
      );
    }
    updateCookies(client.cookies, response.headers.getSetCookie());
    ensure(
      response.status === expected,
      `http_${response.status}_expected_${expected}`,
    );
    if (html) {
      ensure(
        response.headers.get("content-type")?.includes("text/html"),
        "source_viewer_not_html",
      );
      await response.body?.cancel();
      return null;
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new CheckError(
        "invalid_json_response",
        "The API did not return JSON.",
      );
    }
    return data;
  }
  async function login(client: Client, role: Role, code?: string) {
    const result = await request(client, "/api/auth/demo", {
      role,
      locale: "ar",
      ...(code ? { workspaceCode: code } : {}),
    });
    ensure(
      result?.mode === "pilot" &&
        result?.accessMode === "invite-only" &&
        result?.synthetic === true,
      "hosted_pilot_mode_required",
    );
    ensure(
      result.user?.role === role &&
        result.user?.courseId === "CET351" &&
        typeof result.user.userId === "string" &&
        typeof result.user.tenantId === "string",
      "invalid_role_identity",
    );
    ensure(
      client.cookies.has("tilwa_session") &&
        client.cookies.has("tilwa_workspace"),
      "missing_auth_cookies",
    );
    clients.push(client);
    return result.user as { userId: string; tenantId: string; role: Role };
  }
  const materialCache = new Map<string, any>();
  async function material(client: Client, versionId: string) {
    if (!materialCache.has(versionId))
      materialCache.set(
        versionId,
        await request(
          client,
          `/api/materials/${encodeURIComponent(versionId)}`,
        ),
      );
    return materialCache.get(versionId);
  }
  async function validateLocator(
    client: Client,
    locator: Locator,
    openPage: boolean,
  ) {
    const url = sameOriginUrl(config.base, locator.url);
    const versionId =
      locator.versionId ||
      decodeURIComponent(url.pathname.split("/").at(-1) || "");
    ensure(
      url.pathname === `/sources/${versionId}`,
      "invalid_source_viewer_path",
    );
    ensure(
      locator.page !== null
        ? url.searchParams.get("page") === String(locator.page)
        : url.searchParams.get("section") === locator.section,
      "citation_url_locator_mismatch",
    );
    const source = await material(client, versionId);
    ensure(
      source.material?.id === versionId &&
        source.material.current_version === true &&
        source.material.status === "published" &&
        source.material.source_key === locator.sourceKey,
      "source_not_current_published",
    );
    ensure(
      source.material.rights?.displayExcerpt === true &&
        source.material.rights?.sendToModel === true,
      "source_rights_missing",
    );
    ensure(
      Array.isArray(source.chunks) &&
        source.chunks.every((c: any) => c.status === "approved"),
      "student_received_unapproved_source",
    );
    const chunk = source.chunks.find((c: any) => c.id === locator.id);
    ensure(
      chunk &&
        chunk.page === locator.page &&
        (chunk.section ?? null) === (locator.section ?? null) &&
        chunk.source_key === locator.sourceKey &&
        chunk.version_id === versionId,
      "citation_does_not_resolve_exactly",
    );
    if (locator.text !== undefined)
      ensure(
        typeof locator.text === "string" &&
          locator.text.length > 0 &&
          chunk.text_content.startsWith(locator.text),
        "tutor_citation_not_exact_excerpt",
      );
    if (openPage)
      await request(
        client,
        url.pathname + url.search,
        undefined,
        200,
        "ar",
        true,
      );
    return { versionId, chunk };
  }
  try {
    let tenantsBefore: number | undefined;
    if (config.database) {
      step = "neon_preflight";
      tenantsBefore = await tenantCount();
    } else
      skip(
        "no-new-tenant-direct-sql",
        "DATABASE_URL not configured; HTTP denials are still verified.",
      );
    step = "unauthenticated_map";
    await request(fresh(), "/api/knowledge/map", undefined, 401);
    pass("unauthenticated-map-denied");
    for (const language of ["ar", "en"] as const) {
      step = `missing_invitation_${language}`;
      const client = fresh(),
        result = await request(
          client,
          "/api/auth/demo",
          { role: "student", locale: language },
          401,
          language,
        );
      localizedError(result, "INVITE_REQUIRED", language);
      ensure(
        !client.cookies.has("tilwa_session") &&
          !client.cookies.has("tilwa_workspace"),
        "denial_created_auth_cookie",
      );
      pass(`missing-invitation-denied-${language}`);
    }
    step = "invalid_invitation";
    const bogus = await request(
      fresh(),
      "/api/auth/demo",
      { role: "student", workspaceCode: `invalid-${randomUUID()}` },
      401,
      "en",
    );
    localizedError(bogus, "INVALID_WORKSPACE", "en");
    pass("invalid-invitation-denied");
    if (config.database) {
      ensure((await tenantCount()) === tenantsBefore, "denial_created_tenant");
      pass("denied-signins-create-no-neon-tenant");
    }

    step = "three_role_login";
    const student = fresh(),
      studentIdentity = await login(student, "student", config.code);
    const workspaceCookie = student.cookies.get("tilwa_workspace")!;
    const instructor = fresh(workspaceCookie),
      instructorIdentity = await login(instructor, "instructor");
    const advisor = fresh(workspaceCookie),
      advisorIdentity = await login(advisor, "advisor");
    ensure(
      instructorIdentity.tenantId === studentIdentity.tenantId &&
        advisorIdentity.tenantId === studentIdentity.tenantId,
      "role_workspace_mismatch",
    );
    ensure(
      new Set([
        studentIdentity.userId,
        instructorIdentity.userId,
        advisorIdentity.userId,
      ]).size === 3,
      "roles_share_identity",
    );
    const me = await request(student, "/api/auth/me");
    ensure(
      me.mode === "pilot" &&
        me.accessMode === "invite-only" &&
        me.user?.role === "student",
      "auth_me_mode_mismatch",
    );
    pass("three-server-roles-in-existing-invited-workspace", {
      cookieOnlyRoleSwitches: 2,
    });
    if (config.database) {
      ensure(
        (await tenantCount()) === tenantsBefore,
        "existing_login_created_tenant",
      );
      pass("valid-signins-create-no-neon-tenant");
    }

    step = "student_map";
    const map = await request(student, "/api/knowledge/map");
    ensure(
      map.status === "published" && typeof map.releaseId === "string",
      "no_published_map",
    );
    ensure(
      map.concepts?.length === 225 &&
        map.edges?.length === 259 &&
        map.pages?.length === 137,
      "unexpected_comprehensive_map_counts",
    );
    ensure(
      map.coverage?.length === 6 &&
        map.coverage.every(
          (c: any) =>
            c.status === "complete" &&
            c.reviewedPages === c.totalPages &&
            c.mappedTeachingPages === c.teachingPages,
        ),
      "incomplete_course_coverage",
    );
    ensure(
      map.totals?.pages === 137 && map.totals?.reviewedPages === 137,
      "incorrect_coverage_totals",
    );
    const pageKeys = new Set(
      map.pages.map((p: any) => `${p.sourceKey}:${p.page}`),
    );
    ensure(pageKeys.size === 137, "duplicate_coverage_page");
    const ids = new Set(map.concepts.map((c: any) => c.id));
    ensure(
      ids.size === 225 &&
        map.concepts.every(
          (c: any) =>
            c.status === "approved" &&
            c.lectureEvidence?.length &&
            c.umbrellaEvidence?.length,
        ),
      "unapproved_or_ungrounded_map_concept",
    );
    ensure(
      map.edges.every(
        (e: any) =>
          e.status === "approved" &&
          ids.has(e.from) &&
          ids.has(e.to) &&
          e.evidence?.length,
      ),
      "unapproved_or_dangling_map_edge",
    );
    verifyNoPrivateMapFields(map);
    pass("student-comprehensive-approved-map", {
      releaseId: map.releaseId,
      concepts: 225,
      edges: 259,
      reviewedPages: 137,
      completeLectures: 6,
    });

    step = "instructor_materials_and_student_denial";
    const materials = await request(instructor, "/api/materials");
    const current = materials.materials.flatMap((m: any) =>
      m.versions.filter(
        (v: any) => v.current_version && v.status === "published",
      ),
    );
    ensure(
      current.length === 7 &&
        new Set(current.map((v: any) => v.source_key)).size === 7,
      "seven_current_published_sources_required",
    );
    ensure(
      materials.gfg?.registered === true && materials.gfg?.textUsed === false,
      "gfg_must_remain_reference_metadata",
    );
    const reference = materials.materials.find(
      (m: any) => m.sourceKey === "GFG-UMBRELLA",
    );
    ensure(
      reference?.versions.some(
        (v: any) =>
          v.status === "reference_link" && v.rights?.sendToModel === false,
      ),
      "gfg_reference_registration_missing",
    );
    await request(student, "/api/knowledge", { action: "propose" }, 403);
    await request(student, "/api/materials", { action: "register-pack" }, 403);
    pass("instructor-current-materials-and-gfg-reference", {
      publishedSources: 7,
      gfgArticleTextUsed: false,
    });
    pass("student-cannot-propose-or-import-curriculum", {
      deniedOperations: 2,
    });

    step = "approved_source_locators";
    const locators: Locator[] = [
      ...new Map<string, Locator>(
        [
          ...map.concepts.flatMap((c: any) => [
            ...c.lectureEvidence,
            ...c.umbrellaEvidence,
          ]),
          ...map.edges.flatMap((e: any) => e.evidence),
        ].map((l: Locator) => [l.id, l]),
      ).values(),
    ];
    const openedVersions = new Set<string>();
    for (const locator of locators) {
      const open = !openedVersions.has(locator.versionId!);
      await validateLocator(student, locator, open);
      openedVersions.add(locator.versionId!);
    }
    ensure(
      openedVersions.size === 7,
      "source_locator_version_coverage_incomplete",
    );
    pass("all-map-locators-match-approved-material-api", {
      uniqueApprovedLocators: locators.length,
      sourceApis: materialCache.size,
      sourceViewerHtmlPages: openedVersions.size,
    });

    step = "persisted_student_workspace";
    const initialState = await request(student, "/api/workspace");
    ensure(
      initialState.mode === "neon" &&
        initialState.user?.id === studentIdentity.userId,
      "workspace_not_neon_backed",
    );
    ensure(
      initialState.attempts?.length > 0 &&
        initialState.progress?.length > 0 &&
        initialState.states?.length > 0 &&
        initialState.recommendations?.length > 0,
      "existing_student_evidence_missing",
    );
    const before = progressFingerprint(initialState);
    step = "assigned_advisor";
    const advisorState = await request(advisor, "/api/workspace");
    ensure(
      advisorState.user?.role === "advisor" &&
        advisorState.students?.includes(studentIdentity.userId),
      "advisor_not_assigned_to_student",
    );
    const assigned = new Set(advisorState.students);
    ensure(
      advisorState.privateRecords?.length > 0 &&
        advisorState.privateRecords.every((r: any) => assigned.has(r.ownerId)),
      "advisor_received_unassigned_private_history",
    );
    ensure(
      advisorState.recommendations.some(
        (r: any) => r.ownerId === studentIdentity.userId,
      ) &&
        advisorState.events.some(
          (r: any) => r.ownerId === studentIdentity.userId,
        ),
      "advisor_student_evidence_missing",
    );
    if (config.database) {
      const assignment = await db
        .tenant(studentIdentity.tenantId)
        .query(
          "SELECT student_id FROM advisor_assignments WHERE tenant_id=$1 AND advisor_id=$2 AND student_id=$3 AND active=true",
          [
            studentIdentity.tenantId,
            advisorIdentity.userId,
            studentIdentity.userId,
          ],
        );
      ensure(assignment.rows.length === 1, "advisor_assignment_not_persisted");
    } else
      skip(
        "advisor-assignment-direct-sql",
        "Verified through authorized HTTP workspace; DATABASE_URL not configured.",
      );
    pass("assigned-advisor-sees-existing-evidence-and-recommendation", {
      assignedStudents: assigned.size,
      evidenceRecords: advisorState.privateRecords.length,
    });

    step = "signout_and_reopen";
    const revoked = { cookies: new Map(student.cookies) };
    await request(student, "/api/auth/logout", {});
    ensure(
      !student.cookies.has("tilwa_session") &&
        student.cookies.has("tilwa_workspace"),
      "logout_cookie_contract_broken",
    );
    await request(revoked, "/api/auth/me", undefined, 401);
    const reopened = fresh(),
      reopenedIdentity = await login(reopened, "student", config.code);
    ensure(
      reopenedIdentity.userId === studentIdentity.userId &&
        reopenedIdentity.tenantId === studentIdentity.tenantId,
      "relogin_created_new_identity",
    );
    const reopenedState = await request(reopened, "/api/workspace"),
      after = progressFingerprint(reopenedState);
    ensure(
      before.sha256 === after.sha256,
      "student_progress_changed_after_relogin",
    );
    pass("logout-revokes-session-and-new-context-preserves-progress", {
      fingerprint: after.sha256,
      persistedRecordCounts: after.counts,
    });

    if (config.liveTutor) {
      step = "live_tutor_preflight";
      ensure(
        reopenedState.examMode === false,
        "protected_exam_active_no_tutor_call",
      );
      let traceCountBefore: number | undefined;
      if (config.database) {
        const exists = await db
          .tenant(studentIdentity.tenantId)
          .query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2", [
            studentIdentity.tenantId,
            studentIdentity.userId,
          ]);
        ensure(exists.rows.length === 1, "http_database_identity_mismatch");
        const approved = (
          await db
            .tenant(studentIdentity.tenantId)
            .query<{ id: string }>(
              "SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.course_id='CET351' AND c.status='approved' AND v.current_version=true AND v.status='published' AND v.rights->>'sendToModel'='true' AND v.rights->>'displayExcerpt'='true'",
              [studentIdentity.tenantId],
            )
        ).rows;
        const allowed = new Set(approved.map((r) => r.id));
        ensure(
          locators.every((l) => allowed.has(l.id)),
          "precall_db_source_snapshot_mismatch",
        );
        traceCountBefore = Number(
          (
            await db
              .tenant(studentIdentity.tenantId)
              .query<{ count: number }>(
                "SELECT count(*)::int AS count FROM model_traces WHERE tenant_id=$1 AND user_id=$2 AND generated_at IS NOT NULL",
                [studentIdentity.tenantId, studentIdentity.userId],
              )
          ).rows[0].count,
        );
      }
      const sourceSnapshotAt = new Date().toISOString();
      step = "one_real_arabic_tutor_request";
      report.tutorRequests++;
      const answer = await request(reopened, "/api/tutor", {
        question:
          "ليه الـRecall هنا 60%؟ اشرح مثال الاحتيال TP=6 وFN=4 وFP=20 من المحاضرة الرابعة.",
        language: "ar",
        style: "step-by-step",
        courseId: "CET351",
      });
      ensure(
        answer.disposition === "answered" &&
          answer.trace?.outcome === "answered" &&
          answer.trace?.generationCalls === 1 &&
          answer.trace?.tokens > 0 &&
          !answer.trace?.providerStatus &&
          /^gemini-/.test(answer.trace?.modelId),
        "live_tutor_not_verified_generation",
      );
      ensure(
        new Date(answer.trace.retrievedAt).getTime() <=
          new Date(answer.trace.generatedAt).getTime(),
        "http_trace_not_database_first",
      );
      ensure(
        /\p{Script=Arabic}/u.test(answer.answer),
        "tutor_answer_not_arabic",
      );
      const normalized = answer.answer
        .replace(/[٠-٩]/g, (digit: string) =>
          String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)),
        )
        .replace(/٪/g, "%");
      ensure(
        /60(?:[.٫]0+)?\s*%/.test(normalized) &&
          /\b6\b/.test(normalized) &&
          /\b4\b/.test(normalized),
        "tutor_recall_explanation_incorrect",
      );
      ensure(
        answer.citations?.some(
          (c: Locator) =>
            c.sourceKey === "CET351-L4" && [18, 19].includes(c.page!),
        ),
        "tutor_missing_reviewed_recall_source",
      );
      for (const citation of answer.citations as Locator[])
        await validateLocator(reopened, citation, true);
      if (config.database) {
        const trace = (
          await db.tenant(studentIdentity.tenantId).query<{
            id: string;
            user_id: string;
            model_id: string;
            outcome: string;
            tokens: number;
            retrieved_at: Date;
            generated_at: Date;
            evidence_ids: string[];
          }>("SELECT id,user_id,model_id,outcome,tokens,retrieved_at,generated_at,evidence_ids FROM model_traces WHERE tenant_id=$1 AND id=$2", [studentIdentity.tenantId, answer.trace.id])
        ).rows[0];
        ensure(
          trace &&
            trace.user_id === studentIdentity.userId &&
            trace.model_id === answer.trace.modelId &&
            trace.outcome === "answered" &&
            Number(trace.tokens) === answer.trace.tokens &&
            new Date(trace.retrieved_at).getTime() <=
              new Date(trace.generated_at).getTime(),
          "persisted_trace_mismatch",
        );
        ensure(
          answer.citations.every((c: Locator) =>
            trace.evidence_ids.includes(c.id),
          ),
          "citations_not_in_persisted_retrieval",
        );
        const countAfter = Number(
          (
            await db
              .tenant(studentIdentity.tenantId)
              .query<{ count: number }>(
                "SELECT count(*)::int AS count FROM model_traces WHERE tenant_id=$1 AND user_id=$2 AND generated_at IS NOT NULL",
                [studentIdentity.tenantId, studentIdentity.userId],
              )
          ).rows[0].count,
        );
        ensure(
          countAfter === traceCountBefore! + 1,
          "unexpected_additional_provider_trace",
        );
      } else
        skip(
          "persisted-tutor-trace-direct-sql",
          "HTTP trace timestamps and exact approved-source excerpts checked; DATABASE_URL not configured.",
        );
      const finalState = await request(reopened, "/api/workspace");
      ensure(
        progressFingerprint(finalState).sha256 === after.sha256,
        "tutor_rewrote_mastery_or_progress",
      );
      report.verification.model = "real-gemini-verified";
      pass("one-real-gemini-arabic-recall-with-openable-evidence", {
        model: answer.trace.modelId,
        tokens: answer.trace.tokens,
        generationCalls: 1,
        sourceSnapshotAt,
        retrievedAt: answer.trace.retrievedAt,
        generatedAt: answer.trace.generatedAt,
        databaseFirstVerification: config.database
          ? "persisted-neon-trace-and-precall-snapshot"
          : "http-trace-and-approved-material-api-snapshot",
        citations: answer.citations.map(publicCitation),
        progressUnchanged: true,
      });
    } else
      skip(
        "live-gemini-arabic-recall",
        "Set HOSTED_PILOT_LIVE_TUTOR=1 to authorize one metered provider request, including on staged Production before cutover. Do not repeat the call after promoting the same deployment.",
      );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = {
      code: error instanceof CheckError ? error.code : "verification_failed",
      step,
    };
    report.checks.push({
      name: step,
      status: "failed",
      details: { code: report.failure.code },
    });
  } finally {
    // Clean up only sessions created by this invocation; never clear the reusable workspace invitation.
    for (const client of clients)
      if (client.cookies.has("tilwa_session")) {
        try {
          await request(client, "/api/auth/logout", {});
        } catch {
          report.checks.push({
            name: "session-cleanup",
            status: "failed",
            details: { code: "logout_cleanup_failed" },
          });
          report.status = "failed";
        }
      }
    if (config.database) await db.close();
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      stage: { type: "string", default: "staged" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: TILWA_BASE_URL=https://deployment.example TILWA_WORKSPACE_CODE_FILE=.tilwa-private/workspace-code.txt npx tsx scripts/check-hosted-pilot.ts --stage staged|production\nOptional: DATABASE_URL for independent read-only Neon checks; VERCEL_AUTOMATION_BYPASS_SECRET for same-origin Preview access; HOSTED_PILOT_LIVE_TUTOR=1 for one real tutor call. Reports: docs/evidence/hosted-pilot-{stage}.json. No code, cookies, source text or answer keys are written.",
    );
    return;
  }
  ensure(/^[a-z][a-z0-9-]{0,30}$/.test(values.stage), "invalid_stage");
  ensure(
    process.env.TILWA_BASE_URL && process.env.TILWA_WORKSPACE_CODE_FILE,
    "missing_configuration",
    "Set TILWA_BASE_URL and TILWA_WORKSPACE_CODE_FILE.",
  );
  const base = validateOrigin(process.env.TILWA_BASE_URL);
  const code = (
    await readFile(process.env.TILWA_WORKSPACE_CODE_FILE, "utf8")
  ).trim();
  ensure(
    code.length >= 16 && code.length <= 128 && !/[\r\n]/.test(code),
    "invalid_private_code_file",
  );
  const database = !!process.env.DATABASE_URL;
  if (database)
    ensure(
      process.env.LOCAL_DATABASE !== "1" &&
        new URL(process.env.DATABASE_URL!).hostname.endsWith(".neon.tech"),
      "real_neon_required_for_sql_checks",
    );
  const report = await checkHostedPilot({
    base,
    code,
    stage: values.stage,
    database,
    liveTutor: process.env.HOSTED_PILOT_LIVE_TUTOR === "1",
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  });
  const path = `docs/evidence/hosted-pilot-${values.stage}.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: report.status,
      stage: report.stage,
      checks: report.checks.reduce<Record<string, number>>((sum, c) => {
        sum[c.status] = (sum[c.status] ?? 0) + 1;
        return sum;
      }, {}),
      tutorRequests: report.tutorRequests,
      report: path,
      ...(report.failure ? { failure: report.failure } : {}),
    }),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        status: "blocked",
        code:
          error instanceof CheckError
            ? error.code
            : "configuration_or_io_failed",
        message:
          error instanceof CheckError
            ? error.message
            : "Check the private configuration and output path. No provider response, invitation, cookie or credential was printed.",
      }),
    );
    process.exitCode = 2;
  });
