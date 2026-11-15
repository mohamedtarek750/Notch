import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import { type ModelGateway } from "../src/server/ai";
import { catalog, catalogAction } from "../src/server/catalog";
import {
  approvePendingUmbrella,
  importExtractedPages,
  listMaterials,
} from "../src/server/sources";
import {
  extractPrerequisites,
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
            reason: { ar: "يُحسب من المشتقة", en: "Computed from the derivative" },
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
      [tenant, '{"code":"CET351","title":{"ar":"مقرر أول","en":"First course"}}'],
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
});
