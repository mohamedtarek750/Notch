/**
 * Normalize reviewed private inventories. This script contains no lecture text.
 * Inputs, authored bilingual summaries and output remain in .tilwa-private.
 * No database access, publication or model/provider calls are performed.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Bilingual = { ar: string; en: string };
type Locator = {
  sourceKey: string;
  page: number;
  claimShort?: string;
  requiresCorrection?: boolean;
  [key: string]: unknown;
};
type RawConcept = {
  key: string;
  label: Bilingual;
  aliases?: string[];
  lectureLocators: Locator[];
  foundationNeeds?: string[];
  relations?: RawRelation[];
  reviewNote?: unknown;
  coverageDepth?: string;
  reviewStatus?: string;
  summary?: Bilingual;
  coverageLevel?: "explained" | "named_only";
  retainedConceptId?: string;
  semanticRole?: string;
  masteryTransferPolicy?: string;
};
type RawRelation = {
  targetKey: string;
  type: "related" | "prerequisite" | "optional_bridge";
  reason: Bilingual;
  pages: (number | Locator)[];
  sourceKey?: string;
  umbrellaSections?: string[];
};
type RawPage = {
  sourceKey: string;
  page: number;
  classification: string;
  conceptKeys: string[];
  reviewNote: unknown;
  [key: string]: unknown;
};
type Correction = {
  sourceKey: string;
  page: number;
  kind: string;
  text: string;
  reviewNote: Bilingual;
  [key: string]: unknown;
};
type Review = {
  concepts: RawConcept[];
  pages: RawPage[];
  corrections: Correction[];
  sources?: Record<string, unknown>[];
  metadata?: {
    physicalPages: Record<string, number>;
    sourceHashes: Record<string, string>;
  };
  [key: string]: unknown;
};
type Summary = {
  summary: Bilingual;
  coverageLevel: "explained" | "named_only";
};
type Decision = {
  page: number;
  status: string;
  classification: string;
  originalClassification?: string;
  requiresImmutableRevision?: boolean;
  note?: Bilingual;
  [key: string]: unknown;
};
type SourcePlan = {
  sources: {
    sourceKey: string;
    pageCount: number;
    corrections: Correction[];
    decisions: Decision[];
  }[];
  [key: string]: unknown;
};

// These are equivalent terms in the reviewed inventories. Related but differently
// scoped concepts (e.g. training vs parameter fitting) deliberately remain distinct.
const synonymMap: Record<string, string> = {
  "neural-network": "artificial-neural-network",
  "majority-vote": "majority-voting",
  "train-test-split": "train-test-split-implementation",
  "training-data-representativeness": "sample-representativeness",
};
const canonicalKey = (key: string) => synonymMap[key] ?? key;
const unique = <T>(values: T[]) => [...new Set(values)];
const pageKey = (sourceKey: string, page: number) => `${sourceKey}:${page}`;
const sha256 = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const directory = path.resolve(
  process.argv[2] ?? ".tilwa-private/comprehensive",
);
const reviewFiles = [
  "review-l1-l2.json",
  "review-l3-l4.json",
  "review-l5-l6.json",
];
const summaryFiles = ["summaries-l1-l2.json", "summaries-l3-l6.json"];
const inputs: { filename: string; sha256: string }[] = [];
async function readJson<T>(filename: string): Promise<T> {
  const data = await readFile(path.join(directory, filename), "utf8");
  inputs.push({ filename, sha256: sha256(data) });
  return JSON.parse(data) as T;
}
const reviews = await Promise.all(
  reviewFiles.map((filename) => readJson<Review>(filename)),
);
const summarySets = await Promise.all(
  summaryFiles.map((filename) => readJson<Record<string, Summary>>(filename)),
);
let additions: { concepts: RawConcept[] } = { concepts: [] };
try {
  additions = await readJson<{ concepts: RawConcept[] }>(
    "canonical-additions.json",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
summarySets.push(
  Object.fromEntries(
    additions.concepts.map((concept) => {
      if (!concept.summary || !concept.coverageLevel)
        throw new Error(`Continuity addition lacks summary: ${concept.key}`);
      return [
        concept.key,
        { summary: concept.summary, coverageLevel: concept.coverageLevel },
      ];
    }),
  ),
);
let plan: SourcePlan | undefined;
try {
  plan = await readJson<SourcePlan>("source-review-plan.json");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const planByPage = new Map(
  (plan?.sources ?? []).flatMap((source) =>
    source.decisions.map(
      (decision) =>
        [pageKey(source.sourceKey, decision.page), decision] as const,
    ),
  ),
);
const correctionByPage = new Map<string, Correction[]>();
for (const correction of reviews.flatMap((review) => review.corrections)) {
  const key = pageKey(correction.sourceKey, correction.page);
  correctionByPage.set(key, [...(correctionByPage.get(key) ?? []), correction]);
}
// The effective plan supersedes raw correction proposals; originals are retained
// separately in the output, including proposals for later-rejected decorative pages.
if (plan) correctionByPage.clear();
for (const source of plan?.sources ?? [])
  for (const correction of source.corrections) {
    correctionByPage.set(pageKey(source.sourceKey, correction.page), [
      {
        ...correction,
        sourceKey: source.sourceKey,
        approvalStatus: "pending_immutable_revision_and_authenticated_review",
      },
    ]);
  }
const reviewedRawConcepts = reviews.flatMap((review) => review.concepts);
const allRawConcepts = [...reviewedRawConcepts, ...additions.concepts];
const rawKeys = new Set(allRawConcepts.map((concept) => concept.key));
const allPages = reviews.flatMap((review) => review.pages);
for (const addition of additions.concepts)
  for (const locator of addition.lectureLocators) {
    const page = allPages.find(
      (candidate) =>
        candidate.sourceKey === locator.sourceKey &&
        candidate.page === locator.page,
    );
    if (!page)
      throw new Error(
        `Continuity addition has unknown page ${locator.sourceKey}:${locator.page}`,
      );
    page.conceptKeys = unique([...page.conceptKeys, addition.key]);
  }
const pageMap = new Map(
  allPages.map((page) => [pageKey(page.sourceKey, page.page), page]),
);
const issues: Record<string, unknown>[] = [];
const fixes: Record<string, unknown>[] = [];
if (pageMap.size !== allPages.length || allPages.length !== 137)
  throw new Error("Expected exactly 137 unique source pages.");
const knownCounts: Record<string, number> = {
  "CET351-L1": 18,
  "CET351-L2": 24,
  "CET351-L3": 18,
  "CET351-L4": 25,
  "CET351-L5": 26,
  "CET351-L6": 26,
};
for (const [sourceKey, count] of Object.entries(knownCounts))
  for (let page = 1; page <= count; page++) {
    if (!pageMap.has(pageKey(sourceKey, page)))
      throw new Error(`Missing physical page ${sourceKey}:${page}`);
  }
function resolveLocator(locator: Locator): Locator {
  if (!pageMap.has(pageKey(locator.sourceKey, locator.page)))
    throw new Error(`Unknown locator ${JSON.stringify(locator)}`);
  const original = pageMap.get(pageKey(locator.sourceKey, locator.page))!;
  const decision = planByPage.get(pageKey(locator.sourceKey, locator.page));
  const corrections =
    correctionByPage.get(pageKey(locator.sourceKey, locator.page)) ?? [];
  const requiresCorrection = Boolean(
    locator.requiresCorrection ||
    corrections.length ||
    decision?.requiresImmutableRevision,
  );
  const sourceStatus =
    decision?.status ??
    (original.classification === "quarantined"
      ? "quarantined"
      : "pending_review");
  return {
    ...locator,
    requiresCorrection,
    correctionKinds: unique(corrections.map((correction) => correction.kind)),
    sourceStatus,
    evidenceEligible: sourceStatus === "approved",
    // Eligibility describes the review plan only. Publication must verify the
    // authenticated approval against the actual immutable extraction in storage.
    approvalBasis:
      sourceStatus === "approved"
        ? "review_plan_pending_database_verification"
        : "not_approved",
  };
}
type Concept = {
  key: string;
  rawKeys: string[];
  label: Bilingual;
  aliases: string[];
  summary: Bilingual;
  scope: "course";
  courseId: "CET351";
  coverageLevel: "explained" | "named_only";
  lectureLocators: Locator[];
  foundationNeeds: string[];
  reviewNotes: unknown[];
  rawReviewMetadata: Record<string, unknown>[];
  retainedConceptId?: string;
  semanticRole?: string;
  masteryTransferPolicy?: string;
};
const conceptMap = new Map<string, Concept>();
for (const raw of allRawConcepts) {
  const key = canonicalKey(raw.key);
  const summaries = summarySets.flatMap((set) =>
    set[raw.key] ? [set[raw.key]] : [],
  );
  if (
    !summaries.length ||
    summaries.some((item) => !item.summary.ar || !item.summary.en)
  )
    throw new Error(`Missing bilingual summary for ${raw.key}`);
  const preferred = summaries.at(-1)!;
  let concept = conceptMap.get(key);
  if (!concept) {
    concept = {
      key,
      rawKeys: [],
      label: raw.label,
      aliases: [],
      summary: preferred.summary,
      scope: "course",
      courseId: "CET351",
      coverageLevel: preferred.coverageLevel,
      lectureLocators: [],
      foundationNeeds: [],
      reviewNotes: [],
      rawReviewMetadata: [],
    };
    conceptMap.set(key, concept);
  }
  // More detailed later-lecture summaries take precedence while coverage is the
  // maximum actually explained anywhere in the reviewed course.
  if (preferred.coverageLevel === "explained") {
    concept.summary = preferred.summary;
    concept.coverageLevel = "explained";
  }
  if (raw.key === key) concept.label = raw.label;
  if (raw.retainedConceptId) concept.retainedConceptId = raw.retainedConceptId;
  if (raw.semanticRole) concept.semanticRole = raw.semanticRole;
  if (raw.masteryTransferPolicy)
    concept.masteryTransferPolicy = raw.masteryTransferPolicy;
  concept.rawKeys = unique([...concept.rawKeys, raw.key]);
  concept.aliases = unique([
    ...concept.aliases,
    raw.label.ar,
    raw.label.en,
    ...(raw.aliases ?? []),
  ]);
  concept.foundationNeeds = unique([
    ...concept.foundationNeeds,
    ...(raw.foundationNeeds ?? []),
  ]);
  concept.lectureLocators.push(...raw.lectureLocators.map(resolveLocator));
  if (raw.reviewNote) concept.reviewNotes.push(raw.reviewNote);
  concept.rawReviewMetadata.push({
    rawKey: raw.key,
    coverageDepth: raw.coverageDepth ?? null,
    reviewStatus: raw.reviewStatus ?? null,
  });
}
// The page ledger itself is reviewed evidence for where a concept occurs. Add
// missing exact-page occurrence locators without inventing formulae or claims.
const pages = allPages.map((page) => {
  const decision = planByPage.get(pageKey(page.sourceKey, page.page));
  const keys = unique(page.conceptKeys.map(canonicalKey));
  for (const rawKey of page.conceptKeys)
    if (!rawKeys.has(rawKey)) throw new Error(`Unknown page concept ${rawKey}`);
  for (const key of keys) {
    const concept = conceptMap.get(key)!;
    if (
      !concept.lectureLocators.some(
        (locator) =>
          locator.sourceKey === page.sourceKey && locator.page === page.page,
      )
    ) {
      const safe = decision?.status === "approved";
      concept.lectureLocators.push(
        resolveLocator({
          sourceKey: page.sourceKey,
          page: page.page,
          claimShort: `The reviewed page ledger associates this page with ${concept.label.en}. ${typeof page.reviewNote === "string" ? page.reviewNote : ""}`,
          locatorOrigin: "reviewed_page_ledger",
          coverageOnly: !safe,
        }),
      );
      fixes.push({
        type: "page_ledger_locator_added",
        key,
        sourceKey: page.sourceKey,
        page: page.page,
        originalClassification: page.classification,
        sourceStatus: decision?.status ?? "pending_review",
        basis:
          "Existing reviewed page conceptKeys and reviewNote only; no new lecture claim inferred.",
      });
    }
  }
  const effectiveClassification =
    decision?.classification ?? page.classification;
  if (["teaching", "figure"].includes(effectiveClassification) && !keys.length)
    issues.push({
      type: "empty_teaching_or_figure_page",
      sourceKey: page.sourceKey,
      page: page.page,
    });
  return {
    ...page,
    conceptKeys: keys,
    rawConceptKeys: page.conceptKeys,
    originalClassification: page.classification,
    effectiveClassification,
    status: decision?.status ?? "pending_review",
    requiresImmutableRevision: Boolean(
      decision?.requiresImmutableRevision ||
      correctionByPage.has(pageKey(page.sourceKey, page.page)),
    ),
    decisionNote: decision?.note ?? null,
  };
});
for (const concept of conceptMap.values()) {
  const seen = new Set<string>();
  concept.lectureLocators = concept.lectureLocators
    .filter((locator) => {
      const key = JSON.stringify([
        locator.sourceKey,
        locator.page,
        locator.claimShort,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.page - b.page);
  if (!concept.lectureLocators.some((locator) => locator.evidenceEligible))
    issues.push({
      type: "concept_without_plan_approved_locator",
      key: concept.key,
      requiresPublicationResolution: true,
    });
}
type Relation = {
  fromKey: string;
  toKey: string;
  type: RawRelation["type"];
  reason: Bilingual;
  reviewReasons: Bilingual[];
  pages: Locator[];
  sourceKeys: string[];
  umbrellaSections?: string[];
  prerequisiteScope?: string;
};
const relationsMap = new Map<string, Relation>();
let selfEdgesRemoved = 0;
for (const raw of allRawConcepts)
  for (const edge of raw.relations ?? []) {
    const fromKey = canonicalKey(raw.key);
    const toKey = canonicalKey(edge.targetKey);
    if (!conceptMap.has(toKey))
      throw new Error(`Unknown relation endpoint ${edge.targetKey}`);
    if (fromKey === toKey) {
      selfEdgesRemoved++;
      continue;
    }
    const type = edge.type;
    if (!["related", "prerequisite", "optional_bridge"].includes(type))
      throw new Error(`Unknown relation type ${type}`);
    const locators = edge.pages.map((page) => {
      if (typeof page !== "number") return resolveLocator(page);
      if (!edge.sourceKey)
        throw new Error(
          `Relation lacks sourceKey: ${raw.key} -> ${edge.targetKey}`,
        );
      return resolveLocator({ sourceKey: edge.sourceKey, page });
    });
    const id = `${fromKey}|${toKey}|${type}`;
    const existing = relationsMap.get(id);
    if (existing) {
      existing.pages.push(...locators);
      if (edge.umbrellaSections)
        existing.umbrellaSections = unique([
          ...(existing.umbrellaSections ?? []),
          ...edge.umbrellaSections,
        ]);
      if (
        !existing.reviewReasons.some(
          (reason) =>
            reason.ar === edge.reason.ar && reason.en === edge.reason.en,
        )
      )
        existing.reviewReasons.push(edge.reason);
    } else {
      relationsMap.set(id, {
        fromKey,
        toKey,
        type,
        reason: edge.reason,
        reviewReasons: [edge.reason],
        pages: locators,
        sourceKeys: [],
        ...(edge.umbrellaSections
          ? { umbrellaSections: edge.umbrellaSections }
          : {}),
        ...(type === "prerequisite"
          ? {
              prerequisiteScope:
                "The cited calculation or procedural objective only; not a blanket course-wide requirement.",
            }
          : {}),
      });
    }
  }
const relations = [...relationsMap.values()];
for (const edge of relations) {
  const seen = new Set<string>();
  edge.pages = edge.pages.filter((locator) => {
    const key = pageKey(locator.sourceKey, locator.page);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  edge.sourceKeys = unique(edge.pages.map((locator) => locator.sourceKey));
  if (!edge.pages.length)
    throw new Error(
      `Relation without source pages: ${edge.fromKey} -> ${edge.toKey}`,
    );
}
const outgoing = new Map<string, string[]>();
for (const edge of relations.filter((edge) => edge.type === "prerequisite"))
  outgoing.set(edge.fromKey, [
    ...(outgoing.get(edge.fromKey) ?? []),
    edge.toKey,
  ]);
function visit(key: string, trail: Set<string>, done: Set<string>) {
  if (trail.has(key)) throw new Error(`Prerequisite cycle at ${key}`);
  if (done.has(key)) return;
  const next = new Set(trail).add(key);
  for (const target of outgoing.get(key) ?? []) visit(target, next, done);
  done.add(key);
}
const done = new Set<string>();
for (const key of conceptMap.keys()) visit(key, new Set(), done);
const sources = Object.entries(knownCounts).map(
  ([sourceKey, physicalPages]) => {
    const source = reviews
      .flatMap((review) => review.sources ?? [])
      .find((source) => source.sourceKey === sourceKey);
    const review = reviews.find(
      (review) => review.metadata?.sourceHashes?.[sourceKey],
    );
    return {
      ...(source ?? {}),
      sourceKey,
      physicalPages,
      sha256: source?.sha256 ?? review?.metadata?.sourceHashes[sourceKey],
    };
  },
);
const concepts = [...conceptMap.values()].sort((a, b) =>
  a.key.localeCompare(b.key),
);
// Match the database's concept identity normalization exactly. These reviewed
// owners disambiguate loose aliases without merging distinct learning concepts.
const normalizeAlias = (value: string) => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();
const aliasOwners: Record<string, string> = {
  "data preprocessing": "data-preprocessing",
  normalization: "feature-scaling",
  "feature engineering": "feature-engineering",
  "k fold cv": "k-fold-cross-validation",
  "ensemble learning": "ensemble-learning",
  "ensemble methods": "ensemble-learning",
  "train test split": "train-test-split-implementation",
  "majority class": "majority-minority-classes",
};
function aliasCollisions() {
  const owners = new Map<string, Set<string>>();
  for (const concept of concepts) for (const alias of [concept.label.ar, concept.label.en, ...concept.aliases]) {
    const normalized = normalizeAlias(alias);
    owners.set(normalized, new Set([...(owners.get(normalized) ?? []), concept.key]));
  }
  return [...owners].filter(([, keys]) => keys.size > 1).map(([normalized, keys]) => ({ normalized, conceptKeys: [...keys].sort() }));
}
const aliasCollisionsBefore = aliasCollisions();
const removedAliases: { conceptKey: string; alias: string; normalized: string; canonicalOwner: string }[] = [];
for (const concept of concepts) {
  for (const label of [concept.label.ar, concept.label.en]) {
    const owner = aliasOwners[normalizeAlias(label)];
    if (owner && owner !== concept.key) throw new Error(`A concept label conflicts with reviewed alias ownership: ${concept.key}`);
  }
  concept.aliases = concept.aliases.filter((alias) => {
    const normalized = normalizeAlias(alias);
    const owner = aliasOwners[normalized];
    if (!owner || owner === concept.key) return true;
    removedAliases.push({ conceptKey: concept.key, alias, normalized, canonicalOwner: owner });
    return false;
  });
}
const aliasCollisionsAfter = aliasCollisions();
if (aliasCollisionsAfter.length) throw new Error(`Unresolved normalized concept aliases: ${JSON.stringify(aliasCollisionsAfter)}`);
type PriorConcept = { id: string; data: { label: Bilingual; aliases?: string[] } };
let priorConcepts: PriorConcept[] = [];
try { priorConcepts = await readJson<PriorConcept[]>("prior-concepts.json"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const priorAliasAudit = priorConcepts.map((prior) => {
  const aliases = unique([prior.data.label.ar, prior.data.label.en, ...(prior.data.aliases ?? [])].map(normalizeAlias));
  const matches = concepts.filter((concept) => [concept.label.ar, concept.label.en, ...concept.aliases].some((alias) => aliases.includes(normalizeAlias(alias))));
  if (matches.length !== 1 || matches[0].retainedConceptId !== prior.id) throw new Error(`Prior concept alias identity is ambiguous or missing: ${prior.id}`);
  const matched = matches[0];
  const current = new Set([matched.label.ar, matched.label.en, ...matched.aliases].map(normalizeAlias));
  if (aliases.some((alias) => !current.has(alias))) throw new Error(`Prior alias lost for ${prior.id}`);
  return { id: prior.id, conceptKey: matched.key, normalizedAliases: aliases, allAliasesPreserved: true };
});
const aliasRevision = {
  normalization: "NFKC; lowercase; remove Arabic diacritics U+064B–065F/U+0670; replace non-Unicode letters/numbers with spaces; trim (identical to server knowledge.normalize)",
  collisionsBefore: aliasCollisionsBefore,
  removedAliases,
  collisionsAfter: aliasCollisionsAfter,
  priorAliasAudit,
  policy: "Only loose aliases were removed from non-owning concepts; concept keys, labels, summaries, locators, relations and prior identities are unchanged.",
};
const count = (values: string[]) =>
  Object.fromEntries(
    unique(values)
      .sort()
      .map((key) => [key, values.filter((value) => value === key).length]),
  );
const report = {
  rawConceptRecords: reviewedRawConcepts.length,
  continuityConceptRecords: additions.concepts.length,
  uniqueRawKeys: rawKeys.size,
  canonicalConcepts: concepts.length,
  rawRelationRecords: allRawConcepts.reduce(
    (sum, concept) => sum + (concept.relations?.length ?? 0),
    0,
  ),
  normalizedRelations: relations.length,
  relationTypes: count(relations.map((edge) => edge.type)),
  selfEdgesRemoved,
  physicalPages: pages.length,
  pageCounts: knownCounts,
  pageClassifications: count(pages.map((page) => page.effectiveClassification)),
  pageStatuses: count(pages.map((page) => page.status)),
  coverageLevels: count(concepts.map((concept) => concept.coverageLevel)),
  exactPageLocatorCoverage: pages.every((page) =>
    page.conceptKeys.every((key) =>
      conceptMap
        .get(key)!
        .lectureLocators.some(
          (locator) =>
            locator.sourceKey === page.sourceKey && locator.page === page.page,
        ),
    ),
  ),
  bilingualSummariesComplete: concepts.every((concept) =>
    Boolean(concept.summary.ar && concept.summary.en),
  ),
  prerequisiteCycles: 0,
  synonymMappings: synonymMap,
  fixes,
  issues,
  sourceReviewPlanPresent: Boolean(plan),
  aliasRevision,
};
const output = {
  schemaVersion: 1,
  courseId: "CET351",
  scope: "course",
  reviewStatus: "merged_review_inventory_not_database_approval",
  provenance: {
    inputs: [...inputs].sort((a, b) => a.filename.localeCompare(b.filename)),
    summaryAuthorship:
      "Agent-authored bilingual synthesis of reviewed lecture inventories; no Gemini generation for these summaries and no institutional human sign-off.",
    evidencePolicy:
      "Only approved immutable database evidence may be published. Plan eligibility is conditional on corrections and authenticated source-review decisions being applied. Quarantined, rejected and pending locators remain for coverage provenance only.",
  },
  sources,
  concepts,
  relations,
  pages,
  corrections: [...correctionByPage.values()].flat(),
  originalCorrectionProposals: reviews.flatMap((review) => review.corrections),
  report,
};
await writeFile(
  path.join(directory, "canonical-inventory.json"),
  JSON.stringify(output, null, 2) + "\n",
);
await writeFile(
  path.join(directory, "canonical-review-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    file: path.join(directory, "canonical-inventory.json"),
    concepts: concepts.length,
    relations: relations.length,
    pages: pages.length,
    fixes: fixes.length,
    issues: issues.length,
    sourceReviewPlanPresent: Boolean(plan),
  aliasRevision,
  }),
);
