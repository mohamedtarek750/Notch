"use client";
import { useEffect, useState } from "react";
import { Box, Button, localized, request, type Translate } from "./Workspace";

type Lang = "ar" | "en";

/** AD1–AD5: the advisor's caseload, early warning, one student's view and a nudge. */
export function AdvisorDashboard({
  lang,
  t,
  onError,
}: {
  lang: Lang;
  t: Translate;
  onError: (s: string) => void;
}) {
  const [data, D] = useState<any>(null),
    [student, S] = useState<any>(null),
    [search, Q] = useState(""),
    [filter, F] = useState("all"),
    [nudge, N] = useState(""),
    [clearNote, C] = useState(""),
    [note, NO] = useState(""),
    [welcomed, W] = useState(true);
  const load = () =>
    request("/api/dashboard", undefined, lang)
      .then(D)
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
    try {
      W(localStorage.getItem("tilwa_advisor_welcomed") === "1");
    } catch {}
  }, []);
  const open = async (id: string) => {
    try {
      S(
        await request(
          `/api/dashboard?student=${encodeURIComponent(id)}`,
          undefined,
          lang,
        ),
      );
      N("");
      C("");
      NO("");
    } catch (e) {
      onError((e as Error).message);
    }
  };
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
  if (!data) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const reasonText = (r: any) =>
    ({
      "asked-for-help": t(
        `طلب المساعدة في ${localized(r.label, lang)}`,
        `Asked for help on ${localized(r.label, lang)}`,
      ),
      stuck: t(`متعثر في ${r.value} مفهومًا`, `Stuck on ${r.value} concept(s)`),
      "repeated-diagnosis": t(
        `تكرر التشخيص في ${localized(r.label, lang)}`,
        `Repeated diagnosis on ${localized(r.label, lang)}`,
      ),
      inactive: t(
        `غير نشط منذ ${r.value} يومًا`,
        `Inactive for ${r.value} days`,
      ),
      "not-started": t("لا نشاط بعد", "No activity yet"),
    })[r.kind as string] || r.kind;
  const shown = data.caseload.filter(
    (s: any) =>
      (!search.trim() ||
        `${s.name?.ar} ${s.name?.en}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())) &&
      (filter === "all" ||
        (filter === "flagged" && s.reasons.length > 0) ||
        s.reasons.some((r: any) => r.kind === filter)),
  );
  if (student)
    return (
      <>
        <div className="pageHead">
          <button className="textbtn" onClick={() => S(null)}>
            {lang === "ar" ? "→" : "←"} {t("طلابي", "My students")}
          </button>
          <h1>{localized(student.name, lang)}</h1>
          {note && <p role="status">{note}</p>}
        </div>
        <Box>
          <h2>{t("الإتقان في المقرر", "Mastery in the course")}</h2>
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
          <p>
            <small>
              {t(
                "هذا الطالب مسجّل في مقرر واحد على المنصة؛ ستظهر المقررات الأخرى هنا عند إضافتها.",
                "This student is enrolled in one course on the platform; other courses will appear here when added.",
              )}
            </small>
          </p>
          <h3>
            {t(
              "سبب كل علامة: ما وجده سلّم التشخيص",
              "The reason behind each flag: what the diagnosis ladder found",
            )}
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
                  {d.cause}
                  {d.targetLabel && `: ${localized(d.targetLabel, lang)}`}
                  {d.helped === true && ` · ${t("نفع", "it helped")}`}
                  {d.helped === false &&
                    ` · ${t("لم ينفع", "it did not help")}`}
                </small>
              </span>
              <small>{String(d.at).slice(0, 10)}</small>
            </div>
          ))}
          <h3>{t("آخر النشاط", "Recent activity")}</h3>
          {student.recent.length === 0 && (
            <p>{t("لا نشاط بعد.", "No activity yet.")}</p>
          )}
          {student.recent.slice(0, 6).map((a: any, i: number) => (
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
                      : t("بانتظار المراجعة", "awaiting review")}{" "}
                · {String(a.at).slice(0, 10)}
              </small>
            </div>
          ))}
          <p>
            <small>
              {t(
                "لا تُعرض محادثات المساعد ولا درجات من أنظمة أخرى.",
                "Tutor conversations and grades from other systems are not shown.",
              )}
            </small>
          </p>
        </Box>
        <Box cls="end">
          <h2>{t("أرسل تنبيهًا", "Send a nudge")}</h2>
          <div className="actions">
            <Button
              onClick={() =>
                N(
                  t(
                    "أردت الاطمئنان عليك. إن احتجت مساعدة في المقرر فأنا موجود.",
                    "Just checking in. If you need help with the course, I'm here.",
                  ),
                )
              }
            >
              {t("اطمئنان ودّي", "Friendly check-in")}
            </Button>
            <Button
              onClick={() =>
                N(
                  t(
                    "جرّب المفهوم التالي في صفحتك الرئيسية؛ خطوة صغيرة اليوم تكفي.",
                    "Try the next concept on your home page; a small step today is enough.",
                  ),
                )
              }
            >
              {t("اقتراح المفهوم التالي", "Suggested next concept")}
            </Button>
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
                await open(student.studentId).then(() =>
                  NO(t("أُرسل التنبيه.", "Nudge sent.")),
                );
            }}
          >
            {t("إرسال", "Send")}
          </Button>
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
          <h3>{t("العلامة غير دقيقة؟", "Is the flag a false positive?")}</h3>
          <label>
            {t("ملاحظة توضّح السبب", "A note explaining why")}
            <input
              value={clearNote}
              onChange={(e) => C(e.target.value)}
              dir="auto"
            />
          </label>
          <Button
            disabled={clearNote.trim().length < 3}
            onClick={async () => {
              if (
                await act(
                  {
                    action: "flag-clear",
                    studentId: student.studentId,
                    note: clearNote.trim(),
                  },
                  t(
                    "أُخفيت العلامة عندك لأسبوع، وتبقى ظاهرة للمدرّس.",
                    "The flag is hidden for you for a week; the instructor still sees it.",
                  ),
                )
              )
                S(null);
            }}
          >
            {t("أخفِ العلامة عندي", "Clear the flag for me")}
          </Button>
        </Box>
      </>
    );
  return (
    <>
      <div className="pageHead">
        <h1>{t("طلابي", "My students")}</h1>
        <p>
          {t(
            `${data.size} طالبًا في قائمتك. العلامات تأتي من قواعد بسيطة على النشاط والإتقان، ولكل علامة سبب.`,
            `${data.size} students in your caseload. Flags come from simple rules on activity and mastery, and every flag has a reason.`,
          )}
        </p>
        {note && <p role="status">{note}</p>}
      </div>
      {!welcomed && (
        <Box>
          <h2>{t("ما الذي تراه هنا", "What you can see here")}</h2>
          <p>
            {t(
              "ترى لطلابك: خريطة الإتقان، العلامات، النشاط، وما وجده سلّم التشخيص. لا ترى محادثات المساعد ولا درجات الأنظمة الأخرى. يمكنك إرسال تنبيه لأي طالب في قائمتك.",
              "For your students you see: the mastery map, flags, activity and what the diagnosis ladder found. You do not see tutor conversations or grades from other systems. You can send a nudge to any student in your caseload.",
            )}
          </p>
          <Button
            primary
            onClick={() => {
              try {
                localStorage.setItem("tilwa_advisor_welcomed", "1");
              } catch {}
              W(true);
            }}
          >
            {t("فهمت", "Continue")}
          </Button>
        </Box>
      )}
      {data.size === 0 ? (
        <Box>
          <p>
            {t(
              "لم تُحدَّد قائمة طلابك بعد. تواصل مع شؤون الطلاب.",
              "Your caseload hasn't been assigned yet. Contact the registrar.",
            )}
          </p>
        </Box>
      ) : (
        <>
          <Box cls={welcomed ? "" : "end"}>
            <h2>{t("إنذار مبكر", "Early warning")}</h2>
            {(
              [
                ["askedForHelp", "طلبوا المساعدة", "Asked for help"],
                [
                  "repeatedDiagnosis",
                  "تعثّر متكرر في المفهوم نفسه",
                  "Repeatedly stuck on the same concept",
                ],
                ["stuck", "متعثرون في مفهوم", "Stuck on a concept"],
                [
                  "inactive",
                  "بلا نشاط منذ ٧ أيام",
                  "No activity in the last 7 days",
                ],
                ["notStarted", "لم يبدؤوا بعد", "Have not started yet"],
              ] as const
            ).map(([key, ar, en]) => (
              <div className="row" key={key}>
                <strong>{t(ar, en)}</strong>
                <span>
                  {data.earlyWarning[key].length === 0
                    ? t("لا أحد", "nobody")
                    : data.earlyWarning[key].map((s: any) => (
                        <button
                          key={s.studentId}
                          className="textbtn"
                          style={{ marginInlineStart: 10 }}
                          onClick={() => open(s.studentId)}
                        >
                          {localized(s.name, lang)}
                        </button>
                      ))}
                </span>
              </div>
            ))}
          </Box>
          <Box cls="end">
            <h2>{t("القائمة", "Caseload")}</h2>
            <div className="two-columns">
              <label>
                {t("ابحث بالاسم", "Search by name")}
                <input
                  value={search}
                  onChange={(e) => Q(e.target.value)}
                  dir="auto"
                />
              </label>
              <label>
                {t("تصفية", "Filter")}
                <select value={filter} onChange={(e) => F(e.target.value)}>
                  <option value="all">{t("الكل", "Everyone")}</option>
                  <option value="flagged">{t("عليهم علامة", "Flagged")}</option>
                  <option value="inactive">{t("غير نشطين", "Inactive")}</option>
                  <option value="stuck">{t("متعثرون", "Stuck")}</option>
                </select>
              </label>
            </div>
            {shown.map((s: any) => (
              <div className="row" key={s.studentId}>
                <span>
                  <strong>{localized(s.name, lang)}</strong>
                  <br />
                  <small>
                    {t(
                      `جاهز ${s.ready} من ${s.assessable} مفهومًا`,
                      `${s.ready} of ${s.assessable} concepts ready`,
                    )}
                    {s.reasons.length > 0 &&
                      ` · ${s.reasons.map(reasonText).join(" · ")}`}
                    {s.flagsCleared &&
                      ` · ${t("أخفيتَ علاماته", "flags cleared by you")}`}
                    {s.lastActivity &&
                      ` · ${t("آخر نشاط", "last activity")} ${String(s.lastActivity).slice(0, 10)}`}
                  </small>
                </span>
                <Button onClick={() => open(s.studentId)}>
                  {t("افتح الطالب", "Open student")}
                </Button>
              </div>
            ))}
          </Box>
        </>
      )}
    </>
  );
}
