"use client";
import { useCallback, useEffect, useState } from "react";
import { Box, Button, request, type Translate } from "./Workspace";

type Lang = "ar" | "en";
type Named = { id: string; name: { ar: string; en: string } };
export type Catalog = {
  current: string;
  faculties: Named[];
  majors: (Named & { facultyId: string })[];
  courses: {
    id: string;
    code: string;
    title: { ar: string; en: string };
    majorId: string | null;
    term?: string | null;
    order?: number;
    prerequisites?: string[];
    externalPrerequisites?: string[];
    assessable?: number;
    percent?: number | null;
    finished?: boolean;
    locked?: boolean;
  }[];
};
/** "Faculty › Major › Course" for the open course, or just the course when unplaced. */
export function coursePath(catalog: Catalog | null, lang: Lang) {
  const course = catalog?.courses.find((c) => c.id === catalog.current);
  if (!course) return "";
  const major = catalog!.majors.find((m) => m.id === course.majorId);
  const faculty = catalog!.faculties.find((f) => f.id === major?.facultyId);
  return [
    faculty?.name[lang],
    major?.name[lang],
    course.title?.[lang] || course.code,
  ]
    .filter(Boolean)
    .join(" › ");
}
/** Switching reloads the page so every screen shows the newly opened course. */
export async function openCourse(courseId: string, lang: Lang, view?: string) {
  await request("/api/catalog", { action: "select-course", courseId }, lang);
  // Which screen to land on after the reload, for example the course's own tree.
  try {
    if (view) sessionStorage.setItem("notch_open_view", view);
  } catch {}
  window.location.reload();
}
const CARD_W = 214,
  CARD_H = 118,
  GAP_X = 54,
  GAP_Y = 14,
  HEAD = 44;
/**
 * The study plan of one major: its courses term by term, each saying what must be
 * finished first. Pressing a course opens that course's own knowledge tree.
 */
