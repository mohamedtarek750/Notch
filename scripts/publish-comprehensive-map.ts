/**
 * Reviewed, resumable CET351 publication. This does not provision resources or migrate a database.
 * Run with server DATABASE_URL; add GEMINI_API_KEY for --advisories. Credentials are never loaded
 * from a committed file, written to the receipt, or included in diagnostic output.
 *
 * npx tsx scripts/publish-comprehensive-map.ts --validate
 * npx tsx scripts/publish-comprehensive-map.ts --sources
 * npx tsx scripts/publish-comprehensive-map.ts --advisories
 * npx tsx scripts/publish-comprehensive-map.ts --publish
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import gfgIndex from "../pilot/umbrella/gfg-reference-index.json";
import { db } from "../src/server/db";
import {
  authorizeCourse,
  authorizeCourseInTransaction,
  type AuthContext,
} from "../src/server/auth";
import {
  importSupplement,
  reviseMaterialExtracts,
  reviewMaterialChunks,
  COURSE,
  SourceError,
} from "../src/server/sources";
import {
  comprehensiveInput,
  getPublishedConceptMap,
  lectureKeys,
  lecturePages,
  pageClassification,
  referenceLinkSchema,
  readCurrentEvidence,
  permittedEvidence,
  validateComprehensiveCoverage,
  type ComprehensiveInput,
  type CurrentEvidence,
} from "../src/server/coverage";
import {
  stageComprehensiveGraph,
  reviewProposal,
  publishKnowledge,
  proposeKnowledge,
  validateGraph,
  type Graph,
} from "../src/server/knowledge";

const PRIVATE = ".tilwa-private/comprehensive";
const MODEL = "gemini-3.5-flash-lite";
const paths = {
  ids: ".tilwa-private/live-workspace-ids.json",
  plan: `${PRIVATE}/source-review-plan.json`,
  inventory: `${PRIVATE}/canonical-inventory.json`,
  foundations: "pilot/umbrella/comprehensive-foundations-map.json",
  checkpoint: `${PRIVATE}/publication-checkpoint.json`,
  map: `${PRIVATE}/published-map.json`,
  payload: `${PRIVATE}/staged-payload.json`,
  report: "docs/evidence/comprehensive-map.json",
};
const bilingual = z.object({ ar: z.string().min(1), en: z.string().min(1) });
const decisionSchema = z.object({
  page: z.number().int().positive(),
  status: z.enum(["approved", "rejected", "quarantined"]),
  note: bilingual,
  classification: pageClassification,
  originalClassification: z.string().optional(),
  requiresImmutableRevision: z.boolean().optional(),
});
const planSchema = z.object({
  sources: z
    .array(
      z.object({
        sourceKey: z.enum(lectureKeys),
        pageCount: z.number().int().positive(),
        corrections: z
          .array(
            z.object({
              page: z.number().int().positive(),
              text: z.string().min(20).max(30000),
              reviewNote: bilingual,
              kind: z.string().optional(),
            }),
          )
          .min(1),
        decisions: z.array(decisionSchema),
      }),
    )
    .length(6),
  unresolved: z
    .array(
      z.object({
        sourceKey: z.enum(lectureKeys),
        page: z.number().int().positive(),
      }),
    )
    .optional(),
});
const pageLocator = z.object({
  sourceKey: z.enum(lectureKeys),
  page: z.number().int().positive(),
});
const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  courseId: z.literal("CET351"),
  concepts: z
    .array(
      z.object({
        key: z.string().min(1),
        rawKeys: z.array(z.string()).min(1),
        label: bilingual,
        aliases: z.array(z.string()),
        summary: bilingual,
        scope: z.enum(["course", "foundation"]).default("course"),
        coverageLevel: z.enum(["explained", "named_only"]),
        lectureLocators: z.array(pageLocator).min(1),
        referenceLinks: z.array(referenceLinkSchema).optional(),
        retainedConceptId: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
  relations: z
    .array(
      z.object({
        fromKey: z.string(),
        toKey: z.string(),
        type: z.enum(["related", "prerequisite", "optional_bridge"]),
        reason: bilingual,
        pages: z.array(pageLocator).min(1),
        umbrellaSections: z.array(z.string().regex(/^U\d+$/)).optional(),
      }),
    )
    .max(1500),
  pages: z
    .array(
      z.object({
        sourceKey: z.enum(lectureKeys),
        page: z.number().int().positive(),
        conceptKeys: z.array(z.string()),
      }),
    )
    .length(137),
});
const foundationsSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKey: z.literal("TILWA-PILOT-FOUNDATIONS"),
  version: z.string(),
  contentPath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sectionIds: z
    .array(z.string().regex(/^U\d+$/))
    .min(1)
    .max(100),
  conceptSections: z.record(
    z.string(),
    z.array(z.string().regex(/^U\d+$/)).min(1),
  ),
  sections: z.array(
    z.object({
      id: z.string(),
      title: bilingual,
      review: z.object({
        status: z.enum(["approved", "rejected", "quarantined"]),
        note: bilingual,
      }),
    }),
  ),
});
export type SourcePlan = z.infer<typeof planSchema>;
export type CanonicalInventory = z.infer<typeof inventorySchema>;
export type Foundations = z.infer<typeof foundationsSchema>;
type HistoryRow = { id: string; kind: string; hash: string };
type SourceCheckpoint = {
  baseVersionId?: string;
  versionId?: string;
  reviewed?: boolean;
  published?: boolean;
};
type Receipt = {
  schemaVersion: 1;
  tenantId: string;
  instructorId: string;
  startedAt: string;
  inputs: {
    plan: string;
    inventory: string;
    foundations: string;
    supplement: string;
  };
  before: HistoryRow[];
  sources: Record<string, SourceCheckpoint>;
  sourcesCompletedAt?: string;
  advisories: Record<
    string,
    { proposalId: string; modelId: string; scope: unknown; completedAt: string }
  >;
  advisoryFailures: Record<string, string>;
  proposalId?: string;
  releaseId?: string;
  publishedAt?: string;
  preservation?: {
    unchangedExisting: boolean;
    beforeCount: number;
    afterCount: number;
    addedCount: number;
    changedCount: number;
    missingCount: number;
  };
};
type Inputs = {
  ctx: AuthContext;
  plan: SourcePlan;
  inventory: CanonicalInventory;
  foundations: Foundations;
  supplement: string;
  hashes: Receipt["inputs"];
};
class PublicationError extends Error {}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const note = (value: { ar: string; en: string }) => `${value.ar}\n${value.en}`;
const locKey = (value: { sourceKey: string; page: number }) =>
  `${value.sourceKey}:${value.page}`;

/** Select metadata from the reviewed index, never invent an article URL or import its body. */
export function reviewedReference(key: string, englishLabel: string) {
  const term = `${key} ${englishLabel}`.toLowerCase();
  const categories: [RegExp, string, string][] = [
    [
      /naive.bayes|conditional.independence|class.prior|posterior|likelihood/,
      "Naive Bayes",
      "بايز الساذج",
    ],
    [
      /precision|recall|specificity|sensitivity|confusion|true.positive|true.negative|false.positive|false.negative|accuracy|f1|f-score|denominator|evaluation.metric/,
      "Evaluation Metrics",
      "مقاييس التقييم",
    ],
    [
      /cross.validation|train.test|training.data|test.data|validation.data|dataset.split/,
      "Cross Validation",
      "التحقق المتقاطع وتقسيم البيانات",
    ],
    [
      /overfit|underfit/,
      "Underfitting and Overfitting",
      "نقص الملاءمة وفرط الملاءمة",
    ],
    [/bias|variance/, "Bias and Variance", "الانحياز والتباين"],
    [/regulariz/, "Regularization", "التنظيم"],
    [
      /hyperparameter|learning.rate|parameter.tuning/,
      "Hyperparameter Tuning",
      "ضبط المعاملات الفائقة",
    ],
    [
      /support.vector|svm|hyperplane|margin/,
      "Support Vector Machine",
      "آلة المتجهات الداعمة",
    ],
    [
      /random.forest|ensemble|bagging|bootstrap|out.of.bag|majority/,
      "Ensemble Learning",
      "التعلّم التجميعي",
    ],
    [
      /decision.tree|gini|entropy|information.gain|leaf.node|root.node|split.criterion/,
      "Decision Tree",
      "شجرة القرار",
    ],
    [
      /knn|nearest.neigh|euclidean|manhattan|minkowski|distance.metric/,
      "K-Nearest",
      "أقرب الجيران",
    ],
    [
      /reinforcement|agent|reward|policy.learning/,
      "Reinforcement Learning",
      "التعلّم بالتعزيز",
    ],
    [/semi.supervised/, "Semi-Supervised Learning", "التعلّم شبه الموجّه"],
    [/self.supervised/, "Self-Supervised Learning", "التعلّم الذاتي الإشراف"],
    [/unsupervised|cluster/, "Unsupervised Learning", "التعلّم غير الموجّه"],
    [
      /neural|deep.learning|activation|perceptron/,
      "Deep Learning",
      "التعلّم العميق",
    ],
    [/numpy/, "Numpy", "مكتبة NumPy"],
    [
      /python|scikit|sklearn|pandas|matplotlib/,
      "Python for Machine Learning",
      "بايثون لتعلّم الآلة",
    ],
    [
      /probability|bayes|random.variable|conditional/,
      "Probability for Data Science",
      "الاحتمالات لعلم البيانات",
    ],
    [
      /gradient|derivative|calculus|optimization|loss|cost.function/,
      "Calculus for Data Science",
      "التفاضل لتحسين النماذج",
    ],
    [
      /matrix|vector|linear.algebra/,
      "Linear Algebra for Data Science",
      "الجبر الخطي لعلم البيانات",
    ],
    [
      /statistics|mean|median|sampling|sample|correlation/,
      "Statistics for Data Science",
      "الإحصاء لعلم البيانات",
    ],
    [
      /preprocess|feature.scal|normaliz|standardiz|missing.value|cleaning/,
      "Data Preprocessing",
      "معالجة البيانات المسبقة",
    ],
    [
      /machine.learning|artificial.intelligence|classification|regression|supervised|algorithm|feature|target|label/,
      "Machine Learning Tutorial",
      "مقدمة تعلّم الآلة",
    ],
  ];
  for (const [pattern, title, ar] of categories) {
    if (!pattern.test(term)) continue;
    const topic = gfgIndex.topics.find((t) =>
      t.title.toLowerCase().startsWith(title.toLowerCase()),
    );
    if (topic)
      return {
        sourceKey: "GFG-UMBRELLA" as const,
        title: {
          ar: `رابط مرجعي: ${ar}`,
          en: `Reference link: ${topic.title}`,
        },
        url: topic.href,
        mode: "reference_link" as const,
      };
  }
  return {
    sourceKey: "GFG-UMBRELLA" as const,
    title: {
      ar: "الفهرس المرجعي العام للذكاء الاصطناعي وتعلّم الآلة وعلم البيانات",
      en: "General reference index: AI, ML and Data Science",
    },
    url: gfgIndex.sourceUrl,
    mode: "reference_link" as const,
  };
}
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new PublicationError(`Cannot read valid JSON at ${path}.`);
  }
}
async function privateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
function safeCode(error: unknown) {
  if (error instanceof SourceError) return error.code;
  if (error instanceof z.ZodError) return "invalid_input_schema";
  return "operation_failed";
}

