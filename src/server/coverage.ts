import { z } from "zod";
import { db, type Queryable } from "./db";
import { authorizeCourseInTransaction, type AuthContext } from "./auth";
import {
  COURSE,
  SourceError,
  sourceManifest,
  sourceErrorResponse,
} from "./sources";
import { AppError, errorResponse } from "./errors";
import type { Graph } from "./knowledge";

export const bilingualText = z.object({
  ar: z.string().trim().min(1).max(1500),
  en: z.string().trim().min(1).max(1500),
});
export const lectureKeys = [
  "CET351-L1",
  "CET351-L2",
  "CET351-L3",
  "CET351-L4",
  "CET351-L5",
  "CET351-L6",
] as const;
export const lecturePages = new Map<string, number>(
  sourceManifest.flatMap((entry) =>
    "physical_pages" in entry && typeof entry.physical_pages === "number"
      ? [[entry.source_key, entry.physical_pages] as const]
      : [],
  ),
);
export const pageClassification = z.enum([
  "teaching",
  "title",
  "administrative",
  "duplicate",
  "figure",
  "quarantined",
]);
export const referenceLinkSchema = z.object({
  sourceKey: z.literal("GFG-UMBRELLA"),
  title: bilingualText,
  url: z.url().refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      ["www.geeksforgeeks.org", "geeksforgeeks.org"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  }),
  mode: z.literal("reference_link"),
});
export const comprehensiveInput = z.object({
  title: bilingualText,
  reviewBasis: bilingualText,
  concepts: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        label: bilingualText,
        aliases: z.array(z.string().trim().min(1).max(150)).max(40).default([]),
        summary: bilingualText,
        coverageLevel: z.enum(["explained", "named_only"]).default("explained"),
        scope: z.enum(["course", "foundation"]).default("course"),
        evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(160),
        referenceLinks: z.array(referenceLinkSchema).max(8).default([]),
      }),
    )
    .min(1)
    .max(500),
  edges: z
    .array(
      z.object({
        from: z.string().min(1).max(120),
        to: z.string().min(1).max(120),
        type: z.enum(["prerequisite", "related", "optional_bridge"]),
        evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(160),
        reason: bilingualText,
      }),
    )
    .max(1500),
  pages: z
    .array(
      z.object({
        sourceKey: z.enum(lectureKeys),
        page: z.number().int().positive(),
        classification: pageClassification,
        conceptKeys: z.array(z.string().min(1).max(120)).max(100),
        note: bilingualText,
      }),
    )
    .length(137),
  generatedProposalIds: z.array(z.string().min(1).max(120)).max(40).default([]),
});
export type ComprehensiveInput = z.infer<typeof comprehensiveInput>;
export type CoveragePage = Omit<
  ComprehensiveInput["pages"][number],
  "conceptKeys"
