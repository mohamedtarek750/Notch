/** Client-safe approved map shapes. Exports intentionally project fields rather than spreading API objects. */
export type MapLanguage = "ar" | "en";
export type BilingualLabel = { ar: string; en: string };
export type SourceLocator = {
  id: string;
  sourceKey: string;
  title: string;
  role: string;
  versionId: string;
  page: number | null;
  section: string | null;
  url: string;
};
export type MapConcept = {
  id: string;
  label: BilingualLabel;
  aliases: string[];
  summary?: BilingualLabel;
  scope?: "course" | "foundation";
  coverageLevel?: "explained" | "named_only";
  referenceLinks?: Array<{
    sourceKey: string;
    title: BilingualLabel;
    url: string;
    mode: "reference_link";
  }>;
  status: string;
  lectureEvidence: SourceLocator[];
  umbrellaEvidence: SourceLocator[];
};
export type MapEdge = {
  id?: string;
  from: string;
  to: string;
  type: string;
  status: string;
  reason?: BilingualLabel;
  evidence: SourceLocator[];
};
export type LectureCoverage = {
  sourceKey: string;
  conceptCount: number;
  pageCount: number;
  reviewedPages?: number;
  approvedPageCount: number;
  totalPages: number;
  status: string;
  teachingPages?: number;
  mappedTeachingPages?: number;
};
export type PublishedConceptMap = {
  releaseId: string | null;
  status: string;
  publishedAt?: string;
  concepts: MapConcept[];
  edges: MapEdge[];
  coverage: LectureCoverage[];
  totals?: {
    concepts: number;
    linkedConcepts: number;
    edges: number;
    pages: number;
    reviewedPages: number;
    mappedTeachingPages: number;
    teachingPages: number;
  };
  sourceVersions?: unknown[];
  reviewBasis?: unknown;
  pages?: Array<{
    sourceKey: string;
    page: number;
    classification: string;
    conceptIds?: string[];
    note?: string | BilingualLabel;
  }>;
};
export function searchKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .toLocaleLowerCase()
    .trim();
}
export function filterConcepts(
  concepts: MapConcept[],
  query: string,
  lecture: string,
): MapConcept[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  return concepts.filter((c) => {
    if (lecture === "umbrella" && !c.umbrellaEvidence.length) return false;
    if (
      lecture !== "all" &&
      lecture !== "umbrella" &&
      !c.lectureEvidence.some((e) => e.sourceKey === lecture)
    )
      return false;
    const hay = searchKey(
      [
        c.label.ar,
        c.label.en,
        ...(c.aliases || []),
        c.summary?.ar || "",
        c.summary?.en || "",
      ].join(" "),
    );
    return words.every((word) => hay.includes(word));
  });
}
export function privateSourceHref(source: SourceLocator, origin = ""): string {
  // Always open Tilwa's scoped viewer; never trust arbitrary URLs in retrieved records.
  const location = source.page
    ? `page=${encodeURIComponent(source.page)}`
    : `section=${encodeURIComponent(source.section || "")}`;
  return `${origin}/sources/${encodeURIComponent(source.versionId)}?${location}`;
}
function sourceProjection(s: SourceLocator, origin: string) {
  return {
    id: s.id,
    sourceKey: s.sourceKey,
    title: s.title,
    role: s.role,
    versionId: s.versionId,
    page: s.page ?? null,
    section: s.section ?? null,
    url: privateSourceHref(s, origin),
  };
}
const approved = (status: string) =>
  status === "approved" || status === "published";
