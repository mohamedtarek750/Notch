import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { readKnowledgeGraph } from "../src/server/knowledge-graph";
import { createWorkspace } from "../src/server/seed";
import { type AuthContext } from "../src/server/auth";
import { catalogAction } from "../src/server/catalog";
import {
  approvePendingUmbrella,
  importExtractedPages,
} from "../src/server/sources";
import {
  extractPrerequisites,
  reviewPrerequisiteEdges,
} from "../src/server/prerequisites";
import { publishKnowledge } from "../src/server/knowledge";

let ctx: AuthContext;
const courses: Record<string, string> = {};
const prerequisites = [
  "Chain Rule",
  "Partial Derivatives",
  "Activation Function Derivatives",
  "Forward Propagation",
  "Loss Functions",
];
const prerequisitesOf = (id: string) =>
  prerequisites.map((source) => ({
    from: source,
    to: id,
    type: "prerequisite",
    evidenceIds: [],
    reason: { ar: "دليل اصطناعي", en: "Synthetic dependency fixture" },
  }));
async function publish(
  subject: string,
  terms: string[],
  external: string[] = [],
  edges: unknown[] = [],
) {
  const graph = {
    concepts: terms.map((id) => ({
      id,
      label: { ar: id === "Arabic Grammar" ? "النحو العربي" : id, en: id },
      scope: external.includes(id) ? "foundation" : "course",
      evidenceIds: [],
      aliases: [],
    })),
    edges,
  };
  await db
    .tenant(ctx.tenantId)
    .query(
      "INSERT INTO records(tenant_id,course_id,id,kind,data) VALUES($1,$2,$3,'graph_release',$4)",
      [
        ctx.tenantId,
        courses[subject],
        crypto.randomUUID(),
        JSON.stringify({ graph }),
      ],
    );
}
beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  const ws = await createWorkspace();
  const { rows } = await db
    .tenant(ws.tenantId)
    .query<{ user_id: string }>(
      "SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='instructor'",
      [ws.tenantId],
    );
  ctx = {
    role: "instructor",
    locale: "en",
    tenantId: ws.tenantId,
    userId: rows[0].user_id,
    courseId: "CET351",
  };
  const faculty = await catalogAction(ctx, {
    action: "create-faculty",
    name: "Synthetic university",
  });
  if (!("id" in faculty)) throw new Error("Expected faculty");
  const major = await catalogAction(ctx, {
    action: "create-major",
    name: "Synthetic curriculum",
    facultyId: faculty.id,
  });
  if (!("id" in major)) throw new Error("Expected major");
  for (const [code, title] of [
    ["M1", "Math 1"],
    ["ML", "Machine Learning"],
    ["NN", "Neural Networks"],
    ["AR", "Arabic Grammar"],
  ]) {
    const course = await catalogAction(ctx, {
      action: "create-course",
      code,
      title,
      majorId: major.id,
    });
    if (!("id" in course)) throw new Error("Expected course");
    courses[code] = course.id;
  }
});
afterAll(() => db.close());
it("resolves reviewed dependencies when the dependent course is published first and keeps unrelated courses independent", async () => {
  await publish(
    "NN",
    ["Backpropagation", ...prerequisites],
    prerequisites,
    prerequisitesOf("Backpropagation"),
  );
  await publish("AR", ["Arabic Grammar"]);
  await publish("M1", [...prerequisites.slice(0, 2), "Integration"]);
  await publish("ML", [
    ...prerequisites.slice(2),
    "Reinforcement Learning",
    "Integration",
  ]);
  const detail = await readKnowledgeGraph(
    ctx,
    new URLSearchParams({
      kind: "concept",
      id: "Backpropagation",
      courseId: courses.NN,
    }),
  );
  if (!("relations" in detail)) throw new Error("Expected concept details");
  expect(
    detail.relations
      .filter((r) => r.direction === "in")
      .map((r) => r.node.id)
      .sort(),
  ).toEqual([...prerequisites].sort());
  const grammar = await readKnowledgeGraph(
    ctx,
    new URLSearchParams({
      kind: "concept",
      id: "Arabic Grammar",
      courseId: courses.AR,
    }),
  );
  expect(grammar).toMatchObject({
    relations: [],
    node: { label: { ar: "النحو العربي" } },
  });
  const course = (id: string) =>
    readKnowledgeGraph(ctx, new URLSearchParams({ kind: "course", id }));
  const courseRelation = (id: string, type: string) =>
    expect.objectContaining({ node: expect.objectContaining({ id }), type });
  expect(await course(courses.NN)).toMatchObject({
    relations: expect.arrayContaining([
      courseRelation(courses.ML, "PREREQUISITE_OF"),
    ]),
  });
  expect(await course(courses.ML)).toMatchObject({
    relations: expect.arrayContaining([
      courseRelation(courses.M1, "RELATED_TO"),
    ]),
  });
  expect(await course(courses.AR)).toMatchObject({ relations: [] });
  await catalogAction(ctx, {
    action: "set-related-courses",
    courseId: courses.NN,
    relatedCourses: [courses.AR],
  });
  expect(await course(courses.AR)).toMatchObject({
    relations: [courseRelation(courses.NN, "RELATED_TO")],
  });
  await catalogAction(ctx, {
    action: "set-related-courses",
    courseId: courses.AR,
    relatedCourses: [],
  });
  expect(await course(courses.AR)).toMatchObject({ relations: [] });
  await expect(
    publish(
      "M1",
      ["Backpropagation", "Chain Rule"],
      [],
      [{ from: "Backpropagation", to: "Chain Rule", type: "prerequisite" }],
    ),
  ).rejects.toThrow();
});

