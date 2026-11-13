import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import {
  approvePendingUmbrella,
  getMaterial,
  importLecture,
  importUmbrella,
  listMaterials,
  reviewPage,
  splitUmbrellaText,
} from "../src/server/sources";
import { type ModelGateway } from "../src/server/ai";
import { publishKnowledge, stableConceptId } from "../src/server/knowledge";
import {
  batchPages,
  extractPrerequisites,
  reviewPrerequisiteEdges,
} from "../src/server/prerequisites";
import { publishedPrerequisiteSupport } from "../src/server/learning";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

const tenant = randomUUID();
const instructor: AuthContext = {
  tenantId: tenant,
  userId: randomUUID(),
  role: "instructor",
  courseId: "CET351",
  locale: "ar",
};
const student: AuthContext = {
  ...instructor,
  userId: randomUUID(),
  role: "student",
};
const umbrellaText = `# Probability basics
Conditional probability describes an event within a reference group. It is required before Bayes theorem.

# Bayes theorem
Bayes theorem is computed from conditional probability and a prior. Naive Bayes applies Bayes theorem with an independence assumption, so a learner needs Bayes theorem first.

# Python
Python is a programming language often used for examples.`;
let umbrellaVersion = "";
let calls: string[] = [];
/** Deterministic replay: NOT Gemini. Answers from the payload shape only. */
const model: ModelGateway = {
  modelId: "deterministic-extraction-replay-NOT-GEMINI",
  async generate(request) {
    const payload = request.payload as any;
    if (payload.evidence) {
      calls.push("concepts");
      const id = payload.evidence[0].id;
      return {
        tokens: 120,
        value: {
          concepts: [
            {
              key: "nb",
              label: { ar: "بايز الساذج", en: "Naive Bayes" },
              aliases: ["naive bayes classifier"],
              evidenceIds: [id],
            },
            {
              key: "ghost",
              label: { ar: "شبح", en: "Ghost" },
              aliases: [],
              evidenceIds: ["not-supplied"],
            },
          ],
        },
      };
    }
    calls.push("links");
    const nb = payload.lectureConcepts[0].key;
    const bayes = payload.umbrellaEvidence.find((e: any) =>
      e.text.includes("Bayes theorem is computed"),
    ).id;
    return {
      tokens: 200,
      value: {
        foundations: [
          {
            key: "bt",
            label: { ar: "نظرية بايز", en: "Bayes theorem" },
            aliases: [],
            evidenceIds: [bayes],
          },
          {
            key: "cp",
            label: { ar: "الاحتمال الشرطي", en: "Conditional probability" },
            aliases: [],
            evidenceIds: [bayes],
          },
        ],
        edges: [
          {
            from: "bt",
            to: nb,
            type: "prerequisite",
            evidenceIds: [bayes],
            reason: { ar: "يطبّق نظرية بايز", en: "Applies Bayes theorem" },
          },
          {
            from: "cp",
            to: nb,
            type: "optional_bridge",
            evidenceIds: [bayes],
            reason: { ar: "خلفية مفيدة", en: "Helpful background" },
          },
          // Each of the following must be rejected by the application.
          {
            from: nb,
            to: nb,
            type: "prerequisite",
            evidenceIds: [bayes],
            reason: { ar: "حلقة", en: "Self loop" },
          },
          {
            from: "bt",
            to: "cp",
            type: "prerequisite",
            evidenceIds: [bayes],
            reason: { ar: "خارج المحاضرة", en: "Dependent outside lecture" },
          },
          {
            from: "cp",
            to: nb,
            type: "prerequisite",
            evidenceIds: ["fabricated"],
            reason: { ar: "بلا دليل", en: "Fabricated citation" },
          },
          {
            from: "cp",
            to: nb,
            type: "prerequisite",
            evidenceIds: [payload.lectureConcepts[0].lectureEvidenceId],
            reason: { ar: "بلا مرجع", en: "No umbrella citation" },
          },
        ],
      },
    };
  },
};
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
    tenant,
    "Synthetic prerequisite tenant",
  ]);
  for (const ctx of [instructor, student])
    await db.tenant(tenant).transaction(async (tx) => {
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
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,$3,$4,$5,$5)",
        [tenant, ctx.userId, "CET351", ctx.role, ctx.role === "instructor"],
      );
    });
});
afterAll(() => db.close());

