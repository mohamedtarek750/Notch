import { randomUUID } from "node:crypto";
import { z } from "zod";
import { majorCourses } from "./sources";
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
    // "I don't know" is an honest answer: recorded as not known, never penalised further.
    unknown: z.boolean().optional(),
    elapsedMs: z.number().int().min(0).max(3_600_000).optional(),
  }),
  z.object({ action: z.literal("hint"), deliveryId: str }),
  z.object({ action: z.literal("nudge-seen"), id: str }),
  z.object({ action: z.literal("review-due") }),
  z.object({ action: z.literal("review-show"), itemId: str }),
  z.object({
    action: z.literal("review-rate"),
    itemId: str,
    rating: z.enum(["easy", "medium", "hard"]),
    picked: z.string().max(100).optional(),
  }),
  z.object({
    action: z.literal("exam-save"),
    name: z.string().trim().min(1).max(120),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    concepts: z
      .array(
        z.object({
          conceptId: str,
          weight: z.number().int().min(1).max(5),
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({
    action: z.literal("course-settings"),
    tutorStrictness: z.enum([
      "hints-only",
      "hints-then-answer",
      "answer-allowed",
    ]),
  }),
  z.object({ action: z.literal("mock-start"), examId: str }),
  z.object({
    action: z.literal("mock-finish"),
    examId: str,
    deliveryIds: z.array(str).min(1).max(20),
  }),
  z.object({
    action: z.literal("diagnose"),
    objectiveId: str,
    // Set once a prerequisite check or a format switch has already been tried.
    afterPrerequisite: z.enum(["passed", "failed"]).optional(),
    previousEpisodeId: str.optional(),
    formatTried: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("diagnosis-outcome"),
    episodeId: str,
    choice: z.enum([
      "check-prerequisite",
      "stay",
      "format",
      "worked-example",
      "break",
      "ask-instructor",
      "fresh-question",
    ]),
    format: z.string().max(40).optional(),
    helped: z.boolean().optional(),
  }),
  z.object({ action: z.literal("complete-session"), sessionId: str }),
  z.object({
    action: z.literal("diagnostic"),
    limit: z.number().int().min(1).max(12).optional(),
  }),
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
  z.object({
    action: z.literal("enroll"),
    courseId: z.string().min(1).max(40),
  }),
  z.object({
    action: z.literal("review-attempt"),
    attemptId: str,
    score: z.union([z.literal(0), z.literal(1)]),
    feedback: pair,
  }),
  z.object({ action: z.literal("start-exam"), studentId: str }),
  z.object({ action: z.literal("end-exam"), studentId: str }),
]);
const LECTURE_CHECK = "lecture:";
const LECTURE_CHECK_QUESTIONS = 5;
/**
 * The concepts each current lecture teaches, read from the published tree: a concept
 * belongs to the lecture whose approved page it cites first.
 */
export async function lectureConcepts(tx: Queryable, ctx: AuthContext) {
  const pages = (
    await tx.query<{ id: string; source_key: string; title: string }>(
      "SELECT c.id,v.source_key,v.title FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND v.role='instructor' AND v.current_version=true",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows;
  const lectureOf = new Map(pages.map((p) => [p.id, p]));
  const graph = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows[0]?.data.graph;
  const lectures = new Map<
    string,
    { key: string; title: string; conceptIds: string[] }
  >();
  for (const concept of graph?.concepts ?? []) {
    if (concept.scope === "foundation") continue;
    const page = (concept.evidenceIds ?? [])
      .map((id: string) => lectureOf.get(id))
      .find(Boolean);
    if (!page) continue;
    const lecture = lectures.get(page.source_key) ?? {
      key: page.source_key,
      title: page.title,
      conceptIds: [] as string[],
    };
    lecture.conceptIds.push(concept.id);
    lectures.set(page.source_key, lecture);
  }
  return [...lectures.values()].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true }),
  );
}
/** The short check offered after each lecture: which exist, and the learner's last result. */
async function lectureChecks(
  tx: Queryable,
  ctx: AuthContext,
  results: LearningRecord[],
) {
  const lectures = await lectureConcepts(tx, ctx);
  if (!lectures.length) return [];
  const questions = (
    await tx.query<{ objective: string; n: string }>(
      "SELECT data->>'objectiveId' AS objective,count(*) AS n FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false' AND data->>'kind' IN ('choice','transfer') GROUP BY 1",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows;
  return lectures.map((lecture) => {
    const last = results
      .filter((r) => r.data.examId === LECTURE_CHECK + lecture.key)
      .sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)))[0];
    return {
      id: LECTURE_CHECK + lecture.key,
      title: lecture.title,
      concepts: lecture.conceptIds.length,
      questions: lecture.conceptIds.reduce(
        (n, id) =>
          n + Number(questions.find((q) => q.objective === `c:${id}`)?.n ?? 0),
        0,
      ),
      last: last
        ? {
            correct: last.data.correct,
            served: last.data.served,
            at: last.data.at,
          }
        : null,
    };
  });
}
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
    "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=EXCLUDED.data,updated_at=now()",
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
  const { key, rubric, feedback, solution, hints, ...safe } = item.data;
  void hints;
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
    lowConfidence?: boolean;
  }>,
  now = new Date(),
) {
  const independent = attempts.filter(
    (a) =>
      !a.assisted &&
      // A run of very fast answers is not evidence either way.
      !a.lowConfidence &&
      // The post-test measures learning gain and is kept apart from practice.
      !(a as { posttest?: boolean }).posttest &&
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
        "SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND (c.course_id=$2 OR (v.role='umbrella' AND c.course_id=ANY($3::text[]))) AND c.status='approved' AND v.current_version=true AND v.rights->>'displayExcerpt'='true'",
        [ctx.tenantId, ctx.courseId, await majorCourses(ctx, tx)],
      )
    ).rows.map((r) => r.id),
  );
  const links = (release.data.graph.edges ?? []).filter(
    (e: any) =>
      e.to === dependent.id &&
      e.type === "prerequisite" &&
      // A line the instructor drew is their own decision and needs no citation.
      (e.origin === "instructor" ||
        (e.evidenceIds.length &&
          e.evidenceIds.every((id: string) => validEvidence.has(id)))),
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
/** Difficulty to serve next, from independent evidence only. */
export function targetDifficulty(state?: {
  status?: string;
  independentFamilies?: number;
  correctFamilies?: number;
}) {
  if (!state || !state.independentFamilies) return "easy";
  if (state.status === "secure") return "hard";
  return (state.correctFamilies ?? 0) > 0 ? "medium" : "easy";
}
const difficultyOrder = ["easy", "medium", "hard"];
/** Prefer the target difficulty, then the nearest available one. */
function byDifficulty(items: LearningRecord[], target: string) {
  const at = difficultyOrder.indexOf(target);
  return [...items].sort(
    (a, b) =>
      Math.abs(difficultyOrder.indexOf(a.data.difficulty ?? "medium") - at) -
      Math.abs(difficultyOrder.indexOf(b.data.difficulty ?? "medium") - at),
  );
}
/** Answers quicker than this cannot have been read; only a run of them is flagged. */
const FAST_MS = 2500;
export type PathNode = {
  conceptId: string;
  label: Bilingual;
  objectiveId: string | null;
  status: string;
  blockedBy: { conceptId: string; label: Bilingual; status: string }[];
  /** Estimated probability of mastery from independent answers, 0 to 1. */
  mastery: number | null;
  /** What becoming ready on this concept opens up. */
  unlocks: { conceptId: string; label: Bilingual }[];
  covered: { conceptId: string; label: Bilingual }[];
};
/**
 * The learner's route through the published prerequisite graph: prerequisites first,
 * one node per concept that is assessable or that an assessable concept depends on.
 * `next` is the earliest concept that is not secure and whose prerequisites are.
 */
export async function learningPath(
  tx: Queryable,
  ctx: AuthContext,
  userId: string,
): Promise<{
  releaseId: string | null;
  nodes: PathNode[];
  next: PathNode | null;
}> {
  const release = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows[0];
  if (!release?.data.publishedAt)
    return { releaseId: null, nodes: [], next: null };
  const concepts: any[] = release.data.graph?.concepts ?? [];
  const edges: any[] = (release.data.graph?.edges ?? []).filter(
    (e: any) => e.type === "prerequisite",
  );
  const objectives = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='objective'",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows;
  const states = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind='state'",
      [ctx.tenantId, ctx.courseId, userId],
    )
  ).rows;
  const objectiveOf = new Map<string, string>();
  for (const o of objectives)
    if (
      typeof o.data.objectiveId === "string" &&
      o.data.objectiveId.startsWith("c:")
    )
      objectiveOf.set(o.data.conceptId, o.data.objectiveId);
  const stateOf = (conceptId: string) => {
    const objectiveId = objectiveOf.get(conceptId);
    return objectiveId
      ? states.find((r) => r.data.objectiveId === objectiveId)?.data
      : undefined;
  };
  const direct = (conceptId: string) =>
    !objectiveOf.has(conceptId)
      ? "unassessable"
      : (stateOf(conceptId)?.status ?? "unassessed");
  // A concept answered correctly implies its prerequisites are probably known. That is an
  // inference, not evidence: later practice or a confirming check can overturn it.
  const inferred = new Set<string>();
  const mark = (conceptId: string, depth: number) => {
    if (depth > 3) return;
    for (const e of edges)
      if (e.to === conceptId && !inferred.has(e.from)) {
        inferred.add(e.from);
        mark(e.from, depth + 1);
      }
  };
  for (const id of objectiveOf.keys()) if (direct(id) === "secure") mark(id, 0);
  const statusOf = (conceptId: string) => {
    const own = direct(conceptId);
    return own === "unassessed" && inferred.has(conceptId) ? "inferred" : own;
  };
  const relevant = new Set<string>(objectiveOf.keys());
  for (const e of edges) if (objectiveOf.has(e.to)) relevant.add(e.from);
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const included = [...relevant].filter((id) => byId.has(id));
  // Kahn ordering over hard prerequisites; the release is already cycle-free.
  const indegree = new Map(included.map((id) => [id, 0]));
  for (const e of edges)
    if (indegree.has(e.from) && indegree.has(e.to))
      indegree.set(e.to, indegree.get(e.to)! + 1);
  const queue = included.filter((id) => !indegree.get(id));
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const e of edges)
      if (e.from === id && indegree.has(e.to)) {
        indegree.set(e.to, indegree.get(e.to)! - 1);
        if (!indegree.get(e.to)) queue.push(e.to);
      }
  }
  const nodes: PathNode[] = ordered.map((id) => ({
    conceptId: id,
    label: byId.get(id).label,
    objectiveId: objectiveOf.get(id) ?? null,
    status: statusOf(id),
    blockedBy: edges
      .filter((e) => e.to === id && byId.has(e.from))
      .map((e) => ({
        conceptId: e.from,
        label: byId.get(e.from).label,
        status: statusOf(e.from),
      }))
      // Only an assessable, not-yet-secure prerequisite can hold a learner back.
      .filter(
        (p) =>
          p.status !== "secure" &&
          p.status !== "unassessable" &&
          p.status !== "inferred",
      ),
    mastery: stateOf(id)?.bkt?.probability ?? null,
    unlocks: edges
      .filter((e) => e.from === id && byId.has(e.to))
      .map((e) => ({ conceptId: e.to, label: byId.get(e.to).label })),
    covered: edges
      .filter(
        (e) => e.to === id && byId.has(e.from) && statusOf(e.from) === "secure",
      )
      .map((e) => ({ conceptId: e.from, label: byId.get(e.from).label })),
  }));
  const open = nodes.filter((n) => n.objectiveId && n.status !== "secure");
  return {
    releaseId: release.id,
    nodes,
    next: open.find((n) => !n.blockedBy.length) ?? open[0] ?? null,
  };
}
/** Descriptive first-vs-latest independent performance per objective for course staff. */
export function learningGain(attempts: LearningRecord[], minimumGroup = 5) {
  const groups = new Map<string, Map<string, LearningRecord[]>>();
  for (const a of attempts) {
    if (a.data.assisted || typeof a.data.correct !== "boolean" || !a.ownerId)
      continue;
    const learners = groups.get(a.data.objectiveId) ?? new Map();
    learners.set(a.ownerId, [...(learners.get(a.ownerId) ?? []), a]);
    groups.set(a.data.objectiveId, learners);
  }
  return [...groups].map(([objectiveId, learners]) => {
    const pairs = [...learners.values()]
      .map((list) => list.sort((x, y) => x.data.at.localeCompare(y.data.at)))
      .filter((list) => list.length >= 2);
    if (pairs.length < minimumGroup)
      return { objectiveId, suppressed: true, minimumGroupSize: minimumGroup };
    const first = pairs.filter((l) => l[0].data.correct).length;
    const latest = pairs.filter((l) => l.at(-1)!.data.correct).length;
    return {
      objectiveId,
      suppressed: false,
      learners: pairs.length,
      firstCorrect: first,
      latestCorrect: latest,
      firstRate: (100 * first) / pairs.length,
      latestRate: (100 * latest) / pairs.length,
      descriptive: true,
    };
  });
}
/**
 * Exam readiness: the learner's estimated chance of success on each exam concept, weighted
 * by the instructor's concept weights. Always a soft figure, never a promise or a grade.
 */
