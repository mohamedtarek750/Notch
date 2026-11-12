import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Queryable } from "./db";
import {
  authorizeCourse,
  authorizeCourseInTransaction,
  type AuthContext,
} from "./auth";
import { AppError } from "./errors";
import { getOfficialGrades } from "./sis";
import type { Bilingual } from "./domain-seed";
const bi = (ar: string, en: string): Bilingual => ({ ar, en });
export type LearningRecord = {
  id: string;
  kind: string;
  ownerId: string | null;
  data: Record<string, any>;
  createdAt?: string;
};
type Row = {
  id: string;
  kind: string;
  owner_id: string | null;
  data: Record<string, any>;
  created_at?: Date | string;
};
const toRecord = (r: Row): LearningRecord => ({
  id: r.id,
  kind: r.kind,
  ownerId: r.owner_id,
  data: r.data,
  createdAt: r.created_at?.toString(),
});
const pair = z.object({
  ar: z.string().trim().min(1).max(5000),
  en: z.string().trim().min(1).max(5000),
});
const str = z.string().min(1).max(160);
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("select-practice"),
    objectiveId: str.optional(),
    kind: z.enum(["choice", "critique", "transfer", "open"]).optional(),
  }),
  z.object({
    action: z.literal("attempt"),
    deliveryId: str,
    answer: z.string().max(4000),
    explanation: z.string().max(5000).optional(),
    idempotencyKey: z.string().min(8).max(100),
  }),
  z.object({ action: z.literal("complete-session"), sessionId: str }),
  z.object({
    action: z.literal("preferences"),
    lessonLanguage: z.enum(["ar", "en", "mixed"]).optional(),
    presentation: z.enum(["short", "detailed", "steps", "example"]).optional(),
    uiLanguage: z.enum(["ar", "en"]).optional(),
  }),
  z.object({
    action: z.literal("submit-assignment"),
    assignmentId: str,
    text: z.string().min(5).max(12000),
    url: z.string().url().max(2048).optional(),
  }),
  z.object({
    action: z.literal("feedback"),
    submissionId: str,
    feedback: pair,
    score: z.number().min(0).max(100),
  }),
  z.object({
    action: z.literal("career-target"),
    target: z.enum(["ML Engineer", "Data Analyst"]),
  }),
  z.object({
    action: z.literal("portfolio"),
    title: z.string().min(1).max(200),
    url: z.string().url().max(2048),
    description: z.string().min(1).max(5000),
    include: z.boolean(),
  }),
  z.object({
    action: z.literal("portfolio-visibility"),
    artifactId: str,
    include: z.boolean(),
  }),
  z.object({
    action: z.literal("review-portfolio"),
    artifactId: str,
    rubric: z.object({
      analysis: z.number().int().min(0).max(3),
      code: z.number().int().min(0).max(3),
      communication: z.number().int().min(0).max(3),
      reproducibility: z.number().int().min(0).max(3),
    }),
    feedback: pair,
  }),
  z.object({
    action: z.literal("intervention"),
    objectiveId: str,
    title: pair,
    body: pair,
  }),
  z.object({
    action: z.literal("override"),
    studentId: str,
    objectiveId: str,
    status: z.enum(["developing", "secure", "unassessed"]),
    reason: z.string().min(8).max(2000),
  }),
  z.object({ action: z.literal("undo-override"), overrideId: str }),
  z.object({ action: z.literal("announcement"), title: pair, body: pair }),
  z.object({ action: z.literal("enroll"), courseId: z.literal("CET351") }),
  z.object({
    action: z.literal("review-attempt"),
    attemptId: str,
    score: z.union([z.literal(0), z.literal(1)]),
    feedback: pair,
  }),
  z.object({ action: z.literal("start-exam"), studentId: str }),
  z.object({ action: z.literal("end-exam"), studentId: str }),
]);
async function get(
  tx: Queryable,
  ctx: AuthContext,
  id: string,
  kind?: string,
): Promise<LearningRecord> {
  const { rows } = await tx.query<Row>(
    "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND id=$3",
    [ctx.tenantId, ctx.courseId, id],
  );
  const r = rows[0];
  if (!r || (kind && r.kind !== kind)) throw new AppError(404, "NOT_FOUND");
  return toRecord(r);
}
async function put(
  tx: Queryable,
  ctx: AuthContext,
  id: string,
  kind: string,
  data: unknown,
  ownerId: string | null = null,
) {
  await tx.query(
    "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",
    [ctx.tenantId, id, kind, ctx.courseId, ownerId, JSON.stringify(data)],
  );
  return { id, kind, ownerId, data };
}
function role(ctx: AuthContext, ...roles: string[]) {
  if (!roles.includes(ctx.role)) throw new AppError(403, "FORBIDDEN");
}
async function canSeeStudent(
  tx: Queryable,
  ctx: AuthContext,
  studentId: string,
) {
  if (ctx.role === "student") {
    if (studentId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
    return;
  }
  const { rows } = await tx.query(
    "SELECT user_id FROM course_access WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND access_role=$4 AND active=true",
    [ctx.tenantId, studentId, ctx.courseId, "student"],
  );
  if (!rows.length) throw new AppError(403, "FORBIDDEN");
  if (ctx.role === "advisor") {
    const a = await tx.query(
      "SELECT student_id FROM advisor_assignments WHERE tenant_id=$1 AND advisor_id=$2 AND student_id=$3 AND active=true",
      [ctx.tenantId, ctx.userId, studentId],
    );
    if (!a.rows.length) throw new AppError(403, "FORBIDDEN");
  }
}
function publicItem(item: LearningRecord): LearningRecord {
  const { key, rubric, feedback, solution, ...safe } = item.data;
  void key;
  void rubric;
  void feedback;
  void solution;
  return { ...item, data: safe };
}
export function bkt(
  prior: number,
  correct: boolean,
  slip = 0.1,
  guess = 0.2,
  learn = 0.15,
): number {
  const p = Math.max(0.001, Math.min(0.999, prior));
  const posterior = correct
    ? (p * (1 - slip)) / (p * (1 - slip) + (1 - p) * guess)
    : (p * slip) / (p * slip + (1 - p) * (1 - guess));
  return posterior + (1 - posterior) * learn;
}
export function deriveObjective(
  attempts: Array<{
    familyId: string;
    correct: boolean | null;
    assisted: boolean;
    at: string;
    moderation?: string;
  }>,
  now = new Date(),
) {
  const independent = attempts.filter(
    (a) =>
      !a.assisted &&
      typeof a.correct === "boolean" &&
      a.moderation !== "pending",
  );
  const unique = new Map<string, (typeof attempts)[number]>();
  for (const a of independent)
    if (!unique.has(a.familyId)) unique.set(a.familyId, a);
  const evidence = [...unique.values()].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
  const recent = evidence.filter(
    (a) => now.getTime() - new Date(a.at).getTime() < 90 * 86400000,
  );
  const correct = recent.filter((a) => a.correct).length;
  let probability = 0.2;
  for (const a of evidence) probability = bkt(probability, !!a.correct);
  const status =
    recent.length === 0
      ? "unassessed"
      : recent.length < 2
        ? "developing"
        : correct === recent.length
          ? "secure"
          : "developing";
  return {
    status,
    independentFamilies: recent.length,
    correctFamilies: correct,
    totalAttempts: attempts.length,
    assistedAttempts: attempts.filter((a) => a.assisted).length,
    lastEvidenceAt: evidence.at(-1)?.at ?? null,
    model: "independent-family-baseline-v1",
    bkt: {
      model: "BKT-comparator-v1",
      probability: Math.round(probability * 10000) / 10000,
    },
    needsProbe: recent.length === 0 || recent.some((a) => !a.correct),
    evidenceType: "first-unassisted-per-family",
  };
}
export function qmsCounts(
  eligible: number,
  assessed: number,
  attaining: number,
) {
  if (
    eligible < 0 ||
    assessed < 0 ||
    attaining < 0 ||
    assessed > eligible ||
    attaining > assessed
  )
    throw new AppError(400, "INVALID_INPUT");
  return {
    eligible,
    assessed,
    attaining,
    attainment: assessed ? (100 * attaining) / assessed : null,
    coverage: eligible ? (100 * assessed) / eligible : null,
  };
}
export async function publishedPrerequisiteSupport(
  tx: Queryable,
  ctx: AuthContext,
  userId: string,
  objectiveId: string,
) {
  const release = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows[0];
  if (!release?.data.publishedAt) return null;
  const objectives = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='objective'",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows;
  const target = objectives.find((o) => o.data.objectiveId === objectiveId);
  if (!target) return null;
  const normalize = (v: string) => v.normalize("NFKC").toLowerCase().trim();
  const matches = (concept: any, reference: string) =>
    typeof reference === "string" &&
    [
      concept.id,
      concept.label?.ar,
      concept.label?.en,
      ...(concept.aliases ?? []),
    ]
      .filter(Boolean)
      .some((v) => normalize(v) === normalize(reference));
  const concepts = release.data.graph?.concepts ?? [];
  const dependent = concepts.find((c: any) =>
    matches(c, target.data.conceptId),
  );
  if (!dependent) return null;
  const validEvidence = new Set(
    (
      await tx.query<{ id: string }>(
        "SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND c.status='approved' AND v.current_version=true AND v.rights->>'displayExcerpt'='true'",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows.map((r) => r.id),
  );
  const links = (release.data.graph.edges ?? []).filter(
    (e: any) =>
      e.to === dependent.id &&
      e.type === "prerequisite" &&
      e.evidenceIds.length &&
      e.evidenceIds.every((id: string) => validEvidence.has(id)),
  );
  const states = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind='state'",
      [ctx.tenantId, ctx.courseId, userId],
    )
  ).rows;
  const support = links
    .map((edge: any) => {
      const concept = concepts.find((c: any) => c.id === edge.from);
      if (!concept) return null;
      const objective = objectives.find((o) =>
        matches(concept, o.data.conceptId),
      );
      const state = objective
        ? states.find((r) => r.data.objectiveId === objective.data.objectiveId)
        : null;
      return {
        conceptId: concept.id,
        label: concept.label,
        objectiveId: objective?.data.objectiveId ?? null,
        status: state?.data.status ?? "unassessed",
        evidenceIds: edge.evidenceIds,
      };
    })
    .filter((x: any) => x && x.status !== "secure");
  return support.length
    ? {
        releaseId: release.id,
        concepts: support,
        nextAction: "optional-prerequisite-probe",
        note: bi(
          "اعتماد العلاقة لا يثبت إتقان الطالب؛ اختبر الفجوة بدليل مستقل.",
          "An approved relationship does not prove learner mastery; probe the gap independently.",
        ),
      }
    : null;
}
async function recompute(
  tx: Queryable,
  ctx: AuthContext,
  userId: string,
  objectiveId: string,
) {
  const { rows } = await tx.query<Row>(
    "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND kind='attempt' AND course_id=$3 AND data->>'objectiveId'=$4 ORDER BY created_at,id",
    [ctx.tenantId, userId, ctx.courseId, objectiveId],
  );
  const state = {
    objectiveId,
    ...deriveObjective(rows.map((r) => r.data as any)),
    asOf: new Date().toISOString(),
  };
  await put(tx, ctx, `state:${userId}:${objectiveId}`, "state", state, userId);
  const choose = objectiveId === "metric.choose";
  const transfer = objectiveId === "gradient.transfer";
  const title =
    state.status === "secure"
      ? bi("جرّب هدفًا مستقلًا جديدًا", "Try a new independent objective")
      : choose
        ? bi(
            "اختيار المقياس حسب تكلفة الخطأ",
            "Choose the metric by error cost",
          )
        : transfer
          ? bi(
              "اربط اتجاه الخطوة بإشارة المشتقة",
              "Connect update direction to derivative sign",
            )
          : bi("اختيار المقام في Recall", "Choose the denominator in recall");
  const prerequisiteSupport = await publishedPrerequisiteSupport(
    tx,
    ctx,
    userId,
    objectiveId,
  );
  const recommendation = {
    objectiveId,
    title,
    prerequisiteSupport,
    reason: bi(
      `الدليل المستقل: ${state.correctFamilies} إجابات صحيحة من ${state.independentFamilies} عائلات حديثة. المساعدة والزمن لا يثبتان الإتقان.`,
      `Independent evidence: ${state.correctFamilies} correct out of ${state.independentFamilies} recent families. Help and time spent do not establish mastery.`,
    ),
    nextAction:
      state.status === "secure" ? "next-objective" : "fresh-independent-probe",
    evidenceIds: rows.map((r) => r.id),
    model: state.model,
    asOf: state.asOf,
    retired: state.status === "secure",
  };
  await put(
    tx,
    ctx,
    `recommendation:${userId}:${objectiveId}`,
    "recommendation",
    recommendation,
    userId,
  );
  return { state, recommendation };
}
export async function workspace(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "read");
  const conn = db.tenant(ctx.tenantId);
  let students: string[] = [];
  if (ctx.role === "student") students = [ctx.userId];
  else if (ctx.role === "advisor")
    students = (
      await conn.query<{ student_id: string }>(
        "SELECT student_id FROM advisor_assignments WHERE tenant_id=$1 AND advisor_id=$2 AND active=true",
        [ctx.tenantId, ctx.userId],
      )
    ).rows.map((r) => r.student_id);
  else
    students = (
      await conn.query<{ user_id: string }>(
        "SELECT user_id FROM course_access WHERE tenant_id=$1 AND course_id=$2 AND access_role=$3 AND active=true",
        [ctx.tenantId, ctx.courseId, "student"],
      )
    ).rows.map((r) => r.user_id);
  const all = (
    await conn.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND (owner_id IS NULL OR owner_id=ANY($3::text[])) ORDER BY created_at,id",
      [ctx.tenantId, ctx.courseId, students],
    )
  ).rows.map(toRecord);
  const of = (kind: string) => all.filter((r) => r.kind === kind);
  const protectedExam =
    (
      await conn.query(
        "SELECT user_id FROM exam_sessions WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND protected=true AND status='active'",
        [ctx.tenantId, ctx.userId, ctx.courseId],
      )
    ).rows.length > 0;
  const items = of("item").filter(
    (r) =>
      ctx.role === "instructor" ||
      (r.data.approved && !r.data.protected && !protectedExam),
  );
  const baseline = of("quality")[0]?.data ?? {
    eligible: 0,
    assessed: 0,
    attaining: 0,
  };
  const qms = {
    ...baseline,
    fixture: baseline.fixture === true,
    ...qmsCounts(baseline.eligible, baseline.assessed, baseline.attaining),
    smallGroupThreshold: 5,
    groups: (baseline.groups ?? []).map((g: any) =>
      g.assessed >= 5
        ? { ...g, attainment: (100 * g.attaining) / g.assessed }
        : { objectiveId: g.objectiveId, suppressed: true },
    ),
  };
  const interventions = of("intervention").map((r) => {
    if (ctx.role !== "instructor")
      return {
        ...r,
        data: {
          objectiveId: r.data.objectiveId,
          title: r.data.title,
          body: r.data.body,
          at: r.data.at,
          comparison: r.data.comparison,
        },
      };
    const beforeFamily = new Set(
      of("attempt")
        .filter(
          (a) =>
            a.data.objectiveId === r.data.objectiveId && a.data.at <= r.data.at,
        )
        .map((a) => `${a.ownerId}:${a.data.familyId}`),
    );
    const independent = new Map<string, LearningRecord>();
    for (const a of of("attempt")
      .filter(
        (a) =>
          a.data.objectiveId === r.data.objectiveId &&
          a.data.at > r.data.at &&
          !a.data.assisted &&
          a.data.moderation !== "pending",
      )
      .sort((a, b) => a.data.at.localeCompare(b.data.at))) {
      const key = `${a.ownerId}:${a.data.familyId}`;
      if (!beforeFamily.has(key) && !independent.has(key))
        independent.set(key, a);
    }
    const after = [...independent.values()];
    const learnerCount = new Set(after.map((a) => a.ownerId)).size;
    return {
      ...r,
      data: {
        ...r.data,
        after:
          learnerCount < 5
            ? { suppressed: true, minimumGroupSize: 5 }
            : {
                suppressed: false,
                learners: learnerCount,
                independentFamilies: after.length,
                correct: after.filter((a) => a.data.correct).length,
              },
        descriptive: true,
        freshFamiliesOnly: true,
      },
    };
  });
  const safePrivate = new Set([
    "state",
    "event",
    "recommendation",
    "submission",
    "portfolio",
    "progress",
    "preferences",
    "attempt",
    "override",
  ]);
  const privateRecords = all.filter((r) => safePrivate.has(r.kind));
  const roleName =
    ctx.role === "student"
      ? bi("سلمى حسن", "Salma Hassan")
      : ctx.role === "instructor"
        ? bi("د. أحمد · مدرس المقرر", "Dr. Ahmed · Course instructor")
        : bi("د. مريم · المرشد الأكاديمي", "Dr. Mariam · Academic advisor");
  return {
    mode: process.env.LOCAL_DATABASE === "1" ? "local" : "neon",
    user: { id: ctx.userId, role: ctx.role, name: roleName },
    students,
    courses: of("course"),
    sessions: of("session").filter(
      (r) => ctx.role === "instructor" || r.data.approved,
    ),
    items: ctx.role === "instructor" ? items : items.map(publicItem),
    objectives: of("objective"),
    states: of("state"),
    events: of("event"),
    recommendations: of("recommendation"),
    assignments: of("assignment"),
    submissions: of("submission"),
    announcements: of("announcement"),
    calendar: of("calendar"),
    portfolio: of("portfolio"),
    interventions,
    qms: ctx.role === "instructor" ? qms : null,
    preferences: of("preferences").find((r) => r.ownerId === ctx.userId)
      ?.data ?? {
      lessonLanguage: "mixed",
      presentation: "steps",
      uiLanguage: "ar",
    },
    grades: await Promise.all(
      students.map((id) => getOfficialGrades(ctx.tenantId, id)),
    ).then((a) => a.flat()),
    progress: of("progress"),
    attempts: of("attempt").map((r) => ({
      ...r,
      data: { ...r.data, key: undefined },
    })),
    examMode: protectedExam,
    fixture: true,
    privateRecords:
      ctx.role === "advisor"
        ? privateRecords.filter((r) =>
            ["state", "event", "recommendation", "portfolio"].includes(r.kind),
          )
        : undefined,
  };
}
export async function learningAction(
  ctx: AuthContext,
  input: unknown,
): Promise<any> {
  const a = actionSchema.parse(input);
  if (a.action === "enroll") {
    role(ctx, "student");
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      const m = await tx.query(
        "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role=$3 AND active=true",
        [ctx.tenantId, ctx.userId, "student"],
      );
      if (!m.rows.length) throw new AppError(403, "FORBIDDEN");
      const catalog = await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='course' AND data->>'openEnrollment'='true'",
        [ctx.tenantId, a.courseId],
      );
      if (!catalog.rows.length) throw new AppError(403, "COURSE_FORBIDDEN");
      const prior = await tx.query<{ active: boolean }>(
        "SELECT active FROM course_access WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3",
        [ctx.tenantId, ctx.userId, a.courseId],
      );
      if (prior.rows[0] && !prior.rows[0].active)
        throw new AppError(403, "COURSE_FORBIDDEN");
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role) VALUES($1,$2,$3,'student') ON CONFLICT(tenant_id,user_id,course_id) DO NOTHING",
        [ctx.tenantId, ctx.userId, a.courseId],
      );
      return { enrolled: true, courseId: a.courseId };
    });
  }
  const isPractice = a.action === "select-practice" || a.action === "attempt";
  const operation = isPractice
    ? "practice"
    : [
          "announcement",
          "intervention",
          "feedback",
          "override",
          "undo-override",
          "review-attempt",
          "start-exam",
          "end-exam",
        ].includes(a.action)
      ? "write"
      : "read";
  await authorizeCourse(ctx, ctx.courseId, operation);
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    // Lock the caller's membership to serialize retries, exposure and evidence updates.
    await tx.query(
      "SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
      [ctx.tenantId, ctx.userId],
    );
    await authorizeCourseInTransaction(ctx, ctx.courseId, operation, tx);
    if (a.action === "select-practice") {
      role(ctx, "student");
      const { rows } = await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false' ORDER BY id",
        [ctx.tenantId, ctx.courseId],
      );
      const seen = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='attempt'",
          [ctx.tenantId, ctx.userId, ctx.courseId],
        )
      ).rows;
      const recommendations = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind='recommendation' ORDER BY updated_at DESC",
          [ctx.tenantId, ctx.courseId, ctx.userId],
        )
      ).rows;
      const targetObjective =
        a.objectiveId ??
        recommendations.find((r) => !r.data.retired)?.data.objectiveId ??
        "recall.calculate";
      const prerequisiteSupport = await publishedPrerequisiteSupport(
        tx,
        ctx,
        ctx.userId,
        targetObjective,
      );
      const fresh = rows
        .map(toRecord)
        .filter(
          (r) =>
            (!a.kind || r.data.kind === a.kind) &&
            !seen.some((s) => s.data.familyId === r.data.familyId),
        );
      const supportObjective = !a.objectiveId
        ? prerequisiteSupport?.concepts.find(
            (c: any) =>
              c.objectiveId &&
              fresh.some((r) => r.data.objectiveId === c.objectiveId),
          )?.objectiveId
        : null;
      const item =
        fresh.find(
          (r) => r.data.objectiveId === (supportObjective ?? targetObjective),
        ) ?? (!a.objectiveId ? fresh[0] : undefined);
      if (!item)
        return {
          item: null,
          reason: bi(
            "لا توجد عائلة معتمدة جديدة لهذا الهدف؛ اطلب من المدرّس إضافة تدريب.",
            "No fresh approved family remains for this objective; ask your instructor for more practice.",
          ),
        };
      const deliveryId = `delivery:${randomUUID()}`;
      await put(
        tx,
        ctx,
        deliveryId,
        "delivery",
        {
          itemId: item.id,
          version: item.data.version,
          familyId: item.data.familyId,
          objectiveId: item.data.objectiveId,
          assisted: false,
          at: new Date().toISOString(),
        },
        ctx.userId,
      );
      return { item: publicItem(item), deliveryId, prerequisiteSupport };
    }
    if (a.action === "attempt") {
      role(ctx, "student");
      const id = `attempt:${ctx.userId}:${a.idempotencyKey}`;
      const existing = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.data.deliveryId !== a.deliveryId ||
          existing.data.answer !== a.answer ||
          existing.data.explanation !== (a.explanation ?? "")
        )
          throw new AppError(409, "INVALID_INPUT");
        return existing.data.result;
      }
      const delivery = await get(tx, ctx, a.deliveryId, "delivery");
      if (delivery.ownerId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
      const used = (
        await tx.query(
          "SELECT id FROM records WHERE tenant_id=$1 AND owner_id=$2 AND kind='attempt' AND data->>'deliveryId'=$3",
          [ctx.tenantId, ctx.userId, a.deliveryId],
        )
      ).rows;
      if (used.length) throw new AppError(409, "INVALID_INPUT");
      const item = await get(tx, ctx, delivery.data.itemId, "item");
      if (
        !item.data.approved ||
        item.data.protected ||
        item.data.version !== delivery.data.version
      )
        throw new AppError(403, "FORBIDDEN");
      if (
        item.data.kind === "critique" &&
        (!a.explanation || a.explanation.trim().length < 5)
      )
        throw new AppError(400, "INVALID_INPUT");
      const moderated =
        item.data.kind === "open" || item.data.kind === "critique";
      const correct =
        item.data.kind === "open" ? null : a.answer === item.data.key;
      const at = new Date().toISOString();
      const data = {
        deliveryId: a.deliveryId,
        itemId: item.id,
        itemVersion: item.data.version,
        graphVersion: item.data.graphVersion,
        policyVersion: "tilwa-policy-1",
        modelVersion: "independent-family-baseline-v1",
        objectiveId: item.data.objectiveId,
        familyId: item.data.familyId,
        answer: a.answer,
        explanation: a.explanation ?? "",
        errorLocation: item.data.kind === "critique" ? a.answer : undefined,
        correct,
        assisted: delivery.data.assisted === true,
        at,
        moderation: moderated ? "pending" : "not-required",
        fixtureItem: !!item.data.fixture,
      };
      await put(tx, ctx, id, "attempt", data, ctx.userId);
      await put(
        tx,
        ctx,
        `event:${id}`,
        "event",
        {
          type: "answer",
          attemptId: id,
          objectiveId: data.objectiveId,
          correct,
          assisted: data.assisted,
          at,
          itemVersion: data.itemVersion,
          graphVersion: data.graphVersion,
          policyVersion: data.policyVersion,
          title: item.data.stem,
        },
        ctx.userId,
      );
      const derived = await recompute(tx, ctx, ctx.userId, data.objectiveId);
      const result = {
        attempt: { id, ...data },
        feedback:
          item.data.feedback ??
          bi(
            "تم حفظ إجابتك للمراجعة وفق Rubric المدرّس.",
            "Your response was saved for instructor rubric review.",
          ),
        ...derived,
      };
      await put(tx, ctx, id, "attempt", { ...data, result }, ctx.userId);
      return result;
    }
    if (a.action === "complete-session") {
      role(ctx, "student");
      const session = await get(tx, ctx, a.sessionId, "session");
      if (!session.data.approved) throw new AppError(403, "FORBIDDEN");
      return put(
        tx,
        ctx,
        `progress:${ctx.userId}:${a.sessionId}`,
        "progress",
        {
          sessionId: a.sessionId,
          completed: true,
          at: new Date().toISOString(),
          note: bi(
            "إكمال الجلسة ليس دليل إتقان أو درجة رسمية.",
            "Session completion is neither mastery evidence nor an official grade.",
          ),
        },
        ctx.userId,
      );
    }
    if (a.action === "preferences" || a.action === "career-target") {
      const id = `preferences:${ctx.userId}`;
      const existing =
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
            [ctx.tenantId, id],
          )
        ).rows[0]?.data ?? {};
      const { action, ...values } = a;
      return put(
        tx,
        ctx,
        id,
        "preferences",
        {
          ...existing,
          ...(action === "career-target"
            ? { careerTarget: (values as any).target }
            : values),
        },
        ctx.userId,
      );
    }
    if (a.action === "submit-assignment") {
      role(ctx, "student");
      await get(tx, ctx, a.assignmentId, "assignment");
      if (a.url && new URL(a.url).protocol !== "https:")
        throw new AppError(400, "INVALID_INPUT");
      return put(
        tx,
        ctx,
        `submission:${ctx.userId}:${a.assignmentId}`,
        "submission",
        {
          assignmentId: a.assignmentId,
          text: a.text,
          url: a.url ?? null,
          status: "submitted",
          at: new Date().toISOString(),
        },
        ctx.userId,
      );
    }
    if (a.action === "feedback") {
      role(ctx, "instructor");
      const submission = await get(tx, ctx, a.submissionId, "submission");
      await canSeeStudent(tx, ctx, submission.ownerId!);
      return put(
        tx,
        ctx,
        submission.id,
        "submission",
        {
          ...submission.data,
          feedback: a.feedback,
          formativeScore: a.score,
          status: "reviewed",
          reviewerId: ctx.userId,
          reviewedAt: new Date().toISOString(),
          officialGrade: false,
        },
        submission.ownerId,
      );
    }
    if (a.action === "portfolio") {
      role(ctx, "student");
      if (new URL(a.url).protocol !== "https:")
        throw new AppError(400, "INVALID_INPUT");
      return put(
        tx,
        ctx,
        `portfolio:${randomUUID()}`,
        "portfolio",
        {
          title: a.title,
          url: a.url,
          description: a.description,
          include: a.include,
          status: "submitted",
          at: new Date().toISOString(),
        },
        ctx.userId,
      );
    }
    if (a.action === "portfolio-visibility") {
      role(ctx, "student");
      const artifact = await get(tx, ctx, a.artifactId, "portfolio");
      if (artifact.ownerId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
      return put(
        tx,
        ctx,
        artifact.id,
        artifact.kind,
        { ...artifact.data, include: a.include },
        ctx.userId,
      );
    }
    if (a.action === "review-portfolio") {
      role(ctx, "instructor", "advisor");
      const artifact = await get(tx, ctx, a.artifactId, "portfolio");
      await canSeeStudent(tx, ctx, artifact.ownerId!);
      return put(
        tx,
        ctx,
        artifact.id,
        "portfolio",
        {
          ...artifact.data,
          status: "reviewed",
          rubric: a.rubric,
          feedback: a.feedback,
          reviewerId: ctx.userId,
          reviewedAt: new Date().toISOString(),
          nextAction: bi(
            "حسّن أضعف بُعد في Rubric ثم أعد تقديم العمل.",
            "Improve the lowest rubric dimension, then resubmit the work.",
          ),
        },
        artifact.ownerId,
      );
    }
    if (a.action === "intervention") {
      role(ctx, "instructor");
      await get(tx, ctx, `objective:${a.objectiveId}`, "objective");
      const before = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='state' AND data->>'objectiveId'=$3",
          [ctx.tenantId, ctx.courseId, a.objectiveId],
        )
      ).rows;
      return put(tx, ctx, `intervention:${randomUUID()}`, "intervention", {
        objectiveId: a.objectiveId,
        title: a.title,
        body: a.body,
        at: new Date().toISOString(),
        reviewerId: ctx.userId,
        before: before.map((r) => ({ studentId: r.owner_id, state: r.data })),
        comparison: bi(
          "قارن الأداء المستقل الأول في عائلة جديدة بعد التدخل. النتائج وصفية.",
          "Compare first independent performance on a fresh family after the intervention. Results are descriptive.",
        ),
        minimumGroupSize: 5,
      });
    }
    if (a.action === "override") {
      role(ctx, "instructor");
      await canSeeStudent(tx, ctx, a.studentId);
      await get(tx, ctx, `objective:${a.objectiveId}`, "objective");
      const id = `state:${a.studentId}:${a.objectiveId}`;
      const prior = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id],
        )
      ).rows[0]?.data ?? { objectiveId: a.objectiveId, ...deriveObjective([]) };
      const priorRecommendation =
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
            [ctx.tenantId, `recommendation:${a.studentId}:${a.objectiveId}`],
          )
        ).rows[0]?.data ?? null;
      const overrideId = `override:${randomUUID()}`;
      await put(
        tx,
        ctx,
        overrideId,
        "override",
        {
          objectiveId: a.objectiveId,
          prior,
          priorRecommendation,
          status: a.status,
          reason: a.reason,
          reviewerId: ctx.userId,
          at: new Date().toISOString(),
          reversed: false,
        },
        a.studentId,
      );
      await put(
        tx,
        ctx,
        `recommendation:${a.studentId}:${a.objectiveId}`,
        "recommendation",
        {
          ...priorRecommendation,
          objectiveId: a.objectiveId,
          title: bi(
            "توصية بعد مراجعة المدرّس",
            "Recommendation after instructor review",
          ),
          reason: bi(a.reason, a.reason),
          nextAction:
            a.status === "secure"
              ? "next-objective"
              : "fresh-independent-probe",
          retired: a.status === "secure",
          overrideId,
          model: "instructor-override",
          asOf: new Date().toISOString(),
        },
        a.studentId,
      );
      return put(
        tx,
        ctx,
        id,
        "state",
        {
          ...prior,
          status: a.status,
          overrideId,
          overrideReason: a.reason,
          model: "instructor-override",
          asOf: new Date().toISOString(),
        },
        a.studentId,
      );
    }
    if (a.action === "undo-override") {
      role(ctx, "instructor");
      const override = await get(tx, ctx, a.overrideId, "override");
      await canSeeStudent(tx, ctx, override.ownerId!);
      if (override.data.reversed) throw new AppError(409, "INVALID_INPUT");
      const state = await get(
        tx,
        ctx,
        `state:${override.ownerId}:${override.data.objectiveId}`,
        "state",
      );
      if (state.data.overrideId !== override.id)
        throw new AppError(409, "INVALID_INPUT");
      await put(
        tx,
        ctx,
        override.id,
        "override",
        {
          ...override.data,
          reversed: true,
          reversedBy: ctx.userId,
          reversedAt: new Date().toISOString(),
        },
        override.ownerId,
      );
      if (override.data.priorRecommendation)
        await put(
          tx,
          ctx,
          `recommendation:${override.ownerId}:${override.data.objectiveId}`,
          "recommendation",
          override.data.priorRecommendation,
          override.ownerId,
        );
      else
        await tx.query("DELETE FROM records WHERE tenant_id=$1 AND id=$2", [
          ctx.tenantId,
          `recommendation:${override.ownerId}:${override.data.objectiveId}`,
        ]);
      return put(
        tx,
        ctx,
        state.id,
        "state",
        override.data.prior,
        override.ownerId,
      );
    }
    if (a.action === "announcement") {
      role(ctx, "instructor");
      return put(tx, ctx, `announcement:${randomUUID()}`, "announcement", {
        title: a.title,
        body: a.body,
        authorId: ctx.userId,
        at: new Date().toISOString(),
      });
    }
    if (a.action === "review-attempt") {
      role(ctx, "instructor");
      const attempt = await get(tx, ctx, a.attemptId, "attempt");
      await canSeeStudent(tx, ctx, attempt.ownerId!);
      if (attempt.data.moderation !== "pending")
        throw new AppError(409, "INVALID_INPUT");
      const data = {
        ...attempt.data,
        correct: a.score === 1,
        moderation: "reviewed",
        rubricFeedback: a.feedback,
        reviewerId: ctx.userId,
        reviewedAt: new Date().toISOString(),
      };
      await put(tx, ctx, attempt.id, "attempt", data, attempt.ownerId);
      await put(
        tx,
        ctx,
        `moderation:${attempt.id}`,
        "event",
        {
          type: "rubric-review",
          attemptId: attempt.id,
          correct: data.correct,
          feedback: a.feedback,
          reviewerId: ctx.userId,
          at: new Date().toISOString(),
        },
        attempt.ownerId,
      );
      return recompute(tx, ctx, attempt.ownerId!, attempt.data.objectiveId);
    }
    if (a.action === "start-exam" || a.action === "end-exam") {
      role(ctx, "instructor");
      await canSeeStudent(tx, ctx, a.studentId);
      await tx.query(
        "SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [ctx.tenantId, a.studentId],
      );
      if (a.action === "start-exam") {
        const active = await tx.query(
          "SELECT id FROM exam_sessions WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND status='active'",
          [ctx.tenantId, a.studentId, ctx.courseId],
        );
        if (!active.rows.length)
          await tx.query(
            "INSERT INTO exam_sessions(tenant_id,id,user_id,course_id,protected,status) VALUES($1,$2,$3,$4,true,'active')",
            [ctx.tenantId, randomUUID(), a.studentId, ctx.courseId],
          );
      } else
        await tx.query(
          "UPDATE exam_sessions SET status='completed',ended_at=now() WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND status='active'",
          [ctx.tenantId, a.studentId, ctx.courseId],
        );
      return { examMode: a.action === "start-exam" };
    }
    throw new AppError(400, "INVALID_INPUT");
  });
}