describe("instructor umbrella upload", () => {
  it("splits headings into locatable sections and packs plain paragraphs", () => {
    expect(splitUmbrellaText(umbrellaText)).toHaveLength(3);
    expect(splitUmbrellaText("one\n\ntwo\n\nthree")).toEqual([
      "one\n\ntwo\n\nthree",
    ]);
    expect(splitUmbrellaText("x".repeat(13000)).length).toBeGreaterThan(2);
  });
  it("needs an explicit permission statement and a supported file", async () => {
    const bytes = Buffer.from(umbrellaText);
    await expect(
      importUmbrella(instructor, {
        title: "Probability reference",
        filename: "ref.md",
        bytes,
        rightsConfirmed: false,
        rightsReference: "Department licence",
      }),
    ).rejects.toMatchObject({ code: "permission_required" });
    await expect(
      importUmbrella(instructor, {
        title: "Probability reference",
        filename: "ref.docx",
        bytes,
        rightsConfirmed: true,
        rightsReference: "Department licence",
      }),
    ).rejects.toMatchObject({ code: "unsupported_file" });
    await expect(
      importUmbrella(student, {
        title: "Probability reference",
        filename: "ref.md",
        bytes,
        rightsConfirmed: true,
        rightsReference: "Department licence",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("stores pending sections, deduplicates and lists the reference for review", async () => {
    const input = {
      title: "Probability reference",
      filename: "ref.md",
      bytes: Buffer.from(umbrellaText),
      rightsConfirmed: true,
      rightsReference: "Department licence",
    };
    const first = await importUmbrella(instructor, input);
    const again = await importUmbrella(instructor, input);
    expect(first.sourceKey).toMatch(/^UMBRELLA-[0-9A-F]{12}$/);
    expect(again).toMatchObject({ id: first.id, deduplicated: true });
    umbrellaVersion = first.id;
    const listed = (await listMaterials(instructor)).umbrellas;
    expect(listed).toHaveLength(1);
    expect(listed[0].sections).toEqual({ pending: 3 });
    expect((await listMaterials(student)).umbrellas).toEqual([]);
  });
  it("cannot extract prerequisites from unreviewed sources", async () => {
    await expect(
      extractPrerequisites(instructor, model, {
        lectureSourceKey: "CET351-L5",
      }),
    ).rejects.toMatchObject({ code: "insufficient_evidence" });
    expect(calls).toEqual([]);
  });
});

describe("model-extracted prerequisites with instructor approval", () => {
  let proposalId = "";
  const naive = stableConceptId("Naive Bayes");
  const bayes = stableConceptId("Bayes theorem");
  const conditional = stableConceptId("Conditional probability");
  it("requires an approved umbrella before any provider call", async () => {
    const lecture = await importLecture(
      instructor,
      "Lec 5-ML.pdf",
      syntheticPdf(
        "Synthetic fixture: Naive Bayes classifies with class conditional frequencies",
      ),
      { allowNewVersion: true },
    );
    for (const c of (await getMaterial(instructor, lecture.id)).chunks)
      await reviewPage(instructor, c.id, "approved");
    await expect(
      extractPrerequisites(instructor, model, {
        lectureSourceKey: "CET351-L5",
      }),
    ).rejects.toMatchObject({ code: "umbrella_required" });
    expect(calls).toEqual([]);
    expect(
      await approvePendingUmbrella(instructor, umbrellaVersion),
    ).toMatchObject({ approved: 3 });
  });
  it("stores one pending proposal and rejects ungrounded or malformed relationships", async () => {
    const proposal = await extractPrerequisites(instructor, model, {
      lectureSourceKey: "CET351-L5",
    });
    proposalId = proposal.id;
    expect(calls).toEqual(["concepts", "links"]);
    expect(proposal.status).toBe("pending");
    expect(proposal.graph.concepts.map((c) => c.id).sort()).toEqual(
      [naive, bayes, conditional].sort(),
    );
    expect(proposal.graph.edges).toHaveLength(2);
    expect(proposal.graph.edges.every((e) => e.to === naive)).toBe(true);
    expect(proposal.dropped.map((d) => d.reason).sort()).toEqual(
      [
        "uncited_concept",
        "self_loop",
        "dependent_not_in_lecture",
        "no_umbrella_citation",
        "no_umbrella_citation",
      ].sort(),
    );
    expect(proposal.graph.concepts.find((c) => c.id === bayes)?.scope).toBe(
      "foundation",
    );
    const traces = (
      await db
        .tenant(tenant)
        .query<{
          operation: string;
          outcome: string;
          retrieved_at: Date;
          generated_at: Date;
        }>(
          "SELECT operation,outcome,retrieved_at,generated_at FROM model_traces WHERE tenant_id=$1 ORDER BY created_at",
          [tenant],
        )
    ).rows;
    expect(traces.map((t) => t.operation)).toEqual([
      "extract-concepts",
      "extract-prerequisites",
    ]);
    for (const t of traces) {
      expect(t.outcome).toBe("pending_review");
      expect(new Date(t.retrieved_at).getTime()).toBeLessThanOrEqual(
        new Date(t.generated_at).getTime(),
      );
    }
  });
  it("does not route learners before review and publication", async () => {
    await expect(publishKnowledge(instructor)).resolves.toMatchObject({
      publishedProposals: 0,
    });
    const release = (
      await db
        .tenant(tenant)
        .query<{ data: { graph: { edges: unknown[] } } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND kind='graph_release' ORDER BY created_at DESC LIMIT 1",
          [tenant],
        )
    ).rows[0];
    expect(release.data.graph.edges).toHaveLength(0);
  });
  it("lets the instructor keep one relationship, drop another and publish", async () => {
    await expect(
      reviewPrerequisiteEdges(student, { id: proposalId, accept: [] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reviewPrerequisiteEdges(instructor, {
        id: proposalId,
        accept: [{ from: naive, to: bayes }],
      }),
    ).rejects.toMatchObject({ code: "invalid_review" });
    const reviewed = await reviewPrerequisiteEdges(instructor, {
      id: proposalId,
      accept: [{ from: bayes, to: naive }],
    });
    expect(reviewed.status).toBe("approved");
    expect(reviewed.graph!.edges).toHaveLength(1);
    // The dropped relationship's foundation leaves with it.
    expect(reviewed.graph!.concepts.map((c) => c.id).sort()).toEqual(
      [naive, bayes].sort(),
    );
    const release = await publishKnowledge(instructor);
    expect(release).toMatchObject({ concepts: 2, edges: 1 });
  });
  it("published prerequisite drives learner support for the dependent objective", async () => {
    await db
      .tenant(tenant)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,'objective:nb.apply','objective','CET351',NULL,$2)",
        [
          tenant,
          JSON.stringify({ objectiveId: "nb.apply", conceptId: "Naive Bayes" }),
        ],
      );
    const support = await publishedPrerequisiteSupport(
      db.tenant(tenant),
      student,
      student.userId,
      "nb.apply",
    );
    expect(support?.concepts.map((c: any) => c.conceptId)).toEqual([bayes]);
  });
  it("a later run reuses identities, skips published edges and refuses a cycle", async () => {
    calls = [];
    const cyclic: ModelGateway = {
      modelId: "deterministic-cycle-replay-NOT-GEMINI",
      async generate(request) {
        const payload = request.payload as any;
        if (payload.evidence)
          return {
            tokens: 10,
            value: {
              concepts: [
                {
                  key: "b",
                  label: { ar: "نظرية بايز", en: "Bayes Theorem" },
                  aliases: [],
                  evidenceIds: [payload.evidence[0].id],
                },
                {
                  key: "n",
                  label: { ar: "بايز الساذج", en: "naive bayes" },
                  aliases: [],
                  evidenceIds: [payload.evidence[0].id],
                },
              ],
            },
          };
        const u = payload.umbrellaEvidence[0].id;
        const reason = { ar: "سبب", en: "Reason" };
        return {
          tokens: 10,
          value: {
            foundations: [],
            edges: [
              {
                from: naive,
                to: bayes,
                type: "prerequisite",
                evidenceIds: [u],
                reason,
              },
              {
                from: bayes,
                to: naive,
                type: "prerequisite",
                evidenceIds: [u],
                reason,
              },
            ],
          },
        };
      },
    };
    const proposal = await extractPrerequisites(instructor, cyclic, {
      lectureSourceKey: "CET351-L5",
    });
    expect(proposal.graph.concepts.map((c) => c.id).sort()).toEqual(
      [naive, bayes].sort(),
    );
    expect(proposal.graph.edges).toHaveLength(0);
    expect(proposal.dropped.map((d) => d.reason).sort()).toEqual([
      "already_published",
      "cycle",
    ]);
  });
});

describe("lecture batching", () => {
  it("keeps every page of a long lecture within the call and context limits", () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      text_content: "x".repeat(4000),
    }));
    const batches = batchPages(pages, 10000, 4);
    expect(batches).toHaveLength(4);
    expect(batches.flat().map((p) => p.id)).toEqual(pages.map((p) => p.id));
    for (const b of batches)
      expect(
        b.reduce((n, p) => n + p.text_content.length, 0),
      ).toBeLessThanOrEqual(10000);
  });
});
