import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import type { AuthContext } from "../src/server/auth";
import {
  stageComprehensiveGraph,
  reviewProposal,
  publishKnowledge,
  proposeKnowledge,
  stableConceptId,
} from "../src/server/knowledge";
import {
  getPublishedConceptMap,
  lecturePages,
  type ComprehensiveInput,
} from "../src/server/coverage";
import { retrieveEvidence, type ModelGateway } from "../src/server/ai";

const tenant = randomUUID(),
  other = randomUUID();
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
const advisor: AuthContext = {
  ...instructor,
  userId: randomUUID(),
  role: "advisor",
};
const bi = (v: string) => ({ ar: `اختبار ${v}`, en: v });
function input(): ComprehensiveInput {
  const concepts = [...lecturePages].map(([sourceKey], i) => ({
    key: `node-${i}`,
    label:
      i === 0
        ? { ar: "الاحتمال الشرطي", en: "Conditional Probability" }
        : bi(`Concept ${i}`),
    aliases: [],
    summary: bi(`Synthetic explanation ${i}`),
    scope: "course" as const,
    coverageLevel: "explained" as const,
    evidenceIds: [`${sourceKey}-p1`, `umbrella-U${i + 1}`],
    referenceLinks: [],
  }));
  return {
    title: bi("Complete fixture graph"),
    reviewBasis: bi(
      "Synthetic integration fixture; no actual academic approval",
    ),
    concepts,
    edges: [
      {
        from: "node-0",
        to: "node-1",
        type: "related",
        evidenceIds: ["CET351-L1-p1", "umbrella-U1"],
        reason: bi("Synthetic reviewed relationship"),
      },
    ],
    pages: [...lecturePages].flatMap(([sourceKey, count], i) =>
      Array.from({ length: count }, (_, j) => ({
        sourceKey:
          sourceKey as ComprehensiveInput["pages"][number]["sourceKey"],
        page: j + 1,
        classification:
          j === 0
            ? ("teaching" as const)
            : sourceKey === "CET351-L4" && j === 15
              ? ("quarantined" as const)
              : ("administrative" as const),
        conceptKeys: j === 0 ? [`node-${i}`] : [],
        note: bi(
          j === 0
            ? "Synthetic teaching page"
            : j === 15 && sourceKey === "CET351-L4"
              ? "Contradiction held out"
              : "Synthetic administrative fixture",
        ),
      })),
    ),
    generatedProposalIds: [],
  };
}
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  for (const id of [tenant, other])
    await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
      id,
      "Synthetic comprehensive map tests",
    ]);
  await db.tenant(tenant).transaction(async (tx) => {
    for (const c of [instructor, student, advisor]) {
      await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
        tenant,
        c.userId,
        JSON.stringify(bi("Synthetic user")),
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenant, c.userId, c.role],
      );
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,$3,$4,$5,$5)",
        [tenant, c.userId, "CET351", c.role, c.role === "instructor"],
      );
    }
    for (const [sourceKey, count] of [
      ...lecturePages,
      ["TILWA-PILOT-FOUNDATIONS", 6] as const,
    ]) {
      const umbrella = sourceKey === "TILWA-PILOT-FOUNDATIONS";
      await tx.query(
        "INSERT INTO material_versions(tenant_id,id,course_id,source_key,title,role,hash,rights,metadata,status,current_version,page_count) VALUES($1,$2,'CET351',$3,$4,$5,$6,$7,'{}','published',true,$8)",
        [
          tenant,
          `version-${sourceKey}`,
          sourceKey,
          sourceKey,
          umbrella ? "umbrella" : "instructor",
          `hash-${sourceKey}`,
          JSON.stringify({ displayExcerpt: true, sendToModel: true }),
          umbrella ? null : count,
        ],
      );
      for (let p = 1; p <= count; p++)
        await tx.query(
          "INSERT INTO evidence_chunks(tenant_id,id,version_id,course_id,page,section,text_content,status) VALUES($1,$2,$3,'CET351',$4,$5,$6,$7)",
          [
            tenant,
            umbrella ? `umbrella-U${p}` : `${sourceKey}-p${p}`,
            `version-${sourceKey}`,
            umbrella ? null : p,
            umbrella ? `U${p}` : null,
            `Synthetic course source ${sourceKey} page ${p}. probability classification concept. This is not original lecture evidence.`,
            sourceKey === "CET351-L4" && p === 16 ? "quarantined" : "approved",
          ],
        );
    }
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,'historical-attempt','attempt','CET351',$2,$3)",
      [
        tenant,
        student.userId,
        JSON.stringify({
          graphVersion: "historic-original",
          score: 1,
          conceptId: "historic-combined",
        }),
      ],
    );
  });
}, 60000);
afterAll(() => db.close());

