import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { DEFAULT_COURSE, type AuthContext } from "./auth";

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
    action: z.literal("import-study-map"),
    majorId: z.string().min(1).max(80),
    terms: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(60),
          courses: z
            .array(
              z.object({
                code: z.string().trim().min(2).max(20),
                title: name,
                requires: z.array(z.string().trim().min(2).max(20)).max(8),
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(16),
  }),
  z.object({
    action: z.literal("set-prerequisites"),
    courseId: z.string().min(1).max(40),
    prerequisites: z.array(z.string().min(1).max(40)).max(8),
  }),
  z.object({
    action: z.literal("unlock-course"),
    courseId: z.string().min(1).max(40),
    studentId: z.string().min(1).max(80),
    unlocked: z.boolean(),
  }),
  z.object({
    action: z.literal("reset-workspace"),
    // Typed by the instructor, so a stray click cannot wipe the workspace.
    confirm: z.literal("RESET"),
    keepStructure: z.boolean().default(true),
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
  const standing = await courseStanding(ctx.tenantId, ctx.userId);
  const locked =
    ctx.role === "student"
      ? lockedCourses(
          rows.filter((r) => r.kind === "course"),
          standing,
          await unlockedFor(ctx.tenantId, ctx.userId),
        )
      : new Set<string>();
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
        // Study plan: where the course sits and which courses must be finished first.
        term: (r.data.term as string | undefined) ?? null,
        order: (r.data.order as number | undefined) ?? 0,
        prerequisites: (r.data.prerequisites as string[] | undefined) ?? [],
        externalPrerequisites:
          (r.data.externalPrerequisites as string[] | undefined) ?? [],
        ...(standing.get(r.course_id!) ?? {
          assessable: 0,
          percent: null,
          finished: false,
        }),
        locked: locked.has(r.course_id!),
      })),
  };
}

/** A course counts as finished when this share of its assessable concepts is secure. */
export const FINISHED_SHARE = 0.7;
type Standing = {
  assessable: number;
  percent: number | null;
  finished: boolean;
};
/** For one learner: how much of each course's assessable concepts they have secured. */
async function courseStanding(tenantId: string, userId: string) {
  const rows = (
    await db
      .tenant(tenantId)
      .query<{ course_id: string; assessable: string; secure: string }>(
        `SELECT o.course_id,count(*) AS assessable,
              count(*) FILTER (WHERE s.data->>'status'='secure') AS secure
       FROM records o LEFT JOIN records s ON s.tenant_id=o.tenant_id AND s.course_id=o.course_id AND s.kind='state'
            AND s.owner_id=$2 AND s.data->>'objectiveId'=o.data->>'objectiveId'
       WHERE o.tenant_id=$1 AND o.kind='objective' AND o.data->>'objectiveId' LIKE 'c:%' GROUP BY o.course_id`,
        [tenantId, userId],
      )
  ).rows;
  const standing = new Map<string, Standing>();
  for (const r of rows) {
    const assessable = Number(r.assessable),
      secure = Number(r.secure);
    standing.set(r.course_id, {
      assessable,
      percent: assessable ? Math.round((100 * secure) / assessable) : null,
      finished: assessable > 0 && secure / assessable >= FINISHED_SHARE,
    });
  }
  return standing;
}
async function unlockedFor(tenantId: string, userId: string) {
  return new Set(
    (
      await db
        .tenant(tenantId)
        .query<{ course_id: string }>(
          "SELECT course_id FROM records WHERE tenant_id=$1 AND kind='course_unlock' AND owner_id=$2 AND data->>'unlocked'='true'",
          [tenantId, userId],
        )
    ).rows.map((r) => r.course_id),
  );
}
/**
 * A course is locked while a course before it in the study plan is not finished. A
 * prerequisite that has no questions yet cannot be finished, so it does not hold anyone
 * back; an instructor can also open a course for one learner.
 */
