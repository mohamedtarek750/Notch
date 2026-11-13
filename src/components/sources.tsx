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
      SL(r);
      P(r.chunks?.[0]);
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
    [teachingEdit, TE] = useState("");
  const refresh = async () =>
    D(await request("/api/knowledge", undefined, lang));
  useEffect(() => {
    refresh().catch((e) => onError(e.message));
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
        {(data?.proposals || []).map((p: any) => {
          const d = p.data || p;
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
                  <Button onClick={() => TE(teachingEdit === p.id ? "" : p.id)}>
                    {t("تعديل الجلسة والسؤال", "Edit session & question")}
                  </Button>
                  {teachingEdit === p.id && (
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
                      {t("المفتاح الخاص بالمدرّس", "Instructor-only key")}:{" "}
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
              <p>{localized(d.rationale || d.reason || d.description, lang)}</p>
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