export function examReadiness(
  exams: LearningRecord[],
  states: LearningRecord[],
  objectives: LearningRecord[],
  now = new Date(),
) {
  return exams.map((exam) => {
    const concepts = (exam.data.concepts as any[]).map((c) => {
      const objective = objectives.find(
        (o) => o.data.objectiveId === `c:${c.conceptId}`,
      );
      const state = states.find(
        (s) => s.data.objectiveId === `c:${c.conceptId}`,
      )?.data;
      return {
        conceptId: c.conceptId,
        label: objective?.data.title ?? c.label ?? null,
        objectiveId: objective ? `c:${c.conceptId}` : null,
        weight: c.weight,
        // No evidence yet: the same prior the tracer starts from.
        probability: state?.bkt?.probability ?? 0.2,
        assessed: !!state && state.status !== "unassessed",
      };
    });
    const total = concepts.reduce((n, c) => n + c.weight, 0) || 1;
    const raw =
      concepts.reduce((n, c) => n + c.weight * c.probability, 0) / total;
    const assessedShare =
      concepts.filter((c) => c.assessed).reduce((n, c) => n + c.weight, 0) /
      total;
    const daysLeft = Math.ceil(
      (new Date(`${exam.data.date}T00:00:00Z`).getTime() - now.getTime()) /
        86400000,
    );
    const costliest = [...concepts]
      .sort(
        (a, b) =>
          b.weight * (1 - b.probability) - a.weight * (1 - a.probability),
      )
      .slice(0, 4);
    const weak = concepts.filter((c) => c.probability < 0.85).length;
    return {
      examId: exam.id,
      name: exam.data.name,
      date: exam.data.date,
      daysLeft,
      // Rounded to the nearest five and never shown as certain.
      about: Math.min(95, Math.max(5, Math.round((raw * 100) / 5) * 5)),
      assessedShare: Math.round(assessedShare * 100),
      costliest,
      suggestedMinutesPerDay:
        daysLeft > 0
          ? Math.min(
              60,
              Math.max(10, Math.round((weak * 20) / daysLeft / 5) * 5),
            )
          : null,
      concepts: concepts.length,
    };
  });
}
/** Review cards: questions the learner has already met, due now. Missed ones come first. */
async function dueReviews(tx: Queryable, ctx: AuthContext) {
  const attempts = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='attempt' ORDER BY created_at",
      [ctx.tenantId, ctx.userId, ctx.courseId],
    )
  ).rows;
  if (!attempts.length) return [];
  const reviews = new Map(
    (
      await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='review'",
        [ctx.tenantId, ctx.userId, ctx.courseId],
      )
    ).rows.map((r) => [r.data.itemId as string, r.data]),
  );
  const last = new Map<string, Row>();
  for (const a of attempts) last.set(a.data.itemId, a);
  const now = Date.now();
  return [...last.values()]
    .filter((a) => {
      const review = reviews.get(a.data.itemId);
      return !review || new Date(review.dueAt).getTime() <= now;
    })
    .map((a) => ({
      itemId: a.data.itemId as string,
      missed:
        reviews.get(a.data.itemId)?.lastCorrect === false ||
        (!reviews.has(a.data.itemId) && a.data.correct === false),
      dueAt: reviews.get(a.data.itemId)?.dueAt ?? a.data.at,
    }))
    .sort(
      (a, b) =>
        Number(b.missed) - Number(a.missed) || a.dueAt.localeCompare(b.dueAt),
    );
}
/** Next interval in days. A wrong pick overrides an optimistic self-rating. */
export function nextReviewInterval(
  previous: number,
  rating: "easy" | "medium" | "hard",
  pickedCorrectly: boolean | null,
) {
  if (pickedCorrectly === false || rating === "hard") return 1;
  const next =
    rating === "easy" ? Math.max(4, previous * 3) : Math.max(2, previous * 2);
  return Math.min(60, next);
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
  const objectiveTitle = (
    await tx.query<Row>(
      "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='objective'",
      [ctx.tenantId, ctx.courseId, `objective:${objectiveId}`],
    )
  ).rows[0]?.data.title as Bilingual | undefined;
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
          : objectiveId.startsWith("c:") && objectiveTitle
            ? bi(
                `تدرّب على: ${objectiveTitle.ar}`,
                `Practise: ${objectiveTitle.en}`,
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
    "mock_result",
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
      uiLanguage: "en",
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
    diagnoses: of("diagnosis"),
    helpRequests: ctx.role === "instructor" ? of("help_request") : undefined,
    path:
      ctx.role === "student"
        ? await learningPath(conn, ctx, ctx.userId)
        : undefined,
    exams: of("exam"),
    readiness:
      ctx.role === "student"
        ? examReadiness(of("exam"), of("state"), of("objective"))
        : undefined,
    reviewsDue:
      ctx.role === "student" ? (await dueReviews(conn, ctx)).length : undefined,
    settings: of("course_settings")[0]?.data ?? {
      tutorStrictness: "hints-then-answer",
    },
    mockResults: of("mock_result"),
    lectureChecks:
      ctx.role === "student"
        ? await lectureChecks(
            conn,
            ctx,
            of("mock_result").filter((r) => r.ownerId === ctx.userId),
          )
        : undefined,
    nudges: ctx.role === "student" ? of("nudge") : undefined,
    consent:
      ctx.role === "student"
        ? (of("consent").find((r) => r.ownerId === ctx.userId)?.data ?? null)
        : undefined,
    courseEnd:
      ctx.role === "student"
        ? {
            postTestOpen: of("course_settings")[0]?.data.postTestOpen === true,
            postTest:
              of("posttest_result").find((r) => r.ownerId === ctx.userId)
                ?.data ?? null,
            surveyDone: of("survey").some((r) => r.ownerId === ctx.userId),
          }
        : undefined,
    learningGain:
      ctx.role === "instructor" ? learningGain(of("attempt")) : undefined,
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
  const isPractice =
    a.action === "select-practice" ||
    a.action === "attempt" ||
    a.action === "diagnostic" ||
    a.action === "hint" ||
    a.action === "diagnose" ||
    a.action === "diagnosis-outcome" ||
    a.action === "review-due" ||
    a.action === "review-show" ||
    a.action === "review-rate" ||
    a.action === "mock-start" ||
    a.action === "mock-finish";
  const operation = isPractice
    ? "practice"
    : [
          "announcement",
          "intervention",
          "feedback",
          "override",
          "undo-override",
          "review-attempt",
          "exam-save",
          "course-settings",
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
      const path = await learningPath(tx, ctx, ctx.userId);
      const targetObjective =
        a.objectiveId ??
        recommendations.find((r) => !r.data.retired)?.data.objectiveId ??
        path.next?.objectiveId ??
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
      const chosenObjective = supportObjective ?? targetObjective;
      const state = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='state'",
          [
            ctx.tenantId,
            ctx.courseId,
            `state:${ctx.userId}:${chosenObjective}`,
          ],
        )
      ).rows[0]?.data;
      const difficulty = targetDifficulty(state);
      const item =
        byDifficulty(
          fresh.filter((r) => r.data.objectiveId === chosenObjective),
          difficulty,
        )[0] ?? (!a.objectiveId ? fresh[0] : undefined);
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
      return {
        item: publicItem(item),
        deliveryId,
        prerequisiteSupport,
        targetDifficulty: difficulty,
      };
    }
    if (a.action === "diagnostic") {
      role(ctx, "student");
      // One fresh auto-scored question per not-yet-assessed concept, prerequisites first.
      const path = await learningPath(tx, ctx, ctx.userId);
      const items = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false' AND data->>'kind' IN ('choice','transfer') ORDER BY id",
          [ctx.tenantId, ctx.courseId],
        )
      ).rows.map(toRecord);
      const seen = new Set(
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind IN ('attempt','delivery')",
            [ctx.tenantId, ctx.userId, ctx.courseId],
          )
        ).rows.map((r) => r.data.familyId),
      );
      const picked: { item: LearningRecord; deliveryId: string }[] = [];
      for (const node of path.nodes) {
        if (picked.length >= (a.limit ?? 8)) break;
        if (!node.objectiveId || node.status !== "unassessed") continue;
        const item = byDifficulty(
          items.filter(
            (r) =>
              r.data.objectiveId === node.objectiveId &&
              !seen.has(r.data.familyId),
          ),
          "medium",
        )[0];
        if (!item) continue;
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
            diagnostic: true,
            at: new Date().toISOString(),
          },
          ctx.userId,
        );
        picked.push({ item: publicItem(item), deliveryId });
      }
      return {
        items: picked,
        remainingUnassessed: path.nodes.filter(
          (n) => n.objectiveId && n.status === "unassessed",
        ).length,
      };
    }
    if (a.action === "attempt") {
      role(ctx, "student");
      const id = `attempt:${ctx.userId}:${a.idempotencyKey}`;
      const existing = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
          [ctx.tenantId, id, ctx.courseId],
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
        !a.unknown &&
        (item.data.kind === "open" || item.data.kind === "critique");
      const correct = a.unknown
        ? false
        : item.data.kind === "open"
          ? null
          : a.answer === item.data.key;
      const at = new Date().toISOString();
      const fast =
        !a.unknown && typeof a.elapsedMs === "number" && a.elapsedMs < FAST_MS;
      // One fast answer means nothing; most of the last five being fast does.
      const recentFast = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='attempt' ORDER BY created_at DESC,id DESC LIMIT 4",
          [ctx.tenantId, ctx.userId, ctx.courseId],
        )
      ).rows.filter((r) => r.data.fast).length;
      const lowConfidence = fast && recentFast >= 2;
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
        unknown: a.unknown === true,
        elapsedMs: a.elapsedMs ?? null,
        fast,
        lowConfidence,
        hintsUsed: delivery.data.hintsUsed ?? 0,
        diagnostic: delivery.data.diagnostic === true,
        mock: delivery.data.mock === true,
        posttest: delivery.data.posttest === true,
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
    if (a.action === "hint") {
      role(ctx, "student");
      const delivery = await get(tx, ctx, a.deliveryId, "delivery");
      if (delivery.ownerId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
      const item = await get(tx, ctx, delivery.data.itemId, "item");
      const used = Number(delivery.data.hintsUsed ?? 0);
      // Each hint is more direct than the last; none of them states the answer.
      const ladder: Bilingual[] = [
        ...((item.data.hints as Bilingual[] | undefined) ?? []),
        ...(item.data.sourceKey
          ? [
              bi(
                `ارجع إلى المصدر: ${item.data.sourceKey} ${item.data.locator ?? ""}، واقرأ الجزء الذي يشرح هذا المفهوم.`,
                `Go back to the source: ${item.data.sourceKey} ${item.data.locator ?? ""}, and read the part that explains this concept.`,
              ),
            ]
          : []),
        bi(
          "استبعد أولًا الخيارات التي تعرف أنها خطأ، ثم قارن ما بقي بتعريف المفهوم.",
          "First rule out the options you know are wrong, then compare what is left with the definition of the concept.",
        ),
      ].slice(0, 3);
      if (used >= ladder.length)
        return { hint: null, used, total: ladder.length, exhausted: true };
      await put(
        tx,
        ctx,
        delivery.id,
        "delivery",
        { ...delivery.data, hintsUsed: used + 1, assisted: true },
        ctx.userId,
      );
      return {
        hint: ladder[used],
        used: used + 1,
        total: ladder.length,
        exhausted: used + 1 >= ladder.length,
      };
    }
    if (a.action === "diagnose") {
      role(ctx, "student");
      const recent = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='attempt' ORDER BY created_at DESC,id DESC LIMIT 5",
          [ctx.tenantId, ctx.userId, ctx.courseId],
        )
      ).rows;
      const path = await learningPath(tx, ctx, ctx.userId);
      const node = path.nodes.find((n) => n.objectiveId === a.objectiveId);
      const previous = a.previousEpisodeId
        ? (await get(tx, ctx, a.previousEpisodeId, "diagnosis")).data
        : null;
      const level = previous?.cause === "prerequisite" ? previous.level : 0;
      // The order of the ladder is fixed by the application, never by a model.
      let step: Record<string, unknown>;
      const weak =
        a.afterPrerequisite === "passed" ? undefined : node?.blockedBy[0];
      if (recent.filter((r) => r.data.fast).length >= 3)
        step = { cause: "gaming", level: 0 };
      else if (a.afterPrerequisite === "failed" && level >= 2)
        step = { cause: "basics-gap", level };
      else if (
        a.afterPrerequisite === "failed" &&
        previous?.targetObjectiveId
      ) {
        const deeper = path.nodes.find(
          (n) => n.objectiveId === previous.targetObjectiveId,
        )?.blockedBy[0];
        const target = deeper
          ? path.nodes.find((n) => n.conceptId === deeper.conceptId)
          : undefined;
        step = target?.objectiveId
          ? {
              cause: "prerequisite",
              level: level + 1,
              targetObjectiveId: target.objectiveId,
              targetLabel: target.label,
            }
          : { cause: "basics-gap", level };
      } else if (weak) {
        const target = path.nodes.find((n) => n.conceptId === weak.conceptId);
        step = {
          cause: "prerequisite",
          level: 1,
          targetObjectiveId: target?.objectiveId ?? null,
          targetLabel: weak.label,
        };
      } else if (!a.formatTried) step = { cause: "presentation", level: 0 };
      else step = { cause: "confidence", level: 0 };
      const episodeId = `diagnosis:${randomUUID()}`;
      const episode = {
        objectiveId: a.objectiveId,
        conceptLabel: node?.label ?? null,
        ...step,
        previousEpisodeId: a.previousEpisodeId ?? null,
        at: new Date().toISOString(),
        choice: null,
        helped: null,
      };
      await put(tx, ctx, episodeId, "diagnosis", episode, ctx.userId);
      return { episodeId, ...episode };
    }
    if (a.action === "diagnosis-outcome") {
      role(ctx, "student");
      const episode = await get(tx, ctx, a.episodeId, "diagnosis");
      if (episode.ownerId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
      const data: Record<string, any> = {
        ...episode.data,
        choice: a.choice,
        format: a.format ?? episode.data.format ?? null,
        helped: a.helped ?? episode.data.helped ?? null,
        decidedAt: new Date().toISOString(),
      };
      await put(tx, ctx, episode.id, "diagnosis", data, ctx.userId);
      if (a.choice === "ask-instructor")
        // The instructor sees the diagnosis, not a bare "I'm stuck".
        await put(
          tx,
          ctx,
          `help:${episode.id}`,
          "help_request",
          {
            objectiveId: data.objectiveId,
            conceptLabel: data.conceptLabel,
            cause: data.cause,
            level: data.level,
            at: data.decidedAt,
            status: "open",
          },
          ctx.userId,
        );
      return { episodeId: episode.id, ...data };
    }
    if (a.action === "nudge-seen") {
      role(ctx, "student");
      const nudge = await get(tx, ctx, a.id, "nudge");
      if (nudge.ownerId !== ctx.userId) throw new AppError(403, "FORBIDDEN");
      // Whether the student saw it is what the sender's log shows.
      return put(
        tx,
        ctx,
        nudge.id,
        "nudge",
        { ...nudge.data, seenAt: new Date().toISOString() },
        ctx.userId,
      );
    }
    if (a.action === "review-due") {
      role(ctx, "student");
      const due = (await dueReviews(tx, ctx)).slice(0, 10);
      const cards: LearningRecord[] = [];
      for (const d of due) {
        const item = (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false'",
            [ctx.tenantId, ctx.courseId, d.itemId],
          )
        ).rows[0];
        if (item && ["choice", "transfer"].includes(item.data.kind))
          cards.push(publicItem(toRecord(item)));
      }
      return { cards };
    }
    if (a.action === "review-show" || a.action === "review-rate") {
      role(ctx, "student");
      // Answers are shown only for questions this learner has already attempted.
      const met = await tx.query(
        "SELECT id FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='attempt' AND data->>'itemId'=$4 LIMIT 1",
        [ctx.tenantId, ctx.userId, ctx.courseId, a.itemId],
      );
      if (!met.rows.length) throw new AppError(403, "FORBIDDEN");
      const item = await get(tx, ctx, a.itemId, "item");
      if (!item.data.approved || item.data.protected)
        throw new AppError(403, "FORBIDDEN");
      if (a.action === "review-show")
        return {
          key: item.data.key,
          keyLabel:
            (item.data.options ?? []).find((o: any) => o.id === item.data.key)
              ?.label ?? null,
          feedback: item.data.feedback ?? null,
          sourceKey: item.data.sourceKey ?? null,
          locator: item.data.locator ?? null,
        };
      const id = `review:${ctx.userId}:${a.itemId}`;
      const previous =
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
            [ctx.tenantId, id, ctx.courseId],
          )
        ).rows[0]?.data ?? {};
      const pickedCorrectly =
        a.picked === undefined ? null : a.picked === item.data.key;
      const interval = nextReviewInterval(
        Number(previous.interval ?? 0),
        a.rating,
        pickedCorrectly,
      );
      const data = {
        itemId: a.itemId,
        objectiveId: item.data.objectiveId,
        interval,
        dueAt: new Date(Date.now() + interval * 86400000).toISOString(),
        lastRating: a.rating,
        lastCorrect: pickedCorrectly,
        count: Number(previous.count ?? 0) + 1,
        at: new Date().toISOString(),
      };
      await put(tx, ctx, id, "review", data, ctx.userId);
      return data;
    }
    if (a.action === "exam-save") {
      role(ctx, "instructor");
      const id = `exam:${a.name.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")}`;
      return put(tx, ctx, id, "exam", {
        name: a.name,
        date: a.date,
        concepts: a.concepts,
        setBy: ctx.userId,
        at: new Date().toISOString(),
      });
    }
    if (a.action === "course-settings") {
      role(ctx, "instructor");
      const current =
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id='course-settings'",
            [ctx.tenantId],
          )
        ).rows[0]?.data ?? {};
      return put(tx, ctx, "course-settings", "course_settings", {
        ...current,
        tutorStrictness: a.tutorStrictness,
        setBy: ctx.userId,
        at: new Date().toISOString(),
      });
    }
    if (a.action === "mock-start") {
      role(ctx, "student");
      // The same quiz serves two purposes: an exam rehearsal, or the short check of one lecture.
      const lecture = a.examId.startsWith(LECTURE_CHECK)
        ? (await lectureConcepts(tx, ctx)).find(
            (l) => LECTURE_CHECK + l.key === a.examId,
          )
        : null;
      if (a.examId.startsWith(LECTURE_CHECK) && !lecture)
        throw new AppError(404, "NOT_FOUND");
      const exam = lecture
        ? { id: a.examId }
        : await get(tx, ctx, a.examId, "exam");
      const limit = lecture ? LECTURE_CHECK_QUESTIONS : 10;
      const wanted = lecture
        ? lecture.conceptIds.map((id) => `c:${id}`)
        : ((exam as LearningRecord).data.concepts as any[])
            .sort((x, y) => y.weight - x.weight)
            .map((c) => `c:${c.conceptId}`);
      const items = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false' AND data->>'kind' IN ('choice','transfer') ORDER BY id",
          [ctx.tenantId, ctx.courseId],
        )
      ).rows.map(toRecord);
      const seen = new Set(
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind IN ('attempt','delivery')",
            [ctx.tenantId, ctx.userId, ctx.courseId],
          )
        ).rows.map((r) => r.data.familyId),
      );
      const pools = wanted.map((objectiveId) => {
        const mine = items.filter((i) => i.data.objectiveId === objectiveId);
        const unseen = mine.filter((i) => !seen.has(i.data.familyId));
        // An exam rehearsal uses unseen questions only. A lecture check prefers them, and
        // repeats a seen one rather than leave a concept of the lecture unchecked.
        return lecture
          ? [...unseen, ...mine.filter((i) => seen.has(i.data.familyId))]
          : unseen;
      });
      // Round-robin across the exam's concepts, heaviest first, so one concept cannot fill the quiz.
      const picked: LearningRecord[] = [];
      for (let round = 0; picked.length < limit; round++) {
        const before = picked.length;
        for (const pool of pools)
          if (pool[round] && picked.length < limit) picked.push(pool[round]);
        if (picked.length === before) break;
      }
      const served: { item: LearningRecord; deliveryId: string }[] = [];
      for (const item of picked) {
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
            mock: true,
            examId: exam.id,
            at: new Date().toISOString(),
          },
          ctx.userId,
        );
        served.push({ item: publicItem(item), deliveryId });
      }
      return { items: served, secondsAllowed: served.length * 90 };
    }
    if (a.action === "mock-finish") {
      role(ctx, "student");
      const byConcept = new Map<
        string,
        { objectiveId: string; served: number; correct: number }
      >();
      let answered = 0;
      for (const deliveryId of a.deliveryIds) {
        const delivery = await get(tx, ctx, deliveryId, "delivery");
        if (
          delivery.ownerId !== ctx.userId ||
          delivery.data.examId !== a.examId
        )
          throw new AppError(403, "FORBIDDEN");
        const attempt = (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND kind='attempt' AND data->>'deliveryId'=$3",
            [ctx.tenantId, ctx.userId, deliveryId],
          )
        ).rows[0];
        const entry = byConcept.get(delivery.data.objectiveId) ?? {
          objectiveId: delivery.data.objectiveId,
          served: 0,
          correct: 0,
        };
        entry.served++;
        // Unanswered when time ran out: counted against the mock result only, never against mastery.
        if (attempt) answered++;
        if (attempt?.data.correct === true) entry.correct++;
        byConcept.set(delivery.data.objectiveId, entry);
      }
      const result = {
        examId: a.examId,
        served: a.deliveryIds.length,
        answered,
        correct: [...byConcept.values()].reduce((n, c) => n + c.correct, 0),
        concepts: [...byConcept.values()],
        at: new Date().toISOString(),
      };
      await put(
        tx,
        ctx,
        `mock:${randomUUID()}`,
        "mock_result",
        result,
        ctx.userId,
      );
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
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
            [ctx.tenantId, id, ctx.courseId],
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
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
          [ctx.tenantId, id, ctx.courseId],
        )
      ).rows[0]?.data ?? { objectiveId: a.objectiveId, ...deriveObjective([]) };
      const priorRecommendation =
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
            [
              ctx.tenantId,
              `recommendation:${a.studentId}:${a.objectiveId}`,
              ctx.courseId,
            ],
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
        await tx.query(
          "DELETE FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
          [
            ctx.tenantId,
            `recommendation:${override.ownerId}:${override.data.objectiveId}`,
            ctx.courseId,
          ],
        );
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