/** Pure validation/construction: can be tested without a provider or database mutation. */
export function buildStagePayload(
  plan: SourcePlan,
  inventory: CanonicalInventory,
  foundations: Foundations,
  evidence: CurrentEvidence[],
  generatedProposalIds: string[] = [],
): ComprehensiveInput {
  const current = evidence.filter(permittedEvidence);
  const byPage = new Map(
    current
      .filter((e) => e.page !== null)
      .map((e) => [`${e.source_key}:${e.page}`, e.id]),
  );
  const bySection = new Map(
    current
      .filter((e) => e.source_key === foundations.sourceKey && e.section)
      .map((e) => [e.section!, e.id]),
  );
  const decisions = new Map<string, z.infer<typeof decisionSchema>>(
    plan.sources.flatMap((s) =>
      s.decisions.map((d) => [`${s.sourceKey}:${d.page}`, d] as const),
    ),
  );
  const lectureIds = (locators: { sourceKey: string; page: number }[]) => [
    ...new Set(
      locators.flatMap((p) => {
        const id = byPage.get(locKey(p)),
          d = decisions.get(locKey(p));
        if (!d)
          throw new PublicationError(`Missing reviewed locator ${locKey(p)}.`);
        // Inventory retains excluded pages as provenance; only approved teaching claims become citations.
        if (
          d.status !== "approved" ||
          ["title", "administrative", "quarantined"].includes(d.classification)
        )
          return [];
        if (!id)
          throw new PublicationError(
            `Approved current evidence is missing for ${locKey(p)}.`,
          );
        return [id];
      }),
    ),
  ];
  const concepts = inventory.concepts.map((c) => {
    const sections = [
      ...new Set(
        c.rawKeys.flatMap((k) => foundations.conceptSections[k] ?? []),
      ),
    ];
    if (!sections.length)
      throw new PublicationError(
        `Missing umbrella mapping for concept key ${c.key}.`,
      );
    const umbrellaIds = sections.map((section) => {
      const id = bySection.get(section);
      if (!id)
        throw new PublicationError(
          `Approved current original umbrella section ${section} is missing.`,
        );
      return id;
    });
    const lectures = lectureIds(c.lectureLocators);
    if (c.scope !== "foundation" && !lectures.length)
      throw new PublicationError(
        `No eligible lecture evidence for concept key ${c.key}.`,
      );
    return {
      key: c.key,
      label: c.label,
      aliases: c.aliases,
      summary: c.summary,
      scope: c.scope,
      coverageLevel: c.coverageLevel,
      evidenceIds: [...lectures, ...umbrellaIds],
      referenceLinks: [reviewedReference(c.key, c.label.en)],
    };
  });
  const conceptKeys = new Set(concepts.map((c) => c.key));
  return comprehensiveInput.parse({
    title: {
      ar: "خريطة مفاهيم المحاضرات الست ومصادر الأساسيات",
      en: "Six-lecture concept map and foundational sources",
    },
    reviewBasis: {
      ar: "جرد أكاديمي لجميع الصفحات الـ137، مع مراجعة بصرية للتصحيحات ومراجعة تأليف للمادة الأصلية المساندة. مقترحات Gemini محدودة السياق ومحفوظة للمراجعة؛ الخريطة الشاملة مبنية على الجرد المراجع. هذه مراجعة تنفيذية وليست توقيعًا مؤسسيًا.",
      en: "Academic inventory of all 137 pages, visually reviewed corrections, and author review of the original supplementary foundations. Bounded Gemini proposals are retained for review; the comprehensive graph is assembled from the reviewed inventory. This is an implementation review, not institutional sign-off.",
    },
    concepts,
    edges: inventory.relations.map((r) => {
      if (!conceptKeys.has(r.fromKey) || !conceptKeys.has(r.toKey))
        throw new PublicationError(
          "Canonical inventory has a dangling relationship.",
        );
      const evidenceIds = lectureIds(r.pages);
      if (!evidenceIds.length)
        throw new PublicationError(
          "A relationship has no eligible lecture evidence.",
        );
      for (const section of r.umbrellaSections ?? []) {
        const id = bySection.get(section);
        if (!id)
          throw new PublicationError(
            `Approved current relationship umbrella section ${section} is missing.`,
          );
        if (!evidenceIds.includes(id)) evidenceIds.push(id);
      }
      return {
        from: r.fromKey,
        to: r.toKey,
        type: r.type,
        reason: r.reason,
        evidenceIds,
      };
    }),
    pages: inventory.pages.map((p) => {
      const d = decisions.get(locKey(p));
      if (!d)
        throw new PublicationError(
          `Missing explicit decision for ${locKey(p)}.`,
        );
      return {
        sourceKey: p.sourceKey,
        page: p.page,
        classification: d.classification,
        conceptKeys: ["title", "administrative"].includes(d.classification)
          ? []
          : p.conceptKeys,
        note: d.note,
      };
    }),
    generatedProposalIds,
  });
}