function lockedCourses(
  courses: Row[],
  standing: Map<string, Standing>,
  unlocked: Set<string>,
) {
  const locked = new Set<string>();
  for (const c of courses) {
    if (!c.course_id || unlocked.has(c.course_id)) continue;
    const waiting = ((c.data.prerequisites as string[] | undefined) ?? []).some(
      (id) => {
        const s = standing.get(id);
        return s && s.assessable > 0 && !s.finished;
      },
    );
    if (waiting) locked.add(c.course_id);
  }
  return locked;
}
/** Would these prerequisite links make a course come before itself? */
function hasLoop(links: Map<string, string[]>) {
  const done = new Set<string>(),
    open = new Set<string>();
  const visit = (id: string): boolean => {
    if (open.has(id)) return true;
    if (done.has(id)) return false;
    open.add(id);
    const looped = (links.get(id) ?? []).some(visit);
    open.delete(id);
    done.add(id);
    return looped;
  };
  return [...links.keys()].some(visit);
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
    if (ctx.role === "student") {
      const listed = (await catalog(ctx)).courses.find(
        (c) => c.id === a.courseId,
      );
      if (listed?.locked) throw new AppError(403, "COURSE_LOCKED");
    }
    return { courseId: a.courseId };
  }
  if (ctx.role !== "instructor") throw new AppError(403, "FORBIDDEN");
  if (a.action === "reset-workspace")
    return resetWorkspace(ctx, a.keepStructure);
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
    const createCourse = async (
      code: string,
      title: string,
      majorId: string,
    ) => {
      const courseId = "C" + randomBytes(4).toString("hex").toUpperCase();
      await add("course:" + courseId, "course", courseId, {
        code,
        title: both(title),
        majorId,
        openEnrollment: true,
      });
      // Testing phase: everyone in the workspace can open every course in their own role.
      await tx.query(
        `INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish)
         SELECT tenant_id,user_id,$2,role,role='instructor',role='instructor' FROM memberships WHERE tenant_id=$1 AND active`,
        [ctx.tenantId, courseId],
      );
      return courseId;
    };
    const coursesOf = async (majorId?: string) =>
      (
        await tx.query<Row>(
          "SELECT id,kind,course_id,data FROM records WHERE tenant_id=$1 AND kind='course' AND ($2::text IS NULL OR data->>'majorId'=$2)",
          [ctx.tenantId, majorId ?? null],
        )
      ).rows;
    const patch = (courseId: string, data: unknown) =>
      tx.query(
        "UPDATE records SET data=data||$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND kind='course'",
        [ctx.tenantId, courseId, "course:" + courseId, JSON.stringify(data)],
      );
    if (a.action === "unlock-course") {
      await tx.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'course_unlock',$3,$4,$5) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()",
        [
          ctx.tenantId,
          "course_unlock:" + a.studentId,
          a.courseId,
          a.studentId,
          JSON.stringify({ unlocked: a.unlocked, by: ctx.userId }),
        ],
      );
      await audit("catalog.course_unlock", a.courseId);
      return { id: a.courseId };
    }
    if (a.action === "set-prerequisites") {
      const all = await coursesOf();
      const ids = new Set(all.map((c) => c.course_id!));
      if (!ids.has(a.courseId) || a.prerequisites.some((p) => !ids.has(p)))
        throw new AppError(404, "NOT_FOUND");
      const links = new Map(
        all.map((c) => [
          c.course_id!,
          c.course_id === a.courseId
            ? a.prerequisites
            : ((c.data.prerequisites as string[] | undefined) ?? []),
        ]),
      );
      if (hasLoop(links)) throw new AppError(409, "STUDY_MAP_LOOP");
      await patch(a.courseId, { prerequisites: [...new Set(a.prerequisites)] });
      await audit("catalog.prerequisites_set", a.courseId);
      return { id: a.courseId };
    }
    if (!(await exists(a.majorId, "major")))
      throw new AppError(404, "NOT_FOUND");
    if (a.action === "import-study-map") {
      // Courses are matched by code inside the major, so importing again updates the
      // plan instead of duplicating it and never touches a course's content.
      const byCode = new Map(
        (await coursesOf(a.majorId)).map((c) => [
          String(c.data.code ?? "").toUpperCase(),
          c.course_id!,
        ]),
      );
      const listed = a.terms.flatMap((t) => t.courses);
      if (
        new Set(listed.map((c) => c.code.toUpperCase())).size !== listed.length
      )
        throw new AppError(400, "INVALID_INPUT");
      let created = 0;
      for (const c of listed)
        if (!byCode.has(c.code.toUpperCase())) {
          byCode.set(
            c.code.toUpperCase(),
            await createCourse(c.code, c.title, a.majorId),
          );
          created++;
        }
      const links = new Map<string, string[]>();
      let order = 0;
      for (const term of a.terms)
        for (const c of term.courses) {
          const id = byCode.get(c.code.toUpperCase())!;
          links.set(
            id,
            c.requires
              .filter((code) => byCode.has(code.toUpperCase()))
              .map((code) => byCode.get(code.toUpperCase())!),
          );
          await patch(id, {
            code: c.code,
            title: both(c.title),
            term: term.label,
            order: order++,
            prerequisites: links.get(id),
            // A code the plan names but does not list (a preparatory course, say).
            externalPrerequisites: c.requires.filter(
              (code) => !byCode.has(code.toUpperCase()),
            ),
          });
        }
      if (hasLoop(links)) throw new AppError(409, "STUDY_MAP_LOOP");
      await audit("catalog.study_map_imported", a.majorId);
      return { id: a.majorId, courses: listed.length, created };
    }
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
    const courseId = await createCourse(a.code, a.title, a.majorId);
    await audit("catalog.course_created", courseId);
    // Creating a course does not open it; the instructor opens it when ready.
    return { id: courseId };
  });
}

