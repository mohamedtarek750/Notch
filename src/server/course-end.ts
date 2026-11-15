import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Queryable } from "./db";
import { authorizeCourse, type AuthContext } from "./auth";
import { AppError } from "./errors";
import { instructorDashboard } from "./dashboard";
import { learningPath } from "./learning";

/**
 * Consent, the learner's own data, and the end of the course: post-test, survey, course
 * report and research export. Research data leaves only for students whose research
 * consent is on at the moment of export, under an ID that cannot be linked back.
 */
export const CONSENT_VERSION = "2026-11";
type Row = {
  id: string;
  kind: string;
  owner_id: string | null;
  data: Record<string, any>;
  created_at: Date | string;
};
/** Everything recorded about one learner in a course. */
const LEARNER_KINDS = [
  "attempt",
  "delivery",
  "state",
  "recommendation",
  "event",
  "review",
  "diagnosis",
  "help_request",
  "tutor_memory",
  "memory_audit",
  "mock_result",
  "posttest_result",
  "nudge",
  "progress",
  "preferences",
  "survey",
  "content_gap",
  "consent",
  "submission",
  "portfolio",
  "override",
  "flag_clear",
];
export const SURVEY_QUESTIONS = [
  "usefulness",
  "trust",
  "language",
  "ease",
  "hints",
  "map",
  "pace",
  "recommend",
] as const;
export const EXPORT_FIELDS = [
  "concept",
  "correct",
  "unknown",
  "responseTimeMs",
  "hintsUsed",
  "phase",
  "day",
] as const;

async function audit(
  tx: Queryable,
  ctx: AuthContext,
  action: string,
  entity: string,
  data: unknown,
) {
  await tx.query(
    "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      ctx.tenantId,
      randomUUID(),
      ctx.userId,
      action,
      entity,
      JSON.stringify(data),
    ],
  );
}
async function student(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "read");
  if (ctx.role !== "student") throw new AppError(403, "FORBIDDEN");
}
async function instructor(ctx: AuthContext, operation: "read" | "write") {
  await authorizeCourse(ctx, ctx.courseId, operation);
  if (ctx.role !== "instructor") throw new AppError(403, "FORBIDDEN");
}
async function put(
  tx: Queryable,
  ctx: AuthContext,
  id: string,
  kind: string,
  data: unknown,
  ownerId: string | null,
) {
  await tx.query(
    "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",
    [ctx.tenantId, id, kind, ctx.courseId, ownerId, JSON.stringify(data)],
  );
}

const actions = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("consent"),
    platform: z.literal(true),
    research: z.boolean(),
  }),
  z.object({ action: z.literal("delete-my-data"), confirm: z.literal(true) }),
  z.object({ action: z.literal("posttest-open"), open: z.boolean() }),
  z.object({ action: z.literal("posttest-start") }),
  z.object({
    action: z.literal("posttest-finish"),
    deliveryIds: z.array(z.string().min(1).max(160)).min(1).max(20),
  }),
  z.object({
    action: z.literal("survey"),
    ratings: z.record(z.enum(SURVEY_QUESTIONS), z.number().int().min(1).max(5)),
    comment: z.string().trim().max(1500).optional(),
  }),
  z.object({
    action: z.literal("research-export"),
    fields: z.array(z.enum(EXPORT_FIELDS)).min(1),
  }),
]);

