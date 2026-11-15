import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { type AuthContext } from "./auth";

/**
 * Academic structure: faculty -> major -> course. Faculties and majors are records of
 * the whole workspace (no course); each course keeps its own lectures, tree, bank and
 * learner records under its course id.
 */
const name = z.string().trim().min(2).max(120);
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-faculty"), name }),
  z.object({
    action: z.literal("create-major"),
    facultyId: z.string().min(1).max(80),
    name,
  }),
  z.object({
    action: z.literal("create-course"),
    majorId: z.string().min(1).max(80),
    code: z.string().trim().min(2).max(20),
    title: name,
  }),
  z.object({
    action: z.literal("assign-course"),
    courseId: z.string().min(1).max(40),
    majorId: z.string().min(1).max(80),
  }),
  z.object({
    action: z.literal("select-course"),
    courseId: z.string().min(1).max(40),
  }),
]);
type Row = { id: string; kind: string; course_id: string | null; data: any };
const both = (value: string) => ({ ar: value, en: value });

export async function catalog(ctx: AuthContext) {
  const conn = db.tenant(ctx.tenantId);
  const rows = (
    await conn.query<Row>(
      "SELECT id,kind,course_id,data FROM records WHERE tenant_id=$1 AND kind IN ('faculty','major','course') ORDER BY created_at,id",
      [ctx.tenantId],
    )
  ).rows;
  const mine = new Set(
    (
      await conn.query<{ course_id: string }>(
        "SELECT course_id FROM course_access WHERE tenant_id=$1 AND user_id=$2 AND active",
        [ctx.tenantId, ctx.userId],
      )
    ).rows.map((r) => r.course_id),
  );
  const majors = rows
    .filter((r) => r.kind === "major")
    .map((r) => ({ id: r.id, name: r.data.name, facultyId: r.data.facultyId }));
  return {
    current: ctx.courseId,
    faculties: rows
      .filter((r) => r.kind === "faculty")
      .map((r) => ({ id: r.id, name: r.data.name })),
    majors,
    courses: rows
      .filter(
        (r) => r.kind === "course" && r.course_id && mine.has(r.course_id),
      )
      .map((r) => ({
        id: r.course_id!,
        code: r.data.code ?? r.course_id,
        title: r.data.title,
        majorId: majors.some((m) => m.id === r.data.majorId)
          ? r.data.majorId
          : null,
      })),
  };
}

/** Returns the course to switch the session to, when the action selects or creates one. */
export async function catalogAction(ctx: AuthContext, raw: unknown) {
  const a = input.parse(raw);
  const conn = db.tenant(ctx.tenantId);
  if (a.action === "select-course") {
    const access = await conn.query(
      "SELECT 1 FROM course_access WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND active",
      [ctx.tenantId, ctx.userId, a.courseId],
    );
    if (!access.rows[0]) throw new AppError(403, "FORBIDDEN");
    return { courseId: a.courseId };
  }
  if (ctx.role !== "instructor") throw new AppError(403, "FORBIDDEN");
  return conn.transaction(async (tx) => {
    const exists = async (id: string, kind: string) =>
      (
        await tx.query(
          "SELECT 1 FROM records WHERE tenant_id=$1 AND id=$2 AND kind=$3 AND course_id IS NULL",
          [ctx.tenantId, id, kind],
        )
      ).rows.length > 0;
    const add = (
      id: string,
      kind: string,
      courseId: string | null,
      data: unknown,
    ) =>
      tx.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,NULL,$5)",
        [ctx.tenantId, id, kind, courseId, JSON.stringify(data)],
      );
    const audit = (action: string, id: string) =>
      tx.query(
        "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
        [ctx.tenantId, randomUUID(), ctx.userId, action, id, JSON.stringify(a)],
      );
    if (a.action === "create-faculty") {
      const id = "faculty:" + randomBytes(5).toString("hex");
      await add(id, "faculty", null, { name: both(a.name) });
      await audit("catalog.faculty_created", id);
      return { id };
    }
    if (a.action === "create-major") {
      if (!(await exists(a.facultyId, "faculty")))
        throw new AppError(404, "NOT_FOUND");
      const id = "major:" + randomBytes(5).toString("hex");
      await add(id, "major", null, {
        name: both(a.name),
        facultyId: a.facultyId,
      });
      await audit("catalog.major_created", id);
      return { id };
    }
    if (!(await exists(a.majorId, "major")))
      throw new AppError(404, "NOT_FOUND");
    if (a.action === "assign-course") {
      const moved = await tx.query(
        "UPDATE records SET data=data||$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='course' RETURNING id",
        [
          ctx.tenantId,
          a.courseId,
          "course:" + a.courseId,
          JSON.stringify({ majorId: a.majorId }),
        ],
      );
      if (!moved.rows.length) throw new AppError(404, "NOT_FOUND");
      await audit("catalog.course_assigned", a.courseId);
      return { id: a.courseId };
    }
    const courseId = "C" + randomBytes(4).toString("hex").toUpperCase();
    await add("course:" + courseId, "course", courseId, {
      code: a.code,
      title: both(a.title),
      majorId: a.majorId,
      openEnrollment: true,
    });
    // Testing phase: everyone in the workspace can open every course in their own role.
    await tx.query(
      `INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish)
       SELECT tenant_id,user_id,$2,role,role='instructor',role='instructor' FROM memberships WHERE tenant_id=$1 AND active`,
      [ctx.tenantId, courseId],
    );
    await audit("catalog.course_created", courseId);
    // Creating a course does not open it; the instructor opens it when ready.
    return { id: courseId };
  });
}