/** Validate the complete intended publication before mutating source versions. IDs here are
 * local keys; the live stage later rechecks actual DB evidence and resolves historical IDs. */
export function validateReviewedPlan(
  plan: SourcePlan,
  inventory: CanonicalInventory,
  foundations: Foundations,
) {
  const evidence: CurrentEvidence[] = [
    ...plan.sources.flatMap((s) =>
      s.decisions.map((d) => ({
        id: `${s.sourceKey}:${d.page}`,
        source_key: s.sourceKey,
        title: s.sourceKey,
        role: "instructor",
        version_id: `planned:${s.sourceKey}`,
        page: d.page,
        section: null,
        status: d.status,
        current_version: true,
        rights: { displayExcerpt: true, sendToModel: true },
        material_status: "published",
        hash: "planned",
      })),
    ),
    ...foundations.sections.map((s) => ({
      id: `umbrella:${s.id}`,
      source_key: foundations.sourceKey,
      title: foundations.sourceKey,
      role: "umbrella",
      version_id: "planned:umbrella",
      page: null,
      section: s.id,
      status: s.review.status,
      current_version: true,
      rights: { displayExcerpt: true, sendToModel: true },
      material_status: "published",
      hash: "planned",
    })),
  ];
  const payload = buildStagePayload(plan, inventory, foundations, evidence);
  const graph: Graph = {
    concepts: payload.concepts.map((c) => ({ ...c, id: c.key })),
    edges: payload.edges,
  };
  validateGraph(graph);
  validateComprehensiveCoverage(
    graph,
    {
      version: 1,
      title: payload.title,
      reviewBasis: payload.reviewBasis,
      sourceVersionIds: [...new Set(evidence.map((e) => e.version_id))],
      generatedProposalIds: [],
      pages: payload.pages.map(({ conceptKeys, ...page }) => ({
        ...page,
        conceptIds: conceptKeys,
      })),
    },
    evidence,
  );
  return payload;
}

