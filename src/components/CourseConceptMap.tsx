"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCheck,
  ChevronDown,
  Download,
  FileText,
  GitBranch,
  Layers,
  Link2,
  List,
  Network,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  approvedMapExport,
  filterConcepts,
  mapCsv,
  mapHtmlReport,
  privateSourceHref,
  safeReferenceUrl,
  orderedLocators,
  type MapConcept,
  type MapEdge,
  type MapLanguage,
  type PublishedConceptMap,
  type SourceLocator,
} from "./concept-map-model";
import "./concept-map.css";
const lectureKeys = Array.from({ length: 6 }, (_, i) => `CET351-L${i + 1}`);
const labels = {
  ar: [
    "مدخل إلى تعلم الآلة",
    "البيانات والتعميم",
    "التدريب والتقييم",
    "التصنيف ومقاييسه",
    "KNN وNaïve Bayes",
    "الأشجار والغابات",
  ],
  en: [
    "Machine learning foundations",
    "Data and generalization",
    "Training and evaluation",
    "Classification metrics",
    "KNN and Naïve Bayes",
    "Trees and forests",
  ],
};
export function CourseConceptMap({ lang }: { lang: MapLanguage }) {
  const t = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [map, setMap] = useState<PublishedConceptMap | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [lecture, setLecture] = useState("all"),
    [selectedId, setSelected] = useState(""),
    [view, setView] = useState<"map" | "list">("map"),
    [edgeType, setEdgeType] = useState("all");
  const detailRef = useRef<HTMLHeadingElement>(null);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/knowledge/map", {
        cache: "no-store",
        headers: { "Accept-Language": lang },
      });
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          d.error?.message ||
            d.message ||
            t(
              "تعذّر تحميل الخريطة. أعد المحاولة.",
              "The map could not be loaded. Please retry.",
            ),
        );
      const result = {
        ...d,
        concepts: (d.concepts || []).map((c: MapConcept) => ({
          ...c,
          aliases: c.aliases || [],
          lectureEvidence: c.lectureEvidence || [],
          umbrellaEvidence: c.umbrellaEvidence || [],
        })),
        edges: d.edges || [],
        coverage: d.coverage || [],
      };
      setMap(result);
      setSelected((old) =>
        result.concepts.some((c: MapConcept) => c.id === old)
          ? old
          : result.concepts[0]?.id || "",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("تعذّر تحميل الخريطة.", "Map unavailable."),
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const filtered = useMemo(
    () => filterConcepts(map?.concepts || [], query, lecture),
    [map, query, lecture],
  );
  const selected = filtered.find((c) => c.id === selectedId) || filtered[0];
  const selectedEdges = (map?.edges || []).filter(
    (e) =>
      (e.from === selected?.id || e.to === selected?.id) &&
      (edgeType === "all" || e.type === edgeType),
  );
  const getName = (id: string) =>
    map?.concepts.find((c) => c.id === id)?.label[lang] || id;
  const choose = (id: string, scroll = false) => {
    if (!filtered.some((c) => c.id === id)) {
      setQuery("");
      setLecture("all");
    }
    setSelected(id);
    if (scroll) {
      requestAnimationFrame(() => {
        detailRef.current?.focus({ preventScroll: true });
        if (window.innerWidth < 900)
          detailRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
      });
    }
  };
  const sourceCount =
    map?.concepts.filter(
      (c) =>
        c.lectureEvidence.length &&
        c.umbrellaEvidence.length &&
        c.status === "approved",
    ).length || 0;
  const exportMap = (kind: "json" | "csv" | "html") => {
    if (!map?.releaseId) return;
    const data = approvedMapExport(map, window.location.origin);
    const content =
      kind === "json"
        ? JSON.stringify(data, null, 2)
        : kind === "csv"
          ? mapCsv(data)
          : mapHtmlReport(data);
    const mime =
      kind === "json"
        ? "application/json"
        : kind === "csv"
          ? "text/csv;charset=utf-8"
          : "text/html;charset=utf-8";
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `Notch-approved-map-${new Date().toISOString().slice(0, 10)}.${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="course-map" aria-labelledby="course-map-title">
      <div className="map-intro">
        <div>
          <span className="overline">
            <i />
            CET351 · {t("من المصدر إلى الفهم", "From sources to understanding")}
          </span>
          <h1 id="course-map-title">
            {t("خريطة المفاهيم الكاملة", "The complete concept map")}
          </h1>
          <p>
            {t(
              "استكشف المحاضرات الست. اختَر مفهومًا وشوف دليله في المحاضرة وصلته بالمرجع الجامع.",
              "Explore all six lectures. Select a concept to see its lecture evidence and connection to the umbrella foundations.",
            )}
          </p>
        </div>
        <span className="map-release">
          <ShieldCheck size={16} />
          {t("معرفة مراجَعة", "Reviewed knowledge")}
        </span>
      </div>
      {error && (
        <div className="map-error" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={load}>
            {t("إعادة المحاولة", "Retry")}
          </button>
        </div>
      )}
      {loading && !map && (
        <div className="map-loading" role="status">
          <Network size={28} />
          {t(
            "بنحمّل المفاهيم ومصادرها…",
            "Loading concepts and their evidence…",
          )}
        </div>
      )}
      {map && !map.concepts.length && !loading && (
        <div className="map-empty">
          <Network size={32} />
          <h2>
            {t("الخريطة في انتظار النشر", "The map is awaiting publication")}
          </h2>
          <p>
            {t(
              "راجع المدرّس مصادر المقرر ثم ينشر المفاهيم والعلاقات المعتمدة هنا.",
              "The instructor reviews course evidence and publishes approved concepts and relationships here.",
            )}
          </p>
        </div>
      )}
      {!!map?.concepts.length && (
        <>
          <div className="map-stats">
            {[
              [
                map.concepts.length,
                t("مفهوم في الخريطة", "Concepts in the map"),
                Network,
              ],
              [
                (map.edges || []).length,
                t("علاقة في الإصدار", "Relationships in this release"),
                GitBranch,
              ],
              [
                lectureKeys.filter((k) =>
                  map.coverage.some(
                    (c) => c.sourceKey === k && c.conceptCount > 0,
                  ),
                ).length + "/6",
                t("محاضرات مرتبطة", "Lectures connected"),
                BookOpen,
              ],
              [
                sourceCount,
                t("مفهوم بدليل من المصدرين", "Concepts linked to both sources"),
                Link2,
              ],
            ].map(([value, label, Icon], i) => {
              const I = Icon as typeof Network;
              return (
                <div key={i} className="map-stat">
                  <span className={"sq " + (i === 3 ? "mint" : "lavender")}>
                    <I size={19} />
                  </span>
                  <strong>{String(value)}</strong>
                  <small>{String(label)}</small>
                </div>
              );
            })}
          </div>
          <div className="map-toolbar">
            <label className="map-search">
              <Search size={18} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t(
                  "ابحث بالعربي أو بالإنجليزي…",
                  "Search in Arabic or English…",
                )}
                aria-label={t("بحث المفاهيم", "Search concepts")}
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  aria-label={t("مسح البحث", "Clear search")}
                >
                  <X size={16} />
                </button>
              )}
            </label>
            <div
              className="map-view-buttons"
              aria-label={t("طريقة عرض الخريطة", "Map display mode")}
            >
              <button
                aria-pressed={view === "map"}
                className={view === "map" ? "selected" : ""}
                onClick={() => setView("map")}
              >
                <Network size={17} />
                {t("استكشاف", "Explore")}
              </button>
              <button
                aria-pressed={view === "list"}
                className={view === "list" ? "selected" : ""}
                onClick={() => setView("list")}
              >
                <List size={17} />
                {t("قائمة ميسّرة", "Accessible list")}
              </button>
            </div>
          </div>
          <nav
            className="lecture-filters"
            aria-label={t("تصفية حسب المحاضرة", "Filter by lecture")}
          >
            <button
              aria-pressed={lecture === "all"}
              className={lecture === "all" ? "active" : ""}
              onClick={() => setLecture("all")}
            >
              <Layers size={17} />
              {t("كل المحاضرات", "All lectures")}
              <span>{map.concepts.length}</span>
            </button>
            {lectureKeys.map((key, i) => {
              const coverage = map.coverage.find((c) => c.sourceKey === key);
              return (
                <button
                  key={key}
                  aria-pressed={lecture === key}
                  className={lecture === key ? "active" : ""}
                  onClick={() => setLecture(key)}
                >
                  <bdi>L{i + 1}</bdi>
                  <span>{labels[lang][i]}</span>
                  <small>
                    {coverage?.conceptCount ??
                      map.concepts.filter((c) =>
                        c.lectureEvidence.some((e) => e.sourceKey === key),
                      ).length}
                  </small>
                </button>
              );
            })}
            <button
              aria-pressed={lecture === "umbrella"}
              className={lecture === "umbrella" ? "active" : ""}
              onClick={() => setLecture("umbrella")}
            >
              <Link2 size={17} />
              {t("المرجع الجامع", "Umbrella foundations")}
            </button>
          </nav>
          <div className="map-result-count" role="status">
            {t("المعروض", "Showing")} <b>{filtered.length}</b> {t("من", "of")}{" "}
            {map.concepts.length} {t("مفهوم", "concepts")}
            {(query || lecture !== "all") && (
              <button
                className="textbtn"
                onClick={() => {
                  setQuery("");
                  setLecture("all");
                }}
              >
                {t("عرض الكل", "Show all")}
              </button>
            )}
          </div>
          {view === "list" ? (
            <div className="map-table-wrap">
              <table className="map-table">
                <caption>
                  {t(
                    "كل المفاهيم المطابقة مع محدّدات المصادر. اختَر الاسم لعرض العلاقات.",
                    "All matching concepts with source locators. Select a name to see its relationships.",
                  )}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("المفهوم", "Concept")}</th>
                    <th scope="col">
                      {t("دليل المحاضرة", "Lecture evidence")}
                    </th>
                    <th scope="col">
                      {t("المرجع الجامع", "Umbrella foundations")}
                    </th>
                    <th scope="col">{t("الحالة", "Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      className={selected?.id === c.id ? "selected" : ""}
                    >
                      <th scope="row">
                        <button onClick={() => choose(c.id, true)}>
                          {c.label[lang]}
                        </button>
                        <small lang={lang === "ar" ? "en" : "ar"}>
                          {c.label[lang === "ar" ? "en" : "ar"]}
                        </small>
                      </th>
                      <td>
                        <LocatorLinks
                          locators={c.lectureEvidence}
                          lang={lang}
                        />
                      </td>
                      <td>
                        <LocatorLinks
                          locators={c.umbrellaEvidence}
                          lang={lang}
                        />
                      </td>
                      <td>
                        <StateBadge status={c.status} lang={lang} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filtered.length && <EmptyResults lang={lang} />}
            </div>
          ) : (
            <div className="map-explorer">
              <div
                className="concept-catalog"
                aria-label={t("المفاهيم المطابقة", "Matching concepts")}
              >
                {!filtered.length ? (
                  <EmptyResults lang={lang} />
                ) : (
                  filtered.map((c) => (
                    <button
                      key={c.id}
                      className={
                        "concept-choice " +
                        (selected?.id === c.id ? "selected" : "")
                      }
                      aria-pressed={selected?.id === c.id}
                      onClick={() => choose(c.id)}
                    >
                      <span className="concept-choice-top">
                        <strong>{c.label[lang]}</strong>
                        {c.lectureEvidence.length > 0 &&
                          c.umbrellaEvidence.length > 0 && (
                            <Link2
                              size={15}
                              aria-label={t(
                                "دليل من المصدرين",
                                "Evidence from both sources",
                              )}
                            />
                          )}
                      </span>
                      <small
                        lang={lang === "ar" ? "en" : "ar"}
                        dir={lang === "ar" ? "ltr" : "rtl"}
                      >
                        {c.label[lang === "ar" ? "en" : "ar"]}
                      </small>
                      <span className="concept-tags">
                        {[
                          ...new Set(c.lectureEvidence.map((e) => e.sourceKey)),
                        ].map((key) => (
                          <bdi key={key}>{key.replace("CET351-", "")}</bdi>
                        ))}
                        {!c.lectureEvidence.length && (
                          <span>
                            {t("أساس مساند", "Supplemental foundation")}
                          </span>
                        )}
                        <span>
                          {c.lectureEvidence.length + c.umbrellaEvidence.length}{" "}
                          {t("مواضع مصدر", "locators")}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="concept-inspector">
                {selected && (
                  <ConceptDetail
                    concept={selected}
                    lang={lang}
                    headingRef={detailRef}
                  />
                )}
              </div>
            </div>
          )}
          {view === "list" && selected && (
            <div className="concept-inspector list-detail">
              <ConceptDetail
                concept={selected}
                lang={lang}
                headingRef={detailRef}
              />
            </div>
          )}
          {selected && (
            <section
              className="concept-connections"
              aria-labelledby="connections-title"
            >
              <div className="map-section-head">
                <div>
                  <span className="overline">
                    {t(
                      "المتطلب السابق ← المفهوم التابع",
                      "Prerequisite → dependent",
                    )}
                  </span>
                  <h2 id="connections-title">
                    {t("علاقات", "Connections for")} «{selected.label[lang]}»
                  </h2>
                </div>
                <label>
                  {t("نوع العلاقة", "Relationship type")}
                  <select
                    value={edgeType}
                    onChange={(e) => setEdgeType(e.target.value)}
                  >
                    <option value="all">
                      {t("كل العلاقات", "All relationships")}
                    </option>
                    {[...new Set(map.edges.map((e) => e.type))]
                      .sort()
                      .map((type) => (
                        <option key={type} value={type}>
                          {relationshipLabel(type, lang)}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <p className="map-explanation">
                {t(
                  "تظهر العلاقات المباشرة للمفهوم المختار لتبقى الخريطة مقروءة. اختَر أي طرف لاستكشاف علاقاته، أو نزّل الخريطة بكل العلاقات. الارتباط المفاهيمي لا يعني وجود متطلب سابق.",
                  "This view shows the selected concept’s direct connections to stay readable. Select either endpoint to explore, or download every relationship. A related concept is not necessarily a prerequisite.",
                )}
              </p>
              {!selectedEdges.length ? (
                <p className="map-empty-small">
                  {t(
                    "لا توجد علاقة من هذا النوع للمفهوم المختار.",
                    "No relationship of this type exists for the selected concept.",
                  )}
                </p>
              ) : (
                <div className="relationship-columns">
                  {[
                    ["incoming", t("علاقات واردة", "Incoming relationships")],
                    ["outgoing", t("علاقات صادرة", "Outgoing relationships")],
                  ].map(([direction, title]) => (
                    <div key={direction}>
                      <h3>{title}</h3>
                      {selectedEdges
                        .filter((e) =>
                          direction === "incoming"
                            ? e.to === selected.id
                            : e.from === selected.id,
                        )
                        .map((edge, i) => (
                          <article
                            key={edge.id || `${edge.from}:${edge.to}:${i}`}
                            className="relationship-card"
                          >
                            <div className="relationship-heading">
                              <span
                                className={
                                  "relationship-type type-" + edge.type
                                }
                              >
                                {relationshipLabel(edge.type, lang)}
                              </span>
                              <StateBadge status={edge.status} lang={lang} />
                            </div>
                            <div className="relationship-direction" dir="ltr">
                              <button
                                onClick={() => choose(edge.from, true)}
                                disabled={edge.from === selected.id}
                              >
                                {getName(edge.from)}
                              </button>
                              <ArrowRight size={18} aria-hidden="true" />
                              <button
                                onClick={() => choose(edge.to, true)}
                                disabled={edge.to === selected.id}
                              >
                                {getName(edge.to)}
                              </button>
                            </div>
                            {edge.reason && <p>{edge.reason[lang]}</p>}
                            <LocatorLinks
                              locators={edge.evidence || []}
                              lang={lang}
                            />
                          </article>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          <details className="map-coverage">
            <summary>
              <span>
                <BookOpen size={18} />
                {t(
                  "تغطية المحاضرات وحالة الصفحات",
                  "Lecture coverage and page status",
                )}
              </span>
              <ChevronDown size={17} />
            </summary>
            <div className="coverage-grid">
              {lectureKeys.map((key, i) => {
                const c = map.coverage.find((v) => v.sourceKey === key);
                return (
                  <article key={key}>
                    <strong>
                      <bdi>L{i + 1}</bdi> · {labels[lang][i]}
                    </strong>
                    <dl>
                      <div>
                        <dt>{t("مفاهيم مرتبطة", "Linked concepts")}</dt>
                        <dd>{c?.conceptCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>{t("صفحات معتمدة", "Approved pages")}</dt>
                        <dd>
                          {c?.approvedPageCount ?? 0} / {c?.totalPages ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("صفحات مصنّفة", "Classified pages")}</dt>
                        <dd>{c?.pageCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>
                          {t("صفحات تدريس مرتبطة", "Mapped teaching pages")}
                        </dt>
                        <dd>
                          {c?.mappedTeachingPages ?? 0} /{" "}
                          {c?.teachingPages ?? 0}
                        </dd>
                      </div>
                    </dl>
                    <button className="textbtn" onClick={() => setLecture(key)}>
                      {t("عرض المفاهيم", "View concepts")}{" "}
                      {lang === "ar" ? (
                        <ArrowLeft size={14} />
                      ) : (
                        <ArrowRight size={14} />
                      )}
                    </button>
                  </article>
                );
              })}
            </div>
            {map.totals && (
              <p className="map-explanation">
                {t(
                  "صفحات التدريس المرتبطة بمفاهيم",
                  "Teaching pages mapped to concepts",
                )}
                : {map.totals.mappedTeachingPages} / {map.totals.teachingPages}.{" "}
                {t(
                  "الصفحات الإدارية أو المصوّرة أو المتعارضة لا تُعد دليلًا تعليميًا معتمدًا تلقائيًا.",
                  "Administrative, image-only or conflicting pages are not automatically treated as approved teaching evidence.",
                )}
              </p>
            )}
            {!!map.pages?.length && (
              <details className="page-ledger">
                <summary>{t("عرض سجل الصفحات", "Show page ledger")}</summary>
                <div className="page-ledger-grid">
                  {map.pages.map((p) => (
                    <div key={`${p.sourceKey}:${p.page}`}>
                      <bdi>
                        {p.sourceKey} · {p.page}
                      </bdi>
                      <span>{pageClassLabel(p.classification, lang)}</span>
                      <small>
                        {p.conceptIds?.length ?? 0} {t("مفاهيم", "concepts")}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </details>
          <section className="map-downloads">
            <div>
              <h2>
                <Download size={20} />
                {t("خذ الخريطة معك", "Take the map with you")}
              </h2>
              <p>
                {t(
                  "التنزيل يشمل كل المفاهيم والعلاقات المعتمدة ومحدّدات مصادرها، حتى مع وجود فلتر. فتح المصادر يحتاج حسابًا مصرحًا له.",
                  "Downloads include all approved concepts, relationships and locators, even when a filter is active. Opening sources requires an authorized account.",
                )}
              </p>
              <small>
                {t(
                  "يشمل محدّدات الصفحات والأقسام فقط؛ لا يتضمن نصوص المحاضرات الخاصة أو مفاتيح الأسئلة.",
                  "Contains page and section locators only; excludes private lecture passages and answer keys.",
                )}
              </small>
            </div>
            <div className="map-download-buttons">
              <button
                className="btn primary"
                onClick={() => exportMap("html")}
                disabled={!map.releaseId}
              >
                <FileText size={16} />
                {t("تقرير ثنائي اللغة", "Bilingual report")}
              </button>
              <button
                className="btn"
                onClick={() => exportMap("json")}
                disabled={!map.releaseId}
              >
                JSON
              </button>
              <button
                className="btn"
                onClick={() => exportMap("csv")}
                disabled={!map.releaseId}
              >
                CSV
              </button>
            </div>
          </section>
          <p className="map-source-note">
            {t(
              "GeeksforGeeks مسجّل كمرجع جامع برابط. تظهر مقاطع المقال فقط إذا وُجد تصريح استخدام ومراجعة. ملحق Notch الأصلي مصدر مساند مستقل، وليس نصًا من GFG.",
              "GeeksforGeeks is registered as an umbrella reference link. Article passages appear only with permission and review. Notch’s original supplement is a separate foundational source, not GFG article text.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
function EmptyResults({ lang }: { lang: MapLanguage }) {
  return (
    <p className="map-empty-small">
      {lang === "ar"
        ? "لا توجد مفاهيم مطابقة. جرّب مصطلحًا آخر أو كل المحاضرات."
        : "No concepts match. Try another term or all lectures."}
    </p>
  );
}
function StateBadge({ status, lang }: { status: string; lang: MapLanguage }) {
  const text =
    status === "approved" || status === "published"
      ? lang === "ar"
        ? "معتمد"
        : "Approved"
      : status === "pending"
        ? lang === "ar"
          ? "قيد المراجعة"
          : "Pending review"
        : status === "rejected"
          ? lang === "ar"
            ? "مرفوض"
            : "Rejected"
          : lang === "ar"
            ? "يحتاج إعادة مراجعة"
            : "Needs review";
  return (
    <span
      className={
        "map-status " +
        (status === "approved" || status === "published"
          ? "approved"
          : "pending")
      }
    >
      {status === "approved" || status === "published" ? (
        <CheckCheck size={13} />
      ) : (
        <ClockMark />
      )}
      {text}
    </span>
  );
}
function ClockMark() {
  return <span aria-hidden="true">◷</span>;
}
function LocatorLinks({
  locators,
  lang,
}: {
  locators: SourceLocator[];
  lang: MapLanguage;
}) {
  return locators.length ? (
    <ul className="map-locators">
      {orderedLocators(locators).map((s, i) => (
        <li key={s.id || `${s.sourceKey}:${s.page || s.section}:${i}`}>
          <a
            href={privateSourceHref(s)}
            target="_blank"
            rel="noreferrer"
            title={s.title}
          >
            <FileText size={14} />
            <bdi>
              {s.sourceKey === "TILWA-PILOT-FOUNDATIONS"
                ? lang === "ar"
                  ? "ملحق Notch"
                  : "Notch supplement"
                : s.sourceKey}
            </bdi>
            <span>
              {s.page ? `${lang === "ar" ? "ص." : "p."} ${s.page}` : s.section}
            </span>
            <span aria-hidden="true">↗</span>
          </a>
        </li>
      ))}
    </ul>
  ) : (
    <span className="map-no-link">
      {lang === "ar" ? "لا يوجد ربط معتمد" : "No approved link"}
    </span>
  );
}
function ConceptDetail({
  concept,
  lang,
  headingRef,
}: {
  concept: MapConcept;
  lang: MapLanguage;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const t = (ar: string, en: string) => (lang === "ar" ? ar : en);
  return (
    <>
      <div className="map-detail-heading">
        <span className="sq lavender">
          <Network size={22} />
        </span>
        <StateBadge status={concept.status} lang={lang} />
      </div>
      <h2 tabIndex={-1} ref={headingRef}>
        {concept.label[lang]}
      </h2>
      <p
        className="map-alternate-name"
        lang={lang === "ar" ? "en" : "ar"}
        dir={lang === "ar" ? "ltr" : "rtl"}
      >
        {concept.label[lang === "ar" ? "en" : "ar"]}
      </p>
      {concept.coverageLevel === "named_only" && (
        <p className="map-evidence-gap">
          {t(
            "ورد اسم المفهوم في المحاضرة؛ لم يُشرح بالتفصيل في هذا الموضع.",
            "The concept is named in the lecture; it is not explained in detail at this location.",
          )}
        </p>
      )}
      {concept.summary?.[lang] && (
        <p className="map-concept-summary">{concept.summary[lang]}</p>
      )}
      {concept.aliases.length > 0 && (
        <details className="map-aliases">
          <summary>
            {t("أسماء ومصطلحات مرتبطة", "Aliases and related terms")}
          </summary>
          <div className="chips">
            {concept.aliases.map((a, i) => (
              <bdi key={i}>{a}</bdi>
            ))}
          </div>
        </details>
      )}
      <div className="map-evidence-pair">
        <section>
          <h3>
            <BookOpen size={17} />
            {t("دليله في المحاضرة", "Its lecture evidence")}
          </h3>
          <p>
            {t(
              "افتح موضع المفهوم في المصدر الأصلي.",
              "Open the concept’s exact location in the original source.",
            )}
          </p>
          <LocatorLinks locators={concept.lectureEvidence} lang={lang} />
        </section>
        <section>
          <h3>
            <Link2 size={17} />
            {t("صلته بالمرجع الجامع", "Its umbrella foundation")}
          </h3>
          <p>
            {t(
              "مقطع مساند يوضّح الأساس أو يربط المفاهيم.",
              "Supporting evidence explains the foundation or connects concepts.",
            )}
          </p>
          <LocatorLinks locators={concept.umbrellaEvidence} lang={lang} />
        </section>
      </div>
      {!!concept.referenceLinks?.length && (
        <section className="map-reference-links">
          <h3>{t("روابط المرجع الجامع", "Umbrella reference links")}</h3>
          <p>
            {t(
              "روابط وبيانات وصفية فقط؛ لا تُحسب دليلًا من نص المقال.",
              "Links and metadata only; they do not count as retrieved article evidence.",
            )}
          </p>
          <ul>
            {concept.referenceLinks
              .filter((r) => safeReferenceUrl(r.url))
              .map((r, i) => (
                <li key={i}>
                  <a
                    href={safeReferenceUrl(r.url)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.title[lang]} <bdi>GeeksforGeeks</bdi> ↗
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}
      {!concept.umbrellaEvidence.length && (
        <p className="map-evidence-gap">
          {t(
            "لم يعتمد ربط لهذا المفهوم بمقطع من المرجع الجامع حتى الآن. لا نعتبر التشابه وحده دليلًا.",
            "An umbrella passage link has not been approved for this concept yet. Similarity alone is not evidence.",
          )}
        </p>
      )}
      {concept.scope === "foundation" && (
        <p className="map-evidence-gap">
          {t(
            "مفهوم تأسيسي مساند؛ ليس وحده إثباتًا لتغطية محاضرة.",
            "Supplemental foundation; it does not by itself establish lecture coverage.",
          )}
        </p>
      )}
    </>
  );
}
function relationshipLabel(type: string, lang: MapLanguage) {
  const values: Record<string, [string, string]> = {
    prerequisite: ["متطلب سابق", "Prerequisite"],
    related: ["مفهوم مرتبط", "Related concept"],
    optional_bridge: ["جسر اختياري", "Optional bridge"],
    part_of: ["جزء من", "Part of"],
    example_of: ["مثال على", "Example of"],
    contrasts_with: ["مقارنة مع", "Contrasts with"],
    supports: ["يدعم", "Supports"],
    specialization: ["تخصّص من", "Specialization"],
    evaluates: ["يقيّم", "Evaluates"],
    applies_to: ["ينطبق على", "Applies to"],
  };
  return (
    values[type]?.[lang === "ar" ? 0 : 1] ||
    (lang === "ar" ? "علاقة تعليمية" : "Learning relationship")
  );
}
function pageClassLabel(value: string, lang: MapLanguage) {
  const values: Record<string, [string, string]> = {
    teaching: ["صفحة تعليمية", "Teaching page"],
    duplicate: ["محتوى مكرر", "Duplicate content"],
    figure: ["رسم تعليمي مُراجع", "Reviewed teaching figure"],
    administrative: ["معلومات إدارية", "Administrative"],
    title: ["عنوان", "Title"],
    image_only: ["صورة تحتاج مراجعة", "Image needs review"],
    quarantined: ["معزولة", "Quarantined"],
    conflicting: ["تعارض يحتاج تصحيحًا", "Conflict requires correction"],
    unreadable: ["غير مقروءة", "Unreadable"],
    references: ["مراجع", "References"],
    exercise: ["تمرين", "Exercise"],
    non_teaching: ["غير تعليمية", "Non-teaching"],
  };
  return (
    values[value]?.[lang === "ar" ? 0 : 1] ||
    (lang === "ar" ? "مراجعة الصفحة" : "Page review")
  );
}
