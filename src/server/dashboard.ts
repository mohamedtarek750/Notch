import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { authorizeCourse, type AuthContext } from "./auth";
import { AppError } from "./errors";
import { learningPath } from "./learning";

/**
 * Instructor dashboard (IN8–IN15). Every figure comes from queries and fixed rules on the
 * graph and the learning record, never from a language model, and every figure says how
 * many students it is based on.
 */
const SMALL_GROUP = 5;
const INACTIVE_DAYS = 7;
type Row = {
  id: string;
  kind: string;
  owner_id: string | null;
  data: Record<string, any>;
  created_at: Date | string;
};
type Label = { ar: string; en: string };
const daysSince = (iso: string | undefined, now: number) =>
  iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null;

async function instructorOnly(ctx: AuthContext, operation: "read" | "write") {
  await authorizeCourse(ctx, ctx.courseId, operation);
  if (ctx.role !== "instructor") throw new AppError(403, "FORBIDDEN");
}

/** Group near-identical unanswered questions so 14 phrasings read as one topic. */
export function gapTopic(question: string) {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .sort()
    .join(" ");
}

export async function instructorDashboard(ctx: AuthContext, now = Date.now()) {
  await instructorOnly(ctx, "read");
  const conn = db.tenant(ctx.tenantId);
  const students = (
    await conn.query<{ user_id: string; name: Label }>(
      "SELECT c.user_id,u.name FROM course_access c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND c.access_role='student' AND c.active=true ORDER BY c.user_id",
      [ctx.tenantId, ctx.courseId],
    )
  ).rows;
  const ids = students.map((s) => s.user_id);
  const records = (
    await conn.query<Row>(
      "SELECT id,kind,owner_id,data,created_at FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind IN ('state','attempt','diagnosis','help_request','content_gap','tutor_memory','nudge','approved_answer') AND (owner_id IS NULL OR owner_id=ANY($3::text[])) ORDER BY created_at",
      [ctx.tenantId, ctx.courseId, ids],
    )
  ).rows;
  const of = (kind: string) => records.filter((r) => r.kind === kind);
  // Concept order and prerequisite links, read once from the published graph.
  const path = await learningPath(conn, ctx, "__class__");
  const concepts = path.nodes.filter((n) => n.objectiveId);
  const stateOf = (studentId: string, objectiveId: string) =>
    of("state").find(
      (s) => s.owner_id === studentId && s.data.objectiveId === objectiveId,
    )?.data;
  const attemptsBy = (studentId: string) =>
    of("attempt").filter((a) => a.owner_id === studentId);
  const lastActivity = (studentId: string) =>
    attemptsBy(studentId).at(-1)?.data.at as string | undefined;
  /** Stuck: still learning after at least two independent misses on the concept. */
  const stuckOn = (studentId: string) =>
    concepts.filter((c) => {
      const state = stateOf(studentId, c.objectiveId!);
      const misses = attemptsBy(studentId).filter(
        (a) => a.data.objectiveId === c.objectiveId && a.data.correct === false,
      ).length;
      return state?.status === "developing" && misses >= 2;
    });

  const heatmap = concepts.map((c) => {
    const states = ids.map((id) => stateOf(id, c.objectiveId!)?.status);
    const assessed = states.filter((s) => s && s !== "unassessed").length;
    const ready = states.filter((s) => s === "secure").length;
    return {
      conceptId: c.conceptId,
      objectiveId: c.objectiveId,
      label: c.label,
      students: ids.length,
      assessed,
      ready,
      learning: states.filter((s) => s === "developing").length,
      // Share of assessed students who are ready; null until anyone was assessed.
      readyShare: assessed ? Math.round((100 * ready) / assessed) : null,
      thinData: assessed > 0 && assessed < SMALL_GROUP,
      prerequisites: c.blockedBy.map((b) => b.label),
    };
  });

  const roadblocks = concepts
    .map((c) => {
      const stuck = ids.filter((id) =>
        stuckOn(id).some((x) => x.objectiveId === c.objectiveId),
      );
      const episodes = of("diagnosis").filter(
        (d) => d.data.objectiveId === c.objectiveId,
      );
      const causes = new Map<string, number>();
      for (const e of episodes)
        causes.set(e.data.cause, (causes.get(e.data.cause) ?? 0) + 1);
      const topCause = [...causes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const prerequisiteTargets = new Map<string, number>();
      for (const e of episodes)
        if (e.data.cause === "prerequisite" && e.data.targetLabel)
          prerequisiteTargets.set(
            e.data.targetLabel.en,
            (prerequisiteTargets.get(e.data.targetLabel.en) ?? 0) + 1,
          );
      const weakPrerequisite =
        episodes.find(
          (e) =>
            e.data.cause === "prerequisite" &&
            e.data.targetLabel?.en ===
              [...prerequisiteTargets].sort((a, b) => b[1] - a[1])[0]?.[0],
        )?.data.targetLabel ?? null;
      return {
        conceptId: c.conceptId,
        objectiveId: c.objectiveId,
        label: c.label,
        stuckStudents: stuck.length,
        diagnosisEpisodes: episodes.length,
        causes: Object.fromEntries(causes),
        // A reason only when the diagnosis record supports one.
        reason:
          topCause === "prerequisite" && weakPrerequisite
            ? { kind: "weak-prerequisite", prerequisite: weakPrerequisite }
            : topCause
              ? { kind: topCause }
              : null,
        basedOn: stuck.length + new Set(episodes.map((e) => e.owner_id)).size,
        thinData: stuck.length < SMALL_GROUP,
      };
    })
    .filter((r) => r.stuckStudents > 0 || r.diagnosisEpisodes > 0)
    .sort(
      (a, b) =>
        b.stuckStudents - a.stuckStudents ||
        b.diagnosisEpisodes - a.diagnosisEpisodes,
    )
    .slice(0, 3);

  const atRisk = students
    .map((s) => {
      const inactive = daysSince(lastActivity(s.user_id), now);
      const stuck = stuckOn(s.user_id);
      const help = of("help_request").filter(
        (h) => h.owner_id === s.user_id && h.data.status === "open",
      );
      const repeated = concepts.filter(
        (c) =>
          of("diagnosis").filter(
            (d) =>
              d.owner_id === s.user_id && d.data.objectiveId === c.objectiveId,
          ).length >= 3,
      );
      const reasons: { kind: string; value?: number; label?: Label | null }[] =
        [];
      if (help.length)
        reasons.push({
          kind: "asked-for-help",
          label: help[0].data.conceptLabel,
        });
      if (stuck.length)
        reasons.push({
          kind: "stuck",
          value: stuck.length,
          label: stuck[0].label,
        });
      if (repeated.length)
        reasons.push({ kind: "repeated-diagnosis", label: repeated[0].label });
      if (inactive !== null && inactive >= INACTIVE_DAYS)
        reasons.push({ kind: "inactive", value: inactive });
      if (inactive === null) reasons.push({ kind: "not-started" });
      return {
        studentId: s.user_id,
        name: s.name,
        lastActivity: lastActivity(s.user_id) ?? null,
        reasons,
      };
    })
    .filter((s) => s.reasons.length)
    // Someone who asked for help comes before someone who merely has not started.
    .sort(
      (a, b) =>
        Number(b.reasons[0].kind !== "not-started") -
          Number(a.reasons[0].kind !== "not-started") ||
        b.reasons.length - a.reasons.length,
    );

  const gapGroups = new Map<
    string,
    {
      topic: string;
      questions: string[];
      ids: string[];
      status: string;
      last: string;
    }
  >();
  for (const g of of("content_gap")) {
    const topic = gapTopic(g.data.question);
    const group = gapGroups.get(topic) ?? {
      topic,
      questions: [] as string[],
      ids: [] as string[],
      status: g.data.status,
      last: g.data.at,
    };
    group.questions.push(g.data.question);
    group.ids.push(g.id);
    group.status = g.data.status;
    group.last = g.data.at;
    gapGroups.set(topic, group);
  }
  const contentGaps = [...gapGroups.values()]
    .map((g) => ({
      topic: g.topic,
      count: g.questions.length,
      examples: [...new Set(g.questions)].slice(0, 3),
      ids: g.ids,
      status: g.status,
      last: g.last,
    }))
    .sort(
      (a, b) =>
        Number(a.status !== "open") - Number(b.status !== "open") ||
        b.count - a.count,
    );

  // Tutor audit: the answers, without naming who asked.
  const tutorAnswers = of("tutor_memory")
    .slice(-60)
    .reverse()
    .map((m) => ({
      id: m.id,
      question: m.data.question,
      answer: m.data.answer,
      answerMode: m.data.answerMode ?? "direct",
      rating: m.data.rating ?? null,
      audit: m.data.audit ?? null,
      at: String(m.created_at),
      flag:
        m.data.rating === "down"
          ? "thumbs-down"
          : m.data.audit?.verdict === "wrong"
            ? "marked-wrong"
            : null,
    }))
    .sort((a, b) => Number(!!b.flag) - Number(!!a.flag));

  const week = now - 7 * 86400000;
  const activeThisWeek = ids.filter((id) =>
    attemptsBy(id).some((a) => new Date(a.data.at).getTime() >= week),
  ).length;
  return {
    students: ids.length,
    status: {
      activeThisWeek,
      withSomethingReady: ids.filter((id) =>
        concepts.some((c) => stateOf(id, c.objectiveId!)?.status === "secure"),
      ).length,
      tutorQuestionsThisWeek: of("tutor_memory").filter(
        (m) => new Date(m.created_at).getTime() >= week,
      ).length,
      answersThisWeek: of("attempt").filter(
        (a) => new Date(a.data.at).getTime() >= week,
      ).length,
      thinData: ids.length < SMALL_GROUP,
    },
    heatmap,
    roadblocks,
    atRisk,
    helpRequests: of("help_request")
      .filter((h) => h.data.status === "open")
      .map((h) => ({
        id: h.id,
        studentId: h.owner_id,
        name: students.find((s) => s.user_id === h.owner_id)?.name ?? null,
        conceptLabel: h.data.conceptLabel,
        cause: h.data.cause,
        at: h.data.at,
      })),
    contentGaps,
    tutorAnswers,
    label: Object.fromEntries(concepts.map((c) => [c.objectiveId, c.label])),
  };
}

/** IN14: one student's map, recent activity and diagnosis episodes. No tutor transcripts. */
export async function studentView(ctx: AuthContext, studentId: string) {
  await instructorOnly(ctx, "read");
  const conn = db.tenant(ctx.tenantId);
  const student = (
    await conn.query<{ name: Label }>(
      "SELECT u.name FROM course_access c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND c.user_id=$3 AND c.access_role='student' AND c.active=true",
      [ctx.tenantId, ctx.courseId, studentId],
    )
  ).rows[0];
  if (!student) throw new AppError(404, "NOT_FOUND");
  const records = (
    await conn.query<Row>(
      "SELECT id,kind,owner_id,data,created_at FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind IN ('attempt','diagnosis','help_request','nudge') ORDER BY created_at DESC LIMIT 200",
      [ctx.tenantId, ctx.courseId, studentId],
    )
  ).rows;
  const path = await learningPath(conn, ctx, studentId);
  return {
    studentId,
    name: student.name,
    map: path.nodes,
    recent: records
      .filter((r) => r.kind === "attempt")
      .slice(0, 12)
      .map((a) => ({
        at: a.data.at,
        objectiveId: a.data.objectiveId,
        correct: a.data.correct,
        unknown: a.data.unknown === true,
        hintsUsed: a.data.hintsUsed ?? 0,
        lowConfidence: a.data.lowConfidence === true,
      })),
    diagnoses: records
      .filter((r) => r.kind === "diagnosis")
      .slice(0, 12)
      .map((d) => ({
        at: d.data.at,
        conceptLabel: d.data.conceptLabel,
        cause: d.data.cause,
        level: d.data.level,
        targetLabel: d.data.targetLabel ?? null,
        choice: d.data.choice,
        helped: d.data.helped,
      })),
    nudges: records
      .filter((r) => r.kind === "nudge")
      .map((n) => ({
        at: n.data.at,
        text: n.data.text,
        seenAt: n.data.seenAt ?? null,
      })),
    tutorTranscripts: "not-available",
  };
}

const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("gap-status"),
    ids: z.array(z.string().min(1).max(160)).min(1).max(200),
    status: z.enum(["open", "out-of-scope", "resolved"]),
  }),
  z.object({
    action: z.literal("audit"),
    id: z.string().min(1).max(160),
    verdict: z.enum(["good", "wrong"]),
    approvedAnswer: z.string().trim().min(1).max(3000).optional(),
  }),
  z.object({
    action: z.literal("nudge"),
    studentIds: z.array(z.string().min(1).max(160)).min(1).max(50),
    text: z.string().trim().min(3).max(600),
  }),
  z.object({
    action: z.literal("help-resolved"),
    id: z.string().min(1).max(160),
  }),
]);