async function loadInputs(): Promise<Inputs> {
  const [identity, rawPlan, rawInventory, rawFoundations] = await Promise.all([
    readJson(paths.ids),
    readJson(paths.plan),
    readJson(paths.inventory),
    readJson(paths.foundations),
  ]);
  const ids = z
    .object({
      tenantId: z.string().uuid(),
      users: z.object({
        instructor: z.union([
          z.string().uuid(),
          z.object({ id: z.string().uuid() }),
        ]),
      }),
    })
    .parse(identity);
  const plan = planSchema.parse(rawPlan),
    inventory = inventorySchema.parse(rawInventory),
    foundations = foundationsSchema.parse(rawFoundations);
  if (
    plan.unresolved?.some(
      (issue) =>
        plan.sources
          .find((s) => s.sourceKey === issue.sourceKey)
          ?.decisions.find((d) => d.page === issue.page)?.status !==
        "quarantined",
    )
  )
    throw new PublicationError(
      "An unresolved source issue is not explicitly quarantined.",
    );
  if (
    resolve(foundations.contentPath) !==
    resolve("pilot/umbrella/tilwa-ml-foundations.md")
  )
    throw new PublicationError(
      "The foundation content path is not the reviewed original supplement.",
    );
  const supplement = await readFile(foundations.contentPath, "utf8");
  if (hash(supplement) !== foundations.sha256)
    throw new PublicationError(
      "The foundation map hash does not match its original text.",
    );
  const sectionIds = [...supplement.matchAll(/^## (U\d+)\b/gm)].map(
    (m) => m[1],
  );
  if (
    new Set(sectionIds).size !== sectionIds.length ||
    JSON.stringify(sectionIds) !== JSON.stringify(foundations.sectionIds) ||
    foundations.sections.length !== sectionIds.length ||
    foundations.sections.some((s) => !sectionIds.includes(s.id))
  )
    throw new PublicationError(
      "The original umbrella section ledger is incomplete or duplicated.",
    );
  if (new Set(plan.sources.map((s) => s.sourceKey)).size !== 6)
    throw new PublicationError(
      "The source plan must include each of the six lectures exactly once.",
    );
  const inventoryPages = new Set(inventory.pages.map(locKey));
  if (inventoryPages.size !== 137)
    throw new PublicationError(
      "Canonical page coverage is duplicated or incomplete.",
    );
  for (const source of plan.sources) {
    const expected = lecturePages.get(source.sourceKey)!;
    if (
      source.pageCount !== expected ||
      source.decisions.length !== expected ||
      new Set(source.decisions.map((d) => d.page)).size !== expected
    )
      throw new PublicationError(
        `Invalid source ledger for ${source.sourceKey}.`,
      );
    const correctionPages = new Set(source.corrections.map((c) => c.page));
    if (
      correctionPages.size !== source.corrections.length ||
      [...correctionPages].some((p) => p < 1 || p > expected)
    )
      throw new PublicationError(
        `Invalid corrections for ${source.sourceKey}.`,
      );
    for (let page = 1; page <= expected; page++) {
      const d = source.decisions.find((v) => v.page === page);
      if (!d || !inventoryPages.has(`${source.sourceKey}:${page}`))
        throw new PublicationError(`Missing page ${source.sourceKey}:${page}.`);
      if (
        (d.requiresImmutableRevision && !correctionPages.has(page)) ||
        (["teaching", "figure"].includes(d.classification) &&
          d.status !== "approved") ||
        (d.classification === "quarantined" && d.status === "approved")
      )
        throw new PublicationError(
          `Inconsistent review decision for ${source.sourceKey}:${page}.`,
        );
    }
  }
  validateReviewedPlan(plan, inventory, foundations);
  return {
    ctx: {
      tenantId: ids.tenantId,
      userId:
        typeof ids.users.instructor === "string"
          ? ids.users.instructor
          : ids.users.instructor.id,
      role: "instructor",
      courseId: COURSE,
      locale: "ar",
    },
    plan,
    inventory,
    foundations,
    supplement,
    hashes: {
      plan: hash(JSON.stringify(rawPlan)),
      inventory: hash(JSON.stringify(rawInventory)),
      foundations: hash(JSON.stringify(rawFoundations)),
      supplement: hash(supplement),
    },
  };
}

async function snapshotHistory(ctx: AuthContext): Promise<HistoryRow[]> {
  return (
    await db.tenant(ctx.tenantId).query<HistoryRow>(
      `SELECT r.id,r.kind,md5(row_to_json(r)::text) AS hash FROM records r WHERE r.tenant_id=$1 AND r.course_id=$2
      AND (r.kind=ANY($3::text[]) OR r.owner_id IN (SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='student')) ORDER BY r.kind,r.id`,
      [
        ctx.tenantId,
        COURSE,
        [
          "attempt",
          "state",
          "event",
          "recommendation",
          "portfolio",
          "submission",
          "delivery",
          "tutor_memory",
          "override",
          "grade",
          "enrollment",
        ],
      ],
    )
  ).rows;
}
export function compareHistory(before: HistoryRow[], after: HistoryRow[]) {
  const current = new Map(after.map((r) => [r.id, r]));
  const oldIds = new Set(before.map((r) => r.id));
  const missingCount = before.filter((r) => !current.has(r.id)).length;
  const changedCount = before.filter(
    (r) => current.has(r.id) && current.get(r.id)!.hash !== r.hash,
  ).length;
  return {
    unchangedExisting: !missingCount && !changedCount,
    beforeCount: before.length,
    afterCount: after.length,
    addedCount: after.filter((r) => !oldIds.has(r.id)).length,
    changedCount,
    missingCount,
  };
}
async function receiptFor(input: Inputs): Promise<Receipt> {
  let receipt: Receipt | undefined;
  try {
    receipt = JSON.parse(await readFile(paths.checkpoint, "utf8")) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PublicationError(
        "Existing checkpoint cannot be parsed; preserve it before retrying.",
      );
  }
  if (receipt) {
    if (
      receipt.schemaVersion !== 1 ||
      receipt.tenantId !== input.ctx.tenantId ||
      receipt.instructorId !== input.ctx.userId ||
      JSON.stringify(receipt.inputs) !== JSON.stringify(input.hashes)
    )
      throw new PublicationError(
        "The checkpoint belongs to different inputs or identity; do not overwrite a partially published run.",
      );
    return receipt;
  }
  receipt = {
    schemaVersion: 1,
    tenantId: input.ctx.tenantId,
    instructorId: input.ctx.userId,
    startedAt: new Date().toISOString(),
    inputs: input.hashes,
    before: await snapshotHistory(input.ctx),
    sources: {},
    advisories: {},
    advisoryFailures: {},
  };
  await privateJson(paths.checkpoint, receipt);
  return receipt;
}
async function currentVersion(ctx: AuthContext, sourceKey: string) {
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<{ id: string; hash: string; status: string }>(
        "SELECT id,hash,status FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND source_key=$3 AND current_version=true",
        [ctx.tenantId, COURSE, sourceKey],
      )
  ).rows;
  if (rows.length !== 1)
    throw new PublicationError(
      `Expected one current source version for ${sourceKey}. Import the original pack first.`,
    );
  return rows[0];
}
async function chunksFor(ctx: AuthContext, versionId: string) {
  return (
    await db.tenant(ctx.tenantId).query<{
      id: string;
      page: number | null;
      section: string | null;
      status: string;
    }>("SELECT id,page,section,status FROM evidence_chunks WHERE tenant_id=$1 AND course_id=$2 AND version_id=$3 ORDER BY page NULLS LAST,section", [ctx.tenantId, COURSE, versionId])
  ).rows;
}
async function assertSourceCheckpoint(input: Inputs, receipt: Receipt) {
  for (const sourceKey of [...lectureKeys, input.foundations.sourceKey]) {
    const recorded = receipt.sources[sourceKey],
      current = await currentVersion(input.ctx, sourceKey);
    if (
      !recorded?.published ||
      recorded.versionId !== current.id ||
      current.status !== "published"
    )
      throw new PublicationError(
        `Reviewed source ${sourceKey} changed or is not yet published; resume --sources first.`,
      );
  }
}