type GraphConcept = {
  id: string;
  label: { ar: string; en: string };
  scope?: string;
  evidenceIds?: string[];
};
type GraphEdge = {
  from: string;
  to: string;
  type: string;
  origin?: string;
  reason?: { ar: string; en: string };
};
/**
 * One tree for a whole major or the whole university: the published trees of its
 * courses laid over each other. A concept taught in two courses is one node.
 */
export async function unionTree(
  ctx: AuthContext,
  scope: "major" | "university",
) {
  const all = await catalog(ctx);
  const here = all.courses.find((c) => c.id === ctx.courseId);
  const courses =
    scope === "university"
      ? all.courses
      : all.courses.filter((c) =>
          here?.majorId ? c.majorId === here.majorId : c.id === ctx.courseId,
        );
  const key =
    scope === "university"
      ? "tree_layout:university"
      : "tree_layout:" + (here?.majorId ?? "course:" + ctx.courseId);
  const conn = db.tenant(ctx.tenantId);
  const releases = (
    await conn.query<{
      course_id: string;
      graph: { concepts: GraphConcept[]; edges: GraphEdge[] };
    }>(
      "SELECT DISTINCT ON (course_id) course_id,data->'graph' AS graph FROM records WHERE tenant_id=$1 AND kind='graph_release' AND course_id=ANY($2::text[]) ORDER BY course_id,created_at DESC,id DESC",
      [ctx.tenantId, courses.map((c) => c.id)],
    )
  ).rows;
  const concepts = new Map<
    string,
    GraphConcept & { courses: string[]; mentionedIn: string[] }
  >();
  const edges = new Map<string, GraphEdge & { courses: string[] }>();
  for (const r of releases) {
    for (const c of r.graph?.concepts ?? []) {
      const node = concepts.get(c.id) ?? {
        id: c.id,
        label: c.label,
        scope: "foundation",
        courses: [],
        mentionedIn: [],
      };
      // A course "teaches" a concept from its lectures; a foundation is only needed there.
      if (c.scope === "foundation") node.mentionedIn.push(r.course_id);
      else {
        node.courses.push(r.course_id);
        node.scope = "course";
      }
      concepts.set(c.id, node);
    }
    for (const e of r.graph?.edges ?? []) {
      const id = `${e.from}|${e.to}`;
      const edge = edges.get(id) ?? { ...e, courses: [] };
      edge.courses.push(r.course_id);
      // Routing in any course makes the shared line a prerequisite.
      if (e.type === "prerequisite") edge.type = "prerequisite";
      edges.set(id, edge);
    }
  }
  const sourceRows = (await conn.query<{ id: string; course_id: string; source_key: string; title: string; role: string; document_hash: string | null; original_filename: string | null; evidence_id: string | null }>(
    "SELECT v.id,v.course_id,v.source_key,v.title,v.role,v.metadata->>'documentHash' AS document_hash,v.metadata->>'originalFilename' AS original_filename,c.id AS evidence_id FROM material_versions v LEFT JOIN evidence_chunks c ON c.tenant_id=v.tenant_id AND c.version_id=v.id AND c.status='approved' WHERE v.tenant_id=$1 AND v.course_id=ANY($2::text[]) AND v.current_version=true AND v.role IN ('instructor','umbrella') ORDER BY v.course_id,v.title,c.page",
    [ctx.tenantId, courses.map((c) => c.id)],
  )).rows;
  const materials = new Map<string, { id: string; courseId: string; title: string; role: string; versionIds: string[]; conceptIds: string[] }>();
  const byEvidence = new Map<string, string>();
  for (const s of sourceRows) {
    const id = s.course_id + ":" + s.role + ":" + (s.document_hash || s.source_key);
    const material = materials.get(id) ?? { id, courseId: s.course_id, title: s.original_filename?.replace(/\.pdf$/i, "") || s.title, role: s.role, versionIds: [], conceptIds: [] };
    if (!material.versionIds.includes(s.id)) material.versionIds.push(s.id);
    if (s.evidence_id) byEvidence.set(s.evidence_id, id);
    materials.set(id, material);
  }
  for (const r of releases) for (const c of r.graph?.concepts ?? []) {
    for (const evidenceId of c.evidenceIds ?? []) {
      const material = materials.get(byEvidence.get(evidenceId) ?? "");
      if (material && !material.conceptIds.includes(c.id)) material.conceptIds.push(c.id);
    }
  }
  const layout = (
    await conn.query<{ data: { positions?: Record<string, unknown> } }>(
      "SELECT data FROM records WHERE tenant_id=$1 AND id=$2 AND kind='tree_layout' AND course_id IS NULL",
      [ctx.tenantId, key],
    )
  ).rows[0]?.data.positions;
  return {
    scope,
    current: ctx.courseId,
    layoutKey: key,
    courses: courses.map((c) => ({
      ...c,
      major: all.majors.find((m) => m.id === c.majorId)?.name ?? null,
    })),
    concepts: [...concepts.values()],
    edges: [...edges.values()],
    majors: all.majors.filter((m) => courses.some((c) => c.majorId === m.id)),
    materials: [...materials.values()],
    layout: layout ?? {},
  };
}