describe("comprehensive course-to-umbrella map against actual local SQL, no provider", () => {
  it("keeps a relevant permitted umbrella foundation when many lectures match, within four passages", async () => {
    const evidence = await retrieveEvidence(
      student,
      "Explain classification probability",
    );
    expect(evidence.length).toBeLessThanOrEqual(4);
    expect(evidence.some((e) => e.role === "instructor")).toBe(true);
    expect(evidence.some((e) => e.role === "umbrella")).toBe(true);
    expect(evidence.every((e) => e.status === "approved")).toBe(true);
    expect(await retrieveEvidence(student, "seismology astronomy")).toEqual([]);
  });
  it("rejects students and advisors before staging any shared curriculum", async () => {
    await expect(
      stageComprehensiveGraph(student, input()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      stageComprehensiveGraph(advisor, input()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("requires real approved umbrella evidence; a GFG link alone cannot satisfy it", async () => {
    const x = input();
    x.concepts[0].evidenceIds = ["CET351-L1-p1"];
    x.concepts[0].referenceLinks = [
      {
        sourceKey: "GFG-UMBRELLA",
        title: bi("Reference link"),
        url: "https://www.geeksforgeeks.org/machine-learning/",
        mode: "reference_link",
      },
    ];
    await expect(stageComprehensiveGraph(instructor, x)).rejects.toMatchObject({
      code: "umbrella_link_required",
    });
    const y = input();
    y.concepts[0].evidenceIds = ["umbrella-U1"];
    await expect(stageComprehensiveGraph(instructor, y)).rejects.toMatchObject({
      code: "lecture_link_required",
    });
  });
  it("rejects missing pages, false quarantined claims and dangling page concepts", async () => {
    const missing = input();
    missing.pages[1] = { ...missing.pages[0] };
    await expect(
      stageComprehensiveGraph(instructor, missing),
    ).rejects.toMatchObject({ code: "invalid_page_coverage" });
    const quarantined = input();
    quarantined.concepts[0].evidenceIds.push("CET351-L4-p16");
    await expect(
      stageComprehensiveGraph(instructor, quarantined),
    ).rejects.toMatchObject({ code: "unreviewed_evidence" });
    const dangling = input();
    dangling.pages[0].conceptKeys = ["missing-concept"];
    await expect(
      stageComprehensiveGraph(instructor, dangling),
    ).rejects.toMatchObject({ code: "invalid_page_coverage" });
    const edgeClaim = input();
    edgeClaim.edges[0].evidenceIds.push("CET351-L4-p2");
    edgeClaim.pages.find(
      (p) => p.sourceKey === "CET351-L4" && p.page === 2,
    )!.classification = "quarantined";
    await expect(
      stageComprehensiveGraph(instructor, edgeClaim),
    ).rejects.toMatchObject({ code: "invalid_page_coverage" });
  });
  it("rejects duplicate bilingual identities and hard-prerequisite cycles", async () => {
    const duplicate = input();
    duplicate.concepts[1].label = duplicate.concepts[0].label;
    await expect(
      stageComprehensiveGraph(instructor, duplicate),
    ).rejects.toMatchObject({ code: "duplicate_concept" });
    const cycle = input();
    cycle.edges = [
      { ...cycle.edges[0], type: "prerequisite" },
      { ...cycle.edges[0], from: "node-1", to: "node-0", type: "prerequisite" },
    ];
    await expect(
      stageComprehensiveGraph(instructor, cycle),
    ).rejects.toMatchObject({ code: "cycle" });
  });
  it("fails closed for foreign, unapproved, expired-rights and stale-version evidence", async () => {
    const foreign = input();
    foreign.concepts[0].evidenceIds.push("foreign-tenant-chunk");
    await expect(
      stageComprehensiveGraph(instructor, foreign),
    ).rejects.toMatchObject({ code: "unreviewed_evidence" });
    for (const mode of ["pending", "rights", "stale"]) {
      if (mode === "pending")
        await db
          .tenant(tenant)
          .query(
            "UPDATE evidence_chunks SET status='pending' WHERE tenant_id=$1 AND id='umbrella-U1'",
            [tenant],
          );
      else
        await db
          .tenant(tenant)
          .query(
            mode === "rights"
              ? "UPDATE material_versions SET rights='{}' WHERE tenant_id=$1 AND id='version-TILWA-PILOT-FOUNDATIONS'"
              : "UPDATE material_versions SET current_version=false WHERE tenant_id=$1 AND id='version-TILWA-PILOT-FOUNDATIONS'",
            [tenant],
          );
      await expect(
        stageComprehensiveGraph(instructor, input()),
      ).rejects.toMatchObject({ code: "unreviewed_evidence" });
      await db
        .tenant(tenant)
        .query(
          "UPDATE evidence_chunks SET status='approved' WHERE tenant_id=$1 AND id='umbrella-U1'",
          [tenant],
        );
      await db
        .tenant(tenant)
        .query(
          "UPDATE material_versions SET current_version=true,rights=$2 WHERE tenant_id=$1 AND id='version-TILWA-PILOT-FOUNDATIONS'",
          [tenant, JSON.stringify({ displayExcerpt: true, sendToModel: true })],
        );
    }
  });
  it("stages idempotently, requires review, then publishes full safe provenance and all 137 pages", async () => {
    const first = await stageComprehensiveGraph(instructor, input());
    expect(first.status).toBe("pending");
    expect((await stageComprehensiveGraph(instructor, input())).id).toBe(
      first.id,
    );
    expect((await getPublishedConceptMap(student)).status).toBe("empty");
    await reviewProposal(instructor, first.id, "approved");
    await publishKnowledge(instructor);
    const map = await getPublishedConceptMap(student);
    expect(map.totals).toMatchObject({
      concepts: 6,
      linkedConcepts: 6,
      pages: 137,
      reviewedPages: 137,
      teachingPages: 6,
      mappedTeachingPages: 6,
    });
    expect(map.coverage).toHaveLength(6);
    expect(map.coverage.every((l) => l.status === "complete")).toBe(true);
    expect(map.concepts[0].id).toBe(stableConceptId("Conditional Probability"));
    expect(
      map.concepts.every(
        (c) => c.lectureEvidence.length && c.umbrellaEvidence.length,
      ),
    ).toBe(true);
    expect(JSON.stringify(map)).not.toContain("text_content");
    expect(JSON.stringify(map)).not.toContain("Synthetic course source");
    expect(
      map.pages.find((p) => p.sourceKey === "CET351-L4" && p.page === 16)
        ?.classification,
    ).toBe("quarantined");
    const before = (
      await db
        .tenant(tenant)
        .query<{ data: unknown }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND id='historical-attempt'",
          [tenant],
        )
    ).rows[0].data;
    expect(before).toEqual({
      graphVersion: "historic-original",
      score: 1,
      conceptId: "historic-combined",
    });
  });
  it("retains IDs and immutable releases on replacement, with no top-30 ceiling or history rewriting", async () => {
    const before = await getPublishedConceptMap(student);
    const next = input();
    next.title = bi("Expanded reviewed version");
    next.concepts[0].label = {
      ar: "تفسير الاحتمال الشرطي",
      en: "Interpreting conditional probability",
    };
    next.concepts[0].aliases = ["Conditional Probability", "الاحتمال الشرطي"];
    for (let n = 6; n < 48; n++) {
      const concept = {
        ...next.concepts[n % 6],
        key: `node-${n}`,
        label: bi(`Additional ${n}`),
        aliases: [],
        summary: bi(`Named topic ${n}`),
        coverageLevel: "named_only" as const,
      };
      next.concepts.push(concept);
      next.pages
        .find((p) => p.sourceKey === `CET351-L${(n % 6) + 1}` && p.page === 1)!
        .conceptKeys.push(concept.key);
    }
    const staged = await stageComprehensiveGraph(instructor, next);
    await reviewProposal(instructor, staged.id, "approved");
    await publishKnowledge(instructor);
    const after = await getPublishedConceptMap(student);
    expect(after.concepts).toHaveLength(48);
    expect(after.concepts[0].id).toBe(before.concepts[0].id);
    expect(after.concepts[0].aliases).toContain("Conditional Probability");
    const previous = (
      await db
        .tenant(tenant)
        .query<{ data: { graph: { concepts: unknown[] } } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND id=$2",
          [tenant, before.releaseId],
        )
    ).rows[0];
    expect(previous.data.graph.concepts).toHaveLength(6);
    const attempt = (
      await db
        .tenant(tenant)
        .query<{ data: { graphVersion: string } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND id='historical-attempt'",
          [tenant],
        )
    ).rows[0];
    expect(attempt.data.graphVersion).toBe("historic-original");
  });
  it("rechecks approval at publication and withdraws stale source locators without exposing text", async () => {
    const x = input();
    x.title = bi("Revocation candidate");
    const staged = await stageComprehensiveGraph(instructor, x);
    await reviewProposal(instructor, staged.id, "approved");
    await db
      .tenant(tenant)
      .query(
        "UPDATE evidence_chunks SET status='pending' WHERE tenant_id=$1 AND id='umbrella-U1'",
        [tenant],
      );
    await expect(publishKnowledge(instructor)).rejects.toMatchObject({
      code: "unreviewed_evidence",
    });
    const map = await getPublishedConceptMap(student);
    expect(
      map.concepts.find(
        (c) => c.id === stableConceptId("Conditional Probability"),
      )?.status,
    ).toBe("stale");
    expect(
      map.concepts.find(
        (c) => c.id === stableConceptId("Conditional Probability"),
      )?.umbrellaEvidence,
    ).toEqual([]);
    await db
      .tenant(tenant)
      .query(
        "UPDATE evidence_chunks SET status='approved' WHERE tenant_id=$1 AND id='umbrella-U1'",
        [tenant],
      );
    await reviewProposal(instructor, staged.id, "rejected");
  });
  it("bounds a scoped model proposal to the requested reviewed lecture and umbrella, with DB-first trace", async () => {
    let calls = 0;
    let seen: unknown;
    const gateway: ModelGateway = {
      modelId: "deterministic-scoped-graph-test",
      async generate(r) {
        calls++;
        seen = r.payload;
        return {
          tokens: 1,
          value: {
            concepts: [
              {
                key: "x",
                label: bi("Scoped concept"),
                aliases: [],
                evidenceIds: ["CET351-L6-p1", "umbrella-U6"],
              },
            ],
            edges: [],
          },
        };
      },
    };
    const result = await proposeKnowledge(instructor, gateway, {
      lectureSourceKey: "CET351-L6",
      query: "probability classification",
      pages: [1],
      umbrellaSections: ["U6"],
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("pending");
    expect(JSON.stringify(seen)).toContain("CET351-L6-p1");
    expect(JSON.stringify(seen)).toContain("umbrella-U6");
    expect(JSON.stringify(seen)).not.toContain("CET351-L1");
    expect(JSON.stringify(seen)).not.toContain("umbrella-U1");
    await db
      .tenant(tenant)
      .query(
        "UPDATE evidence_chunks SET status='pending' WHERE tenant_id=$1 AND id='CET351-L6-p1'",
        [tenant],
      );
    await expect(
      proposeKnowledge(instructor, gateway, {
        lectureSourceKey: "CET351-L6",
        query: "probability",
        pages: [1],
        umbrellaSections: ["U6"],
      }),
    ).rejects.toMatchObject({ code: "insufficient_evidence" });
    expect(calls).toBe(1);
    await db
      .tenant(tenant)
      .query(
        "UPDATE evidence_chunks SET status='approved' WHERE tenant_id=$1 AND id='CET351-L6-p1'",
        [tenant],
      );
  });
});