it("adds cited requirements from another course to a published lecture without another upload", async () => {
  const nn = { ...ctx, courseId: courses.NN };
  const upload = await importExtractedPages(nn, {
    mode: "lecture",
    title: "Training fixture",
    pages: [
      {
        page: 1,
        text: "Training a neural network with gradient descent uses a loss function to measure prediction error before taking an update step.",
      },
    ],
  });
  await approvePendingUmbrella(nn, upload.id);
  const evidence = (
    await db
      .tenant(nn.tenantId)
      .query<{ id: string }>(
        "SELECT id FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2",
        [nn.tenantId, upload.id],
      )
  ).rows[0].id;
  await db
    .tenant(nn.tenantId)
    .query(
      "INSERT INTO records(tenant_id,course_id,id,kind,data,created_at) VALUES($1,$2,$3,'graph_release',$4,now()+interval '1 second')",
      [
        nn.tenantId,
        nn.courseId,
        crypto.randomUUID(),
        JSON.stringify({
          graph: {
            concepts: [
              {
                id: "Training",
                label: { en: "Training", ar: "التدريب" },
                aliases: [],
                evidenceIds: [evidence],
                scope: "course",
              },
            ],
            edges: [],
          },
        }),
      ],
    );
  const read = () =>
    readKnowledgeGraph(
      nn,
      new URLSearchParams({
        kind: "lecture",
        id: upload.sourceKey,
        courseId: nn.courseId,
      }),
    );
  // The published sibling concept already exists, with no study-plan dependency.
  await publish("ML", ["Loss Function"]);
  expect(await read()).toMatchObject({ requirements: [] });
  const proposal = await extractPrerequisites(
    nn,
    {
      modelId: "cross-course-fixture",
      async generate({ payload }) {
        expect(payload).not.toHaveProperty("evidence");
        expect(payload).toMatchObject({
          candidates: expect.arrayContaining([
            expect.objectContaining({
              key: "Loss Function",
              taughtInCourse: "ML",
            }),
          ]),
        });
        return {
          tokens: 10,
          value: {
            foundations: [],
            edges: [
              {
                from: "Loss Function",
                to: "Training",
                type: "prerequisite",
                evidenceIds: [evidence],
                reason: {
                  en: "Training uses a loss function",
                  ar: "التدريب يعتمد على دالة الخسارة",
                },
              },
            ],
          },
        };
      },
    },
    {
      lectureSourceKey: upload.sourceKey,
      lectureOnlyAllowed: true,
      recheckPublished: true,
    },
  );
  expect(await read()).toMatchObject({ requirements: [] });
  await reviewPrerequisiteEdges(nn, {
    id: proposal.id,
    accept: [{ from: "Loss Function", to: "Training" }],
  });
  await publishKnowledge(nn);
  expect(await read()).toMatchObject({
    requirements: [
      {
        concept: { id: "Loss Function" },
        target: { id: "Training" },
        course: { id: courses.ML },
        evidence: { id: upload.id, page: 1 },
      },
    ],
  });
});
