"use client";
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  Clock3,
  Compass,
  FileText,
  GitBranch,
  GraduationCap,
  House,
  Languages,
  Layers,
  Lightbulb,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Sparkles,
  Landmark,
  NotebookPen,
  Send,
  Settings2,
  ShieldCheck,
  SquarePen,
  Target,
  Upload,
  Users,
  X,
} from "lucide-react";
import { FieldArt } from "./FieldArt";
import { ClassDashboard, CourseReport } from "./instructor";
import { AdvisorDashboard } from "./advisor";
import { CourseConceptMap } from "./CourseConceptMap";
import { KnowledgeTree } from "./KnowledgeTree";
import { BuildStudio } from "./build";
import {
  AcademicStructure,
  CourseSwitcher,
  coursePath,
  type Catalog,
} from "./structure";
import { MaterialsPanel, KnowledgePanel, LaunchPanel } from "./sources";
import {
  StudentHome,
  Learn,
  DailyReview,
  ExamReadiness,
  TutorChat,
  ConsentGate,
  PrivacyBox,
  CourseFinish,
  Roadmap,
  StatusPage,
  type LearnOptions,
} from "./student";
type Lang = "ar" | "en";
type Role = "student" | "instructor" | "advisor";
export type RowData = {
  id: string;
  kind?: string;
  ownerId?: string;
  data: Record<string, any>;
};
export type Translate = (ar: string, en: string) => string;
export function localized(v: any, l: Lang): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return v[l] || v.en || v.ar || "";
}
export async function request(url: string, body?: any, lang: Lang = "ar") {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body instanceof FormData
        ? { "Accept-Language": lang }
        : { "Content-Type": "application/json", "Accept-Language": lang },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      localized(
        result.error?.message || result.message || result.error,
        lang,
      ) ||
        (lang === "ar"
          ? "تعذّر إتمام الطلب. حاول مرة أخرى."
          : "Unable to complete the request. Please retry."),
    );
  return result;
}
export function Box({
  children,
  cls = "",
}: {
  children: ReactNode;
  cls?: string;
}) {
  return <section className={"box " + cls}>{children}</section>;
}
export function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={"btn " + (primary ? "primary" : "")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
// Navigation follows the journey document: each role sees only its own path.
const STUDENT_NAV = [
  ["home", "الرئيسية", "Home", House],
  ["courses", "المحاضرات", "Lectures", BookOpen],
  ["map", "الخريطة", "Map", Network],
  ["review", "المراجعة", "Review", NotebookPen],
  ["exam", "جاهزية الامتحان", "Exam readiness", GraduationCap],
] as const;
const INSTRUCTOR_NAV = [
  ["build", "ابنِ الشجرة", "Build the tree", Sparkles],
  ["materials", "١ · رفع المواد", "1 · Upload materials", Upload],
  [
    "knowledge",
    "٢ · المفاهيم والمتطلبات",
    "2 · Concepts & prerequisites",
    GitBranch,
  ],
  ["bank", "٣ · بنك الأسئلة", "3 · Question bank", NotebookPen],
  ["launch", "٤ · الإطلاق", "4 · Launch", ShieldCheck],
  ["teaching", "متابعة الفصل", "Class dashboard", Users],
  ["report", "تقرير المقرر", "Course report", ClipboardList],
  ["map", "شجرة المعرفة", "Knowledge tree", Network],
  ["structure", "الهيكل الأكاديمي", "Academic structure", Landmark],
] as const;
const ADVISOR_NAV = [["advising", "طلابي", "My students", Users]] as const;
export function Workspace({
  inviteOnlyPilot = false,
  openPilot = false,
}: {
  inviteOnlyPilot?: boolean;
  openPilot?: boolean;
}) {
  // English by default; a person's own choice is remembered on their device.
  const [lang, L] = useState<Lang>("en"),
    [user, U] = useState<any>(null),
    [data, D] = useState<any>(null),
    [view, V] = useState("home"),
    [menu, M] = useState(false),
    [busy, B] = useState(false),
    [loading, Q] = useState(true),
    [error, E] = useState(""),
    [notice, N] = useState(""),
    [workspaceCode, WC] = useState(""),
    [recovery, RC] = useState("");
  const [lessonLanguage, LL] = useState("mixed"),
    [presentation, PP] = useState("short"),
    [sessionId, SI] = useState("");
  useModalFocus(menu, () => M(false));
  const t: Translate = (a, b) => (lang === "ar" ? a : b);
  const tr = (v: any) => localized(v, lang);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const refresh = async () => {
    request("/api/catalog", undefined, lang)
      .then(setCatalog)
      .catch(() => setCatalog(null));
    const d = await request("/api/workspace", undefined, lang);
    D(d);
    if (d.preferences?.lessonLanguage) LL(d.preferences.lessonLanguage);
    if (d.preferences?.presentation) PP(d.preferences.presentation);
    return d;
  };
  useEffect(() => {
    let cancelled = false;
    request("/api/auth/me")
      .then(async (r) => {
        if (cancelled) return;
        U(r.user);
        // Each role opens on its own starting screen, also after a page reload.
        V(
          r.user?.role === "instructor"
            ? "build"
            : r.user?.role === "advisor"
              ? "advising"
              : "home",
        );
        await refresh();
      })
      .catch((e) => {
        if (!cancelled && !/sign|login|session|دخول|جلسة|AUTH/i.test(e.message))
          E(e.message);
      })
      .finally(() => Q(false));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("tilwa_lang");
      if (saved === "ar" || saved === "en") L(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  const switchLanguage = () => {
    const next = lang === "ar" ? "en" : "ar";
    try {
      localStorage.setItem("tilwa_lang", next);
    } catch {}
    L(next);
  };
  const [tutorOpen, TO] = useState(false);
  // SYS1: say plainly when the connection drops, and when it is back.
  const [offline, OFF] = useState(false);
  useEffect(() => {
    const update = () => OFF(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const [learnTarget, LT] = useState<{
    objectiveId: string | null;
    diagnostic: boolean;
    options?: LearnOptions;
    nonce: number;
  } | null>(null);
  const learn = (objectiveId: string, options?: LearnOptions) => {
    LT({ objectiveId, diagnostic: false, options, nonce: Date.now() });
    go("learn");
  };
  /** Like perform, without the "saved" banner after every answer. */
  const performQuiet = async (action: string, body: any = {}) => {
    E("");
    try {
      const r = await request("/api/learning", { action, ...body }, lang);
      await refresh();
      return r;
    } catch (e) {
      E((e as Error).message);
      return null;
    }
  };
  const go = (v: string) => {
    V(v);
    M(false);
    E("");
    N("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const perform = async (action: string, body: any = {}) => {
    B(true);
    E("");
    try {
      const r = await request("/api/learning", { action, ...body }, lang);
      await refresh();
      N(t("تم الحفظ في سجلّك.", "Saved to your record."));
      return r;
    } catch (e) {
      E((e as Error).message);
      return null;
    } finally {
      B(false);
    }
  };
  const login = async (role: Role) => {
    B(true);
    E("");
    try {
      const r = await request(
        "/api/auth/demo",
        {
          role,
          ...(recovery.trim() ? { workspaceCode: recovery.trim() } : {}),
          locale: lang,
        },
        lang,
      );
      U(r.user);
      WC(r.workspaceCode || "");
      await refresh();
      go(
        role === "instructor"
          ? "build"
          : role === "advisor"
            ? "advising"
            : "home",
      );
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  };
  const logout = async () => {
    try {
      await request("/api/auth/logout", {}, lang);
      U(null);
      D(null);
      V("home");
      N("");
      E("");
    } catch (e) {
      E((e as Error).message);
    }
  };
  const session: RowData | undefined =
    (data?.sessions || []).find((s: RowData) => s.id === sessionId) ||
    (data?.sessions || [])[0];
  const chooseSession = (s?: RowData) => {
    if (s) SI(s.id);
    go("session");
  };
  const nav: readonly (readonly [string, string, string, any])[] =
    user?.role === "instructor"
      ? INSTRUCTOR_NAV
      : user?.role === "advisor"
        ? ADVISOR_NAV
        : STUDENT_NAV;
  const roleName = (r: string) =>
    r === "student"
      ? t("الطالب", "Student")
      : r === "instructor"
        ? t("المدرّس", "Instructor")
        : t("المرشد الأكاديمي", "Advisor");
  const renderNav = () => (
    <>
      <div className="brand">
        <img src="/brand/notch-white.png" alt="Notch" width={132} height={36} />
      </div>
      <nav
        className="railnav"
        aria-label={t("التنقل الرئيسي", "Main navigation")}
      >
        <span className="navlabel">{t("مساحة العمل", "Workspace")}</span>
        {nav.map(([id, a, b, Icon], i) => (
          <div
            key={id}
            className={
              user?.role === "instructor" && i === 4
                ? "navgroup sectionbreak"
                : "navitem"
            }
          >
            <button
              className={view === id ? "active" : ""}
              onClick={() => go(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={18} />
              {t(a, b)}
            </button>
          </div>
        ))}
      </nav>
      <div className="railfoot">
        <span className="avatar">{tr(user?.name).slice(0, 1) || "س"}</span>
        <div>
          <strong>
            {tr(user?.name) || t("مساحة Notch", "Notch workspace")}
          </strong>
          <small>{roleName(user?.role)}</small>
        </div>
        <button
          className="icon"
          onClick={logout}
          aria-label={t("تسجيل الخروج", "Sign out")}
        >
          <LogOut size={17} />
        </button>
      </div>
    </>
  );
  if (loading)
    return (
      <div className="boot" role="status">
        <img src="/brand/notch-dark.png" width={170} alt="Notch" />
        <p>{t("بنجهّز مساحة تعلّمك…", "Preparing your learning workspace…")}</p>
      </div>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-toolbar">
          <button
            className="textbtn"
            onClick={() => {
              switchLanguage();
              E("");
            }}
          >
            <Languages size={17} />
            {lang === "ar" ? "English" : "العربية"}
          </button>
        </div>
        <img src="/brand/notch-dark.png" className="login-logo" alt="Notch" />
        <span className="overline">
          {inviteOnlyPilot
            ? t("تجربة جامعية بدعوة", "Invite-only university pilot")
            : t("تجربة تعليمية جامعية", "University learning pilot")}
        </span>
        <h1>{t("نرتقي بالتعليم درجة.", "Taking education up a notch.")}</h1>
        <p>
          {t(
            "كل خطوة تعلّم، لها دليل. ادخل لمساحتك وكمّل رحلتك.",
            "Every learning step has evidence. Open your workspace and continue your journey.",
          )}
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {openPilot ? (
          <p>
            {t(
              "تجربة مفتوحة ببيانات اصطناعية. اختَر دورك للدخول مباشرة.",
              "Open test with synthetic data. Choose a role to enter.",
            )}
          </p>
        ) : (
          <Box cls="login-access">
            {inviteOnlyPilot && (
              <p id="pilot-access-instruction">
                {t(
                  "أدخل رمز مساحة التجربة الذي وصلك، ثم اختَر دورك للوصول إلى المصادر المراجَعة. لو سبق الدخول على هذا المتصفح، تقدر تكمل من غير إعادة إدخال الرمز.",
                  "Enter the pilot workspace code you received, then choose a role to open the reviewed materials. If you have used this browser before, you can continue without entering the code again.",
                )}
              </p>
            )}
            <label>
              {inviteOnlyPilot
                ? t("رمز مساحة التجربة", "Pilot workspace code")
                : t(
                    "رمز مساحة سابقة (اختياري)",
                    "Existing workspace code (optional)",
                  )}
              <input
                value={recovery}
                onChange={(e) => RC(e.target.value)}
                type="password"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={
                  inviteOnlyPilot
                    ? "pilot-access-instruction pilot-access-note"
                    : "pilot-access-note"
                }
                placeholder={
                  inviteOnlyPilot
                    ? t("الصق رمز المساحة هنا", "Paste your workspace code")
                    : t("للرجوع من جهاز آخر", "Resume on another device")
                }
              />
            </label>
            <small id="pilot-access-note">
              {inviteOnlyPilot
                ? t(
                    "هذه تجربة بدعوة فقط، بحسابات وأدوار وبيانات طلاب اصطناعية. تسجيل الخروج يحتفظ بمساحتك على هذا المتصفح.",
                    "This is an invite-only pilot with synthetic accounts, roles and student records. Signing out preserves your workspace on this browser.",
                  )
                : t(
                    "حسابات وبيانات تعليمية اصطناعية. كل زائر يحصل على مساحة منفصلة. يحتفظ تسجيل الخروج بمساحتك على هذا المتصفح.",
                    "Synthetic demo accounts and learning records. Each visitor has a separate workspace. Signing out preserves your workspace on this browser.",
                  )}
            </small>
          </Box>
        )}
        <div className="role-cards">
          {(
            [
              [
                "student",
                "طالب",
                "Student",
                GraduationCap,
                "ذاكر، اسأل، وراجع تقدّمك.",
                "Study, ask questions and see your progress.",
              ],
              [
                "instructor",
                "مدرّس",
                "Instructor",
                BookOpen,
                "استورد المصادر واعتمد جلساتك.",
                "Import sources and publish reviewed sessions.",
              ],
              [
                "advisor",
                "مرشد أكاديمي",
                "Advisor",
                Compass,
                "افهم الدليل وحدّد الخطوة الجاية.",
                "Review evidence and guide the next step.",
              ],
            ] as const
          ).map(([r, a, b, Icon, subar, suben]) => (
            <button
              key={r}
              className="role-card"
              disabled={busy}
              onClick={() => login(r)}
            >
              <span className="sq lavender">
                <Icon size={25} />
              </span>
              <h2>{t(a, b)}</h2>
              <small>{t(subar, suben)}</small>
              <span className="textbtn">
                {t("دخول تجريبي", "Enter demo")}{" "}
                {lang === "ar" ? (
                  <ArrowLeft size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}
              </span>
            </button>
          ))}
        </div>
      </main>
    );
  return (
    <div className="app">
      <aside className="rail">{renderNav()}</aside>
      <div className="frame">
        <header className="topbar">
          <div className="crumb">
            <button
              className="icon hamb"
              onClick={() => M(true)}
              aria-label={t("فتح القائمة", "Open menu")}
            >
              <Menu size={19} />
            </button>
            <i className="workspaceDot" />
            {coursePath(catalog, lang) ||
              `${t("مساحة", "Workspace")} ${roleName(user.role)}`}
            <span className="slash">/</span>
            <strong>
              {nav.find((n) => n[0] === view)?.[lang === "ar" ? 1 : 2] ||
                t("جلسة التعلّم", "Learning session")}
            </strong>
          </div>
          <div className="toolbar">
            <CourseSwitcher catalog={catalog} lang={lang} t={t} />
            <button onClick={switchLanguage}>
              <Languages size={17} />
              {lang === "ar" ? "English" : "العربية"}
            </button>
            <i />
            <button onClick={() => go("settings")}>
              <Settings2 size={16} />
              {t("وضع العرض", "Preferences")}
            </button>
          </div>
        </header>
        <main className={view === "session" ? "sessionMain" : ""}>
          {offline && (
            <div className="error" role="alert">
              {t(
                "أنت غير متصل. ما لم يُرسل بعد لن يُحفظ حتى يعود الاتصال؛ أعد المحاولة عندها.",
                "You're offline. Anything not sent yet is not saved until the connection is back; try again then.",
              )}{" "}
              <button onClick={() => go("status")}>
                {t("حالة النظام", "System status")}
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => E("")} aria-label={t("إغلاق", "Dismiss")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="saved" role="status">
              {notice}
              <button onClick={() => N("")} aria-label={t("إغلاق", "Dismiss")}>
                <X size={14} />
              </button>
            </div>
          )}
          {!data ? (
            <Box>
              <p>
                {t(
                  "تعذّر تحميل مساحة التعلّم.",
                  "The learning workspace could not be loaded.",
                )}
              </p>
              <Button onClick={() => refresh().catch((e) => E(e.message))}>
                {t("إعادة المحاولة", "Retry")}
              </Button>
            </Box>
          ) : user?.role === "student" && data.consent === null ? (
            <ConsentGate lang={lang} t={t} onError={E} done={() => refresh()} />
          ) : (
            <>
              {view === "finish" && (
                <CourseFinish
                  data={data}
                  lang={lang}
                  t={t}
                  perform={performQuiet}
                  refresh={refresh}
                  back={() => go("home")}
                  onError={E}
                />
              )}
              {view === "report" && (
                <CourseReport lang={lang} t={t} onError={E} />
              )}
              {view === "build" && user?.role === "instructor" && (
                <BuildStudio lang={lang} t={t} onError={E} go={go} />
              )}
              {view === "structure" && (
                <AcademicStructure
                  lang={lang}
                  t={t}
                  onError={E}
                  canEdit={user?.role === "instructor"}
                />
              )}
              {view === "home" && user?.role === "student" && (
                <StudentHome
                  data={data}
                  lang={lang}
                  t={t}
                  learn={learn}
                  go={go}
                  perform={performQuiet}
                  startDiagnostic={() => {
                    LT({
                      objectiveId: null,
                      diagnostic: true,
                      nonce: Date.now(),
                    });
                    go("learn");
                  }}
                />
              )}
              {view === "review" && (
                <DailyReview
                  lang={lang}
                  t={t}
                  perform={performQuiet}
                  back={() => go("home")}
                />
              )}
              {view === "exam" && (
                <ExamReadiness
                  data={data}
                  lang={lang}
                  t={t}
                  perform={performQuiet}
                  learn={learn}
                />
              )}
              {view === "learn" && learnTarget && (
                <Learn
                  key={learnTarget.nonce}
                  objectiveId={learnTarget.objectiveId}
                  diagnostic={learnTarget.diagnostic}
                  returnTo={learnTarget.options?.returnTo}
                  resume={learnTarget.options?.resume}
                  data={data}
                  lang={lang}
                  t={t}
                  perform={performQuiet}
                  back={() => go("home")}
                  learn={learn}
                />
              )}
              {view === "home" && user?.role !== "student" && (
                <Home
                  data={data}
                  user={user}
                  lang={lang}
                  t={t}
                  go={go}
                  resume={() => chooseSession()}
                />
              )}
              {view === "courses" && (
                <>
                  <Head
                    title={t("مقرراتي الدراسية", "My courses")}
                    sub={t(
                      "من الوحدة، للمحاضرة، لخطوتك الجاية.",
                      "From module to lecture to your next step.",
                    )}
                  />
                  {(data.courses || []).map((c: RowData) => (
                    <Box key={c.id}>
                      <span className="badge lavender">
                        <bdi>{c.id}</bdi>
                      </span>
                      <h2>{tr(c.data.title || c.data.name)}</h2>
                      <p>{tr(c.data.description)}</p>
                      <Button
                        onClick={() =>
                          perform("enroll", {
                            courseId: c.data.code || "CET351",
                          })
                        }
                      >
                        {t("تسجيل الالتحاق", "Enroll")}
                      </Button>
                      <h3 className="end">
                        {t("وحدة تقييم النماذج", "Model evaluation module")}
                      </h3>
                      {(data.sessions || []).map((s: RowData) => (
                        <div className="row" key={s.id}>
                          <span>
                            <small>
                              {t("المحاضرة", "Lecture")} {s.data.lecture}
                            </small>
                            <strong>{tr(s.data.title)}</strong>
                            <small>
                              {s.data.fixture
                                ? t(
                                    "محتوى تكميلي تجريبي معتمد",
                                    "Reviewed pilot supplement",
                                  )
                                : tr(s.data.sourceLabel)}
                            </small>
                          </span>
                          <Button primary onClick={() => chooseSession(s)}>
                            {t("فتح الجلسة", "Open session")}
                          </Button>
                        </div>
                      ))}
                    </Box>
                  ))}
                </>
              )}
              {view === "session" && (
                <SessionPanel
                  session={session}
                  t={t}
                  lang={lang}
                  language={lessonLanguage}
                  setLanguage={LL}
                  presentation={presentation}
                  setPresentation={PP}
                  perform={perform}
                  busy={busy}
                  go={go}
                  onError={E}
                />
              )}
              {view === "practice" && (
                <Practice
                  t={t}
                  lang={lang}
                  perform={perform}
                  busy={busy}
                  objectives={data.objectives || []}
                  path={data.path}
                />
              )}
              {view === "assignments" && (
                <Assignments
                  data={data}
                  user={user}
                  t={t}
                  lang={lang}
                  perform={perform}
                  busy={busy}
                />
              )}
              {view === "career" && (
                <Career
                  data={data}
                  user={user}
                  t={t}
                  lang={lang}
                  perform={perform}
                  busy={busy}
                />
              )}
              {view === "materials" && (
                <MaterialsPanel lang={lang} t={t} onError={E} />
              )}
              {(view === "knowledge" || view === "bank") && (
                <KnowledgePanel
                  key={view}
                  section={view === "bank" ? "bank" : "graph"}
                  lang={lang}
                  t={t}
                  onError={E}
                  onChanged={refresh}
                />
              )}
              {view === "launch" && (
                <LaunchPanel
                  lang={lang}
                  t={t}
                  onError={E}
                  onPreview={() => login("student")}
                  go={go}
                />
              )}
              {view === "map" && user?.role === "student" && (
                <Roadmap data={data} lang={lang} t={t} learn={learn} />
              )}
              {view === "map" && user?.role === "instructor" && (
                <KnowledgeTree lang={lang} t={t} onError={E} go={go} />
              )}
              {view === "map" && user?.role === "advisor" && (
                <LearningMap data={data} lang={lang} t={t} go={go} />
              )}
              {view === "status" && (
                <StatusPage
                  lang={lang}
                  t={t}
                  back={() =>
                    go(
                      user?.role === "instructor"
                        ? "launch"
                        : user?.role === "advisor"
                          ? "advising"
                          : "home",
                    )
                  }
                />
              )}
              {view === "timeline" && (
                <>
                  <Head
                    title={t("سجلّ تعلّمك", "Your learning history")}
                    sub={t(
                      "دليل مؤرّخ، عبر الجلسات والفصول.",
                      "Dated evidence across sessions and semesters.",
                    )}
                  />
                  <Box>
                    {(data.events || []).length === 0 ? (
                      <Empty t={t} />
                    ) : (
                      data.events.map((r: RowData) => (
                        <div key={r.id} className="row">
                          <span>
                            <strong>
                              {tr(
                                r.data.title ||
                                  r.data.objectiveId ||
                                  r.data.type ||
                                  r.kind,
                              )}
                            </strong>
                            <small>
                              {tr(r.data.feedback || r.data.description)} ·{" "}
                              {r.data.assisted
                                ? t("بمساعدة", "Assisted")
                                : t("دليل مستقل", "Independent evidence")}
                            </small>
                            <small>
                              {r.data.fixture
                                ? t("سجل اصطناعي", "Synthetic history")
                                : ""}
                            </small>
                          </span>
                          <time>
                            {formatDate(
                              r.data.at || r.data.date || r.data.createdAt,
                              lang,
                            )}
                          </time>
                        </div>
                      ))
                    )}
                  </Box>
                </>
              )}
              {view === "calendar" && (
                <>
                  <Head
                    title={t("التقويم والإعلانات", "Calendar & announcements")}
                  />
                  <Box>
                    {(data.calendar || []).map((r: RowData) => (
                      <div className="row" key={r.id}>
                        <CalendarDays size={21} />
                        <strong>{tr(r.data.title)}</strong>
                        <span>
                          {formatDate(r.data.date || r.data.dueAt, lang)}
                        </span>
                      </div>
                    ))}
                    {(data.announcements || []).map((r: RowData) => (
                      <article className="announcement" key={r.id}>
                        <h3>{tr(r.data.title)}</h3>
                        <p>{tr(r.data.body)}</p>
                      </article>
                    ))}
                    {user.role === "instructor" && (
                      <BilingualForm
                        t={t}
                        busy={busy}
                        action={(fields) => perform("announcement", fields)}
                        button={t("نشر إعلان", "Publish announcement")}
                      />
                    )}
                  </Box>
                </>
              )}
              {view === "grades" && (
                <>
                  <Head
                    title={t("الدرجات الرسمية", "Official grades")}
                    sub={t(
                      "مصدرها نظام شؤون الطلاب. التمرين لا يغيّر الدرجة الرسمية.",
                      "Owned by the SIS. Practice does not change official grades.",
                    )}
                  />
                  <Box>
                    {(data.grades || []).length ? (
                      data.grades.map((r: any) => (
                        <div className="row" key={r.id}>
                          <strong>
                            {tr(r.data?.title || r.courseId) || "CET351"}
                          </strong>
                          <span>
                            {r.grade ?? "—"} / {r.scale || 100}
                          </span>
                          <span>{tr(r.semester)}</span>
                          <small>
                            {t("بيانات SIS اصطناعية", "Synthetic SIS record")}
                          </small>
                        </div>
                      ))
                    ) : (
                      <Empty t={t} />
                    )}
                  </Box>
                </>
              )}
              {view === "teaching" && (
                <ClassDashboard lang={lang} t={t} onError={E} go={go} />
              )}
              {view === "qms" && <Quality data={data} t={t} lang={lang} />}
              {view === "advising" && (
                <AdvisorDashboard lang={lang} t={t} onError={E} />
              )}
              {view === "settings" && (
                <>
                  <Head title={t("تفضيلات التعلّم", "Learning preferences")} />
                  <Box>
                    <label>
                      {t(
                        "لغة الشرح، مستقلة عن لغة الواجهة",
                        "Lesson language, separate from interface language",
                      )}
                      <select
                        value={lessonLanguage}
                        onChange={(e) => LL(e.target.value)}
                      >
                        <option value="ar">العربية</option>
                        <option value="en">English</option>
                        <option value="mixed">عربي + English terms</option>
                      </select>
                    </label>
                    <label>
                      {t("طريقة العرض", "Presentation")}
                      <select
                        value={presentation}
                        onChange={(e) => PP(e.target.value)}
                      >
                        {[
                          ["short", "مختصر", "Short"],
                          ["detailed", "تفصيلي", "Detailed"],
                          ["steps", "خطوة بخطوة", "Step by step"],
                          ["example", "مثال محلول", "Worked example"],
                        ].map(([v, a, b]) => (
                          <option value={v} key={v}>
                            {t(a, b)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      primary
                      disabled={busy}
                      onClick={() =>
                        perform("preferences", {
                          lessonLanguage,
                          presentation,
                          uiLanguage: lang,
                        })
                      }
                    >
                      {t("حفظ التفضيلات", "Save preferences")}
                    </Button>
                    {workspaceCode && (
                      <div className="notice">
                        <strong>
                          {t("رمز العودة لمساحتك", "Workspace recovery code")}
                        </strong>
                        <code>{workspaceCode}</code>
                        <small>
                          {t(
                            "احتفظ به للعودة من متصفح آخر. يتيح الوصول لحسابات الديمو الثلاثة في مساحتك.",
                            "Keep it to resume in another browser. It grants access to all three demo roles in this workspace.",
                          )}
                        </small>
                      </div>
                    )}
                    <Button onClick={logout}>
                      <LogOut size={16} />
                      {t("تسجيل الخروج", "Sign out")}
                    </Button>
                  </Box>
                  {user?.role === "student" && data.consent && (
                    <PrivacyBox
                      data={data}
                      lang={lang}
                      t={t}
                      refresh={refresh}
                      onError={E}
                    />
                  )}
                </>
              )}
            </>
          )}
          <footer className="workspace-note">
            {t(
              "تجربة Notch · بيانات أشخاص وسجل مؤسسي اصطناعي",
              "Notch pilot · Synthetic people and institutional history",
            )}{" "}
            ·{" "}
            {data?.mode === "local"
              ? t("قاعدة محلية للاختبار", "Local test database")
              : t(
                  "تقدّم محفوظ على السيرفر",
                  "Progress saved on the server",
                )}{" "}
            ·{" "}
            <button className="textbtn" onClick={() => go("status")}>
              {t("حالة النظام", "System status")}
            </button>
          </footer>
          {user?.role === "student" && data && !tutorOpen && (
            <button
              className="btn primary"
              onClick={() => TO(true)}
              style={{
                position: "fixed",
                insetInlineEnd: 16,
                bottom: 16,
                zIndex: 40,
                borderRadius: 24,
              }}
            >
              {t("اسأل المساعد", "Ask the tutor")}
            </button>
          )}
          {user?.role === "student" && tutorOpen && (
            <TutorChat
              lang={lang}
              t={t}
              concept={
                view === "learn" && learnTarget?.objectiveId
                  ? (data?.path?.nodes || []).find(
                      (n: any) => n.objectiveId === learnTarget.objectiveId,
                    )?.label
                  : null
              }
              close={() => TO(false)}
            />
          )}
        </main>
      </div>
      {menu && (
        <div className="drawer-backdrop" onClick={() => M(false)}>
          <aside
            className="navdrawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("القائمة", "Menu")}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon drawer-close"
              onClick={() => M(false)}
              aria-label={t("إغلاق القائمة", "Close menu")}
            >
              <X />
            </button>
            {renderNav()}
          </aside>
        </div>
      )}
    </div>
  );
}
function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="pageHead">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}
function Empty({ t }: { t: Translate }) {
  return (
    <p className="empty">
      {t("لا يوجد دليل مسجّل حتى الآن.", "No evidence has been recorded yet.")}
    </p>
  );
}
function formatDate(v: any, lang: Lang) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}
function Home({
  data,
  user,
  lang,
  t,
  go,
  resume,
}: {
  data: any;
  user: any;
  lang: Lang;
  t: Translate;
  go: (v: string) => void;
  resume: () => void;
}) {
  const [reason, R] = useState(false);
  const rec = (data.recommendations || [])[0];
  const sessions = data.sessions || [];
  const count = (data.progress || []).filter(
    (e: RowData) => e.data.completed,
  ).length;
  const secure = (data.states || []).filter(
    (o: RowData) => o.data.status === "secure",
  ).length;
  const attemptCount = (data.attempts || []).length;
  return (
    <>
      <div className="greet">
        <div>
          <span className="overline">
            <i />
            {t("الفصل الدراسي الأول · ٢٠٢٦", "Autumn semester · 2026")}
          </span>
          <h1>
            {user.role === "student"
              ? t("أهلًا بعودتك، سلمى", "Welcome back, Salma")
              : t("أهلًا بمساحتك في Notch", "Welcome to your Notch workspace")}
          </h1>
          <p>{t("نرتقي بالتعليم درجة", "Taking education up a notch")}</p>
        </div>
        <span className="headDate">
          <CalendarDays size={16} />
          {new Date().toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </span>
      </div>
      <div className="homeGrid">
        <section className="hero">
          <div className="heroCopy">
            <span className="heroTag">
              <BookOpen size={15} />
              <bdi>CET351</bdi>
              <i />
              {t("تعلّم الآلة", "Machine Learning")}
            </span>
            <h2>{t("كمّل من حيث توقفت", "Continue where you left off")}</h2>
            <strong className="sessionName" dir="ltr">
              {sessions[0]?.data.title?.en ||
                "Confusion Matrix, Precision and Recall"}
            </strong>
            <p className="heroMeta">
              <Layers size={15} />
              {t("المحاضرة ٤ · الجلسة ٢", "Lecture 4 · Session 2")} ·{" "}
              <Clock3 size={15} />
              {t("١٢ دقيقة", "12 min")}
            </p>
            <button className="heroBtn" onClick={resume}>
              {t("متابعة الجلسة", "Resume session")}
              {lang === "ar" ? (
                <ArrowLeft size={19} />
              ) : (
                <ArrowRight size={19} />
              )}
            </button>
          </div>
          <div className="artWrap">
            <FieldArt />
          </div>
          <div className="heroBottom">
            <span>{t("تقدّم المقرر", "Course progress")}</span>
            <bdi>
              {Math.min(count, sessions.length)} / {sessions.length || 1}
            </bdi>
            <div className="progress">
              <i
                style={{
                  width: `${Math.min(100, (count / Math.max(1, sessions.length)) * 100)}%`,
                }}
              />
            </div>
          </div>
        </section>
        <Week data={data} t={t} lang={lang} go={go} />
        <div className="lowerLeft">
          <div className="sectionTitle">
            <span className="sq lavender">
              <Activity size={20} />
            </span>
            <h2>{t("لمحة عن تعلّمك", "Learning at a glance")}</h2>
          </div>
          <div className="metrics">
            {[
              [
                CheckCheck,
                count,
                t("جلسات مكتملة", "Sessions completed"),
                "mint",
              ],
              [
                Target,
                secure,
                t("مهارات مثبتة", "Skills demonstrated"),
                "lavender",
              ],
              [
                SquarePen,
                attemptCount,
                t("محاولات مسجّلة", "Recorded attempts"),
                "peach",
              ],
            ].map(([Icon, n, label, tone], i) => {
              const I = Icon as typeof Activity;
              return (
                <button
                  className="metric"
                  key={i}
                  onClick={() => go(i === 1 ? "map" : "timeline")}
                >
                  <span className={"sq " + tone}>
                    <I size={20} />
                  </span>
                  <b>
                    {Number(n).toLocaleString(lang === "ar" ? "ar-EG" : "en")}
                  </b>
                  <small>{String(label)}</small>
                </button>
              );
            })}
          </div>
          <Box cls="recommend">
            <div className="sectionTop">
              <span className="overline coral">
                <i />
                {t("مقترح لك", "Recommended for you")}
              </span>
              <Lightbulb size={18} />
            </div>
            <h3>
              {localized(rec?.data.title, lang) ||
                t("اختيار المقام في Recall", "Choosing the Recall denominator")}
            </h3>
            <p>
              {localized(rec?.data.description || rec?.data.body, lang) ||
                t(
                  "ابدأ بسؤال قصير يوضّح مين اللي بندخلهم في الحساب.",
                  "Start with a short question about which cases count.",
                )}
            </p>
            <button
              className="textbtn"
              aria-expanded={reason}
              onClick={() => R(!reason)}
            >
              <CircleHelp size={14} />
              {t("ليه المراجعة دي مقترحة؟", "Why was this review suggested?")}
              <ChevronDown size={14} />
            </button>
            {reason && (
              <p className="notice">
                {localized(rec?.data.reason, lang) ||
                  t(
                    "المهارة غير مقاسة حتى الآن. إجابة مستقلة تساعدنا نختار خطوتك الجاية، ولا تكفي وحدها للحكم على الإتقان.",
                    "This skill is unassessed. Independent evidence helps choose your next step; one answer does not establish mastery.",
                  )}
              </p>
            )}
            <div>
              <button className="textbtn" onClick={() => go("practice")}>
                {t("افتح المثال", "Open example")}
                <ArrowLeft size={15} />
              </button>
            </div>
          </Box>
        </div>
        <Box cls="pathCard">
          <span className="sq lavender">
            <GitBranch size={20} />
          </span>
          <h2>{t("مساري الأكاديمي", "My learning path")}</h2>
          <p>
            {t(
              "من أساسيات التصنيف إلى تقييم النموذج.",
              "From classification foundations to model evaluation.",
            )}
          </p>
          {[
            ["أساسيات التصنيف", "Classification basics"],
            ["مصفوفة الالتباس", "Confusion matrix"],
            ["مقاييس التقييم", "Evaluation metrics"],
          ].map(([a, b], i) => (
            <div className={"pathItem p" + i} key={b}>
              <i />
              {t(a, b)}
            </div>
          ))}
          <button className="textbtn" onClick={() => go("map")}>
            {t("استكشف خريطة المفاهيم", "Explore concept map")}
            <ArrowLeft size={15} />
          </button>
        </Box>
      </div>
    </>
  );
}
function Week({
  data,
  t,
  lang,
  go,
}: {
  data: any;
  t: Translate;
  lang: Lang;
  go: (v: string) => void;
}) {
  return (
    <Box cls="week">
      <div className="sectionTop">
        <h2>{t("أجندتي", "My agenda")}</h2>
        <CalendarDays size={18} />
      </div>
      <p className="muted">{t("نوفمبر ٢٠٢٦", "November 2026")}</p>
      <div className="weekdays">
        {[
          ["س", "Sa", 7],
          ["ح", "Su", 8],
          ["ن", "Mo", 9],
          ["ث", "Tu", 10],
          ["ر", "We", 11],
          ["خ", "Th", 12],
          ["ج", "Fr", 13],
        ].map(([a, b, n]) => (
          <div key={n} className={n === 12 ? "today" : ""}>
            <small>{t(String(a), String(b))}</small>
            <b>{n}</b>
          </div>
        ))}
      </div>
      {(data.calendar || []).slice(0, 2).map((r: RowData) => (
        <button className="event" key={r.id} onClick={() => go("calendar")}>
          <span className="date">
            {new Date(r.data.date || r.data.dueAt || "2026-11-15").getDate()}
            <small>{t("نوف", "Nov")}</small>
          </span>
          <span>
            <strong>{localized(r.data.title, lang)}</strong>
            <small dir="ltr">CET351</small>
          </span>
        </button>
      ))}
      <button className="textbtn" onClick={() => go("calendar")}>
        {t("عرض التقويم", "View calendar")}
        <ArrowLeft size={15} />
      </button>
    </Box>
  );
}
type Perform = (action: string, body?: any) => Promise<any>;
function SessionPanel({
  session,
  t,
  lang,
  language,
  setLanguage,
  presentation,
  setPresentation,
  perform,
  busy,
  go,
  onError,
}: {
  session?: RowData;
  t: Translate;
  lang: Lang;
  language: string;
  setLanguage: (v: string) => void;
  presentation: string;
  setPresentation: (v: string) => void;
  perform: Perform;
  busy: boolean;
  go: (v: string) => void;
  onError: (v: string) => void;
}) {
  const [question, SQ] = useState(""),
    [exchanges, EX] = useState<any[]>([]),
    [asking, A] = useState(false),
    [drawer, DR] = useState(false),
    [correcting, CO] = useState(""),
    [correction, CR] = useState("");
  useModalFocus(drawer, () => DR(false));
  const loadMemory = async () => {
    const r = await request("/api/tutor/memory", undefined, lang);
    EX((r.messages || []).map((m: any) => ({ id: m.id, ...m.data })));
  };
  useEffect(() => {
    loadMemory().catch(() => {});
  }, []);
  const memoryAction = async (body: any) => {
    A(true);
    try {
      await request("/api/tutor/memory", body, lang);
      await loadMemory();
      CO("");
      CR("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      A(false);
    }
  };
  const ask = async (e?: FormEvent, q?: string) => {
    e?.preventDefault();
    const value = q || question;
    if (!value.trim()) return;
    A(true);
    try {
      const r = await request(
        "/api/tutor",
        {
          question: value,
          language,
          style:
            presentation === "steps"
              ? "step-by-step"
              : presentation === "example"
                ? "worked-example"
                : presentation,
          courseId: "CET351",
        },
        lang,
      );
      EX((old) => [...old, { question: value, ...r }]);
      SQ("");
      if (r.disposition === "answered") await loadMemory();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      A(false);
    }
  };
  const tutor = (
    <div className="tutor">
      <div className="sectionTop">
        <h2>{t("مساعد Notch", "Notch tutor")}</h2>
        <MessageSquare size={18} />
      </div>
      <small>
        {t(
          "شرح من مصادر مقررك المعتمدة",
          "Explanations from approved course evidence",
        )}
      </small>
      <button
        className="prompt"
        onClick={() =>
          ask(
            undefined,
            language === "en"
              ? "Why is Recall 60% here?"
              : "ليه الـRecall هنا 60%؟",
          )
        }
      >
        {language === "en"
          ? "Why is Recall 60% here?"
          : "ليه الـRecall هنا 60%؟"}
      </button>
      <div aria-live="polite">
        {exchanges.map((x, i) => (
          <div className="exchange" key={i}>
            <p className="question">{x.question}</p>
            <p className="answer">{x.answer}</p>
            {(x.citations || [])
              .filter((c: any) => typeof c === "object" && c.url)
              .map((c: any) => (
                <a
                  className="citation"
                  key={c.id}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileText size={14} />
                  <bdi>{c.sourceKey}</bdi> ·{" "}
                  {c.page ? t("ص. ", "p. ") + c.page : c.section}
                </a>
              ))}
            {x.correction && (
              <p className="notice">
                {t("تصحيحك", "Your correction")}: {x.correction}
              </p>
            )}
            {x.id && (
              <button
                className="textbtn"
                onClick={() => {
                  CO(correcting === x.id ? "" : x.id);
                  CR(x.correction || "");
                }}
              >
                {t("صحّح هذا الملخص", "Correct this memory")}
              </button>
            )}
            {correcting === x.id && x.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  memoryAction({ action: "correct", id: x.id, correction });
                }}
              >
                <input
                  aria-label={t("تصحيح الملخص", "Memory correction")}
                  value={correction}
                  onChange={(e) => CR(e.target.value)}
                  required
                />
                <Button type="submit" disabled={asking}>
                  {t("حفظ التصحيح", "Save correction")}
                </Button>
              </form>
            )}
            {x.trace?.modelId && (
              <small>
                {t("الموديل", "Model")}: <bdi>{x.trace.modelId}</bdi>
              </small>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={ask}>
        <input
          aria-label={t("سؤالك عن الجلسة", "Your question about the session")}
          value={question}
          onChange={(e) => SQ(e.target.value)}
          placeholder={t("اسأل عن الفكرة…", "Ask about the idea…")}
          maxLength={1600}
        />
        <button
          className="icon"
          disabled={asking}
          type="submit"
          aria-label={t("إرسال السؤال", "Send question")}
        >
          <Send size={18} />
        </button>
      </form>
      {asking && (
        <small role="status">
          {t("بنراجع المصادر…", "Checking course evidence…")}
        </small>
      )}
      {exchanges.length > 0 && (
        <button
          className="textbtn"
          disabled={asking}
          onClick={() => memoryAction({ action: "clear-current" })}
        >
          {t(
            "بدء محادثة جديدة (مع حفظ السجل)",
            "New conversation (history retained)",
          )}
        </button>
      )}
    </div>
  );
  return (
    <>
      <div className="breadcrumbs">
        <button onClick={() => go("courses")}>
          {t("المقرر الدراسي", "Course")}
        </button>{" "}
        / <bdi>CET351</bdi> / {t("تقييم النماذج", "Model evaluation")}
      </div>
      <div className="worktools">
        <label>
          {t("لغة الشرح", "Lesson language")}
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
            <option value="mixed">عربي + English</option>
          </select>
        </label>
        <Button
          onClick={() =>
            perform("preferences", {
              lessonLanguage: language,
              presentation,
              uiLanguage: lang,
            })
          }
        >
          {t("حفظ التفضيلات", "Save preferences")}
        </Button>
      </div>
      <div className="workgrid">
        <article className="reader">
          {session ? (
            <>
              <span className="badge lavender">
                {t("جلسة تعلّم", "Learning session")}
              </span>
              <h1>
                {localized(session.data.title, language === "en" ? "en" : "ar")}
              </h1>
              <div className="readMeta">
                <Layers size={15} />
                {t("المحاضرة", "Lecture")} {session.data.lecture} ·{" "}
                {session.data.fixture
                  ? t(
                      "المصدر: الملحق الأصلي للتجربة",
                      "Source: original pilot supplement",
                    )
                  : localized(session.data.sourceLabel, lang)}
              </div>
              <div
                className="tabs"
                aria-label={t("طريقة عرض الشرح", "Explanation format")}
              >
                {[
                  ["short", "مختصر", "Short"],
                  ["detailed", "تفصيلي", "Detailed"],
                  ["steps", "خطوة بخطوة", "Step by step"],
                  ["example", "مثال محلول", "Worked example"],
                ].map(([v, a, b]) => (
                  <button
                    key={v}
                    className={presentation === v ? "sel" : ""}
                    onClick={() => setPresentation(v)}
                  >
                    {t(a, b)}
                  </button>
                ))}
              </div>
              <div
                className="lessonText"
                dir={language === "en" ? "ltr" : "rtl"}
              >
                <LessonContent
                  text={localized(
                    session.data.variants?.[presentation] || session.data.body,
                    language === "en" ? "en" : "ar",
                  )}
                  presentation={presentation}
                  t={t}
                />
                {(session.data.citations || []).map((c: any, i: number) => (
                  <a
                    key={i}
                    className="citation"
                    href={c.url || `/sources/${c.versionId}?page=${c.page}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.label || c.sourceKey} · {c.page || c.section}
                  </a>
                ))}
              </div>
              <div className="actions end">
                <Button
                  primary
                  disabled={busy}
                  onClick={() =>
                    perform("complete-session", { sessionId: session.id })
                  }
                >
                  <CheckCheck size={17} />
                  {t("إتمام الجلسة", "Complete session")}
                </Button>
                <Button onClick={() => go("practice")}>
                  {t("جرّب سؤالًا جديدًا", "Try a fresh question")}
                </Button>
              </div>
              <small>
                {t(
                  "إتمام القراءة لا يثبت الإتقان. التدريب المستقل يضيف دليلًا منفصلًا.",
                  "Completing a reading does not establish mastery. Independent practice adds separate evidence.",
                )}
              </small>
            </>
          ) : (
            <>
              <h2>{t("لم تُنشر جلسة بعد", "No session published yet")}</h2>
              <p>
                {t(
                  "يحتاج المدرّس لمراجعة المصادر واعتماد الجلسة أولًا.",
                  "Your instructor needs to review the sources and approve a session first.",
                )}
              </p>
            </>
          )}
        </article>
        <aside className="sideTutor">{tutor}</aside>
      </div>
      <button className="btn primary mobileTutor" onClick={() => DR(true)}>
        <MessageSquare size={18} />
        {t("اسأل Notch", "Ask Notch")}
      </button>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => DR(false)}>
          <section
            className="tutor-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("مساعد Notch", "Notch tutor")}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon"
              onClick={() => DR(false)}
              aria-label={t("إغلاق المساعد", "Close tutor")}
            >
              <X />
            </button>
            {tutor}
          </section>
        </div>
      )}
    </>
  );
}
function Practice({
  t,
  lang,
  perform,
  busy,
  objectives,
  path,
}: {
  t: Translate;
  lang: Lang;
  perform: Perform;
  busy: boolean;
  objectives: RowData[];
  path?: { nodes: any[]; next: any | null };
}) {
  const [queue, SQ] = useState<any[]>([]),
    [note, SN] = useState("");
  const show = (r: any) => {
    SD(r);
    SA("");
    SE("");
    SF(null);
    AK(crypto.randomUUID());
  };
  const diagnostic = async () => {
    const r = await perform("diagnostic", {});
    if (!r) return;
    if (!r.items.length) {
      SN(
        t(
          "لا توجد مفاهيم غير مقيَّمة لها أسئلة معتمدة الآن.",
          "No unassessed concept has an approved question right now.",
        ),
      );
      return;
    }
    SN(
      t(
        `اختبار تشخيصي: ${r.items.length} أسئلة، سؤال لكل مفهوم. أجب دون مساعدة.`,
        `Diagnostic check: ${r.items.length} questions, one per concept. Answer unaided.`,
      ),
    );
    SQ(r.items.slice(1));
    show(r.items[0]);
  };
  const statusText = (status: string) =>
    ({
      secure: t("متقَن", "Secure"),
      developing: t("قيد التطوّر", "Developing"),
      unassessed: t("لم يُقيَّم بعد", "Not assessed yet"),
      unassessable: t("بلا أسئلة بعد", "No questions yet"),
    })[status] || status;
  const [objective, SO] = useState(""),
    [delivery, SD] = useState<any>(null),
    [answer, SA] = useState(""),
    [explanation, SE] = useState(""),
    [feedback, SF] = useState<any>(null),
    [attemptKey, AK] = useState("");
  const next = async () => {
    if (queue.length) {
      show(queue[0]);
      SQ(queue.slice(1));
      return;
    }
    SN("");
    const r = await perform(
      "select-practice",
      objective ? { objectiveId: objective } : {},
    );
    if (r) show(r);
  };
  const item = delivery?.item?.data || delivery?.item;
  return (
    <>
      <Head
        title={t("مساحة التدريب", "Practice workspace")}
        sub={t(
          "احسب، اختار، وبرّر. كل هدف له دليل مستقل.",
          "Calculate, choose and justify. Each objective has its own evidence.",
        )}
      />
      <Box>
        <label>
          {t("الهدف التعليمي", "Learning objective")}
          <select value={objective} onChange={(e) => SO(e.target.value)}>
            <option value="">
              {t("اختَر الخطوة المناسبة لي", "Choose my next step")}
            </option>
            {objectives.map((o) => (
              <option value={o.data.objectiveId || o.id} key={o.id}>
                {localized(o.data.title || o.data.label, lang) || o.id}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <Button primary onClick={next} disabled={busy}>
            {t("سؤال جديد", "New question")}
          </Button>
          <Button onClick={diagnostic} disabled={busy}>
            {t("اختبار تشخيصي سريع", "Quick diagnostic check")}
          </Button>
        </div>
        {note && <p role="status">{note}</p>}
        {delivery && !item && (
          <p role="status">{localized(delivery.reason, lang)}</p>
        )}
        <p>
          <small>
            {t(
              "الأسئلة من بنك معتمد. أمثلة المراجعة والانتقال بين المقررات موسومة كمحتوى تكميلي.",
              "Questions come from the approved bank. Critique and transfer examples are labeled as supplemental.",
            )}
          </small>
        </p>
      </Box>
      {!!path?.nodes?.length && (
        <Box cls="end">
          <h2>
            {t(
              "مسارك عبر المتطلبات السابقة",
              "Your path through prerequisites",
            )}
          </h2>
          <p>
            {path.next
              ? t(
                  `الخطوة التالية المقترحة: ${path.next.label.ar}`,
                  `Suggested next step: ${path.next.label.en}`,
                )
              : t(
                  "أتقنت كل المفاهيم التي لها أسئلة معتمدة.",
                  "Every concept with approved questions is secure.",
                )}
          </p>
          <ol>
            {path.nodes.map((n: any) => (
              <li key={n.conceptId}>
                <strong>{localized(n.label, lang)}</strong> ·{" "}
                {statusText(n.status)}
                {n.blockedBy.length > 0 && (
                  <small>
                    {" "}
                    — {t("ابدأ أولًا بـ", "start first with")}{" "}
                    {n.blockedBy
                      .map((b: any) => localized(b.label, lang))
                      .join(lang === "ar" ? "، " : ", ")}
                  </small>
                )}
              </li>
            ))}
          </ol>
        </Box>
      )}
      {item && (
        <Box cls="practice">
          {item.difficulty && (
            <span className="badge">
              {{
                easy: t("سهل", "Easy"),
                medium: t("متوسط", "Medium"),
                hard: t("صعب", "Hard"),
              }[item.difficulty as string] || item.difficulty}
            </span>
          )}
          <span className="badge lavender">
            {item.kind === "critique"
              ? t("راجع الحل", "Review the solution")
              : item.kind === "transfer"
                ? t(
                    "انتقال بين المقررات · تكميلي",
                    "Cross-course transfer · supplementary",
                  )
                : t("تدريب مستقل", "Independent practice")}
          </span>
          <h2>{localized(item.stem, lang)}</h2>
          {item.steps && (
            <ol>
              {item.steps.map((s: any, i: number) => (
                <li key={i}>{localized(s, lang)}</li>
              ))}
            </ol>
          )}
          <fieldset className="answer-options">
            <legend>{t("إجابتك", "Your answer")}</legend>
            {item.options?.map((o: any) => (
              <label key={o.id} className={answer === o.id ? "selected" : ""}>
                <input
                  type="radio"
                  name="answer"
                  checked={answer === o.id}
                  value={o.id}
                  onChange={() => SA(o.id)}
                  disabled={!!feedback}
                />
                {localized(o.label, lang)}
              </label>
            ))}
          </fieldset>
          {!item.options?.length && (
            <label>
              {t(
                "الإجابة أو رقم أول خطوة خاطئة",
                "Answer or first incorrect step",
              )}
              <input value={answer} onChange={(e) => SA(e.target.value)} />
            </label>
          )}
          <label>
            {t(
              "اشرح اختيارك (مطلوب في مراجعة الحل)",
              "Explain your choice (required for solution review)",
            )}
            <textarea
              value={explanation}
              onChange={(e) => SE(e.target.value)}
              disabled={!!feedback}
            />
          </label>
          <Button
            primary
            disabled={busy || !answer || !!feedback}
            onClick={async () => {
              const r = await perform("attempt", {
                deliveryId: delivery.deliveryId,
                answer,
                explanation,
                idempotencyKey: attemptKey,
              });
              if (r) SF(r);
            }}
          >
            {t("تسجيل الإجابة", "Submit answer")}
          </Button>
          {feedback && (
            <div className="feedback" role="status">
              <strong>{localized(feedback.feedback, lang)}</strong>
              <p>
                {localized(
                  feedback.recommendation?.data?.reason ||
                    feedback.recommendation?.reason,
                  lang,
                )}
              </p>
              <Button onClick={next}>
                {t("متابعة بسؤال مختلف", "Continue with a different question")}
              </Button>
            </div>
          )}
        </Box>
      )}
    </>
  );
}
function Assignments({
  data,
  user,
  t,
  lang,
  perform,
  busy,
}: {
  data: any;
  user: any;
  t: Translate;
  lang: Lang;
  perform: Perform;
  busy: boolean;
}) {
  const [text, ST] = useState(""),
    [feedback, SF] = useState(""),
    [english, EF] = useState(""),
    [score, SS] = useState(75);
  return (
    <>
      <Head title={t("التكليفات والتغذية الراجعة", "Assignments & feedback")} />
      {(data.assignments || []).map((a: RowData) => (
        <Box key={a.id}>
          <span className="badge lavender">CET351</span>
          <h2>{localized(a.data.title, lang)}</h2>
          <p>{localized(a.data.body || a.data.description, lang)}</p>
          <small>
            {formatDate(a.data.dueAt || a.data.dueDate || a.data.due, lang)}
          </small>
          {user.role === "student" && (
            <>
              <label>
                {t(
                  "إجابتك أو رابط التقرير الخاص",
                  "Your response or private report link",
                )}
                <textarea value={text} onChange={(e) => ST(e.target.value)} />
              </label>
              <Button
                primary
                disabled={busy || text.length < 5}
                onClick={() =>
                  perform("submit-assignment", { assignmentId: a.id, text })
                }
              >
                {t("تسليم الواجب", "Submit assignment")}
              </Button>
            </>
          )}
          {(data.submissions || [])
            .filter((s: RowData) => s.data.assignmentId === a.id)
            .map((s: RowData) => (
              <div className="notice" key={s.id}>
                <p>{s.data.text}</p>
                <p>{localized(s.data.feedback, lang)}</p>
                {s.data.score !== undefined && (
                  <strong>{s.data.score} / 100</strong>
                )}
                {user.role === "instructor" && (
                  <>
                    <div className="two-columns">
                      <label>
                        {t("تغذية راجعة بالعربية", "Feedback in Arabic")}
                        <textarea
                          value={feedback}
                          onChange={(e) => SF(e.target.value)}
                          dir="rtl"
                        />
                      </label>
                      <label>
                        {t("تغذية راجعة بالإنجليزية", "Feedback in English")}
                        <textarea
                          value={english}
                          onChange={(e) => EF(e.target.value)}
                          dir="ltr"
                        />
                      </label>
                    </div>
                    <label>
                      {t("درجة التكليف (٠–١٠٠)", "Assignment score (0–100)")}
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={score}
                        onChange={(e) => SS(Number(e.target.value))}
                      />
                    </label>
                    <Button
                      disabled={busy || !feedback || !english}
                      onClick={() =>
                        perform("feedback", {
                          submissionId: s.id,
                          feedback: { ar: feedback, en: english },
                          score,
                        })
                      }
                    >
                      {t("حفظ المراجعة", "Save review")}
                    </Button>
                  </>
                )}
              </div>
            ))}
        </Box>
      ))}
    </>
  );
}
function Career({
  data,
  user,
  t,
  lang,
  perform,
  busy,
}: {
  data: any;
  user: any;
  t: Translate;
  lang: Lang;
  perform: Perform;
  busy: boolean;
}) {
  const [title, ST] = useState(""),
    [url, SU] = useState(""),
    [desc, SD] = useState(""),
    [feedback, SF] = useState(""),
    [english, EF] = useState(""),
    [rubric, SR] = useState({
      analysis: 0,
      code: 0,
      communication: 0,
      reproducibility: 0,
    });
  return (
    <>
      <Head
        title={t(
          "خطة مهنية مبنية على شغلك",
          "A career plan backed by your work",
        )}
        sub={t(
          "مهارات مثبتة، فجوات واضحة، وخطوة عملية.",
          "Evidenced skills, visible gaps and a practical next step.",
        )}
      />
      <div className="split">
        <Box>
          <h2>{t("هدفي المهني", "My career target")}</h2>
          <div className="actions">
            {["ML Engineer", "Data Analyst"].map((v) => (
              <Button
                key={v}
                primary={data.preferences?.careerTarget === v}
                onClick={() => perform("career-target", { target: v })}
                disabled={busy || user.role !== "student"}
              >
                {v}
              </Button>
            ))}
          </div>
          <p>
            {t(
              "الاختيار لا يتنبأ بوظيفة أو بمعدّل دراسي. ملف الأعمال يضم فقط القطع التي تختار مشاركتها.",
              "A target does not predict employment or GPA. Your portfolio includes only the artifacts you choose to share.",
            )}
          </p>
          <h3>{t("دليل المهارات", "Skill evidence")}</h3>
          {(data.objectives || []).map((o: RowData) => (
            <div className="row" key={o.id}>
              <strong>{localized(o.data.title, lang) || o.id}</strong>
              <span>
                {stateLabel(
                  (data.states || []).find(
                    (s: RowData) => s.data.objectiveId === o.data.objectiveId,
                  )?.data.status,
                  t,
                )}
              </span>
            </div>
          ))}
        </Box>
        {user.role === "student" && (
          <Box>
            <h2>{t("أضف قطعة لملفك", "Add an artifact")}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                perform("portfolio", {
                  title,
                  url,
                  description: desc,
                  include: true,
                });
              }}
            >
              <label>
                {t("عنوان العمل", "Artifact title")}
                <input
                  value={title}
                  onChange={(e) => ST(e.target.value)}
                  required
                />
              </label>
              <label>
                {t(
                  "رابط خاص للتقرير أو Notebook",
                  "Private report or notebook URL",
                )}
                <input
                  type="url"
                  value={url}
                  onChange={(e) => SU(e.target.value)}
                  placeholder="https://"
                  required
                  dir="ltr"
                />
              </label>
              <label>
                {t(
                  "ما الذي يثبته هذا العمل؟",
                  "What does this work demonstrate?",
                )}
                <textarea
                  value={desc}
                  onChange={(e) => SD(e.target.value)}
                  required
                />
              </label>
              <Button type="submit" primary disabled={busy}>
                {t("إضافة للملف المختار", "Add to selected portfolio")}
              </Button>
            </form>
          </Box>
        )}
      </div>
      {(data.portfolio || []).map((p: RowData) => (
        <Box key={p.id}>
          <h3>{localized(p.data.title, lang)}</h3>
          <p>{p.data.description}</p>
          <a
            href={p.data.url}
            target="_blank"
            rel="noreferrer"
            className="textbtn"
          >
            {t("افتح العمل", "Open artifact")} ↗
          </a>
          <p>{localized(p.data.feedback || p.data.review?.feedback, lang)}</p>
          {user.role === "student" && (
            <label className="checklabel">
              <input
                type="checkbox"
                checked={!!p.data.include}
                disabled={busy}
                onChange={(e) =>
                  perform("portfolio-visibility", {
                    artifactId: p.id,
                    include: e.target.checked,
                  })
                }
              />
              {t("ضمّ إلى ملف الأعمال المختار", "Include in selected portfolio")}
            </label>
          )}
          {user.role !== "student" && (
            <>
              <div className="two-columns">
                {[
                  ["analysis", "التحليل", "Analysis"],
                  ["code", "الكود", "Code"],
                  ["communication", "التواصل", "Communication"],
                  [
                    "reproducibility",
                    "قابلية إعادة التنفيذ",
                    "Reproducibility",
                  ],
                ].map(([k, a, b]) => (
                  <label key={k}>
                    {t(a, b)}
                    <select
                      value={rubric[k as keyof typeof rubric]}
                      onChange={(e) =>
                        SR({ ...rubric, [k]: Number(e.target.value) })
                      }
                    >
                      {[0, 1, 2, 3].map((n) => (
                        <option key={n} value={n}>
                          {n} / 3
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="two-columns">
                <label>
                  {t("التغذية الراجعة بالعربية", "Feedback in Arabic")}
                  <textarea
                    value={feedback}
                    onChange={(e) => SF(e.target.value)}
                    dir="rtl"
                  />
                </label>
                <label>
                  {t("التغذية الراجعة بالإنجليزية", "Feedback in English")}
                  <textarea
                    value={english}
                    onChange={(e) => EF(e.target.value)}
                    dir="ltr"
                  />
                </label>
              </div>
              <Button
                disabled={busy || !feedback || !english}
                onClick={() =>
                  perform("review-portfolio", {
                    artifactId: p.id,
                    rubric,
                    feedback: { ar: feedback, en: english },
                  })
                }
              >
                {t("حفظ مراجعة المعايير", "Save rubric review")}
              </Button>
            </>
          )}
        </Box>
      ))}
    </>
  );
}
function stateLabel(v: string, t: Translate) {
  return v === "secure"
    ? t("دليل متين", "Secure evidence")
    : v === "developing"
      ? t("قيد التطوّر", "Developing")
      : t("غير مقاس", "Unassessed");
}
function LearningMap({
  data,
  lang,
  t,
  go,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  go: (v: string) => void;
}) {
  return (
    <>
      <CourseConceptMap lang={lang} />
      <section className="map-learning-objectives">
        <div className="sectionTop">
          <h2>
            {t("أهدافك ودليل تعلّمك", "Your objectives and learning evidence")}
          </h2>
          <p>
            {t(
              "الحساب والاختيار والتبرير أهداف مستقلة. غير المقاس لا يعني الضعف.",
              "Calculation, selection and justification are separate objectives. Unassessed does not mean weak.",
            )}
          </p>
        </div>
        <div className="objective-map">
          {(data.objectives || []).map((o: RowData) => {
            const state = (data.states || []).find(
              (s: RowData) => s.data.objectiveId === o.data.objectiveId,
            )?.data;
            return (
              <button
                key={o.id}
                className="objective-node"
                onClick={() => go("practice")}
              >
                <Target size={21} />
                <strong>
                  {localized(o.data.title || o.data.label, lang) || o.id}
                </strong>
                <span className="badge lavender">
                  {stateLabel(state?.status, t)}
                </span>
                <small>
                  {t("الدليل المستقل", "Independent evidence")}:{" "}
                  {state?.independentFamilies ?? 0}
                </small>
                {state?.bkt && (
                  <small>
                    {t("مقارن BKT", "BKT comparator")}:{" "}
                    {Math.round(state.bkt.probability * 100)}%
                  </small>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
function BilingualForm({
  t,
  action,
  button,
  busy,
}: {
  t: Translate;
  action: (v: any) => void;
  button: string;
  busy: boolean;
}) {
  const [ar, A] = useState(""),
    [en, E] = useState(""),
    [bar, B] = useState(""),
    [ben, C] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        action({ title: { ar, en }, body: { ar: bar, en: ben } });
      }}
    >
      <div className="two-columns">
        <label>
          {t("العنوان بالعربية", "Arabic title")}
          <input
            value={ar}
            onChange={(e) => A(e.target.value)}
            required
            dir="rtl"
          />
        </label>
        <label>
          {t("العنوان بالإنجليزية", "English title")}
          <input
            value={en}
            onChange={(e) => E(e.target.value)}
            required
            dir="ltr"
          />
        </label>
        <label>
          {t("النص بالعربية", "Arabic text")}
          <textarea
            value={bar}
            onChange={(e) => B(e.target.value)}
            required
            dir="rtl"
          />
        </label>
        <label>
          {t("النص بالإنجليزية", "English text")}
          <textarea
            value={ben}
            onChange={(e) => C(e.target.value)}
            required
            dir="ltr"
          />
        </label>
      </div>
      <Button type="submit" primary disabled={busy}>
        {button}
      </Button>
    </form>
  );
}
function Teaching({
  data,
  t,
  lang,
  perform,
  busy,
}: {
  data: any;
  t: Translate;
  lang: Lang;
  perform: Perform;
  busy: boolean;
}) {
  const [obj, SO] = useState(data.objectives?.[0]?.data.objectiveId || ""),
    [feedback, SF] = useState(""),
    [english, EF] = useState(""),
    [score, SS] = useState(1),
    [reason, SR] = useState(""),
    [status, ST] = useState("developing"),
    [student, SU] = useState(data.students?.[0] || "");
  return (
    <>
      <Head
        title={t(
          "أشرح إيه في المحاضرة الجاية؟",
          "What should I teach next class?",
        )}
        sub={t(
          "المقارنة وصفية. راجع اللغة والسؤال قبل استنتاج فجوة تعلّم.",
          "These comparisons are descriptive. Check wording and item equivalence before inferring a learning gap.",
        )}
      />
      <Box>
        <h2>
          {t(
            "من الحساب لاختيار المقياس",
            "From calculating to choosing a metric",
          )}
        </h2>
        <p>
          {t(
            "اعرض النتائج حسب الهدف، ثم حدّد تدخلًا قصيرًا. قياس الأثر يحتاج أول إجابة مستقلة من عائلة سؤال جديدة.",
            "Review outcomes by objective and assign a brief intervention. Comparison requires the first independent answer from a fresh item family.",
          )}
        </p>
        <Quality data={data} t={t} lang={lang} compact />
      </Box>
      <Box>
        <h2>{t("خطّط لتدخل تعليمي", "Plan a teaching intervention")}</h2>
        <label>
          {t("الهدف", "Objective")}
          <select value={obj} onChange={(e) => SO(e.target.value)}>
            {(data.objectives || []).map((o: RowData) => (
              <option key={o.id} value={o.data.objectiveId || o.id}>
                {localized(o.data.title, lang) || o.id}
              </option>
            ))}
          </select>
        </label>
        <BilingualForm
          t={t}
          busy={busy}
          button={t("اعتماد التدخل", "Assign intervention")}
          action={(v) => perform("intervention", { objectiveId: obj, ...v })}
        />
      </Box>
      {(data.interventions || []).map((i: RowData) => (
        <Box key={i.id}>
          <h3>{localized(i.data.title, lang)}</h3>
          <p>{localized(i.data.body, lang)}</p>
          <p className="notice">
            {i.data.after?.suppressed
              ? t(
                  "نتائج المجموعة محجوبة حتى توفر ٥ طلاب لحماية الخصوصية.",
                  "Group results are withheld until five learners are available to protect privacy.",
                )
              : `${i.data.after?.correct ?? 0} / ${i.data.after?.independentFamilies ?? 0} ${t("عائلات سؤال مستقلة صحيحة بعد التدخل", "correct independent item families after intervention")}`}
          </p>
          <small>
            {t(
              "قياس وصفي قبل/بعد؛ لا يثبت السببية",
              "Descriptive before/after comparison; not causal evidence",
            )}
          </small>
        </Box>
      ))}
      <Box>
        <h2>{t("مراجعة الإجابات المفتوحة", "Moderate open responses")}</h2>
        {(data.attempts || [])
          .filter((a: RowData) => a.data.moderation === "pending")
          .map((a: RowData) => (
            <article className="proposal-card" key={a.id}>
              <h3>
                {localized(
                  (data.items || []).find(
                    (i: RowData) => i.id === a.data.itemId,
                  )?.data.stem,
                  lang,
                )}
              </h3>
              <p>
                {t("الإجابة", "Answer")}: {a.data.answer}
              </p>
              <p>
                {t("الشرح", "Explanation")}: {a.data.explanation}
              </p>
              <p>
                {localized(
                  (data.items || []).find(
                    (i: RowData) => i.id === a.data.itemId,
                  )?.data.rubric,
                  lang,
                )}
              </p>
              <div className="two-columns">
                <label>
                  {t("ملاحظات المعيار بالعربية", "Rubric feedback in Arabic")}
                  <textarea
                    dir="rtl"
                    value={feedback}
                    onChange={(e) => SF(e.target.value)}
                  />
                </label>
                <label>
                  {t(
                    "ملاحظات المعيار بالإنجليزية",
                    "Rubric feedback in English",
                  )}
                  <textarea
                    dir="ltr"
                    value={english}
                    onChange={(e) => EF(e.target.value)}
                  />
                </label>
              </div>
              <label>
                {t("نتيجة المراجعة", "Review result")}
                <select
                  value={score}
                  onChange={(e) => SS(Number(e.target.value))}
                >
                  <option value="1">{t("يحقق المعيار", "Meets rubric")}</option>
                  <option value="0">
                    {t("يحتاج مراجعة", "Needs revision")}
                  </option>
                </select>
              </label>
              <Button
                disabled={busy || !feedback || !english}
                primary
                onClick={() =>
                  perform("review-attempt", {
                    attemptId: a.id,
                    score,
                    feedback: { ar: feedback, en: english },
                  })
                }
              >
                {t("اعتماد مراجعة الإجابة", "Approve response review")}
              </Button>
            </article>
          ))}
        {!(data.attempts || []).some(
          (a: RowData) => a.data.moderation === "pending",
        ) && (
          <p>
            {t(
              "لا توجد إجابات تنتظر المراجعة.",
              "No responses await moderation.",
            )}
          </p>
        )}
      </Box>
      <Box>
        <h2>
          {t("قرار تعليمي قابل للمراجعة", "A reviewable teaching decision")}
        </h2>
        <label>
          {t("الطالب", "Student")}
          <select value={student} onChange={(e) => SU(e.target.value)}>
            {(data.students || []).map((id: string, i: number) => (
              <option key={id} value={id}>
                {t("طالب تجريبي", "Demo learner")} {i + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("الحالة", "Status")}
          <select value={status} onChange={(e) => ST(e.target.value)}>
            <option value="developing">{t("قيد التطوّر", "Developing")}</option>
            <option value="secure">{t("دليل متين", "Secure")}</option>
            <option value="unassessed">{t("غير مقاس", "Unassessed")}</option>
          </select>
        </label>
        <label>
          {t(
            "سبب تغيير الحالة (٨ أحرف على الأقل)",
            "Reason for the override (at least 8 characters)",
          )}
          <textarea value={reason} onChange={(e) => SR(e.target.value)} />
        </label>
        <Button
          disabled={busy || reason.length < 8 || !student}
          onClick={() =>
            perform("override", {
              studentId: student,
              objectiveId: obj,
              status,
              reason,
            })
          }
        >
          {t("حفظ القرار مع سجل تدقيق", "Save decision with audit record")}
        </Button>
        {(data.states || [])
          .filter((s: RowData) => s.data.overrideId)
          .map((s: RowData) => (
            <div className="row" key={s.id}>
              <span>{s.data.overrideReason}</span>
              <Button
                onClick={() =>
                  perform("undo-override", { overrideId: s.data.overrideId })
                }
                disabled={busy}
              >
                {t("التراجع عن القرار", "Undo override")}
              </Button>
            </div>
          ))}
        <div className="actions end">
          <Button
            disabled={busy || !student}
            onClick={() => perform("start-exam", { studentId: student })}
          >
            {t("بدء امتحان محمي للطالب", "Start protected exam for learner")}
          </Button>
          <Button
            disabled={busy || !student}
            onClick={() => perform("end-exam", { studentId: student })}
          >
            {t("إنهاء الامتحان المحمي", "End protected exam")}
          </Button>
        </div>
        <small>
          {t(
            "وضع الامتحان يسري على جميع أجهزة الطالب وجلساته.",
            "Exam mode applies to every device and session for the learner.",
          )}
        </small>
      </Box>
    </>
  );
}
function Quality({
  data,
  t,
  lang,
  compact = false,
}: {
  data: any;
  t: Translate;
  lang: Lang;
  compact?: boolean;
}) {
  const q = data.qms || {};
  return (
    <>
      {!compact && (
        <Head
          title={t("الجودة التعليمية", "Educational quality")}
          sub={t(
            "التحقق من المخرجات، شمول التقييم، وتاريخ المراجعة.",
            "Outcome attainment, assessment coverage and review history.",
          )}
        />
      )}
      <div className="qms-grid">
        {[
          [
            q.attainment,
            t("تحقق المخرجات", "Attainment"),
            `${q.attaining ?? 0} / ${q.assessed ?? 0}`,
            t("محققون من المقيمين", "attaining / assessed"),
          ],
          [
            q.coverage,
            t("تغطية التقييم", "Assessment coverage"),
            `${q.assessed ?? 0} / ${q.eligible ?? 0}`,
            t("مقيمون من المؤهلين", "assessed / eligible"),
          ],
        ].map(([n, label, fraction, explain], i) => (
          <section className="quality-stat" key={i}>
            <strong>{n ?? "—"}%</strong>
            <h3>{label}</h3>
            <bdi>{fraction}</bdi>
            <small>{explain}</small>
          </section>
        ))}
      </div>
      <p className="notice">
        {q.fixture
          ? t(
              "هذه الأعداد اصطناعية: ٣٠ مؤهلًا، ٢٤ مقيّمًا، ١٨ محققًا للمخرج.",
              "Synthetic counts: 30 eligible, 24 assessed, 18 attaining.",
            )
          : t("نتائج من الأدلة المسجّلة.", "Results from recorded evidence.")}
      </p>
      {(q.groups || []).map((g: any, i: number) => (
        <div className="row" key={i}>
          <strong>
            {localized(g.title || g.objective, lang) ||
              localized(
                (data.objectives || []).find(
                  (o: RowData) => o.data.objectiveId === g.objectiveId,
                )?.data.title,
                lang,
              )}
          </strong>
          <span>
            {g.suppressed
              ? t(
                  "مجموعة صغيرة: النتائج محجوبة",
                  "Small group: results withheld",
                )
              : `${g.attaining ?? 0} / ${g.assessed ?? 0} · ${Math.round(g.attainment ?? 0)}%`}
          </span>
        </div>
      ))}
    </>
  );
}
function Advising({
  data,
  t,
  lang,
  perform,
  busy,
}: {
  data: any;
  t: Translate;
  lang: Lang;
  perform: Perform;
  busy: boolean;
}) {
  return (
    <>
      <Head
        title={t(
          "دليل الطالب والخطوة الجاية",
          "Student evidence & next action",
        )}
        sub={t(
          "السجلات المسموح بها للطلاب المعيّنين لك فقط.",
          "Permitted records for your assigned advisees only.",
        )}
      />
      {(data.students || []).map((s: any) => (
        <Box key={typeof s === "string" ? s : s.id || s.userId}>
          <div className="sectionTop">
            <h2>
              {localized(s.name || s.data?.name, lang) ||
                t("الطالب المعيّن", "Assigned learner")}
            </h2>
            <span className="badge lavender">
              {t("سجل تجريبي اصطناعي", "Synthetic pilot record")}
            </span>
          </div>
          {(data.recommendations || []).map((r: RowData) => (
            <article className="notice" key={r.id}>
              <h3>{localized(r.data.title, lang)}</h3>
              <p>{localized(r.data.reason || r.data.body, lang)}</p>
              <p>
                {localized(
                  r.data.nextAction === "fresh-independent-probe"
                    ? {
                        ar: "متابعة بسؤال مستقل من عائلة جديدة",
                        en: "Follow up with an independent question from a fresh family",
                      }
                    : r.data.nextAction === "next-objective"
                      ? {
                          ar: "انتقل لهدف مستقل جديد",
                          en: "Move to a new independent objective",
                        }
                      : r.data.nextAction,
                  lang,
                )}
              </p>
            </article>
          ))}
          <h3>{t("الدليل عبر الفصول", "Evidence across semesters")}</h3>
          {(data.events || []).map((e: RowData) => (
            <div className="row" key={e.id}>
              <strong>
                {localized(
                  e.data.title || e.data.objectiveId || e.data.type,
                  lang,
                )}
              </strong>
              <span>
                {e.data.assisted
                  ? t("بمساعدة", "Assisted")
                  : t("مستقل", "Independent")}
              </span>
              <small>{formatDate(e.data.at || e.data.date, lang)}</small>
            </div>
          ))}
        </Box>
      ))}
      {!(data.students || []).length && (
        <Box>
          <Empty t={t} />
        </Box>
      )}
    </>
  );
}

function useModalFocus(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const elements = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    const timer = requestAnimationFrame(() => elements()[0]?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const items = elements();
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(timer);
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [open]);
}

function LessonContent({
  text,
  presentation,
  t,
}: {
  text: string;
  presentation: string;
  t: Translate;
}) {
  const sentences = text.split(/(?<=[.!؟])\s+/).filter(Boolean);
  const pieces = presentation === "short" ? sentences.slice(0, 2) : sentences;
  const examples = sentences.filter((s) => /example|مثال|TP|FN|FP|%/.test(s));
  const render = (s: string) =>
    s
      .split(/((?:Recall|Precision|TP|FN|FP|w)\s*=\s*[^،,.;\n]+)/g)
      .map((part, i) =>
        /^(?:Recall|Precision|TP|FN|FP|w)\s*=/.test(part) ? (
          <bdi dir="ltr" key={i}>
            {part}
          </bdi>
        ) : (
          part
        ),
      );
  return presentation === "steps" ? (
    <ol className="lesson-steps">
      {pieces.map((s, i) => (
        <li key={i}>{render(s)}</li>
      ))}
    </ol>
  ) : presentation === "example" ? (
    <div className="matrix">
      <h2>{t("مثال من النص المعتمد", "Example from approved content")}</h2>
      {(examples.length ? examples : pieces).map((s, i) => (
        <p key={i}>{render(s)}</p>
      ))}
    </div>
  ) : (
    <div className="preserve">
      {pieces.map((s, i) => (
        <p key={i}>{render(s)}</p>
      ))}
      {presentation === "short" && sentences.length > 2 && (
        <small>
          {t(
            "اختر «تفصيلي» لقراءة النص الكامل المعتمد.",
            "Choose Detailed to read the full approved content.",
          )}
        </small>
      )}
    </div>
  );
}