export function approvedMapExport(map: PublishedConceptMap, origin: string) {
  const concepts = map.concepts.filter((c) => approved(c.status));
  const ids = new Set(concepts.map((c) => c.id));
  return {
    schemaVersion: 1,
    course: "CET351",
    releaseId: map.releaseId,
    publishedAt: map.publishedAt || null,
    status: "approved",
    pages: (map.pages || []).map((p) => ({
      sourceKey: p.sourceKey,
      page: p.page,
      classification: p.classification,
      conceptIds: (p.conceptIds || []).filter((id) => ids.has(id)),
      note:
        typeof p.note === "string"
          ? p.note
          : p.note
            ? { ar: p.note.ar, en: p.note.en }
            : null,
    })),
    note: {
      ar: "محدّدات المصادر تفتح عبر حساب مصرح له في تِلوا. التصدير لا يتضمن نصوص المحاضرات أو مفاتيح الأسئلة.",
      en: "Source locators require an authorized Tilwa session. This export contains no lecture passages or assessment keys.",
    },
    concepts: concepts.map((c) => ({
      id: c.id,
      label: { ar: c.label.ar, en: c.label.en },
      aliases: [...(c.aliases || [])],
      summary: c.summary ? { ar: c.summary.ar, en: c.summary.en } : undefined,
      scope: c.scope || "course",
      coverageLevel: c.coverageLevel || "explained",
      referenceLinks: (c.referenceLinks || [])
        .filter((r) => safeReferenceUrl(r.url))
        .map((r) => ({
          sourceKey: r.sourceKey,
          title: { ar: r.title.ar, en: r.title.en },
          url: safeReferenceUrl(r.url)!,
          mode: "reference_link",
        })),
      status: "approved",
      lectureEvidence: orderedLocators(c.lectureEvidence).map((s) =>
        sourceProjection(s, origin),
      ),
      umbrellaEvidence: orderedLocators(c.umbrellaEvidence).map((s) =>
        sourceProjection(s, origin),
      ),
    })),
    edges: map.edges
      .filter((e) => approved(e.status) && ids.has(e.from) && ids.has(e.to))
      .map((e) => ({
        id: e.id || `${e.from}:${e.type}:${e.to}`,
        from: e.from,
        to: e.to,
        type: e.type,
        status: "approved",
        reason: e.reason ? { ar: e.reason.ar, en: e.reason.en } : undefined,
        evidence: orderedLocators(e.evidence || []).map((s) =>
          sourceProjection(s, origin),
        ),
      })),
    coverage: map.coverage.map((c) => ({
      sourceKey: c.sourceKey,
      conceptCount: c.conceptCount,
      pageCount: c.pageCount,
      reviewedPages: c.reviewedPages ?? 0,
      approvedPageCount: c.approvedPageCount,
      teachingPages: c.teachingPages ?? 0,
      mappedTeachingPages: c.mappedTeachingPages ?? 0,
      totalPages: c.totalPages,
      status: c.status,
    })),
  };
}
export type MapExport = ReturnType<typeof approvedMapExport>;
export function csvCell(value: unknown): string {
  const valueString = String(value ?? "");
  const safe =
    /^[\s\uFEFF]*[=+@-]/u.test(valueString) || /^[\t\r\n]/.test(valueString)
      ? `'${valueString}`
      : valueString;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function mapCsv(data: MapExport): string {
  const header = [
    "record_type",
    "id",
    "label_ar",
    "label_en",
    "from",
    "to",
    "relationship",
    "lecture_locators",
    "umbrella_locators",
    "evidence_urls",
    "status",
    "coverage_level",
  ];
  const locator = (s: {
    sourceKey: string;
    page: number | null;
    section: string | null;
  }) => `${s.sourceKey} ${s.page ? `p.${s.page}` : s.section || ""}`;
  const concepts = data.concepts.map((c) => [
    "concept",
    c.id,
    c.label.ar,
    c.label.en,
    "",
    "",
    "",
    c.lectureEvidence.map(locator).join(" | "),
    c.umbrellaEvidence.map(locator).join(" | "),
    [...c.lectureEvidence, ...c.umbrellaEvidence].map((s) => s.url).join(" | "),
    c.status,
    c.coverageLevel,
  ]);
  const edges = data.edges.map((e) => [
    "relationship",
    e.id,
    "",
    "",
    e.from,
    e.to,
    e.type,
    e.evidence
      .filter((s) => s.role === "instructor")
      .map(locator)
      .join(" | "),
    e.evidence
      .filter((s) => s.role === "umbrella")
      .map(locator)
      .join(" | "),
    e.evidence.map((s) => s.url).join(" | "),
    e.status,
    "",
  ]);
  return (
    "\uFEFF" +
    [header, ...concepts, ...edges]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
const htmlEscape = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function mapHtmlReport(data: MapExport): string {
  const names = new Map(data.concepts.map((c) => [c.id, c.label]));
  const edgeLabel = (type: string) =>
    ({
      prerequisite: "متطلب سابق / Prerequisite",
      related: "مفهوم مرتبط / Related concept",
      optional_bridge: "جسر اختياري / Optional bridge",
    })[type] || type;
  const sources = (list: MapExport["concepts"][number]["lectureEvidence"]) =>
    list.length
      ? `<ul>${list.map((s) => `<li><a href="${htmlEscape(s.url)}" target="_blank" rel="noreferrer"><bdi>${htmlEscape(s.sourceKey)}</bdi> · ${s.page ? `ص. / p. ${s.page}` : htmlEscape(s.section)}</a></li>`).join("")}</ul>`
      : "<span>لا يوجد ربط معتمد / No approved link</span>";
  const pageLedger = `<details><summary>سجل مراجعة الصفحات / All ${data.pages.length} reviewed pages</summary><table><thead><tr><th>المصدر / Source</th><th>الصفحة / Page</th><th>التصنيف / Classification</th><th>ملاحظة المراجعة / Review note</th></tr></thead><tbody>${data.pages.map((p) => `<tr><td>${htmlEscape(p.sourceKey)}</td><td>${p.page}</td><td>${htmlEscape(p.classification)}</td><td>${typeof p.note === "string" ? htmlEscape(p.note) : p.note ? `${htmlEscape(p.note.ar)}<br><span lang="en">${htmlEscape(p.note.en)}</span>` : ""}</td></tr>`).join("")}</tbody></table></details>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tilwa · CET351 · خريطة المفاهيم المعتمدة</title><style>body{font:15px/1.8 system-ui,sans-serif;color:#252343;background:#f7f7fb;margin:0}main{max-width:1100px;margin:auto;padding:40px 20px}h1,h2{color:#403680}h1{margin-bottom:0}article,section{background:white;border:1px solid #e0ddec;border-radius:12px;padding:22px;margin:18px 0}a{color:#4c3a8c}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e0ddec;padding:10px;text-align:start;vertical-align:top}bdi,code{direction:ltr;unicode-bidi:isolate}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}.tag{display:inline-block;background:#eeebf9;padding:3px 10px;border-radius:20px}.muted{color:#666177;font-size:13px}@media(max-width:600px){.two{grid-template-columns:1fr}table{display:block;overflow:auto}}@media print{body{background:white}article{break-inside:avoid}main{padding:0}}</style></head><body><main><p class="tag">Tilwa | تِلوا · Know your path · اعرف طريقك</p><h1>خريطة CET351 المعتمدة</h1><p lang="en">CET351 approved concept map · All six lectures and umbrella foundations</p><p>${data.concepts.length} مفاهيم / concepts · ${data.edges.length} علاقات / relationships</p><p class="muted">إصدار / Release: <bdi>${htmlEscape(data.releaseId)}</bdi> · ${htmlEscape(data.publishedAt || "")}</p><section><h2>تغطية المحاضرات / Lecture coverage</h2><table><thead><tr><th>المحاضرة / Lecture</th><th>المفاهيم / Concepts</th><th>الصفحات المعتمدة / Approved pages</th><th>إجمالي الصفحات / All pages</th><th>صفحات التدريس المرتبطة / Mapped teaching pages</th></tr></thead><tbody>${data.coverage.map((c) => `<tr><td><bdi>${htmlEscape(c.sourceKey)}</bdi></td><td>${c.conceptCount}</td><td>${c.approvedPageCount}</td><td>${c.totalPages}</td><td>${c.mappedTeachingPages} / ${c.teachingPages}</td></tr>`).join("")}</tbody></table><p class="muted">تصنيف الصفحة لا يعني اعتمادها كدليل؛ الأعداد تفصل الصفحات المعتمدة عن الإجمالي. / Page classification is distinct from evidence approval; approved and total pages are reported separately.</p></section>${pageLedger}<details><summary>فهرس المفاهيم / Concept index</summary><ul>${data.concepts.map((c) => `<li><a href="#${htmlEscape(c.id)}">${htmlEscape(c.label.ar)} / ${htmlEscape(c.label.en)}</a></li>`).join("")}</ul></details><p>${htmlEscape(data.note.ar)}<br><span lang="en">${htmlEscape(data.note.en)}</span></p>${data.concepts.map((c) => `<article id="${htmlEscape(c.id)}"><h2>${htmlEscape(c.label.ar)} <span lang="en">/ ${htmlEscape(c.label.en)}</span></h2><p class="muted"><bdi>${htmlEscape(c.id)}</bdi></p>${c.summary ? `<p>${htmlEscape(c.summary.ar)}<br><span lang="en">${htmlEscape(c.summary.en)}</span></p>` : ""}${c.coverageLevel === "named_only" ? '<p class="tag">ورد الاسم فقط بالمحاضرة / Named only in the lecture</p>' : ""}<div class="two"><div><h3>دليل المحاضرة / Lecture evidence</h3>${sources(c.lectureEvidence)}</div><div><h3>المرجع الجامع / Umbrella foundations</h3>${sources(c.umbrellaEvidence)}</div></div>${c.referenceLinks.length ? `<p class="muted">روابط مرجعية فقط، وليست نصوصًا مسترجعة / Reference links only, not retrieved article evidence:</p><ul>${c.referenceLinks.map((r) => `<li><a href="${htmlEscape(r.url)}" rel="noreferrer" target="_blank">${htmlEscape(r.title.ar)} / ${htmlEscape(r.title.en)}</a> · GFG</li>`).join("")}</ul>` : ""}</article>`).join("")}<section><h2>العلاقات المعتمدة / Approved relationships</h2><p>اتجاه المتطلب: من المتطلب السابق إلى المفهوم التابع. / Prerequisites point from prerequisite to dependent.</p>${data.edges.map((e) => `<article><p dir="ltr"><a href="#${htmlEscape(e.from)}">${htmlEscape(names.get(e.from)?.ar || e.from)} / ${htmlEscape(names.get(e.from)?.en || "")}</a> → <a href="#${htmlEscape(e.to)}">${htmlEscape(names.get(e.to)?.ar || e.to)} / ${htmlEscape(names.get(e.to)?.en || "")}</a></p><p class="tag">${htmlEscape(edgeLabel(e.type))}</p>${e.reason ? `<p>${htmlEscape(e.reason.ar)}<br><span lang="en">${htmlEscape(e.reason.en)}</span></p>` : ""}${sources(e.evidence)}</article>`).join("")}</section></main></body></html>`;
}

export function safeReferenceUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      ["www.geeksforgeeks.org", "geeksforgeeks.org"].includes(u.hostname) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function orderedLocators(locators: SourceLocator[]): SourceLocator[] {
  return [...locators].sort(
    (a, b) =>
      a.sourceKey.localeCompare(b.sourceKey, "en", { numeric: true }) ||
      (a.page ?? 0) - (b.page ?? 0) ||
      (a.section || "").localeCompare(b.section || "", "en", { numeric: true }),
  );
}