export async function courseEndAction(
  ctx: AuthContext,
  input: unknown,
): Promise<any> {
  const a = actions.parse(input);
  const at = new Date().toISOString();
  if (a.action === "consent") {
    await student(ctx);
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      const id = `consent:${ctx.userId}`;
      const previous = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id],
        )
      ).rows[0]?.data;
      const data = {
        platform: true,
        research: a.research,
        version: CONSENT_VERSION,
        at,
        // Every change is kept with its time and version.
        history: [
          ...(previous?.history ?? []),
          { research: a.research, version: CONSENT_VERSION, at },
        ],
      };
      await put(tx, ctx, id, "consent", data, ctx.userId);
      await audit(tx, ctx, "consent.saved", id, {
        research: a.research,
        version: CONSENT_VERSION,
      });
      return data;
    });
  }
  if (a.action === "delete-my-data") {
    await student(ctx);
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      const consent = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, `consent:${ctx.userId}`],
        )
      ).rows[0]?.data;
      let kept = 0;
      if (consent?.research === true) {
        // Kept only as rows that carry no link back to the person.
        const anonymous = `anon-${randomUUID()}`;
        const attempts = (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind='attempt'",
            [ctx.tenantId, ctx.courseId, ctx.userId],
          )
        ).rows;
        for (const attempt of attempts) {
          await put(
            tx,
            ctx,
            `research:${randomUUID()}`,
            "research_row",
            researchRow(attempt, anonymous, [...EXPORT_FIELDS]),
            null,
          );
          kept++;
        }
      }
      const deleted = await tx.query(
        "DELETE FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind=ANY($4::text[]) RETURNING id",
        [ctx.tenantId, ctx.courseId, ctx.userId, LEARNER_KINDS],
      );
      await audit(tx, ctx, "learner.data.deleted", ctx.userId, {
        deleted: deleted.rows.length,
        anonymizedRowsKept: kept,
      });
      return { deleted: deleted.rows.length, anonymizedRowsKept: kept };
    });
  }
  if (a.action === "posttest-open") {
    await instructor(ctx, "write");
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      const current = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id='course-settings'",
          [ctx.tenantId],
        )
      ).rows[0]?.data ?? { tutorStrictness: "hints-then-answer" };
      const data = { ...current, postTestOpen: a.open, postTestSetAt: at };
      await put(tx, ctx, "course-settings", "course_settings", data, null);
      await audit(tx, ctx, "posttest.toggled", "course-settings", {
        open: a.open,
      });
      return data;
    });
  }
  if (a.action === "posttest-start") {
    await student(ctx);
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      const open = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND id='course-settings'",
          [ctx.tenantId],
        )
      ).rows[0]?.data.postTestOpen;
      if (open !== true) throw new AppError(403, "FORBIDDEN");
      const path = await learningPath(tx, ctx, ctx.userId);
      const items = (
        await tx.query<Row>(
          "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='item' AND data->>'approved'='true' AND COALESCE(data->>'protected','false')='false' AND data->>'kind' IN ('choice','transfer') ORDER BY id",
          [ctx.tenantId, ctx.courseId],
        )
      ).rows;
      const seen = new Set(
        (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind IN ('attempt','delivery')",
            [ctx.tenantId, ctx.userId, ctx.courseId],
          )
        ).rows.map((r) => r.data.familyId),
      );
      const served: { item: Row; deliveryId: string }[] = [];
      // One question per concept, matching the coverage of the starting check.
      for (const node of path.nodes) {
        if (served.length >= 12 || !node.objectiveId) continue;
        const pool = items.filter(
          (i) => i.data.objectiveId === node.objectiveId,
        );
        // Prefer a question not met before; fall back to a met one so every concept is covered.
        const item = pool.find((i) => !seen.has(i.data.familyId)) ?? pool[0];
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
            posttest: true,
            at,
          },
          ctx.userId,
        );
        const { key, rubric, feedback, solution, hints, ...safe } = item.data;
        (void key, void rubric, void feedback, void solution, void hints);
        served.push({ item: { ...item, data: safe }, deliveryId });
      }
      return {
        items: served.map((s) => ({
          deliveryId: s.deliveryId,
          item: { id: s.item.id, data: s.item.data },
        })),
        secondsAllowed: served.length * 90,
      };
    });
  }
  if (a.action === "posttest-finish") {
    await student(ctx);
    return db.tenant(ctx.tenantId).transaction(async (tx) => {
      let answered = 0,
        correct = 0;
      for (const deliveryId of a.deliveryIds) {
        const delivery = (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND id=$2 AND kind='delivery' AND owner_id=$3",
            [ctx.tenantId, deliveryId, ctx.userId],
          )
        ).rows[0];
        if (!delivery || delivery.data.posttest !== true)
          throw new AppError(403, "FORBIDDEN");
        const attempt = (
          await tx.query<Row>(
            "SELECT * FROM records WHERE tenant_id=$1 AND owner_id=$2 AND kind='attempt' AND data->>'deliveryId'=$3",
            [ctx.tenantId, ctx.userId, deliveryId],
          )
        ).rows[0];
        if (attempt) answered++;
        if (attempt?.data.correct === true) correct++;
      }
      // Unanswered questions count as incorrect for the learning-gain measure.
      const result = { served: a.deliveryIds.length, answered, correct, at };
      await put(
        tx,
        ctx,
        `posttest:${ctx.userId}`,
        "posttest_result",
        result,
        ctx.userId,
      );
      return result;
    });
  }
  if (a.action === "survey") {
    await student(ctx);
    const data = { ratings: a.ratings, comment: a.comment ?? "", at };
    await put(
      db.tenant(ctx.tenantId),
      ctx,
      `survey:${ctx.userId}`,
      "survey",
      data,
      ctx.userId,
    );
    return { saved: true };
  }
  // research-export
  await instructor(ctx, "write");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    // Consent is read now, at export time, not when the data was collected.
    const consenting = (
      await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='consent' AND data->>'research'='true'",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows.map((r) => r.owner_id as string);
    const salt = randomUUID();
    const attempts = (
      await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='attempt' AND owner_id=ANY($3::text[]) ORDER BY created_at",
        [ctx.tenantId, ctx.courseId, consenting],
      )
    ).rows;
    const rows = attempts.map((attempt) =>
      researchRow(
        attempt,
        // A fresh salt per export: IDs cannot be joined across exports or back to a person.
        `anon-${createHash("sha256")
          .update(salt + attempt.owner_id)
          .digest("hex")
          .slice(0, 12)}`,
        a.fields,
      ),
    );
    const already = (
      await tx.query<Row>(
        "SELECT * FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='research_row'",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows.map((r) =>
      Object.fromEntries(
        Object.entries(r.data).filter(
          ([k]) => k === "anonymousId" || (a.fields as string[]).includes(k),
        ),
      ),
    );
    await audit(tx, ctx, "research.exported", "research-export", {
      fields: a.fields,
      consentingStudents: consenting.length,
      rows: rows.length + already.length,
    });
    return {
      consentVersion: CONSENT_VERSION,
      consentingStudents: consenting.length,
      fields: ["anonymousId", ...a.fields],
      rows: [...rows, ...already],
      exportedAt: at,
    };
  });
}

