/** Integration replay: actual PostgreSQL engine and non-owner role; Gemini is injected. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { createWorkspace, type Workspace } from "../src/server/seed";
import type { AuthContext, Role } from "../src/server/auth";
import {
  registerPack,
  listMaterials,
  getMaterial,
  getMaterialFile,
  reviewPage,
  sourceManifest,
} from "../src/server/sources";
import { publishKnowledge, getKnowledge } from "../src/server/knowledge";
import { workspace, learningAction } from "../src/server/learning";
import { tutor, tutorInput, type ModelGateway } from "../src/server/ai";
import { getOfficialGrades } from "../src/server/sis";
let first: Workspace, second: Workspace, sourceId: string;
const context = (w: Workspace, role: Role): AuthContext => ({
  tenantId: w.tenantId,
  userId: w.users[role],
  role,
  courseId: "CET351",
  locale: "en",
});
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  process.env.DEMO_MODE = "true";
  process.env.SESSION_SECRET =
    "test-only-runtime-session-secret-longer-than-32-chars";
  await migrateDatabase();
  await db.query("SET ROLE tilwa_runtime");
  first = await createWorkspace();
  second = await createWorkspace();
  await registerPack(context(first, "instructor"));
  sourceId = (await listMaterials(context(first, "instructor"))).materials
    .find((m) => m.sourceKey === "TILWA-PILOT-FOUNDATIONS")!
    .versions.find((v) => v.current_version)!.id;
}, 30000);
afterAll(() => db.close());
describe("complete module boundary under a non-owner runtime database role", () => {
  it("uses tilwa_runtime, not table owner or superuser", async () => {
    expect(
      (await db.query<{ current_user: string }>("SELECT current_user")).rows[0]
        .current_user,
    ).toBe("tilwa_runtime");
  });
  it("permits instructor source approval and publication while blocking student review", async () => {
    await expect(
      getMaterial(context(first, "student"), sourceId),
    ).rejects.toMatchObject({ status: 404 });
    const chunks = (await getMaterial(context(first, "instructor"), sourceId))
      .chunks;
    await expect(
      reviewPage(context(first, "student"), chunks[0].id, "approved"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const c of chunks)
      await reviewPage(context(first, "instructor"), c.id, "approved");
    await publishKnowledge(context(first, "instructor"));
    const published = (await getMaterial(context(first, "student"), sourceId))
      .chunks;
    const expected = sourceManifest.find(
      (s) => s.source_key === "TILWA-PILOT-FOUNDATIONS",
    )!.section_ids!;
    expect(published.map((c) => c.section).sort()).toEqual(
      [...expected].sort(),
    );
    await expect(
      getMaterialFile(context(first, "student"), sourceId),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("hides other tenant material, evidence, learning and integration rows even without SQL filters", async () => {
    await db.tenant(second.tenantId).transaction(async (tx) => {
      expect(
        (await tx.query("SELECT id FROM material_versions")).rows,
      ).toHaveLength(0);
      expect(
        (await tx.query("SELECT id FROM evidence_chunks")).rows,
      ).toHaveLength(0);
      const learners = (
        await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM records")
      ).rows;
      expect(learners.length).toBeGreaterThan(0);
      expect(learners.every((r) => r.tenant_id === second.tenantId)).toBe(true);
      const students = (
        await tx.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM demo_sis.external_students",
        )
      ).rows;
      expect(students.every((r) => r.tenant_id === second.tenantId)).toBe(true);
    });
    await expect(
      getMaterial(context(second, "instructor"), sourceId),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("produces DB-first grounded tutoring through an explicitly injected model", async () => {
    let calls = 0;
    const model: ModelGateway = {
      modelId: "deterministic-runtime-security-replay",
      async generate(req) {
        calls++;
        const evidence = (
          req.payload as { authorizedEvidence: { id: string }[] }
        ).authorizedEvidence;
        return {
          tokens: 20,
          value: {
            disposition: "answered",
            answer: "Recall = 5 / (5 + 5) = 50%, in the original supplement.",
            evidenceIds: [evidence[0].id],
            calculations: [{ numerator: 5, denominator: 10, percent: 50 }],
          },
        };
      },
    };
    const result = await tutor(
      context(first, "student"),
      tutorInput.parse({ question: "Explain Recall", language: "en" }),
      model,
    );
    expect(calls).toBe(1);
    expect(result.disposition).toBe("answered");
    expect(result.citations.length).toBeGreaterThan(0);
    const traces = (
      await db
        .tenant(first.tenantId)
        .query<{ retrieved_at: Date; generated_at: Date }>(
          "SELECT retrieved_at,generated_at FROM model_traces",
        )
    ).rows;
    expect(traces).toHaveLength(1);
    expect(new Date(traces[0].retrieved_at).getTime()).toBeLessThanOrEqual(
      new Date(traces[0].generated_at).getTime(),
    );
  });
  it("persists one learning event under retry and exposes it only to assigned staff", async () => {
    const student = context(first, "student");
    const selected = await learningAction(student, {
      action: "select-practice",
      objectiveId: "recall.calculate",
    });
    const input = {
      action: "attempt",
      deliveryId: selected.deliveryId,
      answer: "a",
      idempotencyKey: "runtime-idempotent-01",
    };
    const firstAttempt = await learningAction(student, input);
    const retry = await learningAction(student, input);
    expect(retry.attempt.id).toBe(firstAttempt.attempt.id);
    const events = (
      await db
        .tenant(first.tenantId)
        .query(
          "SELECT id FROM records WHERE kind='event' AND data->>'type'='answer'",
        )
    ).rows;
    expect(events).toHaveLength(1);
    expect(
      (await workspace(context(first, "advisor"))).states.length,
    ).toBeGreaterThan(0);
    expect((await workspace(context(second, "advisor"))).states).toHaveLength(
      0,
    );
    await db
      .tenant(first.tenantId)
      .query("UPDATE advisor_assignments SET active=false WHERE tenant_id=$1", [
        first.tenantId,
      ]);
    expect((await workspace(context(first, "advisor"))).states).toHaveLength(0);
  });
  it("never exposes protected item key or unapproved graph drafts to the student", async () => {
    await db
      .tenant(first.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,data) VALUES($1,$2,$3,$4,$5)",
        [
          first.tenantId,
          "protected-security-item",
          "item",
          "CET351",
          JSON.stringify({
            approved: true,
            protected: true,
            key: "PROTECTED_SECRET_KEY",
            stem: { en: "Private exam prompt", ar: "سؤال امتحان محمي" },
          }),
        ],
      );
    await db
      .tenant(first.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,data) VALUES($1,$2,$3,$4,$5)",
        [
          first.tenantId,
          "pending-security-graph",
          "knowledge_proposal",
          "CET351",
          JSON.stringify({
            status: "pending",
            evidenceIds: [],
            graph: { concepts: [], edges: [] },
          }),
        ],
      );
    expect(
      JSON.stringify(await workspace(context(first, "student"))),
    ).not.toContain("PROTECTED_SECRET_KEY");
    expect(
      (await getKnowledge(context(first, "student"))).proposals,
    ).toHaveLength(0);
    await learningAction(context(first, "instructor"), {
      action: "start-exam",
      studentId: first.users.student,
    });
    expect((await workspace(context(first, "student"))).items).toHaveLength(0);
    await expect(
      learningAction(context(first, "student"), { action: "select-practice" }),
    ).rejects.toMatchObject({ code: "EXAM_PROTECTED" });
    await learningAction(context(first, "instructor"), {
      action: "end-exam",
      studentId: first.users.student,
    });
  });
  it("reads isolated official grade projections without rewriting learning state", async () => {
    const a = await getOfficialGrades(first.tenantId, first.users.student);
    const wrong = await getOfficialGrades(second.tenantId, first.users.student);
    expect(a.length).toBe(2);
    expect(wrong).toHaveLength(0);
  });
});

import {
  conceptMappingAction,
  getConceptMappings,
} from "../src/server/concept-mapping";
let immutableBefore: string;
let baseGraphRelease = "security-baseline-graph";
let splitIds: string[] = [];
const reason = {
  ar: "مراجعة أكاديمية تجريبية لتقسيم الأهداف المستقلة",
  en: "Synthetic academic review of separate learning objectives",
};
describe("reviewed concept governance with historical evidence preservation", () => {
  beforeAll(async () => {
    const eid = (await getMaterial(context(first, "instructor"), sourceId))
      .chunks[0].id;
    const concepts = [
      ["concept-security-recall", "Recall", "الاستدعاء"],
      ["concept-security-precision", "Precision", "الإحكام"],
      ["concept-security-metrics", "Metrics", "المقاييس"],
    ].map(([id, en, ar]) => ({
      id,
      label: { ar, en },
      aliases: [ar, en],
      evidenceIds: [eid],
    }));
    const graph = {
      concepts,
      edges: [
        {
          from: concepts[0].id,
          to: concepts[2].id,
          type: "related",
          evidenceIds: [eid],
          reason,
        },
        {
          from: concepts[1].id,
          to: concepts[2].id,
          type: "related",
          evidenceIds: [eid],
          reason,
        },
      ],
    };
    await db
      .tenant(first.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,data) VALUES($1,$2,$3,$4,$5)",
        [
          first.tenantId,
          baseGraphRelease,
          "graph_release",
          "CET351",
          JSON.stringify({ graph, fixture: true }),
        ],
      );
    immutableBefore = JSON.stringify(
      (
        await db
          .tenant(first.tenantId)
          .query(
            "SELECT id,data FROM records WHERE kind IN ('event','attempt','state','recommendation') ORDER BY id",
          )
      ).rows,
    );
  });
  it("requires course reviewer authority and rejects phantom split evidence", async () => {
    await expect(
      getConceptMappings(context(first, "student")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      conceptMappingAction(context(first, "instructor"), {
        action: "propose",
        kind: "split",
        conceptId: "concept-security-recall",
        reason,
        successors: [
          { label: { ar: "هدف أ", en: "A" }, evidenceIds: ["phantom"] },
          { label: { ar: "هدف ب", en: "B" }, evidenceIds: ["phantom"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "STALE_EVIDENCE" });
  });
  it("renames only after review and preserves the stable identity and former release", async () => {
    const teacher = context(first, "instructor");
    const proposal = await conceptMappingAction(teacher, {
      action: "propose",
      kind: "rename",
      conceptId: "concept-security-recall",
      label: { ar: "حساسية النموذج", en: "Model sensitivity" },
      reason,
    });
    expect(
      (await getConceptMappings(teacher)).graph.concepts.find(
        (c) => c.id === "concept-security-recall",
      )!.label.en,
    ).toBe("Recall");
    await conceptMappingAction(teacher, { action: "approve", id: proposal.id });
    const renamed = (await getConceptMappings(teacher)).graph.concepts.find(
      (c) => c.id === "concept-security-recall",
    )!;
    expect(renamed.label.en).toBe("Model sensitivity");
    expect(renamed.aliases).toContain("Recall");
    const old = (
      await db
        .tenant(first.tenantId)
        .query<{ data: { graph: { concepts: { label: { en: string } }[] } } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND id=$2",
          [first.tenantId, baseGraphRelease],
        )
    ).rows[0];
    expect(old.data.graph.concepts[0].label.en).toBe("Recall");
  });
  it("splits into unassessed successors without inheriting prerequisite edges or learner evidence", async () => {
    const teacher = context(first, "instructor");
    const original = (await getConceptMappings(teacher)).graph.concepts.find(
      (c) => c.id === "concept-security-recall",
    )!;
    const proposal = await conceptMappingAction(teacher, {
      action: "propose",
      kind: "split",
      conceptId: original.id,
      reason,
      successors: [
        {
          label: { ar: "حساب Recall", en: "Calculate recall" },
          evidenceIds: original.evidenceIds,
        },
        {
          label: { ar: "اختيار Recall", en: "Choose recall" },
          evidenceIds: original.evidenceIds,
        },
      ],
    });
    const result = await conceptMappingAction(teacher, {
      action: "approve",
      id: proposal.id,
    });
    splitIds = result.data.successorIds;
    expect(splitIds).toHaveLength(2);
    const mapping = await getConceptMappings(teacher);
    expect(mapping.graph.concepts.some((c) => c.id === original.id)).toBe(
      false,
    );
    expect(
      mapping.graph.edges.every(
        (e) => !splitIds.includes(e.from) && !splitIds.includes(e.to),
      ),
    ).toBe(true);
    const states = (
      await db.tenant(first.tenantId).query<{
        data: {
          status: string;
          evidenceInherited: boolean;
          evidenceIds: string[];
        };
      }>("SELECT data FROM records WHERE kind='concept_state'")
    ).rows;
    expect(states).toHaveLength(2);
    for (const s of states) {
      expect(s.data.status).toBe("unassessed");
      expect(s.data.evidenceInherited).toBe(false);
      expect(s.data.evidenceIds).toEqual([]);
    }
  });
  it("merges into a reviewed target without rewriting historical decisions and refuses a stale mapping", async () => {
    const teacher = context(first, "instructor");
    const stale = await conceptMappingAction(teacher, {
      action: "propose",
      kind: "rename",
      conceptId: "concept-security-precision",
      label: { ar: "الإحكام المعدل", en: "Revised precision" },
      reason,
    });
    const merge = await conceptMappingAction(teacher, {
      action: "propose",
      kind: "merge",
      conceptId: splitIds[0],
      targetId: "concept-security-precision",
      reason,
    });
    await conceptMappingAction(teacher, { action: "approve", id: merge.id });
    await expect(
      conceptMappingAction(teacher, { action: "approve", id: stale.id }),
    ).rejects.toMatchObject({ code: "STALE_GRAPH" });
    const after = JSON.stringify(
      (
        await db
          .tenant(first.tenantId)
          .query(
            "SELECT id,data FROM records WHERE kind IN ('event','attempt','state','recommendation') ORDER BY id",
          )
      ).rows,
    );
    expect(after).toBe(immutableBefore);
    const retired = (
      await db
        .tenant(first.tenantId)
        .query<{ data: { retired: boolean; successorIds: string[] } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND id=$2",
          [first.tenantId, splitIds[0]],
        )
    ).rows[0];
    expect(retired.data.retired).toBe(true);
    expect(retired.data.successorIds).toEqual(["concept-security-precision"]);
  });
  it("rejects duplicate concept aliases instead of creating ambiguous stable identities", async () => {
    await expect(
      conceptMappingAction(context(first, "instructor"), {
        action: "propose",
        kind: "rename",
        conceptId: "concept-security-precision",
        label: { ar: "المقاييس", en: "Metrics" },
        reason,
      }),
    ).rejects.toMatchObject({ code: "CONCEPT_ALIAS_CONFLICT" });
  });
  it("records rejected review without publishing another graph", async () => {
    const teacher = context(first, "instructor");
    const before = (await getConceptMappings(teacher)).releaseId;
    const proposal = await conceptMappingAction(teacher, {
      action: "propose",
      kind: "rename",
      conceptId: "concept-security-precision",
      label: { ar: "تسمية مرفوضة", en: "Rejected label" },
      reason,
    });
    await conceptMappingAction(teacher, { action: "reject", id: proposal.id });
    expect((await getConceptMappings(teacher)).releaseId).toBe(before);
    const audits = (
      await db
        .tenant(first.tenantId)
        .query(
          "SELECT action FROM audit_events WHERE action LIKE 'concept.mapping.%'",
        )
    ).rows;
    expect(audits.length).toBeGreaterThan(5);
  });
});
