import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import { type ModelGateway } from "../src/server/ai";
import {
  approvePendingUmbrella,
  importExtractedPages,
} from "../src/server/sources";
import { extractPrerequisites } from "../src/server/prerequisites";

const tenant = randomUUID();
const instructor: AuthContext = {
  tenantId: tenant,
  userId: randomUUID(),
  role: "instructor",
  courseId: "CET351",
  locale: "en",
};
const filler = (topic: string) =>
  `${topic} is discussed here in general terms about a network and its learning behaviour. `.repeat(
    12,
  );
// A textbook in miniature: contents and index name every term; one chapter page explains it.
const book = [
  {
    page: 1,
    text: "viii Contents Chapter 4 Multilayer Perceptrons 122 4.4 The Back-Propagation Algorithm 129 4.5 Activation Function 135 Chapter 9 Self-Organizing Maps 425",
  },
  { page: 2, text: "xvi Preface " + filler("The back-propagation algorithm") },
  { page: 40, text: filler("A self-organizing map") },
  {
    page: 153,
    text:
      filler("The multilayer perceptron") +
      "The back-propagation algorithm computes the gradient of the error. Back-propagation applies the chain rule, so back-propagation needs the gradient first. In back-propagation the learning-rate parameter scales each weight change. ",
  },
  { page: 600, text: filler("Information-theoretic learning") },
  {
    page: 927,
    text: "896 Index back-propagation, 129, 153, 170 activation function, 135, 166 Kalman gain, 823 computation of, 739, 764 learning rate, 147, 188, 192 gradient, 150, 247",
  },
];
let supplied: { page: number; text: string }[] = [];
/** Deterministic replay: NOT Gemini. Records which reference pages it is given. */
const model: ModelGateway = {
  modelId: "deterministic-retrieval-replay-NOT-GEMINI",
  async generate(request) {
    const payload = request.payload as any;
    if (payload.evidence)
      return {
        tokens: 10,
        value: {
          concepts: [
            {
              key: "bp",
              label: { ar: "الانتشار العكسي", en: "Backpropagation" },
              aliases: [],
              evidenceIds: [payload.evidence[0].id],
            },
          ],
        },
      };
    supplied = payload.umbrellaEvidence;
    return { tokens: 10, value: { foundations: [], edges: [] } };
  },
};
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
    tenant,
    "Synthetic retrieval tenant",
  ]);
  await db.tenant(tenant).transaction(async (tx) => {
    await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
      tenant,
      instructor.userId,
      '{"ar":"اختبار","en":"Test"}',
    ]);
    await tx.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'instructor')",
      [tenant, instructor.userId],
    );
    await tx.query(
      "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,'CET351','instructor',true,true)",
      [tenant, instructor.userId],
    );
  });
});
afterAll(() => db.close());

describe("choosing reference pages for a lecture concept", () => {
  it("sends the page that explains the concept, not the contents, preface or index", async () => {
    const lecture = await importExtractedPages(instructor, {
      mode: "lecture",
      title: "Lecture 2",
      pages: [
        {
          page: 1,
          text: "Backpropagation updates the weights of a neural network from the output error, layer by layer.",
        },
      ],
    });
    await approvePendingUmbrella(instructor, lecture.id);
    const reference = await importExtractedPages(instructor, {
      mode: "umbrella",
      title: "Neural networks textbook",
      rightsConfirmed: true,
      rightsReference: "Course textbook",
      pages: book,
    });
    await approvePendingUmbrella(instructor, reference.id);
    await extractPrerequisites(instructor, model, {
      lectureSourceKey: lecture.sourceKey,
    });
    const pages = supplied.map((e) => e.page);
    // Written with a hyphen in the book and as one word in the lecture.
    expect(pages[0]).toBe(153);
    expect(pages).not.toContain(1);
    expect(pages).not.toContain(2);
    expect(pages).not.toContain(927);
    expect(supplied[0].text).toMatch(/needs the gradient first/);
  });
});