function researchRow(
  attempt: Row,
  anonymousId: string,
  fields: readonly string[],
) {
  const all: Record<string, unknown> = {
    concept: attempt.data.objectiveId,
    correct: attempt.data.correct,
    unknown: attempt.data.unknown === true,
    responseTimeMs: attempt.data.elapsedMs ?? null,
    hintsUsed: attempt.data.hintsUsed ?? 0,
    phase: attempt.data.posttest
      ? "post-test"
      : attempt.data.diagnostic
        ? "diagnostic"
        : attempt.data.mock
          ? "mock"
          : "practice",
    // The day only: an exact timestamp can help re-identify someone.
    day: String(attempt.data.at).slice(0, 10),
  };
  return {
    anonymousId,
    ...Object.fromEntries(fields.map((f) => [f, all[f]])),
  };
}

/** ST18: a learner's own records, for download. */
export async function myData(ctx: AuthContext) {
  await student(ctx);
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<Row>(
        "SELECT id,kind,owner_id,data,created_at FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind=ANY($4::text[]) ORDER BY created_at",
        [ctx.tenantId, ctx.courseId, ctx.userId, LEARNER_KINDS],
      )
  ).rows;
  return {
    exportedAt: new Date().toISOString(),
    course: ctx.courseId,
    records: rows.map((r) => ({
      kind: r.kind,
      at: String(r.created_at),
      data: r.data,
    })),
  };
}

/** IN18: the course report. Figures only; the wording around them lives in the interface. */
export async function courseReport(ctx: AuthContext) {
  await instructor(ctx, "read");
  const dashboard = await instructorDashboard(ctx);
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<Row>(
        "SELECT id,kind,owner_id,data,created_at FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind IN ('attempt','posttest_result','survey','consent','tutor_memory','content_gap','course_settings')",
        [ctx.tenantId, ctx.courseId],
      )
  ).rows;
  const of = (kind: string) => rows.filter((r) => r.kind === kind);
  const learners = new Set(of("attempt").map((a) => a.owner_id));
  const share = (list: Row[]) =>
    list.length
      ? (100 * list.filter((a) => a.data.correct === true).length) / list.length
      : null;
  // Learning gain needs both ends for the same student.
  const pairs = [...learners]
    .map((id) => {
      const mine = of("attempt").filter((a) => a.owner_id === id);
      const pre = share(mine.filter((a) => a.data.diagnostic));
      const post = of("posttest_result").find((r) => r.owner_id === id)?.data;
      return pre !== null && post
        ? { pre, post: (100 * post.correct) / Math.max(1, post.served) }
        : null;
    })
    .filter((p): p is { pre: number; post: number } => !!p);
  const mean = (list: number[]) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const surveys = of("survey");
  const tutor = of("tutor_memory");
  return {
    participation: {
      enrolled: dashboard.students,
      active: learners.size,
      tookStartingCheck: new Set(
        of("attempt")
          .filter((a) => a.data.diagnostic)
          .map((a) => a.owner_id),
      ).size,
      tookPostTest: of("posttest_result").length,
      researchConsent: of("consent").filter((c) => c.data.research === true)
        .length,
    },
    learningGain: {
      students: pairs.length,
      preAverage: mean(pairs.map((p) => p.pre)),
      postAverage: mean(pairs.map((p) => p.post)),
      thinData: pairs.length < 5,
    },
    masteryByConcept: dashboard.heatmap,
    tutor: {
      questionsAnswered: tutor.length,
      thumbsUp: tutor.filter((m) => m.data.rating === "up").length,
      thumbsDown: tutor.filter((m) => m.data.rating === "down").length,
      couldNotAnswer: of("content_gap").length,
      markedWrongByInstructor: tutor.filter(
        (m) => m.data.audit?.verdict === "wrong",
      ).length,
    },
    survey: {
      responses: surveys.length,
      averages: Object.fromEntries(
        SURVEY_QUESTIONS.map((q) => [
          q,
          mean(
            surveys
              .map((s) => s.data.ratings?.[q])
              .filter((n): n is number => typeof n === "number"),
          ),
        ]),
      ),
      // Free text is shown without who wrote it.
      comments: surveys.map((s) => s.data.comment).filter(Boolean),
    },
    postTestOpen: of("course_settings")[0]?.data.postTestOpen === true,
    exportFields: EXPORT_FIELDS,
  };
}
