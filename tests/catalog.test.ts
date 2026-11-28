import { changeJob, drainCourse, listJobs } from "../src/server/build-jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import { type ModelGateway } from "../src/server/ai";
import { catalog, catalogAction, unionTree } from "../src/server/catalog";
import {
  approvePendingUmbrella,
  importExtractedPages,
  listMaterials,
} from "../src/server/sources";
import {
  extractPrerequisites,
  extractStep,
  reviewPrerequisiteEdges,
} from "../src/server/prerequisites";
import {
  editTree,
  getKnowledge,
  publishKnowledge,
  stableConceptId,
} from "../src/server/knowledge";
import {
  learnerSignals,
  learningPath,
  workspace,
} from "../src/server/learning";

const tenant = randomUUID();
const instructor: AuthContext = {
  tenantId: tenant,
  userId: randomUUID(),
  role: "instructor",
  courseId: "CET351",
  locale: "en",
};
const student: AuthContext = {
  ...instructor,
  userId: randomUUID(),
  role: "student",
};
/** Deterministic replay: NOT Gemini. One concept from the lecture, one foundation before it. */
const model: ModelGateway = {
  modelId: "deterministic-catalog-replay-NOT-GEMINI",
  async generate(request) {
    const payload = request.payload as any;
    if (payload.evidence)
      return {
        tokens: 10,
        value: {
          concepts: [
            {
              key: "gd",
              label: { ar: "الانحدار التدرّجي", en: "Gradient Descent" },
              aliases: [],
              evidenceIds: [payload.evidence[0].id],
            },
          ],
        },
      };
    return {
      tokens: 10,
      value: {
        foundations: [
          {
            key: "d",
            label: { ar: "المشتقة", en: "Derivative" },
            aliases: [],
            evidenceIds: [payload.umbrellaEvidence[0].id],
          },
        ],
        edges: [
          {
            from: "d",
            to: payload.lectureConcepts[0].key,
            type: "prerequisite",
            evidenceIds: [payload.umbrellaEvidence[0].id],
            reason: {
              ar: "يُحسب من المشتقة",
              en: "Computed from the derivative",
            },
          },
        ],
      },
    };
  },
};
/** Upload, approve, extract, accept and publish one tiny lecture in the given course. */
async function teach(ctx: AuthContext) {
  const lecture = await importExtractedPages(ctx, {
    mode: "lecture",
    title: "Lecture 1",
    pages: [
      {
        page: 1,
        text: "Gradient descent lowers the error by stepping against the gradient of the loss.",
      },
    ],
  });
  await approvePendingUmbrella(ctx, lecture.id);
  const reference = await importExtractedPages(ctx, {
    mode: "umbrella",
    title: "Calculus reference",
    rightsConfirmed: true,
    rightsReference: "Course textbook",
    pages: [
      {
        page: 10,
        text: "Gradient descent is computed from the derivative of the loss; gradient descent needs the derivative first.",
      },
    ],
  });
  // A reference the major already has is recognised and reused as it is.
  if (!("duplicate" in reference))
    await approvePendingUmbrella(ctx, reference.id);
  const proposal = await extractPrerequisites(ctx, model, {
    lectureSourceKey: lecture.sourceKey,
  });
  await reviewPrerequisiteEdges(ctx, {
    id: proposal.id,
    accept: proposal.graph.edges.map((e) => ({ from: e.from, to: e.to })),
  });
  return publishKnowledge(ctx);
}
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
    tenant,
    "Synthetic catalogue tenant",
  ]);
  await db.tenant(tenant).transaction(async (tx) => {
    for (const ctx of [instructor, student]) {
      await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
        tenant,
        ctx.userId,
        '{"ar":"اختبار","en":"Test"}',
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenant, ctx.userId, ctx.role],
      );
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,'CET351',$3,$4,$4)",
        [tenant, ctx.userId, ctx.role, ctx.role === "instructor"],
      );
    }
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,'course:CET351','course','CET351',NULL,$2)",
      [
        tenant,
        '{"code":"CET351","title":{"ar":"مقرر أول","en":"First course"}}',
      ],
    );
  });
});
afterAll(() => db.close());