> & { conceptIds: string[] };
export type SourceLocator = {
  id: string;
  sourceKey: string;
  title: string;
  role: string;
  versionId: string;
  page: number | null;
  section: string | null;
  url: string;
  status: string;
};
export type CurrentEvidence = {
  id: string;
  source_key: string;
  title: string;
  role: string;
  version_id: string;
  page: number | null;
  section: string | null;
  status: string;
  current_version: boolean;
  rights: Record<string, boolean>;
  material_status: string;
  hash: string;
};
export type ComprehensiveCoverage = {
  version: 1;
  pages: CoveragePage[];
  title: z.infer<typeof bilingualText>;
  reviewBasis: z.infer<typeof bilingualText>;
  sourceVersionIds: string[];
  generatedProposalIds: string[];
};
export function locator(e: CurrentEvidence): SourceLocator {
  return {
    id: e.id,
    sourceKey: e.source_key,
    title: e.title,
    role: e.role,
    versionId: e.version_id,
    page: e.page,
    section: e.section,
    status: e.status,
    url: `/sources/${encodeURIComponent(e.version_id)}?${e.page !== null ? `page=${e.page}` : `section=${encodeURIComponent(e.section || "")}`}`,
  };
}
export async function readCurrentEvidence(
  tx: Queryable,
  tenantId: string,
): Promise<CurrentEvidence[]> {
  return (
    await tx.query<CurrentEvidence>(
      `SELECT c.id,c.version_id,c.page,c.section,c.status,v.source_key,v.title,v.role,v.hash,v.current_version,v.status AS material_status,v.rights
    FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id
    WHERE c.tenant_id=$1 AND c.course_id=$2 AND v.course_id=$2 AND v.current_version=true`,
      [tenantId, COURSE],
    )
  ).rows;
}
export function permittedEvidence(e: CurrentEvidence) {
  return (
    e.current_version &&
    e.status === "approved" &&
    e.rights.displayExcerpt === true &&
    e.rights.sendToModel === true
  );
}
const validationMessages: Record<string, [string, string]> = {
  invalid_page_coverage: [
    "راجع أرقام الصفحات وربطها بالمفاهيم.",
    "Check the page numbers and their concept links.",
  ],
  incomplete_page_coverage: [
    "سجل التغطية لا يشمل جميع صفحات المحاضرات الست.",
    "The coverage ledger must account for every page of all six lectures.",
  ],
  unmapped_teaching_page: [
    "اربط كل صفحة تعليمية بمفهوم يستشهد بدليلها المعتمد.",
    "Link every teaching page to a concept citing its approved evidence.",
  ],
  unreviewed_evidence: [
    "الخريطة تحتوي على دليل غير معتمد أو تغيّرت نسخته. راجع المصادر الحالية أولًا.",
    "Some evidence is unapproved or has changed version. Review the current sources first.",
  ],
  umbrella_link_required: [
    "كل مفهوم يحتاج دليلًا معتمدًا من مصدر Umbrella؛ الرابط المرجعي وحده لا يكفي.",
    "Each concept needs approved umbrella evidence; a reference link alone is insufficient.",
  ],
  lecture_link_required: [
    "اربط مفهوم المقرر بصفحة معتمدة من المحاضرات.",
    "Link each course concept to an approved lecture page.",
  ],
  duplicate_concept: [
    "يوجد تكرار في هوية المفهوم. راجع الأسماء والمرادفات.",
    "A concept identity is duplicated. Review names and aliases.",
  ],
  ambiguous_concept_alias: [
    "الاسم يطابق أكثر من مفهوم. راجع الدمج أو التسمية قبل النشر.",
    "A name matches multiple concepts. Review the merge or label before publishing.",
  ],
  retired_concept: [
    "هذا المفهوم مؤرشف. استخدم تحويل المفاهيم المعتمد للحفاظ على التاريخ.",
    "This concept is retired. Use a reviewed concept mapping to preserve history.",
  ],
  invalid_generation_provenance: [
    "تعذّر التحقق من مقترحات التوليد المرتبطة بالخريطة.",
    "The linked generation proposals could not be verified.",
  ],
  conflicting_graph_proposals: [
    "اعتمد خريطة شاملة واحدة في كل عملية نشر.",
    "Approve one comprehensive graph for each publication.",
  ],
  graph_size: [
    "حجم الخريطة أكبر من الحد المسموح.",
    "The concept map exceeds the allowed size.",
  ],
  cycle: [
    "المتطلبات السابقة تحتوي على دورة. راجع اتجاه العلاقات.",
    "Prerequisites contain a cycle. Review relationship directions.",
  ],
  phantom_endpoint: [
    "إحدى العلاقات تشير إلى مفهوم غير موجود.",
    "A relationship points to a missing concept.",
  ],
  self_loop: [
    "لا يمكن أن يكون المفهوم متطلبًا لنفسه.",
    "A concept cannot be linked to itself.",
  ],
  duplicate_edge: [
    "توجد علاقة مكررة في الخريطة.",
    "The graph contains a duplicate relationship.",
  ],
};
export function knowledgeErrorResponse(error: unknown, language = "ar") {
  const english = language.startsWith("en");
  if (error instanceof AppError)
    return errorResponse(error, english ? "en" : "ar");
  if (error instanceof SyntaxError)
    return Response.json(
      {
        error: "invalid_input",
        message: english
          ? "The submitted JSON is invalid."
          : "البيانات المرسلة غير صالحة.",
      },
      { status: 400 },
    );
  if (error instanceof SourceError && validationMessages[error.code])
    return Response.json(
      {
        error: error.code,
        message: validationMessages[error.code][english ? 1 : 0],
      },
      { status: error.status },
    );
  return sourceErrorResponse(error, english ? "en" : "ar");
}
/** Every page is accounted for; quarantined/administrative pages cannot become teaching claims. */
export function validateComprehensiveCoverage(
  graph: Graph,
  coverage: ComprehensiveCoverage,
  evidence: CurrentEvidence[],
) {
  const available = new Map(
    evidence.filter(permittedEvidence).map((e) => [e.id, e]),
  );
  const nodes = new Map(graph.concepts.map((c) => [c.id, c]));
  const pages = new Map<string, CoveragePage>();
  for (const entry of coverage.pages) {
    const expected = lecturePages.get(entry.sourceKey);
    const key = `${entry.sourceKey}:${entry.page}`;
    if (!expected || entry.page < 1 || entry.page > expected || pages.has(key))
      throw new SourceError("invalid_page_coverage", 422);
    if (entry.conceptIds.some((id) => !nodes.has(id)))
      throw new SourceError("invalid_page_coverage", 422);
    if (
      ["title", "administrative"].includes(entry.classification) &&
      entry.conceptIds.length
    )
      throw new SourceError("invalid_page_coverage", 422);
    if (
      ["teaching", "figure"].includes(entry.classification) &&
      !entry.conceptIds.length
    )
      throw new SourceError("incomplete_page_coverage", 422);
    pages.set(key, entry);
  }
  for (const [sourceKey, count] of lecturePages)
    for (let page = 1; page <= count; page++)
      if (!pages.has(`${sourceKey}:${page}`))
        throw new SourceError("incomplete_page_coverage", 422);
  const referenced = [
    ...graph.concepts.flatMap((c) => c.evidenceIds),
    ...graph.edges.flatMap((e) => e.evidenceIds),
  ];
  if (referenced.some((id) => !available.has(id)))
    throw new SourceError("unreviewed_evidence", 422);
  // The ledger is authoritative for relationship evidence as well as node evidence.
  // A previously approved chunk cannot turn a quarantined/admin page into a claim.
  for (const id of referenced) {
    const e = available.get(id)!;
    if (lecturePages.has(e.source_key) && e.page !== null) {
      const page = pages.get(`${e.source_key}:${e.page}`);
      if (
        !page ||
        ["title", "administrative", "quarantined"].includes(page.classification)
      )
        throw new SourceError("invalid_page_coverage", 422);
    }
  }
  for (const node of graph.concepts) {
    const refs = node.evidenceIds.map((id) => available.get(id)!);
    if (!refs.some((e) => e.role === "umbrella" && !!e.section))
      throw new SourceError("umbrella_link_required", 422);
    const lectures = refs.filter(
      (e) => lecturePages.has(e.source_key) && e.page !== null,
    );
    if (node.scope !== "foundation" && !lectures.length)
      throw new SourceError("lecture_link_required", 422);
    for (const e of lectures) {
      const page = pages.get(`${e.source_key}:${e.page}`)!;
      if (
        ["title", "administrative", "quarantined"].includes(
          page.classification,
        ) ||
        !page.conceptIds.includes(node.id)
      )
        throw new SourceError("invalid_page_coverage", 422);
    }
  }
  for (const entry of coverage.pages)
    if (["teaching", "figure"].includes(entry.classification)) {
      for (const id of entry.conceptIds) {
        const node = nodes.get(id)!;
        if (
          !node.evidenceIds.some((ref) => {
            const e = available.get(ref);
            return e?.source_key === entry.sourceKey && e.page === entry.page;
          })
        )
          throw new SourceError("unmapped_teaching_page", 422);
      }
    }
  return true;
}

