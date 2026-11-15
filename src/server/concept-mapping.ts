import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Queryable } from "./db";
import {
  authorizeCourse,
  authorizeCourseInTransaction,
  type AuthContext,
} from "./auth";
import { AppError } from "./errors";
import { validateGraph, type Graph } from "./knowledge";
const COURSE = "CET351";
const bilingual = z.object({
  ar: z.string().trim().min(1).max(1500),
  en: z.string().trim().min(1).max(1500),
});
const proposal = z.object({
  action: z.literal("propose"),
  kind: z.enum(["rename", "merge", "split"]),
  conceptId: z.string().min(1).max(120),
  reason: bilingual,
  label: bilingual.optional(),
  targetId: z.string().min(1).max(120).optional(),
  successors: z
    .array(
      z.object({
        label: bilingual,
        evidenceIds: z.array(z.string().min(1)).min(1).max(8),
      }),
    )
    .min(2)
    .max(4)
    .optional(),
});
const decision = z.object({
  action: z.enum(["approve", "reject"]),
  id: z.string().min(1).max(120),
});
export const mappingInput = z.union([proposal, decision]);
type MappingProposal = z.infer<typeof proposal>;
type MappingRecord = MappingProposal & {
  status: "pending" | "approved" | "rejected";
  baseReleaseId: string;
  proposedBy: string;
  proposedAt: string;
  successorIds: string[];
  reviewedBy?: string;
  reviewedAt?: string;
  releaseId?: string;
};
async function latest(tx: Queryable, tenantId: string, courseId: string) {
  const result = await tx.query<{ id: string; data: { graph: Graph } }>(
    "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
    [tenantId, courseId],
  );
  if (!result.rows[0]) throw new AppError(409, "GRAPH_RELEASE_REQUIRED");
  return result.rows[0];
}
async function audit(
  tx: Queryable,
  ctx: AuthContext,
  id: string,
  action: string,
  data: unknown,
) {
  await tx.query(
    "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
    [ctx.tenantId, randomUUID(), ctx.userId, action, id, JSON.stringify(data)],
  );
}
async function writeRecord(
  tx: Queryable,
  ctx: AuthContext,
  id: string,
  kind: string,
  data: unknown,
  ownerId: string | null = null,
) {
  await tx.query(
    "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()",
    [ctx.tenantId, id, kind, ctx.courseId, ownerId, JSON.stringify(data)],
  );
}
function requireConcept(graph: Graph, id: string) {
  const node = graph.concepts.find((c) => c.id === id);
  if (!node) throw new AppError(404, "NOT_FOUND");
  return node;
}
function prepareGraph(
  original: Graph,
  m: MappingRecord,
): { graph: Graph; retired: string[]; successors: Graph["concepts"] } {
  const graph = structuredClone(original);
  const source = requireConcept(graph, m.conceptId);
  let retired: string[] = [];
  let successors: Graph["concepts"] = [];
  if (m.kind === "rename") {
    if (!m.label) throw new AppError(400, "INVALID_INPUT");
    source.aliases = [
      ...new Set([
        ...source.aliases,
        source.label.ar,
        source.label.en,
        m.label.ar,
        m.label.en,
      ]),
    ];
    source.label = m.label;
  } else if (m.kind === "merge") {
    if (!m.targetId || m.targetId === m.conceptId)
      throw new AppError(400, "INVALID_INPUT");
    const target = requireConcept(graph, m.targetId);
    target.aliases = [
      ...new Set([
        ...target.aliases,
        ...source.aliases,
        source.label.ar,
        source.label.en,
      ]),
    ];
    target.evidenceIds = [
      ...new Set([...target.evidenceIds, ...source.evidenceIds]),
    ];
    retired = [source.id];
    graph.concepts = graph.concepts.filter((c) => c.id !== source.id);
    const edges = graph.edges
      .map((e) => ({
        ...e,
        from: e.from === source.id ? target.id : e.from,
        to: e.to === source.id ? target.id : e.to,
      }))
      .filter((e) => e.from !== e.to);
    graph.edges = [
      ...new Map(edges.map((e) => [`${e.from}|${e.to}|${e.type}`, e])).values(),
    ];
  } else {
    if (!m.successors || m.successors.length !== m.successorIds.length)
      throw new AppError(400, "INVALID_INPUT");
    retired = [source.id];
    successors = m.successors.map((s, i) => ({
      id: m.successorIds[i],
      label: s.label,
      aliases: [s.label.ar, s.label.en],
      evidenceIds: s.evidenceIds,
    }));
    graph.concepts = graph.concepts
      .filter((c) => c.id !== source.id)
      .concat(successors);
    // No prerequisite or learner evidence is inferred for newly split concepts.
    graph.edges = graph.edges.filter(
      (e) => e.from !== source.id && e.to !== source.id,
    );
  }
  const activeAliases = new Map<string, string>();
  for (const node of graph.concepts)
    for (const alias of [node.label.ar, node.label.en, ...node.aliases]) {
      const key = alias
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      const owner = activeAliases.get(key);
      if (owner && owner !== node.id)
        throw new AppError(409, "CONCEPT_ALIAS_CONFLICT");
      activeAliases.set(key, node.id);
    }
  validateGraph(graph);
  return { graph, retired, successors };
}
async function ensureEvidence(tx: Queryable, ctx: AuthContext, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx.query<{ id: string }>(
    `SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND c.id=ANY($3::text[]) AND c.status='approved' AND v.current_version=true AND v.status='published' AND v.rights->>'displayExcerpt'='true'`,
    [ctx.tenantId, ctx.courseId, ids],
  );
  if (ids.some((id) => !rows.rows.some((r) => r.id === id)))
    throw new AppError(409, "STALE_EVIDENCE");
}
export async function getConceptMappings(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "review");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    const rows = await tx.query<{ id: string; data: MappingRecord }>(
      "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='concept_mapping' ORDER BY created_at DESC",
      [ctx.tenantId, ctx.courseId],
    );
    const releases = await tx.query<{ id: string; data: { graph: Graph } }>(
      "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.tenantId, ctx.courseId],
    );
    return {
      mappings: rows.rows,
      graph: releases.rows[0]?.data.graph ?? { concepts: [], edges: [] },
      releaseId: releases.rows[0]?.id ?? null,
    };
  });
}
export async function conceptMappingAction(ctx: AuthContext, input: unknown) {
  const a = mappingInput.parse(input);
  await authorizeCourse(
    ctx,
    ctx.courseId,
    a.action === "propose" ? "review" : "publish",
  );
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await tx.query(
      "SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
      [ctx.tenantId, ctx.userId],
    );
    await authorizeCourseInTransaction(
      ctx,
      ctx.courseId,
      a.action === "propose" ? "review" : "publish",
      tx,
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":knowledge:" + ctx.courseId,
    ]);
    const release = await latest(tx, ctx.tenantId, ctx.courseId);
    if (a.action === "propose") {
      const id = randomUUID();
      const data: MappingRecord = {
        ...a,
        status: "pending",
        baseReleaseId: release.id,
        proposedBy: ctx.userId,
        proposedAt: new Date().toISOString(),
        successorIds:
          a.kind === "split"
            ? (a.successors ?? []).map(() => `concept-${randomUUID()}`)
            : [],
      };
      const preview = prepareGraph(release.data.graph, data);
      await ensureEvidence(
        tx,
        ctx,
        preview.graph.concepts.flatMap((c) => c.evidenceIds),
      );
      await writeRecord(tx, ctx, id, "concept_mapping", data, ctx.userId);
      await audit(tx, ctx, id, "concept.mapping.proposed", {
        kind: a.kind,
        baseReleaseId: release.id,
      });
      return {
        id,
        data,
        preview: {
          graph: preview.graph,
          retiredIds: preview.retired,
          successorStates: preview.successors.map((c) => ({
            conceptId: c.id,
            status: "unassessed",
            evidenceInherited: false,
          })),
          historicalLearnerEvidence: "preserved",
        },
      };
    }
    const row = (
      await tx.query<{ data: MappingRecord }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND id=$2 AND kind='concept_mapping' AND course_id=$3 FOR UPDATE",
        [ctx.tenantId, a.id, ctx.courseId],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND");
    if (row.data.status !== "pending") throw new AppError(409, "INVALID_INPUT");
    const data: MappingRecord = {
      ...row.data,
      status: a.action === "reject" ? "rejected" : "approved",
      reviewedBy: ctx.userId,
      reviewedAt: new Date().toISOString(),
    };
    if (a.action === "reject") {
      await writeRecord(
        tx,
        ctx,
        a.id,
        "concept_mapping",
        data,
        row.data.proposedBy,
      );
      await audit(tx, ctx, a.id, "concept.mapping.rejected", {
        baseReleaseId: row.data.baseReleaseId,
      });
      return { id: a.id, data };
    }
    if (row.data.baseReleaseId !== release.id)
      throw new AppError(409, "STALE_GRAPH");
    const result = prepareGraph(release.data.graph, data);
    await ensureEvidence(
      tx,
      ctx,
      result.graph.concepts.flatMap((c) => c.evidenceIds),
    );
    const releaseId = randomUUID();
    data.releaseId = releaseId;
    for (const node of result.graph.concepts)
      await writeRecord(tx, ctx, node.id, "concept", node);
    for (const id of result.retired) {
      const node = requireConcept(release.data.graph, id);
      await writeRecord(tx, ctx, id, "concept", {
        ...node,
        retired: true,
        retiredByMapping: a.id,
        successorIds:
          data.kind === "merge" ? [data.targetId] : data.successorIds,
      });
    }
    if (data.kind === "split") {
      const students = (
        await tx.query<{ user_id: string }>(
          "SELECT user_id FROM course_access WHERE tenant_id=$1 AND course_id=$2 AND access_role='student' AND active",
          [ctx.tenantId, ctx.courseId],
        )
      ).rows;
      for (const student of students)
        for (const id of data.successorIds)
          await writeRecord(
            tx,
            ctx,
            `concept-state:${student.user_id}:${id}`,
            "concept_state",
            {
              conceptId: id,
              status: "unassessed",
              evidenceIds: [],
              evidenceInherited: false,
              sourceMapping: a.id,
              asOf: new Date().toISOString(),
            },
            student.user_id,
          );
    }
    await writeRecord(tx, ctx, releaseId, "graph_release", {
      graph: result.graph,
      publishedBy: ctx.userId,
      publishedAt: new Date().toISOString(),
      parentReleaseId: release.id,
      mappingId: a.id,
      fixture: false,
    });
    await writeRecord(
      tx,
      ctx,
      a.id,
      "concept_mapping",
      data,
      row.data.proposedBy,
    );
    await audit(tx, ctx, a.id, "concept.mapping.approved", {
      kind: data.kind,
      parentReleaseId: release.id,
      releaseId,
      historicalLearnerEvidence: "preserved",
      successorEvidenceInherited: false,
    });
    return {
      id: a.id,
      data,
      releaseId,
      successorStates: result.successors.map((c) => ({
        conceptId: c.id,
        status: "unassessed",
        evidenceInherited: false,
      })),
    };
  });
}