/**
 * Testing aid: empty the workspace so a trial can start again. Removes every uploaded
 * source, tree, question, learner record and model trace of this synthetic workspace.
 * People, their roles and (unless asked otherwise) the academic structure stay.
 */
async function resetWorkspace(ctx: AuthContext, keepStructure: boolean) {
  const conn = db.tenant(ctx.tenantId);
  const synthetic = await conn.query(
    "SELECT 1 FROM tenants WHERE id=$1 AND synthetic=true",
    [ctx.tenantId],
  );
  // Only a synthetic test workspace can ever be emptied this way.
  if (!synthetic.rows[0]) throw new AppError(403, "FORBIDDEN");
  return conn.transaction(async (tx) => {
    const count = async (sql: string, params: unknown[] = [ctx.tenantId]) =>
      (await tx.query(sql + " RETURNING 1", params)).rows.length;
    const removed = {
      embeddings: await count(
        "DELETE FROM chunk_embeddings WHERE tenant_id=$1",
      ),
      pages: await count("DELETE FROM evidence_chunks WHERE tenant_id=$1"),
      sources: await count("DELETE FROM material_versions WHERE tenant_id=$1"),
      traces: await count("DELETE FROM model_traces WHERE tenant_id=$1"),
      exams: await count("DELETE FROM exam_sessions WHERE tenant_id=$1"),
      records: await count(
        keepStructure
          ? "DELETE FROM records WHERE tenant_id=$1 AND kind NOT IN ('course','faculty','major','preferences')"
          : "DELETE FROM records WHERE tenant_id=$1 AND kind<>'preferences' AND NOT (kind='course' AND course_id=$2)",
        keepStructure ? [ctx.tenantId] : [ctx.tenantId, DEFAULT_COURSE],
      ),
    };
    if (!keepStructure) {
      await tx.query(
        "DELETE FROM course_access WHERE tenant_id=$1 AND course_id<>$2",
        [ctx.tenantId, DEFAULT_COURSE],
      );
      await tx.query(
        "UPDATE records SET data=data-'majorId' WHERE tenant_id=$1 AND kind='course'",
        [ctx.tenantId],
      );
    }
    await tx.query(
      "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.userId,
        "workspace.reset",
        ctx.tenantId,
        JSON.stringify({ keepStructure, removed }),
      ],
    );
    return { reset: true, removed, courseId: DEFAULT_COURSE };
  });
}