export function StudyMap({
  catalog,
  majorId,
  lang,
  t,
  student,
  onError,
}: {
  catalog: Catalog;
  majorId: string;
  lang: Lang;
  t: Translate;
  student: boolean;
  onError: (message: string) => void;
}) {
  const courses = catalog.courses
    .filter((c) => c.majorId === majorId && c.term)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!courses.length) return null;
  const terms = [...new Set(courses.map((c) => c.term!))];
  const at = new Map<string, { x: number; y: number }>();
  let rows = 1;
  terms.forEach((term, column) => {
    const list = courses.filter((c) => c.term === term);
    rows = Math.max(rows, list.length);
    list.forEach((c, row) =>
      at.set(c.id, {
        x: column * (CARD_W + GAP_X),
        y: HEAD + row * (CARD_H + GAP_Y),
      }),
    );
  });
  const width = terms.length * (CARD_W + GAP_X) - GAP_X,
    height = HEAD + rows * (CARD_H + GAP_Y);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const label = (c: Catalog["courses"][number]) => c.title?.[lang] || c.code;
  const tone = (c: Catalog["courses"][number]) =>
    c.locked
      ? { bg: "#f1f0f5", line: "#a9a4bd", text: t("مقفل", "Locked") }
      : c.finished
        ? { bg: "#e9f7ef", line: "#23805a", text: t("أنهيته", "Finished") }
        : c.id === catalog.current
          ? {
              bg: "#ede5ff",
              line: "#7847ea",
              text: t("مفتوح الآن", "Open now"),
            }
          : { bg: "#ffffff", line: "#7847ea", text: "" };
  return (
    <div
      style={{ overflow: "auto", padding: "4px 2px 10px", direction: "ltr" }}
      role="group"
      aria-label={t("خطة الدراسة", "Study plan")}
    >
      <div style={{ position: "relative", width, height }}>
        <svg
          width={width}
          height={height}
          style={{ position: "absolute", inset: 0 }}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="plan-tip"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="9"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" fill="#8b7fc0" />
            </marker>
          </defs>
          {courses.flatMap((c) =>
            (c.prerequisites ?? [])
              .filter((p) => at.has(p))
              .map((p) => {
                const a = at.get(p)!,
                  b = at.get(c.id)!,
                  x1 = a.x + CARD_W,
                  y1 = a.y + CARD_H / 2,
                  x2 = b.x,
                  y2 = b.y + CARD_H / 2,
                  bend = Math.max(26, (x2 - x1) / 2);
                return (
                  <path
                    key={p + ">" + c.id}
                    d={`M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}
                    fill="none"
                    stroke="#8b7fc0"
                    strokeWidth={1.6}
                    opacity={0.75}
                    markerEnd="url(#plan-tip)"
                  />
                );
              }),
          )}
        </svg>
        {terms.map((term, column) => (
          <div
            key={term}
            style={{
              position: "absolute",
              left: column * (CARD_W + GAP_X),
              top: 0,
              width: CARD_W,
              textAlign: "center",
              padding: "7px 0",
              borderRadius: 8,
              background: "#130f25",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            {term}
          </div>
        ))}
        {courses.map((c) => {
          const p = at.get(c.id)!,
            look = tone(c);
          const needs = [
            ...(c.prerequisites ?? []).map((id) => {
              const before = byId.get(id);
              return before ? `${before.code} ${label(before)}` : "";
            }),
            ...(c.externalPrerequisites ?? []),
          ].filter(Boolean);
          return (
            <button
              key={c.id}
              type="button"
              dir={lang === "ar" ? "rtl" : "ltr"}
              title={
                c.locked
                  ? t(
                      "مقفل حتى تنهي ما يسبقه",
                      "Locked until you finish what comes before it",
                    )
                  : t("افتح شجرة هذا المقرر", "Open this course's tree")
              }
              onClick={() => {
                if (c.locked)
                  return onError(
                    t(
                      `«${label(c)}» مقفل حتى تنهي: ${needs.join("، ")}.`,
                      `“${label(c)}” is locked until you finish: ${needs.join(", ")}.`,
                    ),
                  );
                void openCourse(c.id, lang, "map").catch((e) =>
                  onError((e as Error).message),
                );
              }}
              style={{
                position: "absolute",
                left: p.x,
                top: p.y,
                width: CARD_W,
                height: CARD_H,
                boxSizing: "border-box",
                textAlign: "start",
                padding: "7px 9px",
                borderRadius: 10,
                border: `1.6px solid ${look.line}`,
                background: look.bg,
                color: "#130f25",
                overflow: "hidden",
                cursor: "pointer",
                font: "inherit",
                display: "block",
              }}
            >
              <span
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  fontWeight: 800,
                  color: look.line,
                }}
              >
                <bdi>{c.code}</bdi>
                <span>
                  {look.text}
                  {student && c.percent != null && !c.locked
                    ? ` ${c.percent}%`
                    : ""}
                </span>
              </span>
              <strong
                style={{ display: "block", fontSize: 13, lineHeight: 1.25 }}
              >
                {label(c)}
              </strong>
              <small
                style={{
                  display: "block",
                  marginTop: 4,
                  color: "#5b5478",
                  lineHeight: 1.3,
                }}
              >
                {needs.length
                  ? t("يسبقه: ", "After: ") +
                    needs.join(lang === "ar" ? "، " : ", ")
                  : t("لا يسبقه شيء", "Open from the start")}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CourseSwitcher({
  catalog,
  lang,
  t,
}: {
  catalog: Catalog | null;
  lang: Lang;
  t: Translate;
}) {
  if (!catalog || catalog.courses.length < 2) return null;
  const label = (c: Catalog["courses"][number]) => {
    const major = catalog.majors.find((m) => m.id === c.majorId);
    return `${major ? major.name[lang] + " › " : ""}${c.title?.[lang] || c.code}`;
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <select
        aria-label={t("المقرر المفتوح", "Open course")}
        value={catalog.current}
        onChange={(e) => void openCourse(e.target.value, lang)}
      >
        {catalog.courses.map((c) => (
          <option key={c.id} value={c.id}>
            {label(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AcademicStructure({
  lang,
  t,
  onError,
  canEdit,
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  canEdit: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [faculty, setFaculty] = useState(""),
    [major, setMajor] = useState<Record<string, string>>({}),
    [course, setCourse] = useState<
      Record<string, { code: string; title: string }>
    >({}),
    [place, setPlace] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      setCatalog(await request("/api/catalog", undefined, lang));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [lang, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    onError("");
    try {
      const result = await request("/api/catalog", body, lang);
      await load();
      return result;
    } catch (e) {
      onError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (!catalog) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const courseRow = (c: Catalog["courses"][number]) => (
    <div
      key={c.id}
      className="row"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <span>
        <strong>{c.title?.[lang] || c.code}</strong> <bdi>({c.code})</bdi>
      </span>
      {c.id === catalog.current ? (
        <span className="badge lavender">{t("مفتوح الآن", "Open now")}</span>
      ) : (
        <Button onClick={() => void openCourse(c.id, lang)}>
          {t("افتح المقرر", "Open course")}
        </Button>
      )}
    </div>
  );
  const unplaced = catalog.courses.filter((c) => !c.majorId);
  return (
    <>
      <h1>{t("الهيكل الأكاديمي", "Academic structure")}</h1>
      <p>
        {t(
          "الجامعة مقسّمة إلى كليات، وكل كلية إلى تخصصات، وكل تخصص إلى مقررات. لكل مقرر محاضراته وشجرته وأسئلته وطلابه. افتح المقرر الذي تريد العمل عليه.",
          "The university is divided into faculties, each faculty into majors, and each major into courses. Every course has its own lectures, tree, questions and students. Open the course you want to work on.",
        )}
      </p>
      {catalog.faculties.map((f) => (
        <Box key={f.id}>
          <h2>
            {t("كلية", "Faculty")}: {f.name[lang]}
          </h2>
          {catalog.majors
            .filter((m) => m.facultyId === f.id)
            .map((m) => (
              <div
                key={m.id}
                style={{
                  borderInlineStart: "3px solid #c9c6ea",
                  paddingInlineStart: 14,
                  margin: "14px 0",
                }}
              >
                <h3>
                  {t("تخصص", "Major")}: {m.name[lang]}
                </h3>
                <StudyMap
                  catalog={catalog}
                  majorId={m.id}
                  lang={lang}
                  t={t}
                  student={!canEdit}
                  onError={onError}
                />
                {catalog.courses
                  .filter((c) => c.majorId === m.id && !c.term)
                  .map(courseRow)}
                {canEdit && (
                  <label style={{ display: "block", margin: "8px 0" }}>
                    <small>
                      {t(
                        "استيراد خطة الدراسة لهذا التخصص (ملف JSON): المقررات بفصولها وما يسبق كل مقرر.",
                        "Import this major's study plan (JSON file): its courses by term and what comes before each.",
                      )}
                    </small>
                    <br />
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={busy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        try {
                          const plan = JSON.parse(await file.text());
                          await act({
                            action: "import-study-map",
                            majorId: m.id,
                            terms: plan.terms,
                          });
                        } catch {
                          onError(
                            t(
                              "تعذّرت قراءة الملف. يجب أن يكون JSON فيه قائمة terms.",
                              "Could not read the file. It must be JSON with a list of terms.",
                            ),
                          );
                        }
                      }}
                    />
                  </label>
                )}
                {!catalog.courses.some((c) => c.majorId === m.id) && (
                  <small>{t("لا مقررات بعد.", "No courses yet.")}</small>
                )}
                {canEdit && (
                  <form
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "end",
                      marginTop: 8,
                    }}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const draft = course[m.id];
                      if (!draft?.code || !draft?.title) return;
                      if (
                        await act({
                          action: "create-course",
                          majorId: m.id,
                          code: draft.code,
                          title: draft.title,
                        })
                      )
                        setCourse({
                          ...course,
                          [m.id]: { code: "", title: "" },
                        });
                    }}
                  >
                    <label>
                      {t("رمز المقرر", "Course code")}
                      <input
                        value={course[m.id]?.code ?? ""}
                        maxLength={20}
                        onChange={(e) =>
                          setCourse({
                            ...course,
                            [m.id]: {
                              title: course[m.id]?.title ?? "",
                              code: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      {t("اسم المقرر", "Course name")}
                      <input
                        value={course[m.id]?.title ?? ""}
                        maxLength={120}
                        onChange={(e) =>
                          setCourse({
                            ...course,
                            [m.id]: {
                              code: course[m.id]?.code ?? "",
                              title: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <Button type="submit" disabled={busy}>
                      {t("أضف مقررًا", "Add course")}
                    </Button>
                  </form>
                )}
              </div>
            ))}
          {canEdit && (
            <form
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "end",
              }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (!major[f.id]) return;
                if (
                  await act({
                    action: "create-major",
                    facultyId: f.id,
                    name: major[f.id],
                  })
                )
                  setMajor({ ...major, [f.id]: "" });
              }}
            >
              <label>
                {t("اسم التخصص", "Major name")}
                <input
                  value={major[f.id] ?? ""}
                  maxLength={120}
                  onChange={(e) =>
                    setMajor({ ...major, [f.id]: e.target.value })
                  }
                />
              </label>
              <Button type="submit" disabled={busy}>
                {t("أضف تخصصًا", "Add major")}
              </Button>
            </form>
          )}
        </Box>
      ))}
      {unplaced.length > 0 && (
        <Box>
          <h2>{t("مقررات بلا تخصص", "Courses not placed in a major")}</h2>
          {unplaced.map((c) => (
            <div key={c.id}>
              {courseRow(c)}
              {canEdit && catalog.majors.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    margin: "6px 0",
                  }}
                >
                  <select
                    aria-label={t("اختر التخصص", "Choose the major")}
                    value={place[c.id] ?? ""}
                    onChange={(e) =>
                      setPlace({ ...place, [c.id]: e.target.value })
                    }
                  >
                    <option value="">
                      {t("اختر التخصص", "Choose the major")}
                    </option>
                    {catalog.majors.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name[lang]}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={busy || !place[c.id]}
                    onClick={() =>
                      void act({
                        action: "assign-course",
                        courseId: c.id,
                        majorId: place[c.id],
                      })
                    }
                  >
                    {t("ضعه في التخصص", "Place in major")}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Box>
      )}
      {canEdit && (
        <Box>
          <h2>{t("أضف كلية", "Add a faculty")}</h2>
          <form
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "end",
            }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!faculty) return;
              if (await act({ action: "create-faculty", name: faculty }))
                setFaculty("");
            }}
          >
            <label>
              {t("اسم الكلية", "Faculty name")}
              <input
                value={faculty}
                maxLength={120}
                onChange={(e) => setFaculty(e.target.value)}
              />
            </label>
            <Button type="submit" primary disabled={busy}>
              {t("أضف الكلية", "Add faculty")}
            </Button>
          </form>
        </Box>
      )}
      {canEdit && <ResetBox lang={lang} t={t} onError={onError} />}
    </>
  );
}

/** Testing aid: empty the workspace and start again, without leaving the app. */
export function ResetBox({
  lang,
  t,
  onError,
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
}) {
  const [word, setWord] = useState(""),
    [structure, setStructure] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <details style={{ marginTop: 24 }}>
      <summary>{t("إعادة ضبط بيانات الاختبار", "Reset test data")}</summary>
      <Box>
        <p>
          {t(
            "يمسح كل ما رُفع وأُنتج في هذه المساحة: المحاضرات والمراجع والشجرة والأسئلة وسجلات الطلاب. لا يمكن التراجع عنه.",
            "Removes everything uploaded and produced in this workspace: lectures, references, the tree, questions and learner records. This cannot be undone.",
          )}
        </p>
        <label className="checklabel">
          <input
            type="checkbox"
            checked={structure}
            onChange={(e) => setStructure(e.target.checked)}
          />{" "}
          {t(
            "امسح أيضًا الكليات والتخصصات والمقررات المضافة",
            "Also remove the faculties, majors and courses that were added",
          )}
        </label>
        <label style={{ display: "block", margin: "10px 0" }}>
          {t("اكتب RESET للتأكيد", "Type RESET to confirm")}
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Button
          disabled={busy || word !== "RESET"}
          onClick={async () => {
            setBusy(true);
            onError("");
            try {
              await request(
                "/api/catalog",
                {
                  action: "reset-workspace",
                  confirm: "RESET",
                  keepStructure: !structure,
                },
                lang,
              );
              window.location.reload();
            } catch (e) {
              onError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy
            ? t("جارٍ المسح…", "Resetting…")
            : t("امسح البيانات وابدأ من جديد", "Reset and start again")}
        </Button>
      </Box>
    </details>
  );
}