export async function getPublishedConceptMap(ctx: AuthContext) {
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, COURSE, "read", tx);
    const release = (
      await tx.query<{
        id: string;
        data: {
          graph: Graph;
          coverage?: ComprehensiveCoverage;
          publishedAt: string;
          fixture?: boolean;
        };
      }>(
        "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='graph_release' ORDER BY created_at DESC,id DESC LIMIT 1",
        [ctx.tenantId, COURSE],
      )
    ).rows[0];
    const evidence = await readCurrentEvidence(tx, ctx.tenantId);
    const allowed = new Map(
      evidence
        .filter(
          (e) => permittedEvidence(e) && e.material_status === "published",
        )
        .map((e) => [e.id, e]),
    );
    const graph = release?.data.graph ?? { concepts: [], edges: [] };
    const concepts = graph.concepts.map((node) => {
      const refs = node.evidenceIds.flatMap((id) =>
        allowed.has(id) ? [locator(allowed.get(id)!)] : [],
      );
      const valid = refs.length === node.evidenceIds.length;
      return {
        id: node.id,
        label: node.label,
        aliases: node.aliases,
        summary: node.summary,
        scope: node.scope ?? "course",
        coverageLevel: node.coverageLevel ?? "explained",
        status: valid ? "approved" : "stale",
        lectureEvidence: refs.filter((e) => lecturePages.has(e.sourceKey)),
        umbrellaEvidence: refs.filter((e) => e.role === "umbrella"),
        referenceLinks: node.referenceLinks ?? [],
      };
    });
    const edges = graph.edges.map((edge) => ({
      id: `${edge.from}:${edge.type}:${edge.to}`,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      reason: edge.reason,
      status:
        edge.evidenceIds.every((id) => allowed.has(id)) &&
        concepts
          .filter((c) => [edge.from, edge.to].includes(c.id))
          .every((c) => c.status === "approved")
          ? "approved"
          : "stale",
      evidence: edge.evidenceIds.flatMap((id) =>
        allowed.has(id) ? [locator(allowed.get(id)!)] : [],
      ),
    }));
    const pages = release?.data.coverage?.pages ?? [];
    const coverage = [...lecturePages].map(([sourceKey, totalPages]) => {
      const ledger = pages.filter((p) => p.sourceKey === sourceKey);
      const ledgerCurrent =
        !!release?.data.coverage &&
        evidence.some(
          (e) =>
            e.source_key === sourceKey &&
            release.data.coverage!.sourceVersionIds.includes(e.version_id),
        );
      const teaching = ledger.filter((p) =>
        ["teaching", "figure"].includes(p.classification),
      );
      const approvedPages = new Set(
        evidence
          .filter((e) => e.source_key === sourceKey && allowed.has(e.id))
          .map((e) => e.page),
      );
      const nodes = concepts.filter((c) =>
        c.lectureEvidence.some((e) => e.sourceKey === sourceKey),
      );
      const mappedTeachingPages = teaching.filter((p) =>
        p.conceptIds.every((id) =>
          nodes.some(
            (n) =>
              n.id === id &&
              n.status === "approved" &&
              n.lectureEvidence.some(
                (e) => e.sourceKey === sourceKey && e.page === p.page,
              ),
          ),
        ),
      ).length;
      return {
        sourceKey,
        totalPages,
        pageCount: ledger.length,
        reviewedPages: ledgerCurrent ? ledger.length : 0,
        approvedPageCount: approvedPages.size,
        teachingPages: teaching.length,
        mappedTeachingPages,
        conceptCount: nodes.length,
        status:
          ledgerCurrent &&
          ledger.length === totalPages &&
          mappedTeachingPages === teaching.length
            ? "complete"
            : "partial",
      };
    });
    const usedIds = new Set([
      ...graph.concepts.flatMap((c) => c.evidenceIds),
      ...graph.edges.flatMap((e) => e.evidenceIds),
    ]);
    const sourceVersions = [
      ...new Map(
        evidence
          .filter((e) => usedIds.has(e.id) && allowed.has(e.id))
          .map((e) => [
            e.version_id,
            {
              id: e.version_id,
              sourceKey: e.source_key,
              title: e.title,
              role: e.role,
              hash: e.hash,
              status: e.material_status,
            },
          ]),
      ).values(),
    ];
    return {
      releaseId: release?.id ?? null,
      status: release ? "published" : "empty",
      publishedAt: release?.data.publishedAt ?? null,
      title: release?.data.coverage?.title ?? null,
      reviewBasis: release?.data.coverage?.reviewBasis ?? null,
      concepts,
      edges,
      coverage,
      pages,
      totals: {
        concepts: concepts.length,
        linkedConcepts: concepts.filter(
          (c) =>
            c.status === "approved" &&
            c.lectureEvidence.length &&
            c.umbrellaEvidence.length,
        ).length,
        edges: edges.length,
        pages: [...lecturePages.values()].reduce((a, b) => a + b, 0),
        reviewedPages: coverage.reduce((n, l) => n + l.reviewedPages, 0),
        teachingPages: coverage.reduce((n, l) => n + l.teachingPages, 0),
        mappedTeachingPages: coverage.reduce(
          (n, l) => n + l.mappedTeachingPages,
          0,
        ),
      },
      sourceVersions,
      fixture: release?.data.fixture === true,
      referencePolicy: {
        gfgMode: "reference_link",
        gfgTextUsed: sourceVersions.some((v) => v.sourceKey === "GFG-UMBRELLA"),
        supplementaryEvidenceDistinct: true,
      },
    };
  });
}