export async function dashboardAction(ctx: AuthContext, input: unknown) {
  const a = action.parse(input);
  await instructorOnly(ctx, "write");
  const at = new Date().toISOString();
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    const audit = (name: string, entity: string, data: unknown) =>
      tx.query(
        "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
        [
          ctx.tenantId,
          randomUUID(),
          ctx.userId,
          name,
          entity,
          JSON.stringify(data),
        ],
      );
    if (a.action === "gap-status") {
      await tx.query(
        "UPDATE records SET data=data||$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND kind='content_gap' AND id=ANY($3::text[])",
        [
          ctx.tenantId,
          ctx.courseId,
          a.ids,
          JSON.stringify({
            status: a.status,
            decidedBy: ctx.userId,
            decidedAt: at,
          }),
        ],
      );
      await audit("content_gap.decided", a.ids[0], {
        status: a.status,
        count: a.ids.length,
      });
      return { updated: a.ids.length, status: a.status };
    }
    if (a.action === "audit") {
      const row = (
        await tx.query<Row>(
          "SELECT id,kind,owner_id,data,created_at FROM records WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='tutor_memory' FOR UPDATE",
          [ctx.tenantId, ctx.courseId, a.id],
        )
      ).rows[0];
      if (!row) throw new AppError(404, "NOT_FOUND");
      await tx.query(
        "UPDATE records SET data=data||$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [
          ctx.tenantId,
          a.id,
          JSON.stringify({
            audit: {
              verdict: a.verdict,
              approvedAnswer: a.approvedAnswer ?? null,
              by: ctx.userId,
              at,
            },
          }),
        ],
      );
      // An approved version is reused for the same question from now on.
      if (a.approvedAnswer && row.data.ladderKey)
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'approved_answer',$3,NULL,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data,updated_at=now()",
          [
            ctx.tenantId,
            `approved:${row.data.ladderKey}`.slice(0, 200),
            ctx.courseId,
            JSON.stringify({
              ladderKey: row.data.ladderKey,
              answer: a.approvedAnswer,
              citations: row.data.citations ?? [],
              approvedBy: ctx.userId,
              at,
            }),
          ],
        );
      await audit("tutor.audited", a.id, {
        verdict: a.verdict,
        approved: !!a.approvedAnswer,
      });
      return { id: a.id, verdict: a.verdict };
    }
    if (a.action === "nudge") {
      const allowed = (
        await tx.query<{ user_id: string }>(
          "SELECT user_id FROM course_access WHERE tenant_id=$1 AND course_id=$2 AND access_role='student' AND active=true AND user_id=ANY($3::text[])",
          [ctx.tenantId, ctx.courseId, a.studentIds],
        )
      ).rows.map((r) => r.user_id);
      // One message per student, never a group message.
      for (const studentId of allowed)
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'nudge',$3,$4,$5)",
          [
            ctx.tenantId,
            `nudge:${randomUUID()}`,
            ctx.courseId,
            studentId,
            JSON.stringify({
              text: a.text,
              from: ctx.userId,
              fromRole: ctx.role,
              at,
            }),
          ],
        );
      await audit("nudge.sent", allowed[0] ?? "none", {
        count: allowed.length,
      });
      return { sent: allowed.length };
    }
    await tx.query(
      "UPDATE records SET data=data||$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND kind='help_request'",
      [
        ctx.tenantId,
        a.id,
        JSON.stringify({ status: "resolved", resolvedAt: at }),
      ],
    );
    await audit("help_request.resolved", a.id, {});
    return { id: a.id, status: "resolved" };
  });
}