describe("faculty, major and course structure", () => {
  let facultyId = "",
    majorId = "",
    second = "";
  it("lets only the instructor build the structure, and checks parents exist", async () => {
    await expect(
      catalogAction(student, { action: "create-faculty", name: "Engineering" }),
    ).rejects.toMatchObject({ status: 403 });
    facultyId = (
      (await catalogAction(instructor, {
        action: "create-faculty",
        name: "Engineering",
      })) as any
    ).id;
    await expect(
      catalogAction(instructor, {
        action: "create-major",
        facultyId: "faculty:missing",
        name: "AI",
      }),
    ).rejects.toMatchObject({ status: 404 });
    majorId = (
      (await catalogAction(instructor, {
        action: "create-major",
        facultyId,
        name: "Artificial Intelligence",
      })) as any
    ).id;
    await expect(
      catalogAction(instructor, {
        action: "create-course",
        majorId: "major:missing",
        code: "NN101",
        title: "Neural Networks",
      }),
    ).rejects.toMatchObject({ status: 404 });
    second = (
      (await catalogAction(instructor, {
        action: "create-course",
        majorId,
        code: "NN101",
        title: "Neural Networks",
      })) as any
    ).id;
    await catalogAction(instructor, {
      action: "assign-course",
      courseId: "CET351",
      majorId,
    });
    const seen = await catalog(student);
    expect(seen.faculties).toHaveLength(1);
    expect(seen.majors).toMatchObject([{ id: majorId, facultyId }]);
    // Everyone in the workspace can open the new course in their own role.
    expect(seen.courses.map((c) => c.id).sort()).toEqual(
      ["CET351", second].sort(),
    );
    expect(seen.courses.every((c) => c.majorId === majorId)).toBe(true);
  });
  it("opens only a course the user has access to", async () => {
    await expect(
      catalogAction(student, { action: "select-course", courseId: second }),
    ).resolves.toEqual({ courseId: second });
    await expect(
      catalogAction(student, { action: "select-course", courseId: "C-OTHER" }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps each course's materials, tree and learner path separate", async () => {
    const inSecond = { ...instructor, courseId: second };
    expect(await teach(inSecond)).toMatchObject({ concepts: 2, edges: 1 });
    // Nothing leaks into the first course.
    expect((await listMaterials(instructor)).lectures).toHaveLength(0);
    expect((await getKnowledge(instructor)).releases).toHaveLength(0);
    expect((await workspace(student)).path?.releaseId ?? null).toBeNull();
    // The same concept taught in both courses is stored once per course.
    expect(await teach(instructor)).toMatchObject({ concepts: 2, edges: 1 });
    const gradient = stableConceptId("Gradient Descent");
    const copies = await db
      .tenant(tenant)
      .query<{ course_id: string }>(
        "SELECT course_id FROM records WHERE tenant_id=$1 AND id=$2 AND kind='concept' ORDER BY course_id",
        [tenant, gradient],
      );
    expect(copies.rows.map((r) => r.course_id).sort()).toEqual(
      ["CET351", second].sort(),
    );
    // Editing the tree of one course leaves the other untouched.
    const derivative = stableConceptId("Derivative");
    await editTree(inSecond, { op: "remove", from: derivative, to: gradient });
    const graph = async (ctx: AuthContext) =>
      (await getKnowledge(ctx)).releases[0].data.graph as any;
    expect((await graph(inSecond)).edges).toHaveLength(0);
    expect((await graph(instructor)).edges).toHaveLength(1);
    expect(
      (await workspace({ ...student, courseId: second })).path?.releaseId,
    ).toBeTruthy();
  });
  it("shares a major's reference with its courses, and not with another major", async () => {
    const create = async (majorId: string, code: string) =>
      (
        (await catalogAction(instructor, {
          action: "create-course",
          majorId,
          code,
          title: "Course " + code,
        })) as any
      ).id as string;
    const sibling = { ...instructor, courseId: await create(majorId, "DL201") };
    const otherMajor = (
      (await catalogAction(instructor, {
        action: "create-major",
        facultyId,
        name: "Networks",
      })) as any
    ).id;
    const outsider = {
      ...instructor,
      courseId: await create(otherMajor, "NW101"),
    };
    const lectureOnly = async (ctx: AuthContext) => {
      const lecture = await importExtractedPages(ctx, {
        mode: "lecture",
        title: "Lecture A",
        pages: [
          {
            page: 1,
            text: "Gradient descent lowers the error by stepping against the gradient of the loss.",
          },
        ],
      });
      await approvePendingUmbrella(ctx, lecture.id);
      return lecture.sourceKey;
    };
    // No reference was uploaded in this course: the one from its major is used.
    const key = await lectureOnly(sibling);
    expect((await listMaterials(sibling)).sharedUmbrellas).toHaveLength(1);
    const proposal = await extractPrerequisites(sibling, model, {
      lectureSourceKey: key,
    });
    expect(proposal.graph.edges).toHaveLength(1);
    await reviewPrerequisiteEdges(sibling, {
      id: proposal.id,
      accept: proposal.graph.edges.map((e) => ({ from: e.from, to: e.to })),
    });
    await expect(publishKnowledge(sibling)).resolves.toMatchObject({
      edges: 1,
    });
    // A course of another major sees no reference at all.
    const outsiderKey = await lectureOnly(outsider);
    expect((await listMaterials(outsider)).sharedUmbrellas).toHaveLength(0);
    await expect(
      extractPrerequisites(outsider, model, { lectureSourceKey: outsiderKey }),
    ).rejects.toMatchObject({ code: "umbrella_required" });
  });
  it("lays the courses of a major over each other as one tree", async () => {
    const tree = await unionTree(instructor, "major");
    expect(tree.courses).toHaveLength(3);
    const gradient = tree.concepts.find(
      (c) => c.id === stableConceptId("Gradient Descent"),
    )!;
    // Taught in all three courses, and still one node.
    expect(gradient.courses).toHaveLength(3);
    expect(tree.concepts.filter((c) => c.id === gradient.id)).toHaveLength(1);
    expect((await unionTree(instructor, "university")).courses).toHaveLength(4);
  });
  it("draws a line from a concept of another course in the same major only", async () => {
    const gradient = stableConceptId("Gradient Descent");
    const derivative = stableConceptId("Derivative");
    const inSecond = { ...instructor, courseId: second };
    // The second course lost its derivative line earlier; drop the concept too.
    await db
      .tenant(tenant)
      .query(
        "UPDATE records SET data=jsonb_set(data,'{graph,concepts}',(SELECT jsonb_agg(c) FROM jsonb_array_elements(data->'graph'->'concepts') c WHERE c->>'id'<>$3)) WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release'",
        [tenant, second, derivative],
      );
    await expect(
      editTree(inSecond, { op: "add", from: derivative, to: gradient }),
    ).rejects.toMatchObject({ code: "phantom_endpoint" });
    const linked = await editTree(inSecond, {
      op: "add",
      from: derivative,
      to: gradient,
      fromCourse: "CET351",
    });
    expect(
      linked.graph.concepts.find((c) => c.id === derivative),
    ).toMatchObject({ scope: "foundation", importedFrom: "CET351" });
    expect(linked.graph.edges).toMatchObject([
      { from: derivative, to: gradient, origin: "instructor" },
    ]);
    const outsider = (await catalog(instructor)).courses.find(
      (c) => c.code === "NW101",
    )!;
    await expect(
      editTree(inSecond, {
        op: "add",
        from: "anything",
        to: gradient,
        fromCourse: outsider.id,
      }),
    ).rejects.toMatchObject({ code: "phantom_endpoint" });
  });
  it("recovers a completed extraction when the worker stops before updating job progress", async () => {
    const entry = await catalogAction(instructor, {
      action: "create-course",
      majorId,
      code: "RC401",
      title: "Recovery test",
    });
    if (!("id" in entry)) throw new Error("Expected a course");
    const ctx = { ...instructor, courseId: entry.id };
    const lecture = await importExtractedPages(ctx, {
      mode: "lecture",
      title: "Recovery lecture",
      pages: [
        {
          page: 1,
          text: "Gradient descent lowers the error by stepping against the gradient of the loss.",
        },
      ],
    });
    await approvePendingUmbrella(ctx, lecture.id);
    const job = await changeJob(ctx, {
      action: "create",
      documentIds: [lecture.id],
    });
    await expect(
      changeJob(ctx, { action: "hide", id: job.id }),
    ).rejects.toMatchObject({ status: 409 });
    const lease = randomUUID();
    const sql = db.tenant(ctx.tenantId);
    await sql.query(
      "UPDATE km_build_jobs SET status='processing',lease_token=$3,lease_until=now()+interval '1 minute' WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, job.id, lease],
    );
    const completion = {
      jobId: job.id,
      lease,
      versionId: lecture.id,
      cacheKey: job.documents[0].cacheKey!,
    };
    let done;
    for (let i = 0; i < 8; i++) {
      const step = await extractStep(
        ctx,
        { lectureSourceKey: lecture.sourceKey, lectureOnlyAllowed: true },
        model,
        completion,
      );
      if (step.done) {
        done = step.proposal;
        break;
      }
    }
    expect(done).toBeDefined();
    expect((await listJobs(ctx))[0].status).toBe("processing");
    await sql.query(
      "UPDATE km_build_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, job.id],
    );
    await drainCourse(ctx.tenantId, ctx.courseId);
    const resumed = (await listJobs(ctx))[0];
    expect(resumed.status).toBe("completed");
    expect(resumed.documents[0].proposalId).toBe(done!.id);
    await changeJob(ctx, { action: "hide", id: job.id });
    expect(await listJobs(ctx)).toEqual([]);
    expect(await listJobs(ctx, true)).toEqual([resumed]);
    expect((await getKnowledge(ctx)).proposals).toHaveLength(1);
    expect((await listMaterials(ctx)).lectures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: lecture.sourceKey }),
      ]),
    );
    await changeJob(ctx, { action: "restore", id: job.id });
    expect(await listJobs(ctx, true)).toEqual([]);
    expect(await listJobs(ctx)).toEqual([resumed]);
  });
  it("extracts step by step: one model call per request, resumable, with a second look", async () => {
    const create = async (code: string) =>
      (
        (await catalogAction(instructor, {
          action: "create-course",
          majorId,
          code,
          title: "Course " + code,
        })) as any
      ).id as string;
    const course = { ...instructor, courseId: await create("ST301") };
    const lecture = await importExtractedPages(course, {
      mode: "lecture",
      title: "Lecture S",
      pages: [
        {
          page: 1,
          text: "Gradient descent lowers the error by stepping against the gradient of the loss.",
        },
      ],
    });
    await approvePendingUmbrella(course, lecture.id);
    // The reference of the major is recognised when uploaded again, not stored twice.
    const again = await importExtractedPages(course, {
      mode: "umbrella",
      title: "Calculus reference",
      rightsConfirmed: true,
      rightsReference: "Course textbook",
      pages: [
        {
          page: 10,
          text: "Gradient descent is computed from the derivative of the loss; gradient descent needs the derivative first.",
        },
      ],
    });
    expect(again).toMatchObject({ duplicate: true });
    expect((await listMaterials(course)).umbrellas).toHaveLength(0);
    let calls = 0,
      failNext = true;
    const counted: ModelGateway = {
      modelId: "deterministic-step-replay-NOT-GEMINI",
      async generate(request) {
        calls++;
        const payload = request.payload as any;
        // The step-by-step run asks for the thorough setting.
        expect(request.thorough).toBe(true);
        if (!payload.evidence && failNext) {
          failNext = false;
          throw Object.assign(new Error("busy"), { status: 503 });
        }
        if (payload.evidence) return model.generate(request);
        // First look finds nothing; the second look finds the relationship.
        return calls < 4
          ? { tokens: 5, value: { foundations: [], edges: [] } }
          : model.generate(request);
      },
    };
    const step = () =>
      extractStep(course, { lectureSourceKey: lecture.sourceKey }, counted);
    const first = await step();
    expect(first).toMatchObject({ done: false, next: { kind: "links" } });
    expect(calls).toBe(1);
    // A failed call loses nothing: the concept answer is not asked for again.
    await expect(step()).rejects.toBeTruthy();
    expect(calls).toBe(2);
    const third = await step();
    expect(calls).toBe(3);
    expect(third).toMatchObject({ done: false, next: { kind: "recheck" } });
    const last = await step();
    expect(calls).toBe(4);
    expect(last.done).toBe(true);
    if (!last.done) throw new Error("unreachable");
    // The concept another course of the major already teaches keeps its identity.
    expect(last.proposal.graph.edges).toMatchObject([
      {
        from: stableConceptId("Derivative"),
        to: stableConceptId("Gradient Descent"),
      },
    ]);
    // Finished: nothing is left over to replay.
    const left = await db
      .tenant(tenant)
      .query(
        "SELECT 1 FROM records WHERE tenant_id=$1 AND kind='extraction_job'",
        [tenant],
      );
    expect(left.rows).toHaveLength(0);
  });
  it("carries a learner's standing across the major and counts repeated tutor questions", async () => {
    const gradient = stableConceptId("Gradient Descent");
    const derivative = stableConceptId("Derivative");
    const inSecond = { ...student, courseId: second };
    const scoped = db.tenant(tenant);
    const put = (id: string, kind: string, course: string, data: unknown) =>
      scoped.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()",
        [
          tenant,
          id,
          kind,
          course,
          kind === "objective" ? null : student.userId,
          JSON.stringify(data),
        ],
      );
    // Gradient descent has questions in the second course; the derivative does not.
    await put("objective:c:" + gradient, "objective", second, {
      objectiveId: "c:" + gradient,
      conceptId: gradient,
    });
    const node = async (id: string) =>
      (await learningPath(scoped, inSecond, student.userId)).nodes.find(
        (n) => n.conceptId === id,
      )!;
    expect((await node(derivative)).status).toBe("unassessable");
    expect((await node(gradient)).blockedBy).toHaveLength(0);
    // The learner is weak on the derivative in the first course: it now holds them back here.
    const state = "state:" + student.userId + ":c:" + derivative;
    await put(state, "state", "CET351", {
      objectiveId: "c:" + derivative,
      status: "developing",
    });
    expect(await node(derivative)).toMatchObject({
      status: "developing",
      knownFrom: "CET351",
    });
    expect((await node(gradient)).blockedBy).toMatchObject([
      { conceptId: derivative, status: "developing" },
    ]);
    // Once it is secure there, it no longer blocks here.
    await put(state, "state", "CET351", {
      objectiveId: "c:" + derivative,
      status: "secure",
    });
    expect((await node(derivative)).status).toBe("secure");
    expect((await node(gradient)).blockedBy).toHaveLength(0);
    // Their own answers in this course always come first.
    await put("objective:c:" + derivative, "objective", second, {
      objectiveId: "c:" + derivative,
      conceptId: derivative,
    });
    await put(state, "state", second, {
      objectiveId: "c:" + derivative,
      status: "developing",
    });
    expect((await node(derivative)).knownFrom).toBeUndefined();
    expect((await node(derivative)).status).toBe("developing");
    // Three recent tutor questions about a concept mark it, and it is studied next.
    expect((await node(gradient)).askedTutor).toBeUndefined();
    for (const n of [1, 2, 3])
      await put("tutor:" + n, "tutor_memory", n === 3 ? "CET351" : second, {
        question: "what is gradient descent again?",
        conceptIds: [gradient],
      });
    expect(
      (await learnerSignals(scoped, inSecond, student.userId)).asked.get(
        gradient,
      ),
    ).toBe(3);
    const path = await learningPath(scoped, inSecond, student.userId);
    expect(path.nodes.find((n) => n.conceptId === gradient)!.askedTutor).toBe(
      3,
    );
    // Another learner's questions and standing never leak in.
    const other = await learnerSignals(scoped, inSecond, instructor.userId);
    expect(other.asked.size).toBe(0);
    expect(other.elsewhere.size).toBe(0);
  });
  it("imports a study plan, and locks a course until the one before it is finished", async () => {
    const major = (
      (await catalogAction(instructor, {
        action: "create-major",
        facultyId,
        name: "Data Science",
      })) as any
    ).id;
    const plan = {
      action: "import-study-map",
      majorId: major,
      terms: [
        {
          label: "Level 1 · Fall",
          courses: [
            {
              code: "GEN111",
              title: "Applied Mathematics I",
              requires: ["GEN011"],
            },
          ],
        },
        {
          label: "Level 2 · Fall",
          courses: [
            {
              code: "GEN211",
              title: "Probability & Statistics",
              requires: ["GEN111"],
            },
            {
              code: "CET251",
              title: "Artificial Intelligence",
              requires: ["GEN211"],
            },
          ],
        },
      ],
    };
    await expect(catalogAction(student, plan)).rejects.toMatchObject({
      status: 403,
    });
    expect(await catalogAction(instructor, plan)).toMatchObject({
      courses: 3,
      created: 3,
    });
    // Importing again updates the plan; it never duplicates a course.
    expect(await catalogAction(instructor, plan)).toMatchObject({ created: 0 });
    const of = async (ctx: AuthContext, code: string) =>
      (await catalog(ctx)).courses.find(
        (c) => c.majorId === major && c.code === code,
      )!;
    const maths = await of(student, "GEN111"),
      statistics = await of(student, "GEN211");
    expect(statistics).toMatchObject({
      term: "Level 2 · Fall",
      prerequisites: [maths.id],
    });
    // A code the plan names but does not list is kept as a note, not as a lock.
    expect(maths).toMatchObject({
      prerequisites: [],
      externalPrerequisites: ["GEN011"],
      locked: false,
    });
    // A plan where a course comes before itself is refused.
    await expect(
      catalogAction(instructor, {
        action: "set-prerequisites",
        courseId: maths.id,
        prerequisites: [(await of(student, "CET251")).id],
      }),
    ).rejects.toMatchObject({ code: "STUDY_MAP_LOOP" });
    // Nothing to finish yet in mathematics, so statistics is open.
    expect(statistics.locked).toBe(false);
    const scoped = db.tenant(tenant);
    const objective = (n: number) =>
      scoped.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'objective',$3,NULL,$4)",
        [
          tenant,
          "objective:c:m" + n,
          maths.id,
          JSON.stringify({ objectiveId: "c:m" + n, conceptId: "m" + n }),
        ],
      );
    for (const n of [1, 2, 3]) await objective(n);
    // Mathematics now has questions the learner has not secured: statistics is locked.
    expect(await of(student, "GEN211")).toMatchObject({ locked: true });
    expect(await of(student, "GEN111")).toMatchObject({
      assessable: 3,
      percent: 0,
      finished: false,
    });
    // The instructor is never locked out.
    expect((await of(instructor, "GEN211")).locked).toBe(false);
    await expect(
      catalogAction(student, {
        action: "select-course",
        courseId: statistics.id,
      }),
    ).rejects.toMatchObject({ code: "COURSE_LOCKED" });
    const secure = (n: number) =>
      scoped.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'state',$3,$4,$5)",
        [
          tenant,
          "state:" + student.userId + ":c:m" + n,
          maths.id,
          student.userId,
          JSON.stringify({ objectiveId: "c:m" + n, status: "secure" }),
        ],
      );
    await secure(1);
    await secure(2);
    // Two of three is 67%: not yet the 70% that counts as finished.
    expect((await of(student, "GEN211")).locked).toBe(true);
    // The instructor can open the course for this learner.
    await catalogAction(instructor, {
      action: "unlock-course",
      courseId: statistics.id,
      studentId: student.userId,
      unlocked: true,
    });
    expect((await of(student, "GEN211")).locked).toBe(false);
    await catalogAction(instructor, {
      action: "unlock-course",
      courseId: statistics.id,
      studentId: student.userId,
      unlocked: false,
    });
    await secure(3);
    expect(await of(student, "GEN111")).toMatchObject({
      percent: 100,
      finished: true,
    });
    await expect(
      catalogAction(student, {
        action: "select-course",
        courseId: statistics.id,
      }),
    ).resolves.toEqual({ courseId: statistics.id });
  });
  it("empties a synthetic test workspace on request, keeping people and structure", async () => {
    // A workspace holding real people can never be emptied this way.
    await db.query("UPDATE tenants SET synthetic=false WHERE id=$1", [tenant]);
    await expect(
      catalogAction(instructor, {
        action: "reset-workspace",
        confirm: "RESET",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await db.query("UPDATE tenants SET synthetic=true WHERE id=$1", [tenant]);
    await expect(
      catalogAction(student, { action: "reset-workspace", confirm: "RESET" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      catalogAction(instructor, { action: "reset-workspace", confirm: "yes" }),
    ).rejects.toBeTruthy();
    const result = (await catalogAction(instructor, {
      action: "reset-workspace",
      confirm: "RESET",
    })) as any;
    expect(result.removed.sources).toBeGreaterThan(0);
    expect((await listMaterials(instructor)).lectures).toHaveLength(0);
    expect((await getKnowledge(instructor)).releases).toHaveLength(0);
    const kept = await catalog(instructor);
    expect(kept.faculties).toHaveLength(1);
    expect(kept.courses.length).toBeGreaterThan(1);
    // A full reset also removes the added structure.
    await catalogAction(instructor, {
      action: "reset-workspace",
      confirm: "RESET",
      keepStructure: false,
    });
    const bare = await catalog(instructor);
    expect(bare.faculties).toHaveLength(0);
    expect(bare.courses.map((c) => c.id)).toEqual(["CET351"]);
  });
});

it("removes and restores catalog entries without erasing published course data", async () => {
  const create = async (input: Record<string, unknown>) => {
    const result = await catalogAction(instructor, input);
    if (!("id" in result) || !result.id) throw new Error("Expected an item ID");
    return result.id;
  };
  const facultyId = await create({
    action: "create-faculty",
    name: "Temporary faculty",
  });
  const majorId = await create({
    action: "create-major",
    name: "Temporary major",
    facultyId,
  });
  const courseId = await create({
    action: "create-course",
    title: "Temporary course",
    majorId,
  });
  const change = (action: string, kind: string, id: string, ctx = instructor) =>
    catalogAction(ctx, { action, kind, id });
  const courseCtx = { ...instructor, courseId };
  await teach(courseCtx);
  await expect(
    change("remove-structure", "faculty", facultyId),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    change("remove-structure", "major", majorId),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    change("remove-structure", "course", courseId, student),
  ).rejects.toMatchObject({ status: 403 });
  await change("remove-structure", "course", courseId);
  await change("remove-structure", "major", majorId);
  await change("remove-structure", "faculty", facultyId);
  expect((await catalog(instructor)).removed.map((item) => item.id)).toEqual(
    expect.arrayContaining([facultyId, majorId, courseId]),
  );
  expect((await catalog(student)).removed).toEqual([]);
  expect(
    (await catalog(student)).courses.map((course) => course.id),
  ).not.toContain(courseId);
  await expect(
    change("restore-structure", "course", courseId),
  ).rejects.toMatchObject({ status: 409 });
  await change("restore-structure", "faculty", facultyId);
  await change("restore-structure", "major", majorId);
  await change("restore-structure", "course", courseId);
  expect((await listMaterials(courseCtx)).lectures).toHaveLength(1);
  expect((await getKnowledge(courseCtx)).releases).toHaveLength(1);
  expect(
    (await catalog(student)).courses.find((course) => course.id === courseId)
      ?.majorId,
  ).toBe(majorId);
  await change("remove-structure", "course", courseId);
  await change("remove-structure", "major", majorId);
  await change("remove-structure", "faculty", facultyId);
});
