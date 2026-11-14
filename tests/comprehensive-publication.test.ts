import { describe, expect, it } from "vitest";
import {
  buildStagePayload,
  compareHistory,
  reviewedReference,
  validateReviewedPlan,
  type SourcePlan,
  type CanonicalInventory,
  type Foundations,
} from "../scripts/publish-comprehensive-map";
import { lecturePages, type CurrentEvidence } from "../src/server/coverage";
import gfgIndex from "../pilot/umbrella/gfg-reference-index.json";

const bi = (en: string) => ({ ar: `اختبار ${en}`, en });
function fixture() {
  const keys = [
    ...lecturePages.keys(),
  ] as SourcePlan["sources"][number]["sourceKey"][];
  const plan: SourcePlan = {
    sources: keys.map((sourceKey) => ({
      sourceKey,
      pageCount: lecturePages.get(sourceKey)!,
      corrections: [
        {
          page: 1,
          text: "Synthetic reviewed corrected source text.",
          reviewNote: bi("Reviewed fixture"),
        },
      ],
      decisions: Array.from(
        { length: lecturePages.get(sourceKey)! },
        (_, i) => ({
          page: i + 1,
          status: i ? "rejected" : "approved",
          classification: i ? "administrative" : "teaching",
          note: bi("Explicit synthetic decision"),
        }),
      ),
    })),
  };
  const inventory: CanonicalInventory = {
    schemaVersion: 1,
    courseId: "CET351",
    concepts: keys.map((sourceKey, i) => ({
      key: `concept-${i}`,
      rawKeys: [`raw-${i}`],
      label: bi(`Concept ${i}`),
      aliases: [],
      summary: bi(`Synthetic concept ${i}`),
      scope: "course",
      coverageLevel: "explained",
      lectureLocators: [{ sourceKey, page: 1 }],
    })),
    relations: [
      {
        fromKey: "concept-0",
        toKey: "concept-1",
        type: "related",
        reason: bi("Reviewed synthetic relation"),
        pages: [{ sourceKey: keys[0], page: 1 }],
      },
    ],
    pages: plan.sources.flatMap((s, i) =>
      s.decisions.map((d) => ({
        sourceKey: s.sourceKey,
        page: d.page,
        conceptKeys: d.page === 1 ? [`concept-${i}`] : [],
      })),
    ),
  };
  const foundations: Foundations = {
    schemaVersion: 1,
    sourceKey: "TILWA-PILOT-FOUNDATIONS",
    version: "2.0",
    contentPath: "fixture",
    sha256: "0".repeat(64),
    sectionIds: ["U1"],
    conceptSections: Object.fromEntries(
      keys.map((_, i) => [`raw-${i}`, ["U1"]]),
    ),
    sections: [
      {
        id: "U1",
        title: bi("Fixture foundation"),
        review: {
          status: "approved",
          note: bi("Explicit fixture author review"),
        },
      },
    ],
  };
  const evidence: CurrentEvidence[] = [...keys, foundations.sourceKey].map(
    (source_key) => ({
      id: `${source_key}-chunk`,
      source_key,
      title: source_key,
      role: source_key === foundations.sourceKey ? "umbrella" : "instructor",
      version_id: `version-${source_key}`,
      page: source_key === foundations.sourceKey ? null : 1,
      section: source_key === foundations.sourceKey ? "U1" : null,
      status: "approved",
      current_version: true,
      rights: { displayExcerpt: true, sendToModel: true },
      material_status: "published",
      hash: "fixture",
    }),
  );
  return { plan, inventory, foundations, evidence };
}
describe("resumable comprehensive publication pure validation; no live providers", () => {
  it("resolves full ledger and real umbrella IDs while keeping reference metadata separate", () => {
    const f = fixture();
    const payload = buildStagePayload(
      f.plan,
      f.inventory,
      f.foundations,
      f.evidence,
      ["advisory-id"],
    );
    expect(
      validateReviewedPlan(f.plan, f.inventory, f.foundations).pages,
    ).toHaveLength(137);
    expect(payload.pages).toHaveLength(137);
    expect(payload.generatedProposalIds).toEqual(["advisory-id"]);
    for (const concept of payload.concepts) {
      expect(concept.evidenceIds).toContain("TILWA-PILOT-FOUNDATIONS-chunk");
      expect(concept.evidenceIds).not.toContain("GFG-UMBRELLA");
      expect(concept.referenceLinks).toHaveLength(1);
    }
  });
  it("excludes quarantined provenance and fails when it is a concept's only lecture evidence", () => {
    const f = fixture();
    const decision = f.plan.sources[3].decisions[15];
    decision.status = "quarantined";
    decision.classification = "quarantined";
    f.inventory.concepts[0].lectureLocators.push({
      sourceKey: "CET351-L4",
      page: 16,
    });
    expect(
      buildStagePayload(f.plan, f.inventory, f.foundations, f.evidence)
        .concepts[0].evidenceIds,
    ).toHaveLength(2);
    f.inventory.concepts[0].lectureLocators = [
      { sourceKey: "CET351-L4", page: 16 },
    ];
    expect(() =>
      buildStagePayload(f.plan, f.inventory, f.foundations, f.evidence),
    ).toThrow("No eligible lecture evidence");
  });
  it("fails closed for revoked evidence and missing actual umbrella mappings", () => {
    const f = fixture();
    f.evidence[0].rights.sendToModel = false;
    expect(() =>
      buildStagePayload(f.plan, f.inventory, f.foundations, f.evidence),
    ).toThrow("Approved current evidence is missing");
    f.evidence[0].rights.sendToModel = true;
    delete f.foundations.conceptSections["raw-0"];
    expect(() =>
      buildStagePayload(f.plan, f.inventory, f.foundations, f.evidence),
    ).toThrow("Missing umbrella mapping");
  });
  it("uses only reviewed GFG index URLs and labels an unmatched term as a general index", () => {
    const allowed = new Set([
      gfgIndex.sourceUrl,
      ...gfgIndex.topics.map((t) => t.href),
    ]);
    for (const key of [
      "recall",
      "naive-bayes",
      "python",
      "gradient-descent",
      "unknown-specialized-term",
    ])
      expect(allowed.has(reviewedReference(key, key).url)).toBe(true);
    expect(
      reviewedReference("unknown-specialized-term", "Unknown term").title.en,
    ).toMatch(/^General reference index/);
    expect(reviewedReference("recall", "Recall").title.en).toContain(
      "Evaluation Metrics",
    );
  });
  it("detects changed/deleted historical rows without mistaking new learner work for a rewrite", () => {
    const before = [
      { id: "attempt", kind: "attempt", hash: "old" },
      { id: "mastery", kind: "state", hash: "state" },
    ];
    expect(
      compareHistory(before, [
        ...before,
        { id: "new", kind: "attempt", hash: "new" },
      ]),
    ).toMatchObject({ unchangedExisting: true, addedCount: 1 });
    expect(
      compareHistory(before, [{ ...before[0], hash: "rewritten" }]),
    ).toMatchObject({
      unchangedExisting: false,
      changedCount: 1,
      missingCount: 1,
    });
  });
});
