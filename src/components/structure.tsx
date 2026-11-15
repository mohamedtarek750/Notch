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
export async function openCourse(courseId: string, lang: Lang) {
  await request("/api/catalog", { action: "select-course", courseId }, lang);
  window.location.reload();
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
                {catalog.courses
                  .filter((c) => c.majorId === m.id)
                  .map(courseRow)}
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
    </>
  );
}
