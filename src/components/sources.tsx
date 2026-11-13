"use client";
import { useEffect, useState, type ChangeEvent } from "react";
import { Upload, FileText, Check, GitBranch, RefreshCw } from "lucide-react";
import { Box, Button, localized, request, type Translate } from "./Workspace";
type Lang = "ar" | "en";
function statusLabel(status: string, t: Translate) {
  return (
    {
      approved: t("معتمد", "Approved"),
      rejected: t("مرفوض", "Rejected"),
      quarantined: t("معزول للمراجعة", "Quarantined"),
      pending: t("بانتظار المراجعة", "Pending review"),
      not_registered: t("غير مسجّل", "Not registered"),
      awaiting_upload: t("بانتظار رفع الملف", "Awaiting upload"),
      published: t("منشور", "Published"),
      missing: t("لم يُرفع الملف", "Not uploaded"),
      registered: t("مرجع مسجّل", "Registered reference"),
      reference_link: t("رابط مرجعي فقط", "Reference link only"),
    }[status] || status
  );
}
export function MaterialsPanel({
  lang,
  t,
  onError,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
}) {
  const [data, D] = useState<any>(null),
    [busy, B] = useState(false),
    [statuses, ST] = useState<Record<string, string>>({}),
    [selected, SL] = useState<any>(null),
    [page, P] = useState<any>(null),
    [corrected, C] = useState("");
  const [passage, PT] = useState(""),
    [sourceKey, SK] = useState("GFG-UMBRELLA"),
    [title, TI] = useState(""),
    [section, SE] = useState(""),
    [rights, RI] = useState(""),
    [confirmed, CF] = useState(false),
    [url, URL] = useState("");
  const refresh = async () => {
    const r = await request("/api/materials", undefined, lang);
    D(r);
  };
  useEffect(() => {
    refresh().catch((e) => onError(e.message));
  }, []);
  const act = async (f: () => Promise<any>) => {
    B(true);
    onError("");
    try {
      const r = await f();
      await refresh();
      return r;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      B(false);
    }
  };
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      ST((s) => ({ ...s, [file.name]: t("جارٍ الاستيراد…", "Importing…") }));
      const form = new FormData();
      form.append("file", file);
      const r = await act(() => request("/api/materials", form, lang));
      ST((s) => ({
        ...s,
        [file.name]: r
          ? t("تم الاستيراد", "Imported")
          : t(
              "تعذّر الاستيراد — أعد اختيار الملف للمحاولة",
              "Import failed — select the file again to retry",
            ),
      }));
    }
    e.target.value = "";
  };
  const open = async (id: string) => {
    const r = await act(() => request(`/api/materials/${id}`, undefined, lang));
    if (r) {
      const chunks = [...(r.chunks || [])].sort(
        (a, b) =>
          (a.page ?? 0) - (b.page ?? 0) ||
          String(a.section || "").localeCompare(String(b.section || ""), "en", {
            numeric: true,
          }),
      );
      SL({ ...r, chunks });
      P(chunks[0]);
      C("");
    }
  };
  const review = async (status: string) => {
    const id = selected.material.id;
    const r = await act(() =>
      request(
        `/api/materials/${id}`,
        {
          chunkId: page.id,
          status,
          ...(corrected.trim() ? { correctedText: corrected } : {}),
        },
        lang,
      ),
    );
    if (r) {
      await open(id);
    }
  };
  return (
    <>
      <div className="pageHead">
        <h1>{t("مصادر المقرر", "Course materials")}</h1>
        <p>
          {t(
            "استورد، راجع النص صفحة بصفحة، ثم انشر الأدلة المعتمدة.",
            "Import, review page by page, then publish approved evidence.",
          )}
        </p>
      </div>
      <Box>
        <div className="sectionTop">
          <h2>{t("حزمة CET351", "CET351 source pack")}</h2>
          <Button
            primary
            disabled={busy}
            onClick={() =>
              act(() =>
                request("/api/materials", { action: "register-pack" }, lang),
              )
            }
          >
            <Upload size={17} />
            {t("استيراد حزمة CET351", "Import CET351 pack")}
          </Button>
        </div>
        <p>
          {t(
            "يسجّل المرجع الجامع ويستورد الملحق الأصلي. ارفع المحاضرات الست كل ملف على حدة؛ يمكن إعادة المحاولة دون تكرار النسخ المطابقة.",
            "Registers the umbrella reference and ingests the original supplement. Upload all six lectures individually; retrying identical files does not duplicate them.",
          )}
        </p>
        <div className="upload">
          <label>
            {t(
              "ملفات محاضرات CET351 الأصلية (PDF)",
              "Original CET351 lecture files (PDF)",
            )}
            <input
              aria-label={t("رفع المحاضرات", "Upload lectures")}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={busy}
              onChange={upload}
            />
          </label>
          <small>
            {t(
              "تتم معالجة كل ملف في طلب مستقل. يُتحقق من الاسم والبصمة وعدد الصفحات.",
              "Each file is processed in a separate request. Filename, checksum and page count are verified.",
            )}
          </small>
        </div>
        {Object.entries(statuses).map(([name, s]) => (
          <div className="row" key={name}>
            <bdi>{name}</bdi>
            <span role="status">{s}</span>
          </div>
        ))}
        <p className="notice">
          {t(
            "GeeksforGeeks: تسجيل رابط لا يعني السماح باستخراج المقال أو إرساله للموديل. الملحق الأصلي مصدر مستقل.",
            "GeeksforGeeks: registering a link does not permit extracting or sending article text to the model. The original supplement is a separate source.",
          )}
        </p>
        {data?.gfg && (
          <small>
            {t("تسجيل GFG", "GFG registration")}:{" "}
            {data.gfg.registered ? t("تم", "Done") : t("لم يتم", "Pending")} ·{" "}
            {t("استخدام نص المقال", "Article text used")}:{" "}
            {data.gfg.textUsed ? t("نعم", "Yes") : t("لا", "No")}
          </small>
        )}
      </Box>
      <div className="source-review end">
        <Box>
          <h2>{t("الملفات والنسخ", "Files & versions")}</h2>
          {!data && <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>}
          {(data?.materials || []).map((m: any) => (
            <article key={m.sourceKey || m.source_key} className="material-row">
              <div>
                <strong>{m.filename || m.title || m.sourceKey}</strong>
                <small>
                  {statusLabel(m.status || "pending", t)}{" "}
                  {m.expectedPages
                    ? `· ${m.expectedPages} ${t("صفحة", "pages")}`
                    : ""}
                </small>
              </div>
              {(m.versions || []).map((v: any) => (
                <Button key={v.id} onClick={() => open(v.id)}>
                  <FileText size={16} />
                  {t("مراجعة النسخة", "Review version")} {v.version || ""}
                </Button>
              ))}
            </article>
          ))}
        </Box>
        <Box>
          {selected && page ? (
            <>
              <div className="sectionTop">
                <h2>{selected.material.title}</h2>
                <a
                  href={`/api/materials/${selected.material.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="textbtn"
                >
                  {t("فتح الأصل الخاص", "Open private original")} ↗
                </a>
              </div>
              <div
                className="page-list"
                aria-label={t("صفحات المصدر", "Source pages")}
              >
                {selected.chunks.map((c: any) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      P(c);
                      C("");
                    }}
                    className={page.id === c.id ? "selected" : ""}
                  >
                    {c.page || c.section}
                  </button>
                ))}
              </div>
              <span className="badge lavender">
                {t("صفحة / قسم", "Page / section")} {page.page || page.section}{" "}
                · {statusLabel(page.status, t)}
              </span>
              {page.review_note && page.status !== "approved" && (
                <p className="notice">
                  {page.review_note === "New/changed passage: review required."
                    ? t(
                        "مقطع جديد أو متغيّر: يحتاج مراجعتك.",
                        "New or changed passage: your review is required.",
                      )
                    : page.review_note ===
                        "Unchanged passage in new source version: review required."
                      ? t(
                          "مقطع لم يتغيّر في نسخة جديدة: يحتاج اعتماد النسخة.",
                          "Unchanged passage in a new version: version approval is required.",
                        )
                      : page.review_note ===
                          "Known numerical conflict: correction and instructor review required."
                        ? t(
                            "تعارض عددي معروف: يحتاج تصحيحًا ومراجعة المدرّس.",
                            "Known numerical conflict: correction and instructor review required.",
                          )
                        : page.review_note ===
                            "Image-only or unreadable page: corrected extract required."
                          ? t(
                              "صفحة مصوّرة أو غير مقروءة: أرفق نصًا مصحّحًا.",
                              "Image-only or unreadable page: attach a corrected extract.",
                            )
                          : page.review_note}
                </p>
              )}
              <blockquote className="page-extract" dir="auto">
                {page.text_content ||
                  t(
                    "صفحة مصوّرة أو نص غير مقروء. أرفق نصًا مصحّحًا أو اعزلها.",
                    "Image-only or unreadable page. Attach a corrected extract or quarantine it.",
                  )}
              </blockquote>
              <label>
                {t(
                  "نص مصحّح مع مراجعة المدرّس (اختياري)",
                  "Instructor-corrected extract (optional)",
                )}
                <textarea
                  value={corrected}
                  onChange={(e) => C(e.target.value)}
                  dir="auto"
                />
              </label>
              <div className="actions">
                <Button
                  primary
                  disabled={busy}
                  onClick={() => review("approved")}
                >
                  <Check size={15} />
                  {t("اعتماد الصفحة", "Approve page")}
                </Button>
                <Button disabled={busy} onClick={() => review("rejected")}>
                  {t("رفض", "Reject")}
                </Button>
                <Button disabled={busy} onClick={() => review("quarantined")}>
                  {t("عزل للمراجعة", "Quarantine")}
                </Button>
              </div>
              <small>
                {t(
                  "الاعتماد لا ينشر تلقائيًا. انشر من شاشة مراجعة المعرفة بعد مراجعة العلاقات والأسئلة.",
                  "Approval does not publish automatically. Publish from Knowledge review after reviewing relationships and questions.",
                )}
              </small>
            </>
          ) : (
            <>
              <h2>
                {t(
                  "راجع النص بجانب القرار",
                  "Review the passage beside your decision",
                )}
              </h2>
              <p>
                {t(
                  "اختَر نسخة من القائمة لعرض النص الأصلي ورقم الصفحة وحالة المراجعة.",
                  "Choose a version to see its original passage, page number and review status.",
                )}
              </p>
              <p className="notice">
                {t(
                  "L4 ص. 16 وL5 ص. 18 و21–23 تحتاج تصحيحًا قبل استخدامها في سؤال محسوب.",
                  "L4 p. 16 and L5 pp. 18, 21–23 need correction before scored use.",
                )}
              </p>
            </>
          )}
        </Box>
      </div>
      <UmbrellaUpload
        mode="lecture"
        lang={lang}
        t={t}
        busy={busy}
        umbrellas={data?.lectures || []}
        act={act}
        open={open}
      />
      <UmbrellaUpload
        mode="umbrella"
        lang={lang}
        t={t}
        busy={busy}
        umbrellas={data?.umbrellas || []}
        act={act}
        open={open}
      />
      <Box cls="end">
        <h2>{t("مقطع مرخّص من مرجع جامع", "Authorized umbrella passage")}</h2>
        <p>
          {t(
            "أضف نصًا تملك تصريحًا واضحًا باستخدامه. يظل في انتظار المراجعة قبل النشر.",
            "Add text you have explicit permission to use. It remains pending review before publication.",
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() =>
              request(
                "/api/materials",
                {
                  action: "authorized-passage",
                  sourceKey,
                  title,
                  text: passage,
                  section,
                  rightsConfirmed: confirmed,
                  rightsReference: rights,
                  ...(url ? { url } : {}),
                },
                lang,
              ),
            );
          }}
        >
          <div className="two-columns">
            <label>
              {t("المصدر", "Source")}
              <select value={sourceKey} onChange={(e) => SK(e.target.value)}>
                <option value="GFG-UMBRELLA">GeeksforGeeks</option>
                <option value="CUSTOM-UMBRELLA">
                  {t("مرجع جامع آخر", "Other umbrella reference")}
                </option>
              </select>
            </label>
            <label>
              {t("عنوان المصدر", "Source title")}
              <input
                value={title}
                onChange={(e) => TI(e.target.value)}
                required
              />
            </label>
            <label>
              {t("رقم القسم أو محدّد المقطع", "Section or passage locator")}
              <input
                value={section}
                onChange={(e) => SE(e.target.value)}
                required
              />
            </label>
            <label>
              {t("رابط المصدر (اختياري)", "Source URL (optional)")}
              <input
                type="url"
                value={url}
                onChange={(e) => URL(e.target.value)}
                dir="ltr"
              />
            </label>
          </div>
          <label>
            {t("النص المسموح باستخدامه", "Authorized text")}
            <textarea
              value={passage}
              onChange={(e) => PT(e.target.value)}
              required
              minLength={20}
              maxLength={30000}
              dir="auto"
            />
          </label>
          <label>
            {t("مرجع تصريح الاستخدام", "Permission reference")}
            <input
              value={rights}
              onChange={(e) => RI(e.target.value)}
              required
              minLength={5}
            />
          </label>
          <label className="checklabel">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => CF(e.target.checked)}
              required
            />
            {t(
              "أؤكد السماح باستخراج وعرض هذا النص وإرساله للموديل المعتمد.",
              "I confirm permission to extract, display and send this passage to the approved model.",
            )}
          </label>
          <div className="end">
            <Button type="submit" primary disabled={busy || !confirmed}>
              {t("استيراد المقطع للمراجعة", "Import passage for review")}
            </Button>
          </div>
        </form>
      </Box>
    </>
  );
}
function UmbrellaUpload({
  mode,
  lang,
  t,
  busy,
  umbrellas,
  act,
  open,
}: {
  mode: "umbrella" | "lecture";
  lang: Lang;
  t: Translate;
  busy: boolean;
  umbrellas: any[];
  act: (f: () => Promise<any>) => Promise<any>;
  open: (id: string) => Promise<void>;
}) {
  const [title, TI] = useState(""),
    [rights, RI] = useState(""),
    [confirmed, CF] = useState(false),
    [file, F] = useState<File | null>(null),
    [replace, RP] = useState(""),
    [done, DN] = useState("");
  const isLecture = mode === "lecture";
  return (
    <Box cls="end">
      <h2>
        {isLecture
          ? t("محاضرات إضافية", "Additional lectures")
          : t("المرجع الشامل للمقرر", "Course umbrella reference")}
      </h2>
      <p>
        {isLecture
          ? t(
              "ارفع أي محاضرة PDF خارج الحزمة الثابتة. تبقى صفحاتها بانتظار مراجعتك ثم تُستخرج مفاهيمها.",
              "Upload any lecture PDF beyond the fixed pack. Its pages stay pending your review, then its concepts can be extracted.",
            )
          : t(
              "ارفع المرجع الذي تُستخرج منه المتطلبات السابقة لمفاهيم المحاضرات: كتاب المقرر أو فصل منه أو مذكرة أساسيات. يُقسَّم إلى أقسام تبقى بانتظار مراجعتك.",
              "Upload the reference that prerequisites of lecture concepts are extracted from: the course textbook, a chapter or a foundations handout. It is split into sections that stay pending your review.",
            )}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file) return;
          const form = new FormData();
          form.append("kind", mode);
          form.append("file", file);
          form.append("title", title);
          form.append("rightsConfirmed", String(confirmed));
          form.append("rightsReference", rights);
          if (replace) form.append("sourceKey", replace);
          DN("");
          const r = await act(() => request("/api/materials", form, lang));
          if (r)
            DN(
              r.deduplicated
                ? t(
                    "هذا الملف مرفوع من قبل؛ لم تُنشأ نسخة جديدة.",
                    "This file was already uploaded; no new version was created.",
                  )
                : t(
                    `تم الاستيراد: ${r.pages} قسمًا بانتظار المراجعة.`,
                    `Imported: ${r.pages} sections pending review.`,
                  ),
            );
        }}
      >
        <div className="two-columns">
          <label>
            {isLecture
              ? t("عنوان المحاضرة", "Lecture title")
              : t("عنوان المرجع", "Reference title")}
            <input
              value={title}
              onChange={(e) => TI(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label>
            {isLecture
              ? t("ملف المحاضرة (PDF)", "Lecture file (PDF)")
              : t(
                  "الملف (PDF أو نص أو Markdown)",
                  "File (PDF, text or Markdown)",
                )}
            <input
              type="file"
              accept={
                isLecture
                  ? ".pdf,application/pdf"
                  : ".pdf,.md,.markdown,.txt,application/pdf,text/plain,text/markdown"
              }
              required
              onChange={(e) => F(e.target.files?.[0] || null)}
            />
          </label>
          {!isLecture && (
            <label>
              {t("مرجع تصريح الاستخدام", "Permission reference")}
              <input
                value={rights}
                onChange={(e) => RI(e.target.value)}
                required
                minLength={5}
                maxLength={500}
              />
            </label>
          )}
          {umbrellas.length > 0 && (
            <label>
              {t("نوع الرفع", "Upload as")}
              <select value={replace} onChange={(e) => RP(e.target.value)}>
                <option value="">
                  {isLecture
                    ? t("محاضرة جديدة", "New lecture")
                    : t("مرجع جديد", "New reference")}
                </option>
                {umbrellas.map((u) => (
                  <option key={u.sourceKey} value={u.sourceKey}>
                    {t("نسخة جديدة من", "New version of")} {u.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <small>
          {t(
            "الحد الأقصى ٣٫٥ ميجابايت و١٠٠ صفحة للملف؛ ارفع الكتاب الكبير فصلًا فصلًا. الصفحات المصوّرة تُعزل حتى ترفق نصًّا لها.",
            "Up to 3.5 MB and 100 pages per file; upload a large book chapter by chapter. Image-only pages are quarantined until you attach their text.",
          )}
        </small>
        {!isLecture && (
          <label className="checklabel">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => CF(e.target.checked)}
              required
            />
            {t(
              "أؤكد السماح باستخراج هذا المرجع وعرض مقاطعه وإرسالها للنموذج المعتمد.",
              "I confirm permission to extract this reference, display its passages and send them to the approved model.",
            )}
          </label>
        )}
        <div className="end">
          <Button
            type="submit"
            primary
            disabled={busy || (!isLecture && !confirmed) || !file}
          >
            <Upload size={16} />
            {isLecture
              ? t("رفع المحاضرة للمراجعة", "Upload lecture for review")
              : t("رفع المرجع للمراجعة", "Upload reference for review")}
          </Button>
        </div>
      </form>
      {done && <p role="status">{done}</p>}
      {umbrellas.map((u) => (
        <article key={u.sourceKey} className="material-row">
          <div>
            <strong>{u.title}</strong>
            <small>
              {u.status === "pending"
                ? t("لم يُنشر بعد", "Not published yet")
                : statusLabel(u.status, t)}{" "}
              · {t("معتمد", "Approved")} {u.sections.approved || 0} ·{" "}
              {t("بانتظار المراجعة", "Pending")} {u.sections.pending || 0}
              {u.sections.quarantined
                ? ` · ${t("معزول", "Quarantined")} ${u.sections.quarantined}`
                : ""}
            </small>
          </div>
          <Button onClick={() => open(u.currentVersionId)}>
            <FileText size={16} />
            {isLecture
              ? t("مراجعة الصفحات", "Review pages")
              : t("مراجعة الأقسام", "Review sections")}
          </Button>
          {(u.sections.pending || 0) > 0 && (
            <Button
              disabled={busy}
              onClick={() =>
                act(() =>
                  request(
                    `/api/materials/${u.currentVersionId}`,
                    { action: "approve-pending" },
                    lang,
                  ),
                )
              }
            >
              <Check size={16} />
              {isLecture
                ? t("اعتماد كل الصفحات المقروءة", "Approve all readable pages")
                : t(
                    "اعتماد كل الأقسام المقروءة",
                    "Approve all readable sections",
                  )}
            </Button>
          )}
        </article>
      ))}
    </Box>
  );
}
const LECTURES = [1, 2, 3, 4, 5, 6].map((n) => `CET351-L${n}`);
function PrerequisiteReview({
  p,
  lang,
  t,
  busy,
  act,
}: {
  p: any;
  lang: Lang;
  t: Translate;
  busy: boolean;
  act: (body: any) => Promise<void>;
}) {
  const d = p.data || p;
  const source = d.extracted || d.graph;
  const status = d.status || "pending";
  const kept = new Set(
    (d.graph?.edges || []).map((e: any) => `${e.from}|${e.to}`),
  );
  const key = (e: any) => `${e.from}|${e.to}`;
  // Before the first decision every extracted relationship starts selected.
  const [accepted, AC] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      source.edges.map((e: any) => [
        key(e),
        status === "pending" ? true : kept.has(key(e)),
      ]),
    ),
  );
  const [types, TY] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      source.edges.map((e: any) => [
        key(e),
        d.graph?.edges.find((x: any) => key(x) === key(e))?.type || e.type,
      ]),
    ),
  );
  const [dropped, DR] = useState<Record<string, boolean>>({});
  const label = (id: string) =>
    localized(source.concepts.find((c: any) => c.id === id)?.label, lang) || id;
  const lectureIds = new Set(d.lectureConceptIds || []);
  const passage = (id: string) =>
    (p.passages || []).find((x: any) => x.id === id);
  const locked = status === "published";
  const count = source.edges.filter((e: any) => accepted[key(e)]).length;
  return (
    <article className="proposal-card">
      <div className="sectionTop">
        <h3>{localized(d.title, lang)}</h3>
        <span className="badge lavender">{statusLabel(status, t)}</span>
      </div>
      <small>
        {t("النموذج", "Model")}: <bdi>{d.modelId}</bdi> · {t("طلبات", "Calls")}{" "}
        {d.stats?.calls} · {t("مفاهيم المحاضرة", "Lecture concepts")}{" "}
        {d.stats?.lectureConcepts} · {t("علاقات", "Relationships")}{" "}
        {d.stats?.edges}
      </small>
      {d.stats?.partial && (
        <p className="notice">
          {t(
            "الاستخراج جزئي: تعذّر أحد طلبات النموذج. يمكنك اعتماد الموجود أو إعادة الاستخراج لاحقًا.",
            "Partial extraction: a model request failed. Approve what is here or re-run later.",
          )}
        </p>
      )}
      <h3>{t("مفاهيم المحاضرة", "Lecture concepts")}</h3>
      <div className="chips">
        {source.concepts
          .filter((c: any) => lectureIds.has(c.id))
          .map((c: any) => (
            <label className="checklabel" key={c.id}>
              <input
                type="checkbox"
                disabled={locked}
                checked={!dropped[c.id]}
                onChange={(e) =>
                  DR((x) => ({ ...x, [c.id]: !e.target.checked }))
                }
              />
              {localized(c.label, lang)}
            </label>
          ))}
      </div>
      <h3>
        {t("المتطلبات السابقة المقترحة", "Proposed prerequisites")} ({count}/
        {source.edges.length})
      </h3>
      {source.edges.length === 0 && (
        <p>
          {t(
            "لم يجد النموذج في المرجع الشامل ما يدعم متطلبات سابقة لهذه المحاضرة.",
            "The model found no umbrella support for prerequisites of this lecture.",
          )}
        </p>
      )}
      {source.edges.map((e: any) => {
        const off = dropped[e.from] || dropped[e.to];
        return (
          <div className="notice" key={key(e)}>
            <label className="checklabel">
              <input
                type="checkbox"
                disabled={locked || off}
                checked={!!accepted[key(e)] && !off}
                onChange={(ev) =>
                  AC((x) => ({ ...x, [key(e)]: ev.target.checked }))
                }
              />
              <strong>
                {label(e.from)} → {label(e.to)}
              </strong>
            </label>
            <p>{localized(e.reason, lang)}</p>
            <label>
              {t("نوع العلاقة", "Relationship type")}
              <select
                disabled={locked}
                value={types[key(e)]}
                onChange={(ev) =>
                  TY((x) => ({ ...x, [key(e)]: ev.target.value }))
                }
              >
                <option value="prerequisite">
                  {t(
                    "متطلب سابق — يوجّه مسار الطالب",
                    "Prerequisite — routes the learner",
                  )}
                </option>
                <option value="optional_bridge">
                  {t(
                    "خلفية اختيارية — لا تغيّر المسار",
                    "Optional background — does not route",
                  )}
                </option>
              </select>
            </label>
            {e.evidenceIds.map((id: string) => {
              const c = passage(id);
              return c ? (
                <div key={id}>
                  <a
                    href={`/sources/${c.version_id}?${c.page ? `page=${c.page}` : `section=${encodeURIComponent(c.section || "")}`}`}
                    target="_blank"
                    rel="noreferrer"
                    className="textbtn"
                  >
                    {c.title || c.source_key} · {c.page || c.section}
                  </a>
                  <blockquote dir="auto">
                    {String(c.text_content || "").slice(0, 700)}
                  </blockquote>
                </div>
              ) : null;
            })}
          </div>
        );
      })}
      {(d.dropped || []).length > 0 && (
        <details>
          <summary>
            {t(
              `استبعد التحقق الآلي ${d.dropped.length} عنصرًا من ردّ النموذج`,
              `Automatic validation excluded ${d.dropped.length} model outputs`,
            )}
          </summary>
          {d.dropped.map((x: any, i: number) => (
            <p key={i}>
              <bdi>
                {x.from ? `${x.from} → ${x.to}` : x.label} · {x.reason}
              </bdi>
            </p>
          ))}
        </details>
      )}
      {!locked && (
        <div className="actions">
          <Button
            primary
            disabled={busy}
            onClick={() =>
              act({
                action: "review-edges",
                id: p.id,
                accept: source.edges
                  .filter((e: any) => accepted[key(e)])
                  .map((e: any) => ({
                    from: e.from,
                    to: e.to,
                    type: types[key(e)],
                  })),
                rejectConcepts: Object.keys(dropped).filter((k) => dropped[k]),
              })
            }
          >
            <Check size={16} />
            {t("اعتماد المحدَّد", "Approve selection")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              act({ action: "review", id: p.id, status: "rejected" })
            }
          >
            {t("رفض المقترح كله", "Reject whole proposal")}
          </Button>
        </div>
      )}
      <small>
        {t(
          "الاعتماد لا يغيّر مسار أي طالب حتى تضغط «نشر المعتمد».",
          "Approval changes no learner path until you press “Publish approved”.",
        )}
      </small>
    </article>
  );
}
function QuestionBank({
  data,
  lang,
  t,
  busy,
  act,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  busy: boolean;
  act: (body: any) => Promise<void>;
}) {
  const [settings, S] = useState<any>(data.bank.settings),
    [exemplars, EX] = useState<string>(
      (data.bank.settings.exemplars || []).join("\n---\n"),
    ),
    [filter, F] = useState(""),
    [picked, P] = useState<string[]>([]);
  const kindNames: Record<string, string> = {
    choice: t("اختيار من متعدد", "Multiple choice"),
    critique: t("اكتشاف الخطأ في حل", "Find the error in a solution"),
    open: t("سؤال مقالي", "Open response"),
    transfer: t("تطبيق في سياق جديد", "Transfer to a new context"),
  };
  const levelNames: Record<string, string> = {
    easy: t("سهل", "Easy"),
    medium: t("متوسط", "Medium"),
    hard: t("صعب", "Hard"),
  };
  const weights = (
    group: "kinds" | "difficulty",
    names: Record<string, string>,
  ) =>
    Object.keys(names).map((k) => (
      <label key={k}>
        {names[k]}
        <input
          type="number"
          min={0}
          max={10}
          value={settings[group][k]}
          onChange={(e) =>
            S({
              ...settings,
              [group]: { ...settings[group], [k]: Number(e.target.value) },
            })
          }
        />
      </label>
    ));
  const concepts = (data.concepts || [])
    .map((c: any) => ({ id: c.id, label: c.data?.label }))
    .filter(
      (c: any) =>
        !filter.trim() ||
        `${c.label?.ar} ${c.label?.en}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
    );
  return (
    <Box cls="end">
      <h2>{t("بنك الأسئلة", "Question bank")}</h2>
      <p>
        {t(
          "حدّد نِسَب أنواع الأسئلة ومستويات الصعوبة وأسلوب امتحانك. الأرقام أوزان نسبية؛ الصفر يستبعد النوع.",
          "Set the mix of question kinds and difficulty and describe your exam style. Numbers are relative weights; zero excludes a kind.",
        )}
      </p>
      <h3>{t("أنواع الأسئلة", "Question kinds")}</h3>
      <div className="two-columns">{weights("kinds", kindNames)}</div>
      <h3>{t("مستويات الصعوبة", "Difficulty levels")}</h3>
      <div className="two-columns">
        {weights("difficulty", levelNames)}
        <label>
          {t(
            "عدد الأسئلة لكل مفهوم في كل توليد",
            "Questions per concept per run",
          )}
          <input
            type="number"
            min={1}
            max={5}
            value={settings.perConcept}
            onChange={(e) =>
              S({ ...settings, perConcept: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <label>
        {t("وصف أسلوب الامتحان", "Exam style description")}
        <textarea
          dir="auto"
          maxLength={2000}
          value={settings.styleNotes}
          placeholder={t(
            "مثال: سيناريو قصير من الواقع ثم سؤال واحد، أرقام بسيطة تُحسب يدويًّا، بلا أسئلة تعريفات مباشرة.",
            "Example: a short real-world scenario then one question, numbers solvable by hand, no direct definition questions.",
          )}
          onChange={(e) => S({ ...settings, styleNotes: e.target.value })}
        />
      </label>
      <label>
        {t(
          "أسئلة سابقة كنماذج للأسلوب (حتى ٥، افصل بينها بسطر ---)",
          "Past questions as style samples (up to 5, separate with a --- line)",
        )}
        <textarea
          dir="auto"
          value={exemplars}
          onChange={(e) => EX(e.target.value)}
        />
      </label>
      <small>
        {t(
          "يُحاكى شكل النماذج وصياغتها فقط، ولا يُنسخ محتواها.",
          "Only the format and wording of samples are imitated; their content is not copied.",
        )}
      </small>
      <div className="end">
        <Button
          disabled={busy}
          onClick={() =>
            act({
              action: "bank-settings",
              settings: {
                ...settings,
                exemplars: exemplars
                  .split(/\n-{3,}\n/)
                  .map((x) => x.trim())
                  .filter((x) => x.length >= 10)
                  .slice(0, 5),
              },
            })
          }
        >
          {t("حفظ الإعدادات", "Save settings")}
        </Button>
      </div>
      <h3>
        {t(
          "توليد أسئلة لمفاهيم منشورة",
          "Draft questions for published concepts",
        )}
      </h3>
      <label>
        {t("ابحث عن مفهوم", "Find a concept")}
        <input value={filter} onChange={(e) => F(e.target.value)} dir="auto" />
      </label>
      <div className="chips">
        {concepts.slice(0, 40).map((c: any) => {
          const n = data.bank.coverage[c.id]?.total || 0;
          return (
            <label className="checklabel" key={c.id}>
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                disabled={!picked.includes(c.id) && picked.length >= 3}
                onChange={(e) =>
                  P(
                    e.target.checked
                      ? [...picked, c.id]
                      : picked.filter((x) => x !== c.id),
                  )
                }
              />
              {localized(c.label, lang)} ({n})
            </label>
          );
        })}
      </div>
      <small>
        {t(
          "الرقم بين القوسين عدد الأسئلة المنشورة للمفهوم. اختر حتى ٣ مفاهيم في كل مرة؛ الأسئلة تظهر أعلاه كمسودات للمراجعة.",
          "The number in brackets is the concept’s published questions. Pick up to 3 concepts per run; drafts appear above for review.",
        )}
      </small>
      <div className="end">
        <Button
          primary
          disabled={busy || !picked.length}
          onClick={async () => {
            // One concept per request keeps each call inside the serverless time limit.
            for (const conceptId of picked)
              await act({ action: "generate-bank", conceptIds: [conceptId] });
            P([]);
          }}
        >
          {t("توليد مسودات الأسئلة", "Draft questions")}
        </Button>
      </div>
    </Box>
  );
}
export function KnowledgePanel({
  lang,
  t,
  onError,
  onChanged,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
  onChanged: () => Promise<any>;
}) {
  const [data, D] = useState<any>(null),
    [busy, B] = useState(false),
    [expanded, EX] = useState(""),
    [edit, ED] = useState(""),
    [teachingEdit, TE] = useState(""),
    [lecture, LE] = useState(LECTURES[0]);
  const [custom, CU] = useState<any[]>([]),
    [showPublished, SP] = useState(false);
  const refresh = async () =>
    D(await request("/api/knowledge", undefined, lang));
  useEffect(() => {
    refresh().catch((e) => onError(e.message));
    request("/api/materials", undefined, lang)
      .then((m) => CU(m.lectures || []))
      .catch(() => undefined);
  }, []);
  const act = async (body: any) => {
    B(true);
    onError("");
    try {
      await request("/api/knowledge", body, lang);
      await refresh();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      B(false);
    }
  };
  return (
    <>
      <div className="pageHead">
        <h1>{t("مراجعة المعرفة", "Knowledge review")}</h1>
        <p>
          {t(
            "كل مفهوم وعلاقة وسؤال يبدأ كمسودة. قرار النشر لك.",
            "Every concept, relationship and question starts as a draft. You decide what gets published.",
          )}
        </p>
      </div>
      <Box>
        <div className="sectionTop">
          <h2>
            {t("اقتراحات قائمة على المصادر", "Source-grounded proposals")}
          </h2>
          <div className="actions">
            <Button disabled={busy} onClick={() => act({ action: "propose" })}>
              <GitBranch size={16} />
              {t("اقتراحات Gemini", "Propose with Gemini")}
            </Button>
            <Button disabled={busy} onClick={() => act({ action: "generate" })}>
              {t("اقتراح جلسة وسؤال", "Draft session & question")}
            </Button>
            <Button
              primary
              disabled={busy}
              onClick={() => act({ action: "publish" })}
            >
              <Check size={17} />
              {t("نشر المعتمد", "Publish approved")}
            </Button>
          </div>
        </div>
        <div className="actions">
          <label>
            {t("المحاضرة", "Lecture")}
            <select value={lecture} onChange={(e) => LE(e.target.value)}>
              {LECTURES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              {custom.map((l) => (
                <option key={l.sourceKey} value={l.sourceKey}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
          <Button
            primary
            disabled={busy}
            onClick={() =>
              act({
                action: "extract-prerequisites",
                lectureSourceKey: lecture,
              })
            }
          >
            <GitBranch size={16} />
            {t(
              "استخراج المفاهيم والمتطلبات السابقة",
              "Extract concepts & prerequisites",
            )}
          </Button>
        </div>
        <small>
          {t(
            "يقرأ النموذج كل صفحات المحاضرة المعتمدة ثم يبحث في المرجع الشامل المعتمد عمّا يسبق كل مفهوم. قد يستغرق حتى دقيقة.",
            "The model reads every approved lecture page, then searches the approved umbrella reference for what precedes each concept. This can take up to a minute.",
          )}
        </small>
        <p className="notice">
          {t(
            "تُرسل المقاطع المسموح بها فقط. الاقتراح لا يغيّر مسار الطالب حتى المراجعة والنشر.",
            "Only permitted passages are sent. A proposal does not change a learner’s path before review and publication.",
          )}
        </p>
        {busy && (
          <p role="status">{t("جارٍ حفظ المراجعة…", "Saving review…")}</p>
        )}
        {(data?.proposals || []).length === 0 && (
          <p>
            {t(
              "لا توجد مقترحات بعد. راجع صفحات المصادر ثم اطلب الاقتراحات.",
              "No proposals yet. Review source pages, then request proposals.",
            )}
          </p>
        )}
        {data?.extractionQuality?.reviewedRuns > 0 && (
          <p className="notice">
            {t(
              `جودة الاستخراج حتى الآن: اعتمدتَ ${data.extractionQuality.acceptedByInstructor} من ${data.extractionQuality.extractedRelationships} علاقة اقترحها النموذج (${Math.round(data.extractionQuality.precision)}٪)، وغيّرتَ نوع ${data.extractionQuality.typeChangedByInstructor}. استبعد التحقق الآلي ${data.extractionQuality.rejectedByValidation} قبل وصولها إليك.`,
              `Extraction quality so far: you kept ${data.extractionQuality.acceptedByInstructor} of ${data.extractionQuality.extractedRelationships} model-proposed relationships (${Math.round(data.extractionQuality.precision)}%) and changed the type of ${data.extractionQuality.typeChangedByInstructor}. Automatic validation excluded ${data.extractionQuality.rejectedByValidation} before they reached you.`,
            )}
          </p>
        )}
        <label className="checklabel">
          <input
            type="checkbox"
            checked={showPublished}
            onChange={(e) => SP(e.target.checked)}
          />
          {t(
            "إظهار المقترحات المنشورة والمرفوضة",
            "Show published and rejected proposals",
          )}
        </label>
        {(data?.proposals || [])
          .filter(
            (p: any) =>
              showPublished ||
              !["published", "rejected"].includes((p.data || p).status),
          )
          .map((p: any) => {
            const d = p.data || p;
            if (d.kind === "prerequisite-extraction")
              return (
                <PrerequisiteReview
                  key={`${p.id}:${d.status}:${d.reviewedAt || ""}`}
                  p={p}
                  lang={lang}
                  t={t}
                  busy={busy}
                  act={act}
                />
              );
            return (
              <article className="proposal-card" key={p.id}>
                <div className="sectionTop">
                  <h3>
                    {localized(d.title || d.label || d.stem || d.name, lang) ||
                      d.kind ||
                      p.kind}
                  </h3>
                  <span className="badge lavender">
                    {statusLabel(p.status || d.status || "pending", t)}
                  </span>
                </div>
                {d.graph && (
                  <>
                    <h3>{t("المفاهيم المقترحة", "Proposed concepts")}</h3>
                    <div className="chips">
                      {d.graph.concepts.map((c: any) => (
                        <span className="badge lavender" key={c.id}>
                          {localized(c.label, lang)}
                        </span>
                      ))}
                    </div>
                    <h3>
                      {t(
                        "العلاقات وأثرها على المسار",
                        "Relationships and path effects",
                      )}
                    </h3>
                    {d.graph.edges.map((e: any, i: number) => (
                      <div className="notice" key={i}>
                        <strong>
                          {localized(
                            d.graph.concepts.find((c: any) => c.id === e.from)
                              ?.label,
                            lang,
                          )}{" "}
                          →{" "}
                          {localized(
                            d.graph.concepts.find((c: any) => c.id === e.to)
                              ?.label,
                            lang,
                          )}
                        </strong>
                        <p>{localized(e.reason, lang)}</p>
                        <small>
                          {e.type === "prerequisite"
                            ? t(
                                "بعد النشر: يقترح تعلّم المتطلب السابق أولًا.",
                                "After publication: suggests the prerequisite first.",
                              )
                            : t(
                                "علاقة اختيارية لا تمنع تقدّم الطالب.",
                                "Optional relationship; does not gate progress.",
                              )}
                        </small>
                      </div>
                    ))}
                  </>
                )}
                {d.item && (
                  <>
                    {d.item.difficulty && (
                      <span className="badge">
                        {d.item.kind} · {d.item.difficulty}
                      </span>
                    )}
                    {d.session && (
                      <Button
                        onClick={() => TE(teachingEdit === p.id ? "" : p.id)}
                      >
                        {t("تعديل الجلسة والسؤال", "Edit session & question")}
                      </Button>
                    )}
                    {d.session && teachingEdit === p.id && (
                      <TeachingEditor
                        draft={d}
                        t={t}
                        busy={busy}
                        onSave={(item, session) =>
                          act({ action: "edit", id: p.id, item, session })
                        }
                      />
                    )}
                    <h3>
                      {t("مسودة سؤال ثنائي اللغة", "Bilingual question draft")}
                    </h3>
                    <p dir="rtl">{d.item.stem.ar}</p>
                    <p dir="ltr">{d.item.stem.en}</p>
                    {d.item.options?.map((o: any) => (
                      <p key={o.id}>
                        <bdi>{o.id}</bdi> · {o.label.ar} / {o.label.en}
                      </p>
                    ))}
                    <p>
                      <strong>
                        {t("المفتاح الخاص بالمدرّس", "Instructor-only key")}
                        :{" "}
                      </strong>
                      <bdi>{d.item.key}</bdi>
                    </p>
                    <p>{localized(d.item.rubric, lang)}</p>
                  </>
                )}
                {d.session && (
                  <>
                    <h3>{localized(d.session.title, lang)}</h3>
                    <p>{localized(d.session.body, lang)}</p>
                  </>
                )}
                {d.from && (
                  <p>
                    <bdi>{d.from}</bdi> → <bdi>{d.to}</bdi> ·{" "}
                    {d.relationship || d.type}
                  </p>
                )}
                <p>
                  {localized(d.rationale || d.reason || d.description, lang)}
                </p>
                {(
                  p.passages ||
                  d.evidence ||
                  d.citations ||
                  p.evidence ||
                  []
                ).map((c: any, i: number) => (
                  <div key={i} className="notice">
                    <a
                      href={
                        c.url ||
                        `/sources/${c.version_id || c.versionId || c.sourceVersionId}?${c.page ? `page=${c.page}` : `section=${encodeURIComponent(c.section || "")}`}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="textbtn"
                    >
                      {c.sourceKey || c.source_key || c.id} ·{" "}
                      {c.page || c.section}
                    </a>
                    {(c.text || c.text_content || c.quote) && (
                      <blockquote dir="auto">
                        {c.text || c.text_content || c.quote}
                      </blockquote>
                    )}
                  </div>
                ))}
                <div className="actions">
                  <Button
                    disabled={busy}
                    primary
                    onClick={() =>
                      act({ action: "review", id: p.id, status: "approved" })
                    }
                  >
                    {t("اعتماد", "Approve")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act({ action: "review", id: p.id, status: "rejected" })
                    }
                  >
                    {t("رفض", "Reject")}
                  </Button>
                  <Button
                    onClick={() => {
                      EX(expanded === p.id ? "" : p.id);
                      ED(JSON.stringify(d.graph || d, null, 2));
                    }}
                  >
                    {t("تعديل ومراجعة التفاصيل", "Edit & inspect details")}
                  </Button>
                </div>
                {expanded === p.id && (
                  <>
                    <label>
                      {t(
                        "بيانات المقترح — يحتفظ بالمعرّف الثابت",
                        "Proposal data — stable identity is preserved",
                      )}
                      <textarea
                        dir="ltr"
                        className="json-editor"
                        value={edit}
                        onChange={(e) => ED(e.target.value)}
                      />
                    </label>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        try {
                          act({
                            action: "review",
                            id: p.id,
                            status: "approved",
                            data: JSON.parse(edit),
                          });
                        } catch {
                          onError(
                            t("بيانات JSON غير صالحة.", "Invalid JSON data."),
                          );
                        }
                      }}
                    >
                      {t("حفظ التعديل واعتماد", "Save edit and approve")}
                    </Button>
                  </>
                )}
              </article>
            );
          })}
      </Box>
      <div className="split end">
        <Box>
          <h2>{t("مفاهيم ثابتة الهوية", "Stable concept identities")}</h2>
          {(data?.concepts || []).map((c: any) => (
            <div key={c.id} className="row">
              <strong>
                {localized(
                  c.name ||
                    c.label ||
                    c.data?.name ||
                    c.data?.label ||
                    c.data?.title,
                  lang,
                ) ||
                  c.canonical_name ||
                  c.id}
              </strong>
              <bdi>{c.id}</bdi>
            </div>
          ))}
        </Box>
        <Box>
          <h2>{t("تاريخ النشر", "Release history")}</h2>
          {(data?.releases || []).map((r: any) => (
            <div key={r.id} className="row">
              <bdi>{r.id}</bdi>
              <span>{r.version || r.created_at || r.data?.publishedAt}</span>
            </div>
          ))}
          <small>
            {t(
              "الإصدارات السابقة وأدلة الطلاب محفوظة عند تحديث المصدر.",
              "Previous releases and learner evidence are retained when sources change.",
            )}
          </small>
        </Box>
      </div>
      {data?.bank && (
        <QuestionBank
          key={JSON.stringify(data.bank.settings)}
          data={data}
          lang={lang}
          t={t}
          busy={busy}
          act={act}
        />
      )}
      <ConceptMappings lang={lang} t={t} onError={onError} />
    </>
  );
}
function TeachingEditor({
  draft,
  t,
  busy,
  onSave,
}: {
  draft: any;
  t: Translate;
  busy: boolean;
  onSave: (item: any, session: any) => void;
}) {
  const [item, I] = useState<any>(structuredClone(draft.item)),
    [session, S] = useState<any>(structuredClone(draft.session));
  const editItem = (field: string, lang: "ar" | "en", value: string) =>
    I({ ...item, [field]: { ...item[field], [lang]: value } });
  const editSession = (field: string, lang: "ar" | "en", value: string) =>
    S({ ...session, [field]: { ...session[field], [lang]: value } });
  return (
    <form
      className="teaching-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(item, session);
      }}
    >
      <h3>
        {t(
          "مراجعة تكافؤ العربية والإنجليزية",
          "Review Arabic / English equivalence",
        )}
      </h3>
      {["stem", "feedback", "rubric"].map((field) => (
        <div className="two-columns" key={field}>
          {(["ar", "en"] as const).map((l) => (
            <label key={l}>
              {field === "stem"
                ? t("السؤال", "Question")
                : field === "feedback"
                  ? t("التغذية الراجعة", "Feedback")
                  : t("معيار التصحيح", "Rubric")}{" "}
              · {l === "ar" ? "العربية" : "English"}
              <textarea
                value={item[field]?.[l] || ""}
                onChange={(e) => editItem(field, l, e.target.value)}
                dir={l === "ar" ? "rtl" : "ltr"}
                required
              />
            </label>
          ))}
        </div>
      ))}
      {(item.options || []).map((o: any, i: number) => (
        <div className="two-columns" key={o.id}>
          {(["ar", "en"] as const).map((l) => (
            <label key={l}>
              {t("الخيار", "Option")} <bdi>{o.id}</bdi> ·{" "}
              {l === "ar" ? "العربية" : "English"}
              <input
                value={o.label[l]}
                dir={l === "ar" ? "rtl" : "ltr"}
                onChange={(e) =>
                  I({
                    ...item,
                    options: item.options.map((v: any, j: number) =>
                      j === i
                        ? { ...v, label: { ...v.label, [l]: e.target.value } }
                        : v,
                    ),
                  })
                }
              />
            </label>
          ))}
        </div>
      ))}
      <label>
        {t(
          "المفتاح الخاص (غير مرسل للطالب)",
          "Private answer key (never delivered to learner)",
        )}
        <input
          value={item.key}
          onChange={(e) => I({ ...item, key: e.target.value })}
          dir="ltr"
        />
      </label>
      {["title", "body"].map((field) => (
        <div className="two-columns" key={field}>
          {(["ar", "en"] as const).map((l) => (
            <label key={l}>
              {field === "title"
                ? t("عنوان الجلسة", "Session title")
                : t("محتوى الجلسة", "Session content")}{" "}
              · {l === "ar" ? "العربية" : "English"}
              <textarea
                value={session[field]?.[l] || ""}
                onChange={(e) => editSession(field, l, e.target.value)}
                dir={l === "ar" ? "rtl" : "ltr"}
                required
              />
            </label>
          ))}
        </div>
      ))}
      <Button type="submit" disabled={busy} primary>
        {t("حفظ المسودة المعدّلة", "Save edited draft")}
      </Button>
      <small>
        {t(
          "يتطلب التعديل اعتمادًا جديدًا قبل النشر.",
          "Edits require fresh approval before publication.",
        )}
      </small>
    </form>
  );
}
function ConceptMappings({
  lang,
  t,
  onError,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
}) {
  const [data, D] = useState<any>(null),
    [kind, K] = useState("rename"),
    [from, F] = useState(""),
    [target, T] = useState(""),
    [ar, A] = useState(""),
    [en, E] = useState(""),
    [secondAr, SA] = useState(""),
    [secondEn, SE] = useState(""),
    [reasonAr, RA] = useState(""),
    [reasonEn, RE] = useState(""),
    [busy, B] = useState(false);
  const refresh = async () => {
    const r = await request("/api/concept-mapping", undefined, lang);
    D(r);
  };
  useEffect(() => {
    refresh().catch((e) => onError(e.message));
  }, []);
  const concepts = data?.graph?.concepts || [];
  const selected = concepts.find((c: any) => c.id === from);
  const act = async (body: any) => {
    B(true);
    try {
      await request("/api/concept-mapping", body, lang);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      B(false);
    }
  };
  return (
    <Box cls="end">
      <h2>{t("تطوير هوية المفاهيم", "Evolving concept identities")}</h2>
      <p>
        {t(
          "تغيير الاسم يحتفظ بالهوية. الدمج والفصل يخضعان للمراجعة؛ المفاهيم الناتجة عن الفصل تبدأ غير مقاسة.",
          "Renaming preserves identity. Merges and splits require review; split successors start unassessed.",
        )}
      </p>
      {concepts.length === 0 ? (
        <p>
          {t(
            "انشر خريطة معتمدة أولًا لإدارة المفاهيم.",
            "Publish an approved graph before managing concepts.",
          )}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act({
              action: "propose",
              kind,
              conceptId: from,
              reason: { ar: reasonAr, en: reasonEn },
              ...(kind === "rename"
                ? { label: { ar, en } }
                : kind === "merge"
                  ? { targetId: target }
                  : {
                      successors: [
                        {
                          label: { ar, en },
                          evidenceIds: selected?.evidenceIds || [],
                        },
                        {
                          label: { ar: secondAr, en: secondEn },
                          evidenceIds: selected?.evidenceIds || [],
                        },
                      ],
                    }),
            });
          }}
        >
          <div className="two-columns">
            <label>
              {t("نوع التغيير", "Change type")}
              <select value={kind} onChange={(e) => K(e.target.value)}>
                <option value="rename">{t("إعادة تسمية", "Rename")}</option>
                <option value="merge">{t("دمج", "Merge")}</option>
                <option value="split">
                  {t("فصل إلى مفهومين", "Split into two concepts")}
                </option>
              </select>
            </label>
            <label>
              {t("المفهوم الحالي", "Current concept")}
              <select value={from} onChange={(e) => F(e.target.value)} required>
                <option value="">{t("اختَر مفهومًا", "Choose a concept")}</option>
                {concepts.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {localized(c.label, lang)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {kind === "merge" ? (
            <label>
              {t("الدمج في مفهوم موجود", "Merge into existing concept")}
              <select
                value={target}
                onChange={(e) => T(e.target.value)}
                required
              >
                <option value="">
                  {t("اختَر المفهوم الهدف", "Choose target concept")}
                </option>
                {concepts
                  .filter((c: any) => c.id !== from)
                  .map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {localized(c.label, lang)}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <div className="two-columns">
              <label>
                {t("الاسم بالعربية", "Arabic label")}
                <input
                  value={ar}
                  onChange={(e) => A(e.target.value)}
                  dir="rtl"
                  required
                />
              </label>
              <label>
                {t("الاسم بالإنجليزية", "English label")}
                <input
                  value={en}
                  onChange={(e) => E(e.target.value)}
                  dir="ltr"
                  required
                />
              </label>
              {kind === "split" && (
                <>
                  <label>
                    {t(
                      "اسم المفهوم الثاني بالعربية",
                      "Second concept Arabic label",
                    )}
                    <input
                      value={secondAr}
                      onChange={(e) => SA(e.target.value)}
                      dir="rtl"
                      required
                    />
                  </label>
                  <label>
                    {t(
                      "اسم المفهوم الثاني بالإنجليزية",
                      "Second concept English label",
                    )}
                    <input
                      value={secondEn}
                      onChange={(e) => SE(e.target.value)}
                      dir="ltr"
                      required
                    />
                  </label>
                </>
              )}
            </div>
          )}
          <div className="two-columns">
            <label>
              {t("سبب التغيير بالعربية", "Reason in Arabic")}
              <textarea
                value={reasonAr}
                onChange={(e) => RA(e.target.value)}
                dir="rtl"
                required
              />
            </label>
            <label>
              {t("سبب التغيير بالإنجليزية", "Reason in English")}
              <textarea
                value={reasonEn}
                onChange={(e) => RE(e.target.value)}
                dir="ltr"
                required
              />
            </label>
          </div>
          <Button primary type="submit" disabled={busy}>
            {t("إرسال التغيير للمراجعة", "Submit change for review")}
          </Button>
        </form>
      )}
      {(data?.mappings || []).map((m: any) => (
        <article className="proposal-card" key={m.id}>
          <strong>
            {m.data.kind === "rename"
              ? t("إعادة تسمية", "Rename")
              : m.data.kind === "merge"
                ? t("دمج", "Merge")
                : t("فصل", "Split")}
          </strong>
          <p>{localized(m.data.reason, lang)}</p>
          <span className="badge lavender">
            {statusLabel(m.data.status, t)}
          </span>
          {m.data.status === "pending" && (
            <div className="actions">
              <Button
                disabled={busy}
                primary
                onClick={() => act({ action: "approve", id: m.id })}
              >
                {t("اعتماد التغيير", "Approve change")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => act({ action: "reject", id: m.id })}
              >
                {t("رفض التغيير", "Reject change")}
              </Button>
            </div>
          )}
        </article>
      ))}
    </Box>
  );
}