async function publishSources(input: Inputs, receipt: Receipt) {
  const { ctx } = input;
  if (receipt.sourcesCompletedAt) {
    await assertSourceCheckpoint(input, receipt);
    return;
  }
  for (const source of input.plan.sources) {
    const checkpoint = (receipt.sources[source.sourceKey] ??= {});
    if (!checkpoint.baseVersionId) {
      checkpoint.baseVersionId = (
        await currentVersion(ctx, source.sourceKey)
      ).id;
      await privateJson(paths.checkpoint, receipt);
    }
    if (!checkpoint.versionId) {
      const oldChunks = await chunksFor(ctx, checkpoint.baseVersionId);
      const corrections = source.corrections.map((c) => {
        const chunk = oldChunks.find((old) => old.page === c.page);
        if (!chunk)
          throw new PublicationError(
            `Missing original correction page ${source.sourceKey}:${c.page}.`,
          );
        return { chunkId: chunk.id, text: c.text, note: note(c.reviewNote) };
      });
      checkpoint.versionId = (
        await reviseMaterialExtracts(ctx, checkpoint.baseVersionId, corrections)
      ).id;
      await privateJson(paths.checkpoint, receipt);
    }
    if (
      (await currentVersion(ctx, source.sourceKey)).id !== checkpoint.versionId
    )
      throw new PublicationError(
        `Source ${source.sourceKey} changed outside this checkpoint.`,
      );
    if (!checkpoint.reviewed) {
      const chunks = await chunksFor(ctx, checkpoint.versionId);
      if (chunks.length !== source.pageCount)
        throw new PublicationError(
          `Unexpected extraction page count for ${source.sourceKey}.`,
        );
      await reviewMaterialChunks(
        ctx,
        checkpoint.versionId,
        source.decisions.map((d) => ({
          chunkId: chunks.find((c) => c.page === d.page)!.id,
          status: d.status,
          note: note(d.note),
        })),
      );
      checkpoint.reviewed = true;
      await privateJson(paths.checkpoint, receipt);
    }
    console.log(
      JSON.stringify({
        stage: "source_reviewed",
        sourceKey: source.sourceKey,
        pages: source.pageCount,
        correctedPages: source.corrections.length,
      }),
    );
  }
  const key = input.foundations.sourceKey,
    umbrella = (receipt.sources[key] ??= {});
  if (!umbrella.versionId) {
    umbrella.versionId = (await importSupplement(ctx, input.supplement)).id;
    await privateJson(paths.checkpoint, receipt);
  }
  if ((await currentVersion(ctx, key)).id !== umbrella.versionId)
    throw new PublicationError(
      "The imported original umbrella is not current.",
    );
  if (!umbrella.reviewed) {
    const chunks = await chunksFor(ctx, umbrella.versionId);
    if (chunks.length !== input.foundations.sections.length)
      throw new PublicationError(
        "The original umbrella extraction is incomplete.",
      );
    await reviewMaterialChunks(
      ctx,
      umbrella.versionId,
      input.foundations.sections.map((s) => ({
        chunkId: chunks.find((c) => c.section === s.id)!.id,
        status: s.review.status,
        note: note(s.review.note),
      })),
    );
    umbrella.reviewed = true;
    await privateJson(paths.checkpoint, receipt);
  }
  // Publish only versions with explicit complete decisions, in a course-authorized transaction.
  await db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, COURSE, "publish", tx);
    for (const [sourceKey, saved] of Object.entries(receipt.sources)) {
      const versions = (
        await tx.query<{ id: string }>(
          "SELECT id FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND source_key=$3 AND id=$4 AND current_version=true AND rights->>'displayExcerpt'='true' AND rights->>'sendToModel'='true' FOR UPDATE",
          [ctx.tenantId, COURSE, sourceKey, saved.versionId],
        )
      ).rows;
      const decisions = (
        await tx.query<{ status: string }>(
          "SELECT status FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2",
          [ctx.tenantId, saved.versionId],
        )
      ).rows;
      if (
        versions.length !== 1 ||
        !saved.reviewed ||
        decisions.some(
          (d) => !["approved", "rejected", "quarantined"].includes(d.status),
        ) ||
        !decisions.some((d) => d.status === "approved")
      )
        throw new PublicationError(
          `Source ${sourceKey} no longer satisfies its explicit review.`,
        );
      await tx.query(
        "UPDATE material_versions SET status='published' WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, saved.versionId],
      );
    }
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5) ON CONFLICT(tenant_id,id) DO NOTHING",
      [
        ctx.tenantId,
        `comprehensive-sources:${input.hashes.plan}`,
        COURSE,
        ctx.userId,
        JSON.stringify({
          action: "comprehensive-reviewed-sources-published",
          sourceVersionIds: Object.values(receipt.sources).map(
            (s) => s.versionId,
          ),
          planHash: input.hashes.plan,
          institutionalSignoff: false,
        }),
      ],
    );
  });
  for (const source of Object.values(receipt.sources)) source.published = true;
  receipt.sourcesCompletedAt = new Date().toISOString();
  receipt.preservation = compareHistory(
    receipt.before,
    await snapshotHistory(ctx),
  );
  await privateJson(paths.checkpoint, receipt);
  if (!receipt.preservation.unchangedExisting)
    throw new PublicationError(
      "Existing learner records changed during source publication; inspect the private checkpoint before proceeding.",
    );
  console.log(
    JSON.stringify({
      stage: "sources_published",
      sources: 7,
      lecturePages: 137,
      umbrellaSections: input.foundations.sections.length,
      learnerHistory: receipt.preservation,
    }),
  );
}

