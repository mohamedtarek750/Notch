"use client";
import { useEffect, useState } from "react";
import { Box, Button, localized, request, type Translate } from "./Workspace";

type Lang = "ar" | "en";
type Tab = "overview" | "students" | "gaps" | "tutor";

/** A heat-map cell colour from the share of assessed students who are ready. */
function heat(share: number | null) {
  if (share === null) return "#e6e8ef";
  if (share >= 75) return "#bfe3cf";
  if (share >= 40) return "#f6dfa6";
  return "#f3bdb5";
}

/** IN8–IN15: what the instructor needs between classes, on one screen with four tabs. */
export function ClassDashboard({
  lang,
  t,
  onError,
  go,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
  go: (view: string) => void;
}) {
  const [data, D] = useState<any>(null),
    [tab, T] = useState<Tab>("overview"),
    [student, S] = useState<any>(null),
    [nudge, N] = useState(""),
    [note, NO] = useState(""),
    [approved, A] = useState<Record<string, string>>({});
  const load = () =>
    request("/api/dashboard", undefined, lang)
      .then(D)
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
  }, []);
  const act = async (body: any, message: string) => {
    onError("");
    try {
      await request("/api/dashboard", body, lang);
      NO(message);
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  const openStudent = async (id: string) => {
    try {
      S(
        await request(
          `/api/dashboard?student=${encodeURIComponent(id)}`,
          undefined,
          lang,
        ),
      );
      N("");
      T("students");
    } catch (e) {
      onError((e as Error).message);
    }
  };
  if (!data) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const caution = (n: number) =>
    t(
      `مبني على ${n} طالبًا — فسّره بحذر.`,
      `Based on ${n} students — interpret with caution.`,
    );
  const reasonText = (r: any) =>
    ({
      "asked-for-help": t(
        `طلب المساعدة في ${localized(r.label, lang)}`,
        `Asked for help on ${localized(r.label, lang)}`,
      ),
      stuck: t(
        `متعثر في ${r.value} مفهومًا، أولها ${localized(r.label, lang)}`,
        `Stuck on ${r.value} concept(s), first ${localized(r.label, lang)}`,
      ),
      "repeated-diagnosis": t(
        `تكرر التشخيص في ${localized(r.label, lang)}`,
        `Repeated diagnosis on ${localized(r.label, lang)}`,
      ),
      inactive: t(
        `غير نشط منذ ${r.value} يومًا`,
        `Inactive for ${r.value} days`,
      ),
      "not-started": t("لم يبدأ بعد", "Has not started yet"),
    })[r.kind as string] || r.kind;
  const causeText = (cause: string) =>
    ({
      prerequisite: t("متطلب سابق ضعيف", "weak prerequisite"),
      presentation: t("طريقة العرض", "presentation"),
      confidence: t("الثقة والمحاولات", "confidence"),
      "basics-gap": t("فجوة في الأساسيات", "gap in the basics"),
      gaming: t("إجابات سريعة جدًّا", "very fast answers"),
    })[cause] || cause;
  const tabs: [Tab, string, string, number][] = [
    ["overview", "نظرة عامة", "Overview", 0],
    [
      "students",
      "طلاب يحتاجون متابعة",
      "Students to follow up",
      data.atRisk.length,
    ],
    [
      "gaps",
      "فجوات المحتوى",
      "Content gaps",
      data.contentGaps.filter((g: any) => g.status === "open").length,
    ],
    [
      "tutor",
      "تدقيق المساعد",
      "Tutor audit",
      data.tutorAnswers.filter((a: any) => a.flag && !a.audit).length,
    ],
  ];
  return (
    <>
      <div className="pageHead">
        <h1>{t("متابعة الفصل", "Class dashboard")}</h1>
        <p>
          {t(
            "كل رقم هنا محسوب من إجابات الطلاب وسجل التشخيص بقواعد ثابتة، لا بتخمين من النموذج.",
            "Every number here is computed from students' answers and the diagnosis record by fixed rules, not guessed by the model.",
          )}
        </p>
        <div className="actions" role="tablist">
          {tabs.map(([id, ar, en, count]) => (
            <Button
              key={id}
              primary={tab === id}
              onClick={() => {
                T(id);
                S(null);
                NO("");
              }}
            >
              {t(ar, en)}
              {count > 0 && ` (${count})`}
            </Button>
          ))}
        </div>
        {note && <p role="status">{note}</p>}
      </div>

      {tab === "overview" && (
        <>
          <Box>
            <h2>{t("حالة الفصل هذا الأسبوع", "Class status this week")}</h2>
            <div className="two-columns">
              {(
                [
                  [data.status.activeThisWeek, "طلاب نشطون", "active students"],
                  [
                    data.status.withSomethingReady,
                    "طلاب أتقنوا مفهومًا على الأقل",
                    "students with a concept ready",
                  ],
                  [
                    data.status.answersThisWeek,
                    "إجابة مسجّلة",
                    "answers recorded",
                  ],
                  [
                    data.status.tutorQuestionsThisWeek,
                    "سؤالًا للمساعد",
                    "tutor questions",
                  ],
                ] as const
              ).map(([n, ar, en]) => (
                <p key={en}>
                  <strong style={{ fontSize: 26 }}>{n}</strong> {t(ar, en)}
                </p>
              ))}
            </div>
            <small>
              {t(
                `من ${data.students} طالبًا مسجّلًا.`,
                `Out of ${data.students} enrolled students.`,
              )}{" "}
              {data.status.thinData && caution(data.students)}
            </small>
          </Box>
          <Box cls="end">
            <h2>{t("أهم العوائق", "Top roadblocks")}</h2>
            {data.roadblocks.length === 0 && (
              <p>
                {t(
                  "لا عوائق ظاهرة بعد: لم يتعثر أحد مرتين في مفهوم واحد.",
                  "No roadblocks yet: nobody has missed twice on the same concept.",
                )}
              </p>
            )}
            {data.roadblocks.map((r: any) => (
              <div className="row" key={r.conceptId}>
                <span>
                  <strong>{localized(r.label, lang)}</strong>
                  <br />
                  <small>
                    {t(
                      `${r.stuckStudents} طالبًا متعثرًا · ${r.diagnosisEpisodes} تشخيصًا`,
                      `${r.stuckStudents} stuck student(s) · ${r.diagnosisEpisodes} diagnosis episode(s)`,
                    )}
                    {r.reason?.kind === "weak-prerequisite" &&
                      ` · ${t(
                        `أغلب التعثر مرتبط بضعف ${localized(r.reason.prerequisite, lang)}`,
                        `most misses are associated with weak ${localized(r.reason.prerequisite, lang)}`,
                      )}`}
                    {r.reason &&
                      r.reason.kind !== "weak-prerequisite" &&
                      ` · ${t("السبب الأكثر تسجيلًا", "most recorded cause")}: ${causeText(r.reason.kind)}`}
                    {r.thinData && ` · ${caution(r.stuckStudents)}`}
                  </small>
                </span>
              </div>
            ))}
          </Box>
          <Box cls="end">
            <h2>{t("خريطة حرارة المفاهيم", "Concept heat map")}</h2>
            <p>
              <small>
                {t(
                  "مرتبة من الأساس إلى ما يُبنى عليه. اللون يعبّر عن نسبة الجاهزين من الطلاب الذين قُيّموا.",
                  "Ordered from foundations to what builds on them. Colour shows the share of assessed students who are ready.",
                )}
              </small>
            </p>
            {data.heatmap.length === 0 && (
              <p>
                {t(
                  "لا مفاهيم لها أسئلة منشورة بعد.",
                  "No concepts with published questions yet.",
                )}{" "}
                <button className="textbtn" onClick={() => go("bank")}>
                  {t("اذهب إلى بنك الأسئلة", "Go to the question bank")}
                </button>
              </p>
            )}
            {data.heatmap.map((c: any) => (
              <div
                className="row"
                key={c.conceptId}
                style={{
                  background: heat(c.readyShare),
                  padding: "8px 12px",
                  borderRadius: 8,
                  marginBottom: 6,
                }}
              >
                <strong>{localized(c.label, lang)}</strong>
                <span>
                  {c.readyShare === null
                    ? t("لم يُقيَّم أحد بعد", "nobody assessed yet")
                    : t(
                        `جاهز ${c.ready} من ${c.assessed} قُيّموا`,
                        `${c.ready} of ${c.assessed} assessed are ready`,
                      )}
                  {c.thinData && ` · ${caution(c.assessed)}`}
                </span>
              </div>
            ))}
          </Box>
        </>
      )}

      {tab === "students" && !student && (
        <Box>
          <h2>{t("طلاب يحتاجون متابعة", "Students to follow up")}</h2>
          <p>
            <small>
              {t(
                "قواعد بسيطة: طلب مساعدة، تعثّر متكرر، تشخيص متكرر، أو انقطاع ٧ أيام.",
                "Simple rules: asked for help, repeated misses, repeated diagnosis, or 7 days inactive.",
              )}
            </small>
          </p>
          {data.atRisk.length === 0 && (
            <p>
              {t(
                "لا أحد يحتاج متابعة الآن.",
                "Nobody needs follow-up right now.",
              )}
            </p>
          )}
          {data.atRisk.map((s: any) => (
            <div className="row" key={s.studentId}>
              <span>
                <strong>{localized(s.name, lang)}</strong>
                <br />
                <small>
                  {s.reasons.map(reasonText).join(" · ")}
                  {s.lastActivity &&
                    ` · ${t("آخر نشاط", "last activity")} ${String(s.lastActivity).slice(0, 10)}`}
                </small>
              </span>
              <Button onClick={() => openStudent(s.studentId)}>
                {t("افتح الطالب", "Open student")}
              </Button>
            </div>
          ))}
        </Box>
      )}

      {tab === "students" && student && (
        <>
          <Box>
            <button className="textbtn" onClick={() => S(null)}>
              {lang === "ar" ? "→" : "←"} {t("القائمة", "Back to the list")}
            </button>
            <h2>{localized(student.name, lang)}</h2>
            <h3>{t("خريطة الإتقان", "Mastery map")}</h3>
            {student.map
              .filter((n: any) => n.objectiveId)
              .map((n: any) => (
                <div className="row" key={n.conceptId}>
                  <strong>{localized(n.label, lang)}</strong>
                  <span>
                    {{
                      secure: t("جاهز", "Ready"),
                      inferred: t("معروف على الأرجح", "Likely known"),
                      developing: t("قيد التعلّم", "Learning"),
                      unassessed: t("لم يبدأ", "Not started"),
                    }[n.status as string] || n.status}
                  </span>
                </div>
              ))}
            <h3>
              {t("ما وجده سلّم التشخيص", "What the diagnosis ladder found")}
            </h3>
            {student.diagnoses.length === 0 && (
              <p>{t("لا تشخيصات مسجّلة.", "No diagnosis episodes recorded.")}</p>
            )}
            {student.diagnoses.map((d: any, i: number) => (
              <div className="row" key={i}>
                <span>
                  <strong>{localized(d.conceptLabel, lang)}</strong>
                  <br />
                  <small>
                    {causeText(d.cause)}
                    {d.targetLabel && `: ${localized(d.targetLabel, lang)}`}
                    {d.choice && ` · ${t("اختار", "chose")} ${d.choice}`}
                    {d.helped === true && ` · ${t("نفع", "it helped")}`}
                    {d.helped === false &&
                      ` · ${t("لم ينفع", "it did not help")}`}
                  </small>
                </span>
                <small>{String(d.at).slice(0, 10)}</small>
              </div>
            ))}
            <h3>{t("آخر الإجابات", "Recent answers")}</h3>
            {student.recent.length === 0 && (
              <p>{t("لا إجابات بعد.", "No answers yet.")}</p>
            )}
            {student.recent.map((a: any, i: number) => (
              <div className="row" key={i}>
                <span>
                  {localized(data.label[a.objectiveId], lang) || a.objectiveId}
                </span>
                <small>
                  {a.unknown
                    ? t("لا أعرف", "didn't know")
                    : a.correct === true
                      ? t("صحيحة", "right")
                      : a.correct === false
                        ? t("خاطئة", "wrong")
                        : t("بانتظار المراجعة", "awaiting review")}
                  {a.hintsUsed > 0 &&
                    ` · ${t("تلميحات", "hints")} ${a.hintsUsed}`}
                  {a.lowConfidence && ` · ${t("سريعة جدًّا", "very fast")}`} ·{" "}
                  {String(a.at).slice(0, 10)}
                </small>
              </div>
            ))}
            <p>
              <small>
                {t(
                  "محادثات المساعد غير معروضة لهذا الطالب.",
                  "Tutor transcripts aren't available for this student.",
                )}
              </small>
            </p>
          </Box>
          <Box cls="end">
            <h2>{t("أرسل تنبيهًا ودّيًّا", "Send a friendly nudge")}</h2>
            <div className="actions">
              {(
                [
                  [
                    "لاحظت أنك لم تدخل منذ فترة. خمس دقائق اليوم تكفي للعودة.",
                    "I noticed you haven't been in for a while. Five minutes today is enough to get back.",
                    "اطمئنان ودّي",
                    "Friendly check-in",
                  ],
                  [
                    "جرّب المفهوم التالي في صفحتك الرئيسية، وإن تعثّرت فاسألني في المحاضرة.",
                    "Try the next concept on your home page, and if you get stuck, ask me in class.",
                    "اقتراح المفهوم التالي",
                    "Suggested next concept",
                  ],
                ] as const
              ).map(([ar, en, labelAr, labelEn]) => (
                <Button key={labelEn} onClick={() => N(t(ar, en))}>
                  {t(labelAr, labelEn)}
                </Button>
              ))}
            </div>
            <label>
              {t("الرسالة", "Message")}
              <textarea
                dir="auto"
                value={nudge}
                onChange={(e) => N(e.target.value)}
              />
            </label>
            <Button
              primary
              disabled={nudge.trim().length < 3}
              onClick={async () => {
                if (
                  await act(
                    {
                      action: "nudge",
                      studentIds: [student.studentId],
                      text: nudge.trim(),
                    },
                    t("أُرسل التنبيه.", "Nudge sent."),
                  )
                )
                  await openStudent(student.studentId);
              }}
            >
              {t("إرسال", "Send")}
            </Button>
            {student.nudges.length > 0 && (
              <>
                <h3>{t("تنبيهات سابقة", "Previous nudges")}</h3>
                {student.nudges.map((n: any, i: number) => (
                  <div className="row" key={i}>
                    <span dir="auto">{n.text}</span>
                    <small>
                      {String(n.at).slice(0, 10)} ·{" "}
                      {n.seenAt
                        ? t("شوهد", "seen")
                        : t("لم يُشاهد بعد", "not seen yet")}
                    </small>
                  </div>
                ))}
              </>
            )}
          </Box>
        </>
      )}

      {tab === "gaps" && (
        <Box>
          <h2>
            {t("أسئلة لم تغطّها موادك", "Questions your material did not cover")}
          </h2>
          {data.contentGaps.length === 0 && (
            <p>
              {t(
                "لا فجوات مسجّلة: المساعد وجد إجابة لكل ما سُئل عنه.",
                "No gaps recorded: the tutor found an answer for everything asked.",
              )}
            </p>
          )}
          {data.contentGaps.map((g: any) => (
            <div className="row" key={g.topic}>
              <span>
                <strong dir="auto">{g.examples[0]}</strong>
                <br />
                <small>
                  {t(`سُئل ${g.count} مرة`, `asked ${g.count} time(s)`)} ·{" "}
                  {{
                    open: t("مفتوح", "open"),
                    "out-of-scope": t("خارج المقرر", "out of scope"),
                    resolved: t("أُضيفت له مادة", "material added"),
                  }[g.status as string] || g.status}
                  {g.examples.slice(1).map((e: string) => ` · ${e}`)}
                </small>
              </span>
              {g.status === "open" && (
                <span className="actions">
                  <Button onClick={() => go("materials")}>
                    {t("ارفع مادة", "Upload material")}
                  </Button>
                  <Button
                    onClick={() =>
                      act(
                        {
                          action: "gap-status",
                          ids: g.ids,
                          status: "resolved",
                        },
                        t("عُلّم كمغطّى.", "Marked as covered."),
                      )
                    }
                  >
                    {t("غُطّي", "Covered now")}
                  </Button>
                  <Button
                    onClick={() =>
                      act(
                        {
                          action: "gap-status",
                          ids: g.ids,
                          status: "out-of-scope",
                        },
                        t("عُلّم خارج المقرر.", "Marked out of scope."),
                      )
                    }
                  >
                    {t("خارج المقرر", "Out of scope")}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </Box>
      )}

      {tab === "tutor" && (
        <Box>
          <h2>{t("عيّنة من إجابات المساعد", "A sample of tutor answers")}</h2>
          <p>
            <small>
              {t(
                "الإجابات معروضة دون أسماء الطلاب. الإجابة المعتمدة التي تكتبها تُستخدم للسؤال نفسه بعد ذلك.",
                "Answers are shown without student names. An approved answer you write is used for the same question from then on.",
              )}
            </small>
          </p>
          {data.tutorAnswers.length === 0 && (
            <p>
              {t(
                "لم يُسأل المساعد بعد.",
                "The tutor has not been asked anything yet.",
              )}
            </p>
          )}
          {data.tutorAnswers.map((a: any) => (
            <article className="proposal-card" key={a.id}>
              <p dir="auto">
                <strong>{a.question}</strong>{" "}
                {a.flag && (
                  <span className="badge">
                    {a.flag === "thumbs-down"
                      ? t("تقييم سلبي من الطالب", "student thumbs-down")
                      : t("عُلّمت خاطئة", "marked wrong")}
                  </span>
                )}
                {a.rating === "up" && (
                  <span className="badge lavender">
                    {t("تقييم إيجابي", "thumbs-up")}
                  </span>
                )}
              </p>
              <p dir="auto">{a.answer}</p>
              {a.audit ? (
                <small>
                  {a.audit.verdict === "good"
                    ? t("راجعتَها: جيدة", "You reviewed it: good")
                    : t("راجعتَها: خاطئة", "You reviewed it: wrong")}
                  {a.audit.approvedAnswer &&
                    ` · ${t("الإجابة المعتمدة", "approved answer")}: ${a.audit.approvedAnswer}`}
                </small>
              ) : (
                <>
                  <label>
                    {t(
                      "الإجابة المعتمدة (اختياري)",
                      "Approved answer (optional)",
                    )}
                    <textarea
                      dir="auto"
                      value={approved[a.id] || ""}
                      onChange={(e) =>
                        A({ ...approved, [a.id]: e.target.value })
                      }
                    />
                  </label>
                  <div className="actions">
                    <Button
                      onClick={() =>
                        act(
                          { action: "audit", id: a.id, verdict: "good" },
                          t("سُجّلت كجيدة.", "Marked good."),
                        )
                      }
                    >
                      {t("جيدة", "Mark good")}
                    </Button>
                    <Button
                      onClick={() =>
                        act(
                          {
                            action: "audit",
                            id: a.id,
                            verdict: "wrong",
                            ...(approved[a.id]?.trim()
                              ? { approvedAnswer: approved[a.id].trim() }
                              : {}),
                          },
                          t("سُجّلت كخاطئة.", "Marked wrong."),
                        )
                      }
                    >
                      {approved[a.id]?.trim()
                        ? t("خاطئة، واعتمد إجابتي", "Wrong — use my answer")
                        : t("خاطئة", "Mark wrong")}
                    </Button>
                  </div>
                </>
              )}
            </article>
          ))}
        </Box>
      )}
    </>
  );
}

/** IN18 + IN19: the course report and the research export. */
export function CourseReport({
  lang,
  t,
  onError,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
}) {
  const [report, R] = useState<any>(null),
    [fields, F] = useState<string[]>([]),
    [note, N] = useState("");
  const load = () =>
    request("/api/course-end", undefined, lang)
      .then((r) => {
        R(r);
        F((f) => (f.length ? f : [...r.exportFields]));
      })
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!report) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);
  const gain = report.learningGain;
  const surveyLabels: Record<string, string> = {
    usefulness: t("ساعدتني على التعلّم", "Helped me learn"),
    trust: t("الثقة في المساعد", "Trust in the tutor"),
    language: t("مناسبة اللغة", "Language suited me"),
    ease: t("سهولة الاستخدام", "Ease of use"),
    hints: t("فائدة التلميحات", "Hints were useful"),
    map: t("دقة خريطة المهارات", "Skill map accuracy"),
    pace: t("التعلّم بسرعتي", "Own pace"),
    recommend: t("أنصح بها", "Would recommend"),
  };
  return (
    <>
      <div className="pageHead">
        <h1>{t("تقرير المقرر", "Course report")}</h1>
        {note && <p role="status">{note}</p>}
      </div>
      <Box>
        <h2>{t("الاختبار البعدي", "Post-test")}</h2>
        <p>
          {report.postTestOpen
            ? t("مفتوح للطلاب الآن.", "Open to students now.")
            : t(
                "مغلق. افتحه في نهاية المقرر ليقيس ما تعلّمه الطلاب.",
                "Closed. Open it at the end of the course to measure what students learned.",
              )}
        </p>
        <Button
          onClick={async () => {
            try {
              await request(
                "/api/course-end",
                { action: "posttest-open", open: !report.postTestOpen },
                lang,
              );
              await load();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          {report.postTestOpen
            ? t("أغلق الاختبار البعدي", "Close the post-test")
            : t("افتح الاختبار البعدي", "Open the post-test")}
        </Button>
      </Box>
      <Box cls="end">
        <h2>{t("المشاركة", "Participation")}</h2>
        <p>
          {t(
            `${report.participation.active} من ${report.participation.enrolled} طالبًا أجابوا عن سؤال واحد على الأقل. اختبار البداية: ${report.participation.tookStartingCheck}. الاختبار البعدي: ${report.participation.tookPostTest}.`,
            `${report.participation.active} of ${report.participation.enrolled} students answered at least one question. Starting check: ${report.participation.tookStartingCheck}. Post-test: ${report.participation.tookPostTest}.`,
          )}
        </p>
        <h2>{t("ما تعلّمه الطلاب", "Learning gain")}</h2>
        {gain.students === 0 ? (
          <p>
            {t(
              "لا يوجد طالب أكمل اختبار البداية والاختبار البعدي معًا بعد.",
              "No student has completed both the starting check and the post-test yet.",
            )}
          </p>
        ) : (
          <p>
            {t(
              `من ${pct(gain.preAverage)} في اختبار البداية إلى ${pct(gain.postAverage)} في الاختبار البعدي، لـ${gain.students} طالبًا أكملوا الاثنين.`,
              `From ${pct(gain.preAverage)} on the starting check to ${pct(gain.postAverage)} on the post-test, for ${gain.students} students who completed both.`,
            )}{" "}
            {gain.thinData &&
              t(
                "العدد صغير؛ فسّره بحذر.",
                "The number is small; interpret with caution.",
              )}
          </p>
        )}
        <h2>{t("الإتقان بحسب المفهوم", "Mastery by concept")}</h2>
        {report.masteryByConcept.map((c: any) => (
          <div className="row" key={c.conceptId}>
            <strong>{localized(c.label, lang)}</strong>
            <span>
              {c.readyShare === null
                ? t("لم يُقيَّم أحد", "nobody assessed")
                : t(
                    `جاهز ${c.ready} من ${c.assessed}`,
                    `${c.ready} of ${c.assessed} ready`,
                  )}
            </span>
          </div>
        ))}
        <h2>{t("المساعد", "Tutor")}</h2>
        <p>
          {t(
            `${report.tutor.questionsAnswered} إجابة، ${report.tutor.couldNotAnswer} سؤالًا بلا تغطية في المواد، ${report.tutor.thumbsUp} تقييمًا إيجابيًّا و${report.tutor.thumbsDown} سلبيًّا، و${report.tutor.markedWrongByInstructor} علّمتَها خاطئة.`,
            `${report.tutor.questionsAnswered} answers, ${report.tutor.couldNotAnswer} questions the material did not cover, ${report.tutor.thumbsUp} thumbs-up and ${report.tutor.thumbsDown} thumbs-down, ${report.tutor.markedWrongByInstructor} marked wrong by you.`,
          )}
        </p>
        <h2>{t("استبيان الطلاب", "Student survey")}</h2>
        {report.survey.responses === 0 ? (
          <p>{t("لا ردود بعد.", "No responses yet.")}</p>
        ) : (
          <>
            <p>
              <small>
                {t(
                  `${report.survey.responses} ردًّا · المتوسط من ٥`,
                  `${report.survey.responses} responses · average out of 5`,
                )}
              </small>
            </p>
            {Object.entries(report.survey.averages).map(([k, v]) => (
              <div className="row" key={k}>
                <span>{surveyLabels[k] || k}</span>
                <strong>{v === null ? "—" : (v as number).toFixed(1)}</strong>
              </div>
            ))}
            {report.survey.comments.map((c: string, i: number) => (
              <p className="notice" key={i} dir="auto">
                {c}
              </p>
            ))}
          </>
        )}
        <p className="notice">
          {t(
            "حدود هذا التقرير: لا توجد مجموعة مقارنة عشوائية، فالأرقام تُظهر ارتباطًا لا دليلًا على أن المنصة هي السبب.",
            "Limits of this report: there is no randomized comparison group, so the figures show association, not proof that the platform caused the change.",
          )}
        </p>
        <Button onClick={() => window.print()}>
          {t("اطبع أو احفظ PDF", "Print or save as PDF")}
        </Button>
      </Box>
      <Box cls="end">
        <h2>{t("تصدير بيانات البحث", "Research data export")}</h2>
        <p>
          {t(
            `${report.participation.researchConsent} طالبًا وافقوا على البحث حتى هذه اللحظة. يُصدَّر لهم فقط، بمعرّفات مجهولة لا تُربط بهم، ودون أي نص حر.`,
            `${report.participation.researchConsent} students consent to research as of now. Only their data is exported, under anonymous IDs that cannot be linked back, with no free text.`,
          )}
        </p>
        {report.exportFields.map((f: string) => (
          <label className="checklabel" key={f}>
            <input
              type="checkbox"
              checked={fields.includes(f)}
              onChange={(e) =>
                F(
                  e.target.checked
                    ? [...fields, f]
                    : fields.filter((x) => x !== f),
                )
              }
            />
            <bdi>{f}</bdi>
          </label>
        ))}
        <Button
          primary
          disabled={!fields.length}
          onClick={async () => {
            try {
              const r = await request(
                "/api/course-end",
                { action: "research-export", fields },
                lang,
              );
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(r, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "tilwa-research-export.json";
              a.click();
              URL.revokeObjectURL(url);
              N(
                t(
                  `صُدّر ${r.rows.length} صفًّا لـ${r.consentingStudents} طالبًا، وسُجّل التصدير في سجل التدقيق.`,
                  `Exported ${r.rows.length} rows for ${r.consentingStudents} students; the export was recorded in the audit log.`,
                ),
              );
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          {t("وافق ونزّل", "Approve and download")}
        </Button>
      </Box>
    </>
  );
}
