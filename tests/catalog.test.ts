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
import { workspace } from "../src/server/learning";

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