async function generateAdvisories(input: Inputs, receipt: Receipt) {
  await assertSourceCheckpoint(input, receipt);
  if (!process.env.GEMINI_API_KEY)
    throw new PublicationError(
      "Set GEMINI_API_KEY in the server environment before --advisories.",
    );
  process.env.GEMINI_MODEL = MODEL;
  for (const sourceKey of lectureKeys) {
    if (receipt.advisories[sourceKey]) continue;
    const source = input.plan.sources.find((s) => s.sourceKey === sourceKey)!;
    const pages = source.decisions
      .filter(
        (d) =>
          d.status === "approved" &&
          ["teaching", "figure"].includes(d.classification),
      )
      .map((d) => d.page)
      .slice(0, 2);
    const concepts = input.inventory.concepts
      .filter((c) =>
        c.lectureLocators.some(
          (p) => p.sourceKey === sourceKey && pages.includes(p.page),
        ),
      )
      .slice(0, 8);
    const sections = [
      ...new Set(
        concepts.flatMap((c) =>
          c.rawKeys.flatMap((k) => input.foundations.conceptSections[k] ?? []),
        ),
      ),
    ].slice(0, 2);
    if (!pages.length || !sections.length)
      throw new PublicationError(
        `No minimal reviewed context is available for ${sourceKey}.`,
      );
    const scope = {
      lectureSourceKey: sourceKey,
      pages,
      umbrellaSections: sections,
      query:
        `Review supported concepts and relationships in ${sourceKey}: ${concepts.map((c) => c.label.en).join("; ")}`.slice(
          0,
          1000,
        ),
    };
    try {
      // Recover a successful DB insertion whose checkpoint write was interrupted.
      const existing = (
        await db
          .tenant(input.ctx.tenantId)
          .query<{ id: string; data: { modelId: string; status: string } }>(
            "SELECT id,data FROM records WHERE tenant_id=$1 AND course_id=$2 AND owner_id=$3 AND kind='knowledge_proposal' AND data->>'modelId'=$4 AND data->'scope'=$5::jsonb AND data->>'status'='pending' AND created_at >= $6::timestamptz ORDER BY created_at DESC LIMIT 1",
            [
              input.ctx.tenantId,
              COURSE,
              input.ctx.userId,
              MODEL,
              JSON.stringify(scope),
              receipt.startedAt,
            ],
          )
      ).rows[0];
      const result = existing
        ? { id: existing.id, modelId: existing.data.modelId }
        : await proposeKnowledge(input.ctx, undefined, scope);
      receipt.advisories[sourceKey] = {
        proposalId: result.id,
        modelId: result.modelId,
        scope,
        completedAt: new Date().toISOString(),
      };
      delete receipt.advisoryFailures[sourceKey];
      await privateJson(paths.checkpoint, receipt);
      console.log(
        JSON.stringify({
          stage: "gemini_advisory_pending_review",
          sourceKey,
          modelId: result.modelId,
          selectedPages: pages,
          umbrellaSections: sections,
        }),
      );
    } catch (error) {
      receipt.advisoryFailures[sourceKey] = safeCode(error);
      await privateJson(paths.checkpoint, receipt);
      console.log(
        JSON.stringify({
          stage: "gemini_advisory_failed",
          sourceKey,
          error: safeCode(error),
        }),
      );
    }
  }
  if (lectureKeys.some((key) => !receipt.advisories[key]))
    throw new PublicationError(
      "Some bounded Gemini advisories failed. Correct the provider/configuration issue and rerun --advisories; successful proposals remain pending and are reused.",
    );
}

