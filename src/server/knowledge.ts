import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { semanticTypes } from "../lib/knowledge-graph";
import { db } from "./db";
import { queueCrossCourseRechecks } from "./cross-course-rechecks";
import {
  type AuthContext,
  authorizeCourse,
  authorizeCourseInTransaction,
} from "./auth";
import { majorCourses, SourceError, staff, type Evidence } from "./sources";
import {
  GeminiGateway,
  prepareModel,
  saveTrace,
  SYSTEM_POLICY,
  type ModelGateway,
} from "./ai";
import {
  bilingualText,
  comprehensiveInput,
  referenceLinkSchema,
  readCurrentEvidence,
  validateComprehensiveCoverage,
  type ComprehensiveCoverage,
  lectureKeys,
} from "./coverage";

export const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const knownAliases: Record<string, string> = {
  "conditional probability": "conditional-probability",
  "الاحتمال الشرطي": "conditional-probability",
  "احتمال شرطي": "conditional-probability",
  recall: "recall",
  الاستدعاء: "recall",
  استدعاء: "recall",
  precision: "precision",
  الإحكام: "precision",
  الاحكام: "precision",
  "confusion matrix": "confusion-matrix",
  "مصفوفة الالتباس": "confusion-matrix",
  python: "python",
  بايثون: "python",
  "gradient descent": "gradient-descent",
  "الانحدار المتدرج": "gradient-descent",
};
export function stableConceptId(label: string) {
  const key = knownAliases[normalize(label)] || normalize(label);
  return `concept-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}
const bilingual = z.object({
  ar: z.string().min(1).max(1500),
  en: z.string().min(1).max(1500),
});
const conceptSchema = z.object({
  key: z.string().min(1).max(100),
  label: bilingual,
  aliases: z.array(z.string().max(100)).max(20),
  evidenceIds: z.array(z.string()).min(1).max(6),
});
const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(semanticTypes),
  evidenceIds: z.array(z.string()).min(1).max(6),
  reason: bilingual,
});
const graphSchema = z.object({
  concepts: z.array(conceptSchema).min(1).max(16),
  edges: z.array(edgeSchema).max(24),
});
export type Graph = {
  concepts: {
    id: string;
    label: { ar: string; en: string };
    aliases: string[];
    evidenceIds: string[];
    summary?: { ar: string; en: string };
    coverageLevel?: "explained" | "named_only";
    scope?: "course" | "foundation";
    referenceLinks?: z.infer<typeof referenceLinkSchema>[];
    /** Set when the instructor linked this concept in from another course of the major. */
    importedFrom?: string;
    sense?: string;
    identityCandidates?: { id: string; label: { ar: string; en: string } }[];
  }[];
  edges: {
    from: string;
    to: string;
    type: string;
    evidenceIds: string[];
    reason: { ar: string; en: string };
    /** "instructor" for a line the instructor drew on the knowledge tree. */
    origin?: "instructor";
  }[];
};
/** A release is always strictly later than the one before it, so "latest" is never a tie. */
const NEXT_RELEASE_TIME =
  "GREATEST(clock_timestamp(),COALESCE((SELECT max(created_at) FROM records WHERE tenant_id=$1 AND course_id=$3 AND kind='graph_release'),'epoch'::timestamptz)+interval '1 millisecond')";
export function validateGraph(graph: Graph) {
  const ids = new Set(graph.concepts.map((c) => c.id));
  if (ids.size !== graph.concepts.length)
    throw new SourceError("duplicate_concept", 422);
  if (graph.concepts.length > 500 || graph.edges.length > 1500)
    throw new SourceError("graph_size", 422);
  const seen = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!semanticTypes.some((type) => type === edge.type))
      throw new SourceError("invalid_relationship", 422);
    if (!ids.has(edge.from) || !ids.has(edge.to))
      throw new SourceError("phantom_endpoint");
    if (edge.from === edge.to) throw new SourceError("self_loop");
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (seen.has(key)) throw new SourceError("duplicate_edge");
    seen.add(key);
    if (edge.type === "prerequisite")
      adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), edge.to]);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new SourceError("cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of adjacency.get(id) || []) visit(child);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return true;
}

const reviewedGraphSchema = z.object({
  concepts: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        label: bilingual,
        aliases: z.array(z.string().min(1).max(150)).max(50),
        evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(160),
        summary: bilingualText.optional(),
        sense: z.string().max(180).optional(),
        scope: z.enum(["course", "foundation"]).optional(),
        coverageLevel: z.enum(["explained", "named_only"]).optional(),
        referenceLinks: z.array(referenceLinkSchema).max(8).optional(),
      }),
    )
    .min(1)
    .max(500),
  edges: z
    .array(
      edgeSchema.extend({
        evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(160),
      }),
    )
    .max(1500),
});

/** Stage a complete instructor-reviewed inventory. This never publishes or changes source approval. */
export async function stageComprehensiveGraph(
  ctx: AuthContext,
  input: unknown,
) {
  await staff(ctx, "review");
  const submitted = comprehensiveInput.parse(input);
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "review", tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":knowledge:" + ctx.courseId,
    ]);
    const existing = (
      await tx.query<{
        id: string;
        data: Graph["concepts"][number] & { retired?: boolean };
      }>(
        "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='concept'",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows;
    const existingByAlias = new Map<string, typeof existing>();
    for (const entry of existing)
      for (const alias of [
        entry.data.label.ar,
        entry.data.label.en,
        ...(entry.data.aliases ?? []),
      ]) {
        const key = normalize(alias);
        const matches = existingByAlias.get(key) ?? [];
        if (!matches.some((m) => m.id === entry.id)) matches.push(entry);
        existingByAlias.set(key, matches);
      }
    const keys = new Map<string, string>();
    const seenAliases = new Map<string, string>();
    const concepts = submitted.concepts.map((node) => {
      if (keys.has(node.key)) throw new SourceError("duplicate_concept", 422);
      let aliases = [
        ...new Set([node.label.ar, node.label.en, ...node.aliases]),
      ];
      const matches = [
        ...new Map(
          aliases
            .flatMap((alias) => existingByAlias.get(normalize(alias)) ?? [])
            .map((entry) => [entry.id, entry]),
        ).values(),
      ];
      const active = matches.filter((e) => !e.data.retired);
      if (active.length > 1)
        throw new SourceError("ambiguous_concept_alias", 409);
      if (!active.length && matches.length)
        throw new SourceError("retired_concept", 409);
      if (active[0])
        aliases = [
          ...new Set([
            ...aliases,
            active[0].data.label.ar,
            active[0].data.label.en,
            ...(active[0].data.aliases ?? []),
          ]),
        ];
      const canonical =
        aliases.find((a) => knownAliases[normalize(a)]) || node.label.en;
      const id = active[0]?.id || stableConceptId(canonical);
      for (const alias of aliases) {
        const key = normalize(alias);
        if (seenAliases.has(key) && seenAliases.get(key) !== id)
          throw new SourceError("ambiguous_concept_alias", 409);
        seenAliases.set(key, id);
      }
      keys.set(node.key, id);
      return {
        id,
        label: node.label,
        aliases,
        summary: node.summary,
        scope: node.scope,
        coverageLevel: node.coverageLevel,
        evidenceIds: [...new Set(node.evidenceIds)],
        referenceLinks: node.referenceLinks,
      };
    });
    const graph: Graph = {
      concepts,
      edges: submitted.edges.map((edge) => ({
        ...edge,
        from: keys.get(edge.from) || edge.from,
        to: keys.get(edge.to) || edge.to,
        evidenceIds: [...new Set(edge.evidenceIds)],
      })),
    };
    validateGraph(graph);
    const evidence = await readCurrentEvidence(tx, ctx.tenantId, ctx.courseId);
    const allIds = [
      ...new Set([
        ...graph.concepts.flatMap((c) => c.evidenceIds),
        ...graph.edges.flatMap((e) => e.evidenceIds),
      ]),
    ];
    const coverage: ComprehensiveCoverage = {
      version: 1,
      title: submitted.title,
      reviewBasis: submitted.reviewBasis,
      pages: submitted.pages.map((p) => ({
        sourceKey: p.sourceKey,
        page: p.page,
        classification: p.classification,
        note: p.note,
        conceptIds: p.conceptKeys.map((k) => keys.get(k) || k),
      })),
      sourceVersionIds: [
        ...new Set(
          evidence
            .filter((e) => allIds.includes(e.id))
            .map((e) => e.version_id),
        ),
      ],
      generatedProposalIds: submitted.generatedProposalIds,
    };
    validateComprehensiveCoverage(graph, coverage, evidence);
    if (submitted.generatedProposalIds.length) {
      const generated = (
        await tx.query<{ id: string }>(
          "SELECT id FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='knowledge_proposal' AND id=ANY($3::text[]) AND data->>'modelId' IS NOT NULL AND data->>'status'<>'rejected'",
          [ctx.tenantId, ctx.courseId, submitted.generatedProposalIds],
        )
      ).rows;
      if (
        new Set(generated.map((p) => p.id)).size !==
        new Set(submitted.generatedProposalIds).size
      )
        throw new SourceError("invalid_generation_provenance", 422);
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ graph, coverage }))
      .digest("hex");
    const duplicate = (
      await tx.query<{
        id: string;
        data: {
          status: string;
          graph: Graph;
          coverage: ComprehensiveCoverage;
          evidenceIds: string[];
          [key: string]: unknown;
        };
      }>(
        "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='knowledge_proposal' AND data->>'fingerprint'=$3 ORDER BY created_at DESC LIMIT 1",
        [ctx.tenantId, ctx.courseId, fingerprint],
      )
    ).rows[0];
    if (duplicate)
      return { id: duplicate.id, ...duplicate.data, deduplicated: true };
    const id = randomUUID();
    const data = {
      status: "pending",
      kind: "comprehensive",
      graph,
      coverage,
      evidenceIds: allIds,
      fingerprint,
      policyVersion: (
        await tx.query<{ version: string }>(
          "SELECT version FROM policy_versions WHERE active=true LIMIT 1",
        )
      ).rows[0].version,
      preparedBy: ctx.userId,
      preparedAt: new Date().toISOString(),
      origin: "reviewed-instructor-inventory",
      modelId: null,
    };
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'knowledge_proposal',$3,$4,$5)",
      [ctx.tenantId, id, ctx.courseId, ctx.userId, JSON.stringify(data)],
    );
    await tx.query(
      "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.userId,
        "knowledge.comprehensive.staged",
        id,
        JSON.stringify({
          concepts: graph.concepts.length,
          edges: graph.edges.length,
          pages: coverage.pages.length,
          sourceVersionIds: coverage.sourceVersionIds,
        }),
      ],
    );
    return { id, ...data, deduplicated: false };
  });
}
function grounded(ids: string[], evidence: Evidence[]) {
  if (ids.some((id) => !evidence.some((e) => e.id === id)))
    throw new SourceError("invalid_citation");
}
async function normalizeGraph(
  ctx: AuthContext,
  value: unknown,
  evidence: Evidence[],
): Promise<Graph> {
  const result = graphSchema.parse(value);
  const existing = (
    await db.tenant(ctx.tenantId).query<{
      id: string;
      data: { label: { ar: string; en: string }; aliases: string[] };
    }>("SELECT id,data FROM records WHERE tenant_id=$1 AND kind='concept'", [ctx.tenantId])
  ).rows;
  const keyMap = new Map<string, string>();
  const concepts = result.concepts.map((c) => {
    grounded(c.evidenceIds, evidence);
    const aliases = [c.label.en, c.label.ar, ...c.aliases];
    const match = existing.find((e) =>
      [e.data.label.en, e.data.label.ar, ...e.data.aliases].some((a) =>
        aliases.some((b) => normalize(a) === normalize(b)),
      ),
    );
    const id = match?.id || stableConceptId(c.label.en);
    keyMap.set(c.key, id);
    return { id, label: c.label, aliases, evidenceIds: c.evidenceIds };
  });
  const edges = result.edges.map((e) => {
    grounded(e.evidenceIds, evidence);
    return {
      ...e,
      from: keyMap.get(e.from) || e.from,
      to: keyMap.get(e.to) || e.to,
    };
  });
  const graph = {
    concepts: [...new Map(concepts.map((c) => [c.id, c])).values()],
    edges,
  };
  validateGraph(graph);
  return graph;
}
export const proposalScope = z.object({
  lectureSourceKey: z.enum(lectureKeys),
  query: z.string().trim().min(2).max(1000),
  pages: z.array(z.number().int().positive().max(26)).min(1).max(5).optional(),
  umbrellaSections: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(12)
    .optional(),
});
export async function proposeKnowledge(
  ctx: AuthContext,
  gateway: ModelGateway = new GeminiGateway(),
  scopeInput?: z.infer<typeof proposalScope>,
) {
  await staff(ctx, "generate");
  const scope = scopeInput ? proposalScope.parse(scopeInput) : undefined;
  const prepared = await prepareModel(
    ctx,
    "propose",
    scope?.query ??
      "Recall precision confusion matrix conditional probability classification prerequisites",
    scope,
  );
  if (
    !prepared.evidence.length ||
    (scope &&
      !prepared.evidence.some((e) => e.source_key === scope.lectureSourceKey))
  )
    throw new SourceError("insufficient_evidence", 422);
  const id = randomUUID();
  const base = {
    id,
    operation: "propose",
    policyVersion: prepared.policyVersion,
    retrievedAt: prepared.retrievedAt,
    evidenceIds: prepared.evidence.map((e) => e.id),
    modelId: gateway.modelId,
  };
  await saveTrace(ctx, { ...base, outcome: "retrieved" });
  const generatedAt = new Date().toISOString();
  try {
    const response = await gateway.generate({
      operation: "propose",
      system: `${SYSTEM_POLICY}\nPropose a small bilingual course concept graph for instructor review, with at most 6 concepts and 8 edges. Keep labels and reasons concise. Direction is prerequisite to dependent. Use only explicit supported prerequisites; Python examples do not prove a hard mathematical prerequisite. Provide keys local to this response, bilingual labels, aliases, reasons and exact evidence IDs.`,
      schema: {
        type: "object",
        properties: {
          concepts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: {
                  type: "object",
                  properties: {
                    ar: { type: "string" },
                    en: { type: "string" },
                  },
                  required: ["ar", "en"],
                },
                aliases: { type: "array", items: { type: "string" } },
                evidenceIds: { type: "array", items: { type: "string" } },
              },
              required: ["key", "label", "aliases", "evidenceIds"],
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                type: {
                  type: "string",
                  enum: ["prerequisite", "related", "optional_bridge"],
                },
                reason: {
                  type: "object",
                  properties: {
                    ar: { type: "string" },
                    en: { type: "string" },
                  },
                  required: ["ar", "en"],
                },
                evidenceIds: { type: "array", items: { type: "string" } },
              },
              required: ["from", "to", "type", "reason", "evidenceIds"],
            },
          },
        },
        required: ["concepts", "edges"],
      },
      payload: {
        evidence: prepared.evidence.map((e) => ({
          id: e.id,
          text: e.text_content,
          source: e.source_key,
          page: e.page,
          section: e.section,
        })),
      },
    });
    const graph = await normalizeGraph(ctx, response.value, prepared.evidence);
    const data = {
      status: "pending",
      graph,
      evidenceIds: base.evidenceIds,
      modelId: gateway.modelId,
      policyVersion: prepared.policyVersion,
      generatedAt,
      ...(scope ? { scope } : {}),
    };
    await db
      .tenant(ctx.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'knowledge_proposal',$3,$4,$5)",
        [ctx.tenantId, id, ctx.courseId, ctx.userId, JSON.stringify(data)],
      );
    await saveTrace(ctx, {
      ...base,
      generatedAt,
      outcome: "pending_review",
      tokens: response.tokens,
    });
    return { id, ...data };
  } catch (e) {
    await saveTrace(ctx, {
      ...base,
      generatedAt,
      outcome: e instanceof SourceError ? e.code : "invalid_output",
    });
    throw e;
  }
}
export async function getKnowledge(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "read");
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<{ id: string; kind: string; data: Record<string, unknown> }>(
        `SELECT id,kind,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind IN ('concept','knowledge_proposal','tree_layout') ORDER BY created_at DESC`,
        [ctx.tenantId, ctx.courseId],
      )
  ).rows;
  const proposals =
    ctx.role === "instructor"
      ? rows.filter((r) => r.kind === "knowledge_proposal")
      : [];
  const evidenceIds = proposals.flatMap((r) =>
    Array.isArray(r.data.evidenceIds) ? (r.data.evidenceIds as string[]) : [],
  );
  const passages = evidenceIds.length
    ? (
        await db
          .tenant(ctx.tenantId)
          .query<Evidence>(
            `SELECT c.*,v.source_key,v.title,v.role,v.hash FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.id=ANY($2::text[]) AND EXISTS(SELECT 1 FROM course_access a WHERE a.tenant_id=v.tenant_id AND a.course_id=v.course_id AND a.user_id=$3 AND a.active)`,
            [ctx.tenantId, evidenceIds, ctx.userId],
          )
      ).rows
    : [];
  return {
    concepts: rows.filter(
      (r) => r.kind === "concept" && r.data.retired !== true,
    ),
    proposals: proposals.map((p) => ({
      ...p,
      passages: passages.filter((e) =>
        ((p.data.evidenceIds ?? []) as string[]).includes(e.id),
      ),
    })),
    // Every tree edit is a release: send the current one in full and only the
    // dates of the last few, not every past copy of the graph.
    releases: (
      await db
        .tenant(ctx.tenantId)
        .query<{ id: string; kind: string; data: Record<string, unknown> }>(
          `SELECT id,kind,CASE WHEN row_number() OVER (ORDER BY created_at DESC,id DESC)=1 THEN data ELSE jsonb_build_object('publishedAt',data->'publishedAt') END AS data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 10`,
          [ctx.tenantId, ctx.courseId],
        )
    ).rows,
    layout:
      (rows.find((r) => r.kind === "tree_layout")?.data.positions as
        Record<string, { x: number; y: number }> | undefined) ?? {},
  };
}
const layoutInput = z.object({
  /** A layout key from the union tree; omitted for the open course's own tree. */
  key: z
    .string()
    .regex(
      /^tree_layout:(university|major:[a-z0-9]{4,20}|course:[A-Za-z0-9]{2,40})$/,
    )
    .optional(),
  positions: z
    .record(
      z.string().min(1).max(120),
      z.object({
        x: z.number().finite().min(-20000).max(20000),
        y: z.number().finite().min(-20000).max(20000),
      }),
    )
    .refine((p) => Object.keys(p).length <= 600),
});
/** Where the instructor placed each concept on the knowledge tree. Display only. */
export async function saveTreeLayout(ctx: AuthContext, raw: unknown) {
  await staff(ctx, "review");
  const { positions, key } = layoutInput.parse(raw);
  if (key) {
    // The shared tree of a major or of the university belongs to no single course.
    await db
      .tenant(ctx.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'tree_layout',NULL,NULL,$3) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()",
        [ctx.tenantId, key, JSON.stringify({ positions })],
      );
    return { saved: Object.keys(positions).length };
  }
  await db
    .tenant(ctx.tenantId)
    .query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'tree_layout',$3,NULL,$4) ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()",
      [
        ctx.tenantId,
        "tree_layout:" + ctx.courseId,
        ctx.courseId,
        JSON.stringify({ positions }),
      ],
    );
  return { saved: Object.keys(positions).length };
}
export async function reviewProposal(
  ctx: AuthContext,
  id: string,
  status: "approved" | "rejected",
  edit?: Graph,
) {
  await staff(ctx, "publish");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    const record = (
      await tx.query<{
        data: {
          status: string;
          graph?: Graph;
          coverage?: ComprehensiveCoverage;
          evidenceIds: string[];
          [key: string]: unknown;
        };
      }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND id=$2 AND kind='knowledge_proposal' AND course_id=$3 FOR UPDATE",
        [ctx.tenantId, id, ctx.courseId],
      )
    ).rows[0];
    if (!record) throw new SourceError("source_missing", 404);
    if (record.data.status === "published")
      throw new SourceError("already_published", 409);
    const data = {
      ...record.data,
      status,
      reviewedBy: ctx.userId,
      reviewedAt: new Date().toISOString(),
    };
    if (edit) {
      const graph = reviewedGraphSchema.parse(edit);
      validateGraph(graph);
      if (
        [
          ...graph.concepts.flatMap((c) => c.evidenceIds),
          ...graph.edges.flatMap((e) => e.evidenceIds),
        ].some((id) => !record.data.evidenceIds.includes(id))
      )
        throw new SourceError("invalid_citation", 422);
      const origins = new Map(record.data.kind === "prerequisite-extraction"
        ? record.data.graph?.concepts.map(c => [c.id,c.importedFrom])
        : []);
      data.graph = { ...graph, concepts: graph.concepts.map(c => {
        const importedFrom = c.scope === "foundation" && origins.get(c.id);
        return importedFrom ? { ...c, importedFrom } : c;
      }) };
    }
    if (status === "approved" && data.graph && data.coverage)
      validateComprehensiveCoverage(
        data.graph,
        data.coverage,
        await readCurrentEvidence(tx, ctx.tenantId, ctx.courseId),
      );
    await tx.query(
      "UPDATE records SET data=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND course_id=$4 AND kind='knowledge_proposal'",
      [ctx.tenantId, id, JSON.stringify(data), ctx.courseId],
    );
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'knowledge_review',$3,$4,$5)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.courseId,
        ctx.userId,
        JSON.stringify({
          proposalId: id,
          status,
          previous: record.data,
          edited: !!edit,
        }),
      ],
    );
    return {
      id,
      ...data,
      preview:
        data.graph?.edges.map((e) => ({
          prerequisite: e.from,
          dependent: e.to,
          type: e.type,
          effect:
            e.type === "prerequisite"
              ? "Adds prerequisite routing after publication"
              : "Optional relationship; does not gate progress",
        })) || [],
    };
  });
}
const treeEdit = z.object({
  op: z.enum(["add", "remove", "retype"]),
  from: z.string().min(1).max(120),
  to: z.string().min(1).max(120),
  type: z.enum(semanticTypes).default("prerequisite"),
  originalType: z.enum(semanticTypes).optional(),
  /** The course a prerequisite is taught in, when it is not yet part of this course's tree. */
  fromCourse: z.string().min(1).max(40).optional(),
});
/**
 * Instructor edits the published knowledge tree directly: draw a line between two
 * concepts, remove one, or switch it between routing and optional. Each edit is a
 * new release, so the learner path follows at once; later lecture extractions merge
 * into the same tree and keep these lines.
 */
export async function editTree(ctx: AuthContext, raw: unknown) {
  await staff(ctx, "publish");
  const edit = treeEdit.parse(raw);
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":knowledge:" + ctx.courseId,
    ]);
    const prior = (
      await tx.query<{ data: Record<string, unknown> & { graph: Graph } }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND kind='graph_release' AND course_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows[0];
    if (!prior) throw new SourceError("tree_not_published", 409);
    const same = (e: Graph["edges"][number]) =>
      e.from === edit.from && e.to === edit.to && (edit.op === "add" ? e.type === edit.type : !edit.originalType || e.type === edit.originalType);
    if (edit.op !== "add" && prior.data.graph.edges.filter(same).length > 1)
      throw new SourceError("ambiguous_relationship", 409);
    const existing = prior.data.graph.edges.find(same);
    let edges = prior.data.graph.edges;
    let concepts = prior.data.graph.concepts;
    if (edit.op === "add") {
      if (existing) throw new SourceError("duplicate_edge", 409);
      if (
        edit.fromCourse &&
        edit.fromCourse !== ctx.courseId &&
        !concepts.some((c) => c.id === edit.from)
      ) {
        // A line from another course of the same major brings that concept in as background.
        if (!(await majorCourses(ctx, tx)).includes(edit.fromCourse))
          throw new SourceError("phantom_endpoint");
        const source = (
          await tx.query<{ data: { graph: Graph } }>(
            "SELECT data FROM records WHERE tenant_id=$1 AND kind='graph_release' AND course_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
            [ctx.tenantId, edit.fromCourse],
          )
        ).rows[0]?.data.graph.concepts.find((c) => c.id === edit.from);
        if (!source) throw new SourceError("phantom_endpoint");
        const imported = {
          id: source.id,
          label: source.label,
          aliases: source.aliases ?? [],
          evidenceIds: [],
          scope: "foundation" as const,
          importedFrom: edit.fromCourse,
        };
        concepts = [...concepts, imported];
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'concept',$3,NULL,$4) ON CONFLICT ON CONSTRAINT records_pkey DO NOTHING",
          [ctx.tenantId, imported.id, ctx.courseId, JSON.stringify(imported)],
        );
      }
      edges = [
        ...edges,
        {
          from: edit.from,
          to: edit.to,
          type: edit.type,
          evidenceIds: [],
          reason: {
            ar: "علاقة أضافها المحاضر على شجرة المعرفة.",
            en: "Relationship added by the instructor on the knowledge tree.",
          },
          origin: "instructor",
        },
      ];
    } else {
      if (!existing) throw new SourceError("edge_missing", 404);
      edges =
        edit.op === "remove"
          ? edges.filter((e) => !same(e))
          : edges.map((e) => (same(e) ? { ...e, type: edit.type } : e));
    }
    const graph: Graph = { concepts, edges };
    validateGraph(graph);
    const now = new Date().toISOString();
    await tx.query(
      `INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data,created_at) VALUES($1,$2,'graph_release',$3,NULL,$4,${NEXT_RELEASE_TIME})`,
      [
        ctx.tenantId,
        randomUUID(),
        ctx.courseId,
        JSON.stringify({
          ...prior.data,
          graph,
          publishedBy: ctx.userId,
          publishedAt: now,
          proposalIds: [],
          treeEdit: edit,
        }),
      ],
    );
    await tx.query(
      "INSERT INTO audit_events(tenant_id,id,actor_id,action,entity_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.userId,
        "knowledge.tree_edit",
        ctx.courseId,
        JSON.stringify(edit),
      ],
    );
    return { graph };
  });
}
export async function queueExistingKnowledge(ctx: AuthContext) {
  await staff(ctx, "publish");
  return db.tenant(ctx.tenantId).transaction(async tx => {
    await authorizeCourseInTransaction(ctx,ctx.courseId,"publish",tx);
    const release = (await tx.query<{id:string;data:{graph:Graph}}>(
      "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.tenantId,ctx.courseId],
    )).rows[0];
    if (!release) return [];
    const refs = (await tx.query<{id:string}>("SELECT id FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND role='umbrella' AND current_version AND status='published'",[ctx.tenantId,ctx.courseId])).rows;
    return queueCrossCourseRechecks(tx,ctx,"existing:"+release.id,
      release.data.graph.concepts.filter(c=>c.scope!=="foundation"&&!c.importedFrom).map(c=>c.id),refs.map(r=>r.id));
  });
}

export async function publishKnowledge(ctx: AuthContext) {
  await staff(ctx, "publish");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":knowledge:" + ctx.courseId,
    ]);
    const proposals = (
      await tx.query<{
        id: string;
        data: {
          graph?: Graph;
          coverage?: ComprehensiveCoverage;
          evidenceIds: string[];
          item?: Record<string, unknown>;
          [key: string]: unknown;
        };
      }>(
        "SELECT id,data FROM records WHERE tenant_id=$1 AND kind='knowledge_proposal' AND course_id=$2 AND data->>'status'='approved' FOR UPDATE",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows;
    const comprehensive = proposals.filter((p) => p.data.coverage);
    if (
      comprehensive.length > 1 ||
      (comprehensive.length &&
        proposals.some((p) => p.data.graph && p.id !== comprehensive[0].id))
    )
      throw new SourceError("conflicting_graph_proposals", 409);
    const full = comprehensive[0];
    if (full?.data.graph && full.data.coverage)
      validateComprehensiveCoverage(
        full.data.graph,
        full.data.coverage,
        await readCurrentEvidence(tx, ctx.tenantId, ctx.courseId),
      );
    const approved = (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND (c.course_id=$2 OR (v.role='umbrella' AND c.course_id=ANY($4::text[]))) AND c.status=$3 AND v.current_version=true AND v.rights->>'sendToModel'='true' AND v.rights->>'displayExcerpt'='true'`,
        [ctx.tenantId, ctx.courseId, "approved", await majorCourses(ctx, tx)],
      )
    ).rows.map((r) => r.id);
    for (const p of proposals) {
      const claims = p.data.graph
        ? [
            ...p.data.graph.concepts.flatMap((c) => c.evidenceIds),
            ...p.data.graph.edges.flatMap((e) => e.evidenceIds),
          ]
        : p.data.evidenceIds;
      if (claims.some((id) => !approved.includes(id)))
        throw new SourceError("unreviewed_evidence", 422);
    }
    const prior = (
      await tx.query<{
        data: { graph: Graph; coverage?: ComprehensiveCoverage };
      }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND kind='graph_release' AND course_id=$2 ORDER BY created_at DESC LIMIT 1",
        [ctx.tenantId, ctx.courseId],
      )
    ).rows[0];
    const currentApproved = (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.status='approved' AND v.current_version=true`,
        [ctx.tenantId],
      )
    ).rows.map((r) => r.id);
    const current = new Set(currentApproved);
    const retainEvidence = <T extends { evidenceIds: string[] }>(entry: T): T[] => {
      const evidenceIds = entry.evidenceIds.filter(id => current.has(id));
      return evidenceIds.length || !entry.evidenceIds.length ? [{ ...entry, evidenceIds }] : [];
    };
    const retainedConcepts = (full ? [] : prior?.data.graph.concepts || []).flatMap(retainEvidence);
    const graph: Graph = {
      concepts: retainedConcepts,
      edges: (full ? [] : prior?.data.graph.edges || []).flatMap(retainEvidence).filter(
        (e) =>
          retainedConcepts.some((c) => c.id === e.from) &&
          retainedConcepts.some((c) => c.id === e.to),
      ),
    };
    for (const p of proposals) {
      if (p.data.graph) {
        for (const c of p.data.graph.concepts) {
          const idx = graph.concepts.findIndex((n) => n.id === c.id);
          if (idx < 0) graph.concepts.push(c);
          else if (p.data.kind === "prerequisite-extraction") {
            // Extraction adds evidence and relationships to a reviewed concept;
            // it never replaces its summary, coverage or earlier citations.
            const old = graph.concepts[idx];
            graph.concepts[idx] = {
              ...old,
              ...c,
              label: old.label,
              scope: old.scope === "course" || c.scope === "course" ? "course" : old.scope ?? c.scope,
              aliases: [...new Set([...(old.aliases ?? []), ...c.aliases])],
              evidenceIds: [...new Set([...old.evidenceIds, ...c.evidenceIds])],
            };
          } else graph.concepts[idx] = c;
        }
        for (const edge of p.data.graph.edges) {
          const priorEdge = graph.edges.find(e => e.from === edge.from && e.to === edge.to && e.type === edge.type);
          if (priorEdge) priorEdge.evidenceIds = [...new Set([...priorEdge.evidenceIds, ...edge.evidenceIds])];
          else graph.edges.push(edge);
        }
      }
    }
    validateGraph(graph);
    if (full?.data.coverage)
      validateComprehensiveCoverage(
        graph,
        full.data.coverage,
        await readCurrentEvidence(tx, ctx.tenantId, ctx.courseId),
      );
    const releaseId = randomUUID();
    // One scoped statement keeps complete maps within the serverless time budget.
    await tx.query(
      `INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data)
       SELECT $1,node->>'id','concept',$2,NULL,node
       FROM jsonb_array_elements($3::jsonb) AS node
       ON CONFLICT ON CONSTRAINT records_pkey DO UPDATE SET data=excluded.data,updated_at=now()`,
      [ctx.tenantId, ctx.courseId, JSON.stringify(graph.concepts)],
    );
    await tx.query(
      `INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data,created_at) VALUES($1,$2,'graph_release',$3,$4,$5,${NEXT_RELEASE_TIME})`,
      [
        ctx.tenantId,
        releaseId,
        ctx.courseId,
        null,
        JSON.stringify({
          graph,
          publishedBy: ctx.userId,
          publishedAt: new Date().toISOString(),
          proposalIds: proposals.map((p) => p.id),
          fixture: false,
          ...((full?.data.coverage ?? prior?.data.coverage)
            ? {
                coverage: full?.data.coverage ?? prior?.data.coverage,
                publicationMode: full
                  ? "comprehensive-replacement"
                  : "incremental",
              }
            : {}),
        }),
      ],
    );
    for (const p of proposals) {
      if (p.data.session)
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'session',$3,$4,$5)",
          [
            ctx.tenantId,
            `session-${p.id}`,
            ctx.courseId,
            null,
            JSON.stringify({
              ...(p.data.session as Record<string, unknown>),
              approved: true,
              fixture: false,
              modelId: p.data.modelId,
              policyVersion: p.data.policyVersion,
              graphVersion: releaseId,
              languageEquivalenceReviewed: true,
            }),
          ],
        );
      if (p.data.item?.conceptId)
        // A concept becomes assessable the moment its first reviewed question is published.
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'objective',$3,NULL,$4) ON CONFLICT ON CONSTRAINT records_pkey DO NOTHING",
          [
            ctx.tenantId,
            `objective:${p.data.item.objectiveId}`,
            ctx.courseId,
            JSON.stringify({
              objectiveId: p.data.item.objectiveId,
              conceptId: p.data.item.conceptId,
              title:
                graph.concepts.find((c) => c.id === p.data.item!.conceptId)
                  ?.label ?? p.data.item.conceptLabel,
              fixture: false,
            }),
          ],
        );
      if (p.data.item)
        await tx.query(
          "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'item',$3,$4,$5)",
          [
            ctx.tenantId,
            `item-${p.id}`,
            ctx.courseId,
            null,
            JSON.stringify({
              ...p.data.item,
              status: "published",
              approved: true,
              languageEquivalenceReviewed: true,
              graphVersion: releaseId,
              modelId: p.data.modelId,
              policyVersion: p.data.policyVersion,
            }),
          ],
        );
      await tx.query(
        "UPDATE records SET data=data || $3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND course_id=$4 AND kind='knowledge_proposal'",
        [
          ctx.tenantId,
          p.id,
          JSON.stringify({ status: "published", releaseId }),
          ctx.courseId,
        ],
      );
    }
    const publishedMaterials = await tx.query<{ id: string; role: string }>(
      `UPDATE material_versions SET status='published' WHERE tenant_id=$1 AND course_id=$2 AND current_version=true AND status<>'published'
       AND id IN (SELECT version_id FROM evidence_chunks WHERE tenant_id=$1 AND status='approved') RETURNING id,role`,
      [ctx.tenantId, ctx.courseId],
    );
    const previousTeaching = new Set((prior?.data.graph.concepts ?? [])
      .filter(c => c.scope !== "foundation" && !c.importedFrom).map(c => c.id));
    const newTeaching = graph.concepts.filter(c => c.scope !== "foundation" && !c.importedFrom && !previousTeaching.has(c.id));
    const recheckCourses = await queueCrossCourseRechecks(tx,ctx,releaseId,newTeaching.map(c => c.id),
      publishedMaterials.rows.filter(material => material.role === "umbrella").map(material => material.id));
    return {
      releaseId,
      recheckCourses,
      concepts: graph.concepts.length,
      edges: graph.edges.length,
      publishedProposals: proposals.length,
    };
  });
}

const teachingSchema = z.object({
  item: z.object({
    kind: z.enum(["choice", "open", "critique", "transfer"]),
    objectiveId: z.enum([
      "recall.calculate",
      "metric.choose",
      "metric.justify",
      "solution.review",
      "gradient.transfer",
    ]),
    stem: bilingual,
    steps: z.array(bilingual).min(2).max(8).optional(),
    options: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9_-]{0,20}$/),
          label: bilingual,
        }),
      )
      .max(6),
    key: z.string().max(100),
    feedback: bilingual,
    rubric: bilingual,
    evidenceIds: z.array(z.string()).min(1).max(4),
  }),
  session: z.object({
    title: bilingual,
    body: bilingual,
    objectiveIds: z.array(z.string()).min(1).max(5),
    evidenceIds: z.array(z.string()).min(1).max(4),
  }),
});
export async function generateTeaching(
  ctx: AuthContext,
  gateway: ModelGateway = new GeminiGateway(),
) {
  await staff(ctx, "generate");
  const prepared = await prepareModel(
    ctx,
    "generate",
    "Recall precision choosing metric denominator class imbalance",
  );
  if (!prepared.evidence.length)
    throw new SourceError("insufficient_evidence", 422);
  const id = randomUUID();
  const base = {
    id,
    operation: "generate",
    policyVersion: prepared.policyVersion,
    retrievedAt: prepared.retrievedAt,
    evidenceIds: prepared.evidence.map((e) => e.id),
    modelId: gateway.modelId,
  };
  await saveTrace(ctx, { ...base, outcome: "retrieved" });
  const generatedAt = new Date().toISOString();
  try {
    const response = await gateway.generate({
      operation: "generate",
      system: `${SYSTEM_POLICY}\nCreate ONE original unprotected bilingual practice item using new numbers and a short bilingual teaching session. Both translations must have equivalent stable option IDs and one shared rubric/key. Key for open responses is 'moderation'. For choice/critique/transfer key must be an option id. For critique items include a bilingual steps array with a deliberate error; option IDs refer to first wrong step. Do not reuse source numerical errors. These are drafts for instructor review, not approved content.`,
      schema: z.toJSONSchema(teachingSchema) as Record<string, unknown>,
      payload: {
        evidence: prepared.evidence.map((e) => ({
          id: e.id,
          text: e.text_content,
          source: e.source_key,
          page: e.page,
          section: e.section,
        })),
      },
    });
    const draft = teachingSchema.parse(response.value);
    if (draft.item.kind === "critique" && !draft.item.steps?.length)
      throw new SourceError("invalid_output");
    grounded(
      [...draft.item.evidenceIds, ...draft.session.evidenceIds],
      prepared.evidence,
    );
    if (
      (draft.item.kind === "open" && draft.item.key !== "moderation") ||
      (draft.item.kind !== "open" &&
        !draft.item.options.some((o) => o.id === draft.item.key)) ||
      new Set(draft.item.options.map((o) => o.id)).size !==
        draft.item.options.length
    )
      throw new SourceError("invalid_output");
    const first = prepared.evidence.find((e) =>
      draft.item.evidenceIds.includes(e.id),
    )!;
    const data = {
      status: "pending",
      item: {
        ...draft.item,
        approved: false,
        protected: false,
        version: 1,
        graphVersion: "pending",
        policyVersion: prepared.policyVersion,
        familyId: `family-${id}`,
        sourceKey: first.source_key,
        locator: first.page ? `p. ${first.page}` : first.section,
        fixture: false,
      },
      session: {
        ...draft.session,
        approved: false,
        fixture: false,
        lecture: 4,
        module: "evaluation",
        version: 1,
        citations: prepared.evidence
          .filter((e) => draft.session.evidenceIds.includes(e.id))
          .map((e) => ({
            id: e.id,
            sourceKey: e.source_key,
            versionId: e.version_id,
            page: e.page,
            section: e.section,
            url: `/sources/${e.version_id}?${e.page ? `page=${e.page}` : `section=${e.section}`}`,
          })),
      },
      evidenceIds: base.evidenceIds,
      modelId: gateway.modelId,
      policyVersion: prepared.policyVersion,
      generatedAt,
    };
    await db
      .tenant(ctx.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'knowledge_proposal',$3,$4,$5)",
        [ctx.tenantId, id, ctx.courseId, ctx.userId, JSON.stringify(data)],
      );
    await saveTrace(ctx, {
      ...base,
      generatedAt,
      outcome: "pending_review",
      tokens: response.tokens,
    });
    return { id, ...data };
  } catch (e) {
    await saveTrace(ctx, {
      ...base,
      generatedAt,
      outcome: e instanceof SourceError ? e.code : "invalid_output",
    });
    throw e;
  }
}

export async function editTeaching(
  ctx: AuthContext,
  id: string,
  input: { item?: unknown; session?: unknown },
) {
  await staff(ctx, "publish");
  const old = (
    await db
      .tenant(ctx.tenantId)
      .query<{ data: Record<string, unknown> }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND id=$2 AND course_id=$3 AND kind='knowledge_proposal'",
        [ctx.tenantId, id, ctx.courseId],
      )
  ).rows[0];
  if (!old) throw new SourceError("source_missing", 404);
  if (old.data.status === "published")
    throw new SourceError("already_published", 409);
  const item = input.item
    ? teachingSchema.shape.item.parse(input.item)
    : undefined;
  const session = input.session
    ? teachingSchema.shape.session.parse(input.session)
    : undefined;
  if (!item && !session) throw new SourceError("invalid_input");
  const allowed = old.data.evidenceIds as string[];
  if (
    [...(item?.evidenceIds || []), ...(session?.evidenceIds || [])].some(
      (id) => !allowed.includes(id),
    )
  )
    throw new SourceError("invalid_citation");
  if (
    item &&
    (item.kind === "open"
      ? item.key !== "moderation"
      : !item.options.some((o) => o.id === item.key))
  )
    throw new SourceError("invalid_output");
  if (item?.kind === "critique" && !item.steps?.length)
    throw new SourceError("invalid_output");
  if (
    item &&
    new Set(item.options.map((o) => o.id)).size !== item.options.length
  )
    throw new SourceError("invalid_output");
  const next = {
    ...old.data,
    status: "pending",
    editedBy: ctx.userId,
    editedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    ...(item
      ? {
          item: {
            ...(old.data.item as Record<string, unknown>),
            ...item,
            approved: false,
          },
        }
      : {}),
    ...(session
      ? {
          session: {
            ...(old.data.session as Record<string, unknown>),
            ...session,
            approved: false,
          },
        }
      : {}),
  };
  await db.tenant(ctx.tenantId).transaction(async (tx) => {
    await tx.query(
      "UPDATE records SET data=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, id, JSON.stringify(next)],
    );
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'knowledge_review',$3,$4,$5)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.courseId,
        ctx.userId,
        JSON.stringify({ proposalId: id, action: "edit", previous: old.data }),
      ],
    );
  });
  return { id, ...next };
}