async function publishMap(input: Inputs, receipt: Receipt) {
  await assertSourceCheckpoint(input, receipt);
  if (lectureKeys.some((key) => !receipt.advisories[key]))
    throw new PublicationError(
      "Complete the six bounded --advisories before publication.",
    );
  let proposalId = receipt.proposalId;
  if (!proposalId) {
    const evidence = await db
      .tenant(input.ctx.tenantId)
      .transaction((tx) => readCurrentEvidence(tx, input.ctx.tenantId));
    const payload = buildStagePayload(
      input.plan,
      input.inventory,
      input.foundations,
      evidence,
      lectureKeys.map((key) => receipt.advisories[key].proposalId),
    );
    await privateJson(paths.payload, payload);
    proposalId = (await stageComprehensiveGraph(input.ctx, payload)).id;
    receipt.proposalId = proposalId;
    await privateJson(paths.checkpoint, receipt);
  }
  const proposal = (
    await db
      .tenant(input.ctx.tenantId)
      .query<{ data: { status: string; releaseId?: string; graph: Graph } }>(
        "SELECT data FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='knowledge_proposal' AND id=$3",
        [input.ctx.tenantId, COURSE, proposalId],
      )
  ).rows[0];
  if (!proposal)
    throw new PublicationError("The staged comprehensive proposal is missing.");
  for (const node of input.inventory.concepts.filter(
    (c) => c.retainedConceptId,
  )) {
    const retained = proposal.data.graph.concepts.find(
      (c) => c.id === node.retainedConceptId,
    );
    if (!retained || retained.label.en !== node.label.en)
      throw new PublicationError(
        "A retained navigation concept did not preserve its reviewed historical ID.",
      );
  }
  if (proposal.data.status === "rejected")
    throw new PublicationError(
      "The comprehensive proposal was rejected; review it before retrying publication.",
    );
  if (proposal.data.status === "pending")
    await reviewProposal(input.ctx, proposalId, "approved");
  if (proposal.data.status === "published")
    receipt.releaseId = proposal.data.releaseId;
  if (!receipt.releaseId) {
    // Avoid accidentally publishing unrelated instructor work in the same operation.
    const others = (
      await db
        .tenant(input.ctx.tenantId)
        .query<{ id: string }>(
          "SELECT id FROM records WHERE tenant_id=$1 AND course_id=$2 AND kind='knowledge_proposal' AND data->>'status'='approved' AND id<>$3",
          [input.ctx.tenantId, COURSE, proposalId],
        )
    ).rows;
    if (others.length)
      throw new PublicationError(
        "Other approved proposals exist; review their intended publication separately before this run.",
      );
    receipt.releaseId = (await publishKnowledge(input.ctx)).releaseId;
    receipt.publishedAt = new Date().toISOString();
    await privateJson(paths.checkpoint, receipt);
  }
  const map = await getPublishedConceptMap(input.ctx);
  if (
    map.releaseId !== receipt.releaseId ||
    map.concepts.some((c) => c.status !== "approved") ||
    map.edges.some((e) => e.status !== "approved") ||
    map.coverage.some((c) => c.status !== "complete")
  )
    throw new PublicationError(
      "Published map verification failed or a newer release superseded this run.",
    );
  receipt.preservation = compareHistory(
    receipt.before,
    await snapshotHistory(input.ctx),
  );
  await privateJson(paths.checkpoint, receipt);
  await privateJson(paths.map, map);
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    releaseId: receipt.releaseId,
    environment:
      process.env.LOCAL_DATABASE === "1"
        ? "local-simulation"
        : "real-postgresql",
    title: map.title,
    reviewBasis: map.reviewBasis,
    totals: map.totals,
    coverage: map.coverage,
    sourceVersions: map.sourceVersions.map(({ sourceKey, hash, status }) => ({
      sourceKey,
      hash,
      status,
    })),
    sourceReview: {
      lecturePages: 137,
      revisedLectures: 6,
      correctedPages: input.plan.sources.reduce(
        (n, s) => n + s.corrections.length,
        0,
      ),
      umbrellaSections: input.foundations.sections.length,
      institutionalSignoff: false,
    },
    gemini: {
      mode: "real-bounded-advisory",
      modelId: MODEL,
      successfulLectureCalls: Object.keys(receipt.advisories).length,
      status: "pending-review",
      comprehensiveGraphOrigin: "reviewed-instructor-inventory",
    },
    preservation: receipt.preservation,
    references: map.referencePolicy,
    exports: {
      authenticatedMapEndpoint: "/api/knowledge/map",
      privateMapFile: paths.map,
    },
  };
  await mkdir(dirname(paths.report), { recursive: true });
  await writeFile(paths.report, JSON.stringify(report, null, 2) + "\n");
  if (!receipt.preservation.unchangedExisting)
    throw new PublicationError(
      "Existing learner history changed during this run; the evidence report records the failure. Inspect the private checkpoint.",
    );
  console.log(
    JSON.stringify({
      stage: "comprehensive_map_verified",
      releaseId: receipt.releaseId,
      totals: map.totals,
      learnerHistory: receipt.preservation,
      report: paths.report,
    }),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      validate: { type: "boolean" },
      sources: { type: "boolean" },
      advisories: { type: "boolean" },
      publish: { type: "boolean" },
    },
  });
  if (Object.values(values).filter(Boolean).length !== 1)
    throw new PublicationError(
      "Choose exactly one stage: --validate, --sources, --advisories, or --publish.",
    );
  const input = await loadInputs();
  if (values.validate) {
    console.log(
      JSON.stringify({
        stage: "inputs_valid",
        sources: input.plan.sources.length,
        pages: input.inventory.pages.length,
        concepts: input.inventory.concepts.length,
        relations: input.inventory.relations.length,
        umbrellaSections: input.foundations.sections.length,
        providerCalls: 0,
        databaseMutations: 0,
      }),
    );
    return;
  }
  try {
    await authorizeCourse(input.ctx, COURSE, "publish");
    const receipt = await receiptFor(input);
    if (values.sources) await publishSources(input, receipt);
    if (values.advisories) await generateAdvisories(input, receipt);
    if (values.publish) await publishMap(input, receipt);
  } finally {
    await db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        status: "blocked",
        error: safeCode(error),
        message:
          error instanceof PublicationError
            ? error.message
            : "Stage failed. Inspect the validated private inputs and checkpoint; provider responses, source text, and credentials were not printed.",
        ...(error instanceof z.ZodError
          ? {
              issues: error.issues
                .slice(0, 12)
                .map((issue) => ({ path: issue.path, code: issue.code })),
            }
          : {}),
      }),
    );
    process.exitCode = 1;
  });
}
