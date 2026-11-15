"use client";
import { useEffect, useRef, useState } from "react";
import { Box, Button, localized, request, type Translate } from "./Workspace";

type Lang = "ar" | "en";
type Perform = (action: string, body?: any) => Promise<any>;
type Node = {
  conceptId: string;
  label: { ar: string; en: string };
  objectiveId: string | null;
  status: string;
  blockedBy: { conceptId: string; label: { ar: string; en: string } }[];
  mastery: number | null;
  unlocks: { conceptId: string; label: { ar: string; en: string } }[];
  covered: { conceptId: string; label: { ar: string; en: string } }[];
};
export type LearnOptions = {
  returnTo?: { objectiveId: string; episodeId: string };
  resume?: {
    afterPrerequisite: "passed" | "failed";
    previousEpisodeId: string;
  };
};
const QUESTION_LIMIT = 6;
const WRONG_STREAK = 3;

/** Progress is a state, never a grade. */
function statusInfo(status: string, t: Translate) {
  return (
    {
      secure: { label: t("جاهز", "Ready"), color: "#3b6fd4" },
      inferred: {
        label: t("معروف على الأرجح", "Likely known"),
        color: "#2e9e6b",
      },
      developing: { label: t("قيد التعلّم", "Learning"), color: "#d99a1c" },
      unassessed: { label: t("لم يبدأ بعد", "Not started"), color: "#9aa0ae" },
      unassessable: {
        label: t("بلا أسئلة بعد", "No questions yet"),
        color: "#d5d8e0",
      },
    }[status] || { label: status, color: "#9aa0ae" }
  );
}
function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: 6,
        background: color,
        marginInlineEnd: 8,
        verticalAlign: "middle",
      }}
    />
  );
}
const list = (items: { label: { ar: string; en: string } }[], lang: Lang) =>
  items.map((i) => localized(i.label, lang)).join(lang === "ar" ? "، " : ", ");

/** ST5 + ST6: where the student stands and the single next thing to do. */
export function StudentHome({
  data,
  lang,
  t,
  learn,
  startDiagnostic,
  go,
  perform,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  perform: Perform;
  learn: (objectiveId: string) => void;
  startDiagnostic: () => void;
  go: (view: string) => void;
}) {
  const nodes: Node[] = data.path?.nodes || [];
  const next: Node | null = data.path?.next || null;
  const exam = (data.readiness || [])[0];
  const assessable = nodes.filter((n) => n.objectiveId);
  const answered = (data.attempts || []).length > 0;
  const [skipped, SK] = useState(false);
  useEffect(() => {
    try {
      SK(localStorage.getItem("tilwa_diagnostic_skipped") === "1");
    } catch {}
  }, []);
  const notStarted = assessable.filter((n) => n.status === "unassessed").length;
  const ready = assessable.filter((n) => n.status === "secure").length;
  if (!assessable.length)
    return (
      <>
        <div className="pageHead">
          <h1>{t("أهلًا بك", "Welcome")}</h1>
        </div>
        <Box>
          <h2>{t("المقرر لم يُجهَّز بعد", "The course is not ready yet")}</h2>
          <p>
            {t(
              "لم ينشر مدرّسك مفاهيم وأسئلة بعد. ستظهر هنا خطوتك التالية فور نشرها.",
              "Your instructor has not published concepts and questions yet. Your next step will appear here as soon as they are.",
            )}
          </p>
        </Box>
      </>
    );
  return (
    <>
      <div className="pageHead">
        <h1>{t("أهلًا بك", "Welcome")}</h1>
        <p>
          {t(
            "تقدّمك هنا صورة لما تعلّمته، وليس درجة.",
            "Your progress here is a picture of what you have learned, not a grade.",
          )}
        </p>
      </div>
      {(data.nudges || [])
        .filter((n: any) => !n.data.seenAt)
        .slice(-2)
        .map((n: any) => (
          <p className="notice" key={n.id} dir="auto">
            <strong>
              {t("رسالة من مدرّسك", "A message from your instructor")}:
            </strong>{" "}
            {n.data.text}{" "}
            <button
              className="textbtn"
              onClick={() => perform("nudge-seen", { id: n.id })}
            >
              {t("تم", "Got it")}
            </button>
          </p>
        ))}
      {data.courseEnd?.postTestOpen && (
        <Box>
          <h2>{t("نهاية المقرر", "End of course")}</h2>
          <p>
            {data.courseEnd.postTest
              ? data.courseEnd.surveyDone
                ? t(
                    "أكملت الاختبار البعدي والاستبيان. افتح ملخصك.",
                    "You finished the post-test and the survey. Open your summary.",
                  )
                : t("بقي استبيان قصير.", "A short survey is left.")
              : t(
                  "فتح مدرّسك الاختبار البعدي: يقيس ما تعلّمته في المقرر.",
                  "Your instructor opened the post-test: it measures what you learned in the course.",
                )}
          </p>
          <Button primary onClick={() => go("finish")}>
            {data.courseEnd.postTest
              ? t("متابعة", "Continue")
              : t("ابدأ الاختبار البعدي", "Start the post-test")}
          </Button>
        </Box>
      )}
      {!answered && !skipped && (
        <Box>
          <h2>{t("اختبار قصير للبداية", "A short check to begin")}</h2>
          <p>
            {t(
              "يساعدنا على تخطّي ما تعرفه بالفعل. لا يؤثر على درجتك. إن لم تعرف إجابة فاختر «لا أعرف».",
              "This helps us skip what you already know. It does not affect your grade. If you do not know an answer, choose “I don't know”.",
            )}
          </p>
          <div className="actions">
            <Button primary onClick={startDiagnostic}>
              {t("ابدأ الاختبار القصير", "Start the short check")}
            </Button>
            <Button
              onClick={() => {
                try {
                  localStorage.setItem("tilwa_diagnostic_skipped", "1");
                } catch {}
                SK(true);
              }}
            >
              {t("تخطَّ وابدأ التعلّم", "Skip and start learning")}
            </Button>
          </div>
        </Box>
      )}
      {next ? (
        <Box cls={!answered && !skipped ? "end" : ""}>
          <span className="badge lavender">{t("التالي لك", "Next up")}</span>
          <h2>{localized(next.label, lang)}</h2>
          <p>
            {next.blockedBy.length
              ? t(
                  `يعتمد على ${list(next.blockedBy, lang)}، ولم تتقنه بعد. يمكنك البدء به أو بالمتطلب أولًا.`,
                  `It builds on ${list(next.blockedBy, lang)}, which is not ready yet. You can start here or with the prerequisite first.`,
                )
              : next.covered.length
                ? t(
                    `أتقنتَ ${list(next.covered, lang)}، وهذا ما يليها.`,
                    `You've covered ${list(next.covered, lang)}, and this comes next.`,
                  )
                : t(
                    "نقطة بداية جيدة: لا يعتمد على شيء لم تتقنه.",
                    "A good place to start: it does not depend on anything you have not covered.",
                  )}
          </p>
          <div className="actions">
            <Button primary onClick={() => learn(next.objectiveId!)}>
              {t("متابعة", "Continue")}
            </Button>
            {answered && notStarted > 0 && (
              <Button onClick={startDiagnostic}>
                {t(
                  `اختبار سريع لما لم يُقيَّم (${notStarted})`,
                  `Quick check of what is not assessed yet (${notStarted})`,
                )}
              </Button>
            )}
          </div>
        </Box>
      ) : (
        <Box>
          <h2>
            {t("أتقنتَ هذا الجزء كله", "You've mastered this whole section")}
          </h2>
          <p>
            {t(
              "كل المفاهيم التي لها أسئلة معتمدة صارت جاهزة. يمكنك مواصلة التدريب على أي منها.",
              "Every concept with approved questions is ready. You can keep practising any of them.",
            )}
          </p>
        </Box>
      )}
      <div className="split end">
        <Box>
          <h2>{t("مراجعات مستحقة", "Reviews due")}</h2>
          <p>
            {data.reviewsDue
              ? t(
                  `${data.reviewsDue} سؤالًا للمراجعة اليوم.`,
                  `${data.reviewsDue} questions to review today.`,
                )
              : t("لا مراجعات مستحقة الآن.", "You're all caught up.")}
          </p>
          {data.reviewsDue > 0 && (
            <Button onClick={() => go("review")}>
              {t("ابدأ المراجعة", "Start review")}
            </Button>
          )}
        </Box>
        {exam && (
          <Box>
            <h2>{t("جاهزية الامتحان", "Exam readiness")}</h2>
            <p>
              {exam.name}: {t(`نحو ${exam.about}٪`, `about ${exam.about}%`)}
              {exam.daysLeft > 0 &&
                ` · ${t(`باقٍ ${exam.daysLeft} يومًا`, `${exam.daysLeft} days to go`)}`}
            </p>
            <Button onClick={() => go("exam")}>
              {t("افتح الجاهزية", "Open readiness")}
            </Button>
          </Box>
        )}
      </div>
      <Box cls="end">
        <h2>{t("خريطة مهاراتك", "Your skill map")}</h2>
        <p>
          {t(
            `${ready} من ${assessable.length} مفهومًا جاهز. المرتّبة من الأساس إلى ما يُبنى عليه.`,
            `${ready} of ${assessable.length} concepts ready. Ordered from the foundations to what builds on them.`,
          )}
        </p>
        <p>
          {["secure", "inferred", "developing", "unassessed"].map((s) => (
            <span key={s} style={{ marginInlineEnd: 16 }}>
              <Dot color={statusInfo(s, t).color} />
              <small>{statusInfo(s, t).label}</small>
            </span>
          ))}
        </p>
        {nodes.map((n) => {
          const info = statusInfo(n.status, t);
          return (
            <div className="row" key={n.conceptId}>
              <span>
                <Dot color={info.color} />
                <strong>{localized(n.label, lang)}</strong>
                <br />
                <small>
                  {info.label}
                  {n.blockedBy.length > 0 &&
                    ` · ${t("يعتمد على", "builds on")} ${list(n.blockedBy, lang)}`}
                  {!n.objectiveId &&
                    ` · ${t("معرفة مساندة، ليست من أسئلة المقرر بعد", "background knowledge, no course questions yet")}`}
                </small>
              </span>
              {n.objectiveId && (
                <span className="actions">
                  <Button onClick={() => learn(n.objectiveId!)}>
                    {n.status === "secure"
                      ? t("واصل التدريب", "Keep practising")
                      : t("تدرّب على هذا", "Practise this")}
                  </Button>
                  {n.status === "inferred" && (
                    <Button onClick={() => learn(n.objectiveId!)}>
                      {t("هذا غير صحيح؟ اختبرني", "Looks wrong? Check me")}
                    </Button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </Box>
    </>
  );
}

const FORMATS = [
  ["analogy", "تشبيه أبسط", "Simpler analogy"],
  ["step-by-step", "خطوة بخطوة", "Step by step"],
  ["worked-example", "مثال محلول", "Worked example"],
  ["real-world", "مثال من الواقع", "Real-world example"],
  ["short", "ملخص أقصر", "Shorter summary"],
] as const;

/** ST8–ST11 for one concept, or ST4 when `diagnostic` is set. */
export function Learn({
  objectiveId,
  diagnostic,
  data,
  lang,
  t,
  perform,
  back,
  learn,
  returnTo,
  resume,
}: {
  objectiveId: string | null;
  diagnostic: boolean;
  data: any;
  lang: Lang;
  t: Translate;
  perform: Perform;
  back: () => void;
  learn: (objectiveId: string, options?: LearnOptions) => void;
  returnTo?: LearnOptions["returnTo"];
  resume?: LearnOptions["resume"];
}) {
  const nodes: Node[] = data.path?.nodes || [];
  const node = nodes.find((n) => n.objectiveId === objectiveId) || null;
  const state = (data.states || []).find(
    (s: any) => s.data.objectiveId === objectiveId,
  )?.data;
  const [concept, C] = useState<any>(null);
  const [delivery, D] = useState<any>(null),
    [queue, Q] = useState<any[]>([]),
    [answer, A] = useState(""),
    [result, R] = useState<any>(null),
    [hints, H] = useState<any[]>([]),
    [noMoreHints, NH] = useState(false),
    [count, N] = useState(0),
    [streak, S] = useState(0),
    [phase, P] = useState<"read" | "question" | "done" | "empty" | "diagnosis">(
      diagnostic ? "question" : "read",
    ),
    [episode, E] = useState<any>(null),
    [explained, X] = useState<any>(null),
    [explaining, XB] = useState(false),
    [busy, B] = useState(false),
    [preferred, PF] = useState(""),
    [formatTried, FT] = useState(false),
    [note, NO] = useState(
      resume?.afterPrerequisite === "passed"
        ? t(
            "أنت متمكّن من المتطلب السابق. لنعد إلى هذا المفهوم.",
            "You're solid on the prerequisite. Let's try this concept again.",
          )
        : returnTo
          ? t(
              "تحقّق سريع من المتطلب السابق، ثم نعود.",
              "A quick check of the prerequisite, then we go back.",
            )
          : "",
    );
  const shownAt = useRef(0);
  useEffect(() => {
    try {
      PF(localStorage.getItem("tilwa_format") || "");
    } catch {}
  }, []);
  useEffect(() => {
    if (!node) return;
    request("/api/knowledge/map", undefined, lang)
      .then((m) =>
        C(m.concepts.find((c: any) => c.id === node.conceptId) || null),
      )
      .catch(() => undefined);
  }, [node?.conceptId]);
  const show = (d: any) => {
    D(d);
    A("");
    R(null);
    H([]);
    NH(false);
    shownAt.current = Date.now();
    P("question");
  };
  const nextQuestion = async () => {
    if (queue.length) {
      show(queue[0]);
      Q(queue.slice(1));
      return;
    }
    if (diagnostic) {
      P("done");
      return;
    }
    B(true);
    const r = await perform("select-practice", { objectiveId });
    B(false);
    if (r?.item) show(r);
    else P(state?.status === "secure" ? "done" : "empty");
  };
  useEffect(() => {
    // Back from a failed prerequisite check: go one level deeper, or stop descending.
    if (resume?.afterPrerequisite === "failed")
      void diagnose({
        afterPrerequisite: "failed",
        previousEpisodeId: resume.previousEpisodeId,
      });
  }, []);
  useEffect(() => {
    if (!diagnostic) return;
    (async () => {
      const r = await perform("diagnostic", {});
      if (r?.items?.length) {
        Q(r.items.slice(1));
        show(r.items[0]);
      } else P("done");
    })();
  }, []);
  const diagnose = async (extra: any = {}) => {
    B(true);
    const r = await perform("diagnose", {
      objectiveId,
      formatTried,
      ...extra,
    });
    B(false);
    if (r) {
      E(r);
      P("diagnosis");
    }
  };
  const submit = async (unknown = false) => {
    B(true);
    const r = await perform("attempt", {
      deliveryId: delivery.deliveryId,
      answer: unknown ? "" : answer,
      unknown,
      elapsedMs: Date.now() - shownAt.current,
      idempotencyKey: crypto.randomUUID(),
    });
    B(false);
    if (!r) return;
    R(r);
    N((n) => n + 1);
    S((s) => (r.attempt.correct === false ? s + 1 : 0));
  };
  const afterAnswer = async () => {
    if (diagnostic) return nextQuestion();
    const status = result?.state?.status;
    const wrongRun = streak >= WRONG_STREAK;
    // A prerequisite check that was part of a diagnosis returns to the concept it served.
    if (returnTo && (status === "secure" || wrongRun || count >= 3)) {
      const passed = status === "secure" || !wrongRun;
      await perform("diagnosis-outcome", {
        episodeId: returnTo.episodeId,
        choice: "check-prerequisite",
        helped: passed,
      });
      learn(returnTo.objectiveId, {
        resume: {
          afterPrerequisite: passed ? "passed" : "failed",
          previousEpisodeId: returnTo.episodeId,
        },
      });
      return;
    }
    if (status === "secure" && count >= 2) return P("done");
    if (wrongRun) {
      S(0);
      return diagnose();
    }
    if (count >= QUESTION_LIMIT)
      return P(status === "secure" ? "done" : "empty");
    return nextQuestion();
  };
  const explain = async (style: string) => {
    if (!node) return;
    XB(true);
    try {
      const r = await request(
        "/api/tutor",
        {
          question:
            lang === "ar"
              ? `اشرح ${node.label.ar} (${node.label.en})`
              : `Explain ${node.label.en}`,
          language: lang,
          style,
          courseId: "CET351",
        },
        lang,
      );
      X({ ...r, style });
    } catch (e) {
      X({ answer: (e as Error).message, citations: [], style });
    } finally {
      XB(false);
    }
  };
  const item = delivery?.item?.data || delivery?.item;
  const mastery = Math.round(
    100 * (result?.state?.bkt?.probability ?? state?.bkt?.probability ?? 0.2),
  );
  const title = diagnostic
    ? t("اختبار قصير للبداية", "A short check to begin")
    : localized(node?.label, lang);
  return (
    <>
      <div className="pageHead">
        <button className="textbtn" onClick={back}>
          {lang === "ar" ? "→" : "←"} {t("رجوع", "Back")}
        </button>
        <h1>{title}</h1>
        {!diagnostic && (
          <p>
            <span className="badge lavender">
              {t("راجعه مدرّسك", "Reviewed by your instructor")}
            </span>{" "}
            {node && statusInfo(node.status, t).label}
          </p>
        )}
        {note && <p role="status">{note}</p>}
      </div>
      {!diagnostic && (
        <Box>
          {concept?.summary && <p>{localized(concept.summary, lang)}</p>}
          {!concept?.summary && (
            <p>
              {t(
                "اقرأ الشريحة الأصلية لهذا المفهوم، أو اطلب شرحًا بالطريقة التي تناسبك.",
                "Read the original slide for this concept, or ask for an explanation in the way that suits you.",
              )}
            </p>
          )}
          {(concept?.lectureEvidence || []).slice(0, 4).map((e: any) => (
            <a
              key={e.id}
              href={e.url}
              target="_blank"
              rel="noreferrer"
              className="textbtn"
              style={{ marginInlineEnd: 12 }}
            >
              {t("الشريحة الأصلية", "View original slide")} · {e.title}{" "}
              {e.page ?? e.section} ↗
            </a>
          ))}
          <h3>{t("اشرحها بطريقة أخرى", "Explain it differently")}</h3>
          <div className="actions">
            {FORMATS.map(([id, ar, en]) => (
              <Button
                key={id}
                primary={preferred === id}
                disabled={explaining}
                onClick={() => {
                  // The format picked last becomes the default offered first next time.
                  try {
                    localStorage.setItem("tilwa_format", id);
                  } catch {}
                  PF(id);
                  explain(id);
                }}
              >
                {t(ar, en)}
              </Button>
            ))}
          </div>
          <p>
            <small>
              {t(
                "هذه طريقة العرض فقط؛ لا تغيّر ما يُحتسب لك. آخر طريقة اخترتها تبقى مميّزة.",
                "This only changes how content is shown, not what is scored. The format you picked last stays highlighted.",
              )}
            </small>
          </p>
          {explaining && (
            <p role="status">
              {t("جارٍ تجهيز الشرح…", "Preparing the explanation…")}
            </p>
          )}
          {explained && (
            <div className="feedback" role="status">
              <p dir="auto">{explained.answer}</p>
              {(explained.citations || []).map((c: any) => (
                <a
                  key={c.id}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="textbtn"
                  style={{ marginInlineEnd: 12 }}
                >
                  {t("المصدر", "Source")}: {c.title || c.sourceKey}{" "}
                  {c.page ? `${t("ص", "p.")} ${c.page}` : c.section} ↗
                </a>
              ))}
            </div>
          )}
          {phase === "read" && (
            <div className="actions">
              <Button primary disabled={busy} onClick={nextQuestion}>
                {t("ابدأ الأسئلة", "Start the questions")}
              </Button>
            </div>
          )}
        </Box>
      )}
      {phase === "question" && item && (
        <Box cls="practice end">
          <p>
            <small>
              {diagnostic
                ? t(
                    `سؤال ${count + 1} · لا درجات هنا`,
                    `Question ${count + 1} · no scores here`,
                  )
                : t(
                    `سؤال ${Math.min(count + 1, QUESTION_LIMIT)} من ${QUESTION_LIMIT}`,
                    `Question ${Math.min(count + 1, QUESTION_LIMIT)} of ${QUESTION_LIMIT}`,
                  )}
            </small>
          </p>
          {!diagnostic && (
            <div
              role="progressbar"
              aria-valuenow={mastery}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t(
                "مؤشر الإتقان، ليس درجة",
                "Mastery indicator, not a grade",
              )}
              style={{
                height: 6,
                borderRadius: 3,
                background: "#e6e8ef",
                overflow: "hidden",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  width: `${mastery}%`,
                  height: "100%",
                  background: "#3b6fd4",
                }}
              />
            </div>
          )}
          <h2 dir="auto">{localized(item.stem, lang)}</h2>
          {item.steps && (
            <ol>
              {item.steps.map((s: any, i: number) => (
                <li key={i} dir="auto">
                  {localized(s, lang)}
                </li>
              ))}
            </ol>
          )}
          {item.options?.length > 0 ? (
            <fieldset className="answer-options">
              <legend>{t("إجابتك", "Your answer")}</legend>
              {item.options.map((o: any) => (
                <label key={o.id} className={answer === o.id ? "selected" : ""}>
                  <input
                    type="radio"
                    name="answer"
                    checked={answer === o.id}
                    onChange={() => A(o.id)}
                    disabled={!!result}
                  />
                  <span dir="auto">{localized(o.label, lang)}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <label>
              {t("إجابتك", "Your answer")}
              <textarea
                dir="auto"
                value={answer}
                onChange={(e) => A(e.target.value)}
                disabled={!!result}
              />
            </label>
          )}
          {hints.map((h, i) => (
            <p className="notice" key={i} dir="auto">
              {t("تلميح", "Hint")} {i + 1}: {localized(h, lang)}
            </p>
          ))}
          {!result && (
            <div className="actions">
              <Button
                primary
                disabled={busy || !answer}
                onClick={() => submit(false)}
              >
                {t("تحقّق من الإجابة", "Check answer")}
              </Button>
              {!diagnostic && (
                <Button
                  disabled={busy || noMoreHints}
                  onClick={async () => {
                    const r = await perform("hint", {
                      deliveryId: delivery.deliveryId,
                    });
                    if (r?.hint) H((x) => [...x, r.hint]);
                    if (!r?.hint || r.exhausted) NH(true);
                  }}
                >
                  {noMoreHints
                    ? t("لا تلميحات أخرى", "No more hints")
                    : t("تلميح", "Hint")}
                </Button>
              )}
              <Button disabled={busy} onClick={() => submit(true)}>
                {t("لا أعرف", "I don't know")}
              </Button>
            </div>
          )}
          {result && (
            <div className="feedback" role="status">
              {diagnostic ? (
                <strong>
                  {t("سُجّلت إجابتك.", "Your answer was recorded.")}
                </strong>
              ) : (
                <>
                  <strong>
                    {result.attempt.unknown
                      ? t(
                          "لا بأس. هذا ما يشرحه السؤال:",
                          "That's fine. Here is what the question is about:",
                        )
                      : result.attempt.correct === true
                        ? t("إجابة صحيحة.", "That's right.")
                        : result.attempt.correct === false
                          ? t(
                              "ليست هذه. إليك السبب:",
                              "Not this one. Here is why:",
                            )
                          : t(
                              "حُفظت إجابتك لمراجعة المدرّس.",
                              "Your answer was saved for your instructor to review.",
                            )}
                  </strong>
                  <p dir="auto">{localized(result.feedback, lang)}</p>
                </>
              )}
              <Button primary disabled={busy} onClick={afterAnswer}>
                {t("التالي", "Next")}
              </Button>
            </div>
          )}
        </Box>
      )}
      {phase === "done" && (
        <Box cls="end">
          {diagnostic ? (
            <>
              <h2>
                {t("انتهى الاختبار القصير", "The short check is finished")}
              </h2>
              <p>
                {t(
                  "حدّثنا خريطة مهاراتك. افتحها لترى من أين تبدأ.",
                  "We updated your skill map. Open it to see where you start.",
                )}
              </p>
            </>
          ) : (
            <>
              <h2>
                {localized(node?.label, lang)}: {t("جاهز", "ready")}
              </h2>
              <p>
                {node?.unlocks.length
                  ? t(
                      `هذا يفتح لك: ${list(node.unlocks, lang)}.`,
                      `What it unlocks next: ${list(node.unlocks, lang)}.`,
                    )
                  : t("أحسنت.", "Well done.")}
              </p>
            </>
          )}
          <div className="actions">
            <Button primary onClick={back}>
              {t("إلى خريطة مهاراتي", "To my skill map")}
            </Button>
            {!diagnostic && (
              <Button
                onClick={() => {
                  N(0);
                  nextQuestion();
                }}
              >
                {t("واصل التدريب", "Keep practising")}
              </Button>
            )}
          </div>
        </Box>
      )}
      {phase === "empty" && (
        <Box cls="end">
          <h2>
            {t(
              "انتهت الأسئلة المعتمدة لهذا المفهوم",
              "No more reviewed questions for this concept",
            )}
          </h2>
          <p>
            {t(
              "لم تصل إلى «جاهز» بعد، ولا توجد أسئلة جديدة الآن. جرّب شرحًا بطريقة أخرى من الأعلى، أو لنبحث عن سبب التعثّر.",
              "You have not reached “ready” yet and there are no fresh questions right now. Try a different explanation above, or let's look for what is in the way.",
            )}
          </p>
          <div className="actions">
            <Button primary disabled={busy} onClick={() => diagnose()}>
              {t("ابحث عن سبب التعثّر", "Find what is in the way")}
            </Button>
            <Button onClick={back}>{t("رجوع", "Back")}</Button>
          </div>
        </Box>
      )}
      {phase === "diagnosis" && episode && (
        <Box cls="end">
          {episode.cause === "prerequisite" && (
            <>
              <h2>
                {t(
                  `${localized(node?.label, lang)} يعتمد على ${localized(episode.targetLabel, lang)}. لنتحقق منه أولًا.`,
                  `${localized(node?.label, lang)} builds on ${localized(episode.targetLabel, lang)}. Let's check that first.`,
                )}
              </h2>
              <div className="actions">
                {episode.targetObjectiveId && (
                  <Button
                    primary
                    onClick={() =>
                      learn(episode.targetObjectiveId, {
                        returnTo: {
                          objectiveId: objectiveId!,
                          episodeId: episode.episodeId,
                        },
                      })
                    }
                  >
                    {t(
                      `تحقّق من ${localized(episode.targetLabel, lang)}`,
                      `Check ${localized(episode.targetLabel, lang)}`,
                    )}
                  </Button>
                )}
                <Button
                  onClick={async () => {
                    await perform("diagnosis-outcome", {
                      episodeId: episode.episodeId,
                      choice: "stay",
                    });
                    NO(
                      t(
                        "قد يبدو التدريب أصعب، لكن يمكنك المواصلة.",
                        "Practice may feel harder — but you can keep going.",
                      ),
                    );
                    N(0);
                    nextQuestion();
                  }}
                >
                  {t(
                    `ابقَ على ${localized(node?.label, lang)}`,
                    `Stay on ${localized(node?.label, lang)}`,
                  )}
                </Button>
              </div>
            </>
          )}
          {episode.cause === "presentation" && (
            <>
              <h2>
                {t(
                  "المتطلبات السابقة سليمة، لكن المفهوم لم يتضح بعد. لنجرّب طريقة أخرى.",
                  "The prerequisite is fine, but the concept still isn't clicking. Let's try a different way.",
                )}
              </h2>
              <div className="actions">
                {FORMATS.map(([id, ar, en]) => (
                  <Button
                    key={id}
                    disabled={explaining}
                    onClick={async () => {
                      FT(true);
                      await explain(id);
                      await perform("diagnosis-outcome", {
                        episodeId: episode.episodeId,
                        choice: "format",
                        format: id,
                      });
                      N(0);
                      P("read");
                    }}
                  >
                    {t(ar, en)}
                  </Button>
                ))}
              </div>
            </>
          )}
          {episode.cause === "gaming" && (
            <>
              <h2>
                {t(
                  "لنجرّب سؤالًا جديدًا على هذا المفهوم.",
                  "Let's try a fresh question on this concept.",
                )}
              </h2>
              <p>
                {t(
                  "خذ وقتك في القراءة؛ الإجابات السريعة جدًّا لا تُحتسب لك ولا عليك.",
                  "Take your time reading; very fast answers do not count for or against you.",
                )}
              </p>
              <div className="actions">
                <Button
                  primary
                  onClick={async () => {
                    await perform("diagnosis-outcome", {
                      episodeId: episode.episodeId,
                      choice: "fresh-question",
                    });
                    N(0);
                    nextQuestion();
                  }}
                >
                  {t("سؤال جديد", "Fresh question")}
                </Button>
              </div>
            </>
          )}
          {(episode.cause === "confidence" ||
            episode.cause === "basics-gap") && (
            <>
              <h2>
                {episode.cause === "basics-gap"
                  ? t(
                      "يبدو أن هناك فجوة في الأساسيات. ماذا تفضّل؟",
                      "This looks like a gap in the basics. What would you like?",
                    )
                  : t(
                      "تعرف المتطلبات، والطريقة مناسبة. أحيانًا يحتاج الأمر بضع محاولات أخرى.",
                      "You know the prerequisites, and the format is fine. Sometimes it just takes a few more tries.",
                    )}
              </h2>
              <div className="actions">
                <Button
                  primary
                  onClick={async () => {
                    await perform("diagnosis-outcome", {
                      episodeId: episode.episodeId,
                      choice: "worked-example",
                    });
                    await explain("worked-example");
                    N(0);
                    P("read");
                  }}
                >
                  {t("مثال محلول", "A worked example")}
                </Button>
                <Button
                  onClick={async () => {
                    await perform("diagnosis-outcome", {
                      episodeId: episode.episodeId,
                      choice: "break",
                    });
                    back();
                  }}
                >
                  {t("استراحة", "Take a break")}
                </Button>
                <Button
                  onClick={async () => {
                    await perform("diagnosis-outcome", {
                      episodeId: episode.episodeId,
                      choice: "ask-instructor",
                    });
                    NO(
                      t(
                        "أرسلنا لمدرّسك ما وجدناه ليساعدك.",
                        "We sent your instructor what we found so they can help.",
                      ),
                    );
                    P("read");
                  }}
                >
                  {t("اسأل المدرّس", "Ask your instructor")}
                </Button>
              </div>
            </>
          )}
        </Box>
      )}
    </>
  );
}

/** ST16: a few minutes of recall on questions already met. */
export function DailyReview({
  lang,
  t,
  perform,
  back,
}: {
  lang: Lang;
  t: Translate;
  perform: Perform;
  back: () => void;
}) {
  const [cards, C] = useState<any[] | null>(null),
    [index, I] = useState(0),
    [picked, P] = useState(""),
    [shown, S] = useState<any>(null),
    [tally, T] = useState({ easy: 0, medium: 0, hard: 0 });
  useEffect(() => {
    perform("review-due", {}).then((r) => C(r?.cards || []));
  }, []);
  if (!cards) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const card = cards[index];
  const finished = cards.length > 0 && index >= cards.length;
  return (
    <>
      <div className="pageHead">
        <h1>{t("المراجعة اليومية", "Daily review")}</h1>
        <p>
          {t(
            "أسئلة قابلتها من قبل، لتثبيت ما تعلّمته. أجب من الذاكرة ثم اكشف الإجابة.",
            "Questions you have met before, to keep what you learned. Answer from memory, then show the answer.",
          )}
        </p>
      </div>
      {cards.length === 0 && (
        <Box>
          <h2>{t("لا مراجعات مستحقة الآن", "You're all caught up")}</h2>
          <p>
            {t(
              "عُد غدًا، أو واصل التعلّم من الرئيسية.",
              "Come back tomorrow, or keep learning from Home.",
            )}
          </p>
          <Button primary onClick={back}>
            {t("إلى الرئيسية", "To Home")}
          </Button>
        </Box>
      )}
      {finished && (
        <Box>
          <h2>{t("انتهت مراجعة اليوم", "Today's review is done")}</h2>
          <p>
            {t(
              `راجعتَ ${cards.length} سؤالًا: سهل ${tally.easy}، متوسط ${tally.medium}، صعب ${tally.hard}. الصعبة تعود غدًا.`,
              `You reviewed ${cards.length} questions: ${tally.easy} easy, ${tally.medium} medium, ${tally.hard} hard. The hard ones come back tomorrow.`,
            )}
          </p>
          <Button primary onClick={back}>
            {t("إلى الرئيسية", "To Home")}
          </Button>
        </Box>
      )}
      {card && (
        <Box cls="practice">
          <p>
            <small>
              {t(
                `${index + 1} من ${cards.length}`,
                `${index + 1} of ${cards.length}`,
              )}
            </small>
          </p>
          <h2 dir="auto">{localized(card.data.stem, lang)}</h2>
          <fieldset className="answer-options">
            <legend>
              {t("ما تتذكّره (اختياري)", "What you remember (optional)")}
            </legend>
            {(card.data.options || []).map((o: any) => (
              <label
                key={o.id}
                className={
                  shown && o.id === shown.key
                    ? "selected"
                    : picked === o.id
                      ? "selected"
                      : ""
                }
              >
                <input
                  type="radio"
                  name="review"
                  checked={picked === o.id}
                  onChange={() => P(o.id)}
                  disabled={!!shown}
                />
                <span dir="auto">
                  {localized(o.label, lang)}
                  {shown && o.id === shown.key && ` ✓`}
                </span>
              </label>
            ))}
          </fieldset>
          {!shown && (
            <Button
              primary
              onClick={async () =>
                S(await perform("review-show", { itemId: card.id }))
              }
            >
              {t("أظهر الإجابة", "Show answer")}
            </Button>
          )}
          {shown && (
            <div className="feedback" role="status">
              <p dir="auto">{localized(shown.feedback, lang)}</p>
              {shown.sourceKey && (
                <small>
                  {t("المصدر", "Source")}: {shown.sourceKey} {shown.locator}
                </small>
              )}
              <p>{t("كم كان تذكّرها سهلًا؟", "How easy was it to recall?")}</p>
              <div className="actions">
                {(
                  [
                    ["easy", "سهل", "Easy"],
                    ["medium", "متوسط", "Medium"],
                    ["hard", "صعب", "Hard"],
                  ] as const
                ).map(([rating, ar, en]) => (
                  <Button
                    key={rating}
                    onClick={async () => {
                      await perform("review-rate", {
                        itemId: card.id,
                        rating,
                        ...(picked ? { picked } : {}),
                      });
                      T((x) => ({ ...x, [rating]: x[rating] + 1 }));
                      P("");
                      S(null);
                      I(index + 1);
                    }}
                  >
                    {t(ar, en)}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Box>
      )}
    </>
  );
}

/** ST14 + ST15: a soft readiness estimate and a timed mock quiz. */
export function ExamReadiness({
  data,
  lang,
  t,
  perform,
  learn,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  perform: Perform;
  learn: (objectiveId: string) => void;
}) {
  const readiness: any[] = data.readiness || [];
  const [mock, M] = useState<any>(null),
    [index, I] = useState(0),
    [answer, A] = useState(""),
    [left, L] = useState(0),
    [result, R] = useState<any>(null),
    [flagged, F] = useState<number[]>([]);
  const answered = useRef(new Set<number>());
  const shownAt = useRef(0);
  const finish = async (examId: string, items: any[]) => {
    const r = await perform("mock-finish", {
      examId,
      deliveryIds: items.map((i) => i.deliveryId),
    });
    M(null);
    R(r);
  };
  useEffect(() => {
    if (!mock) return;
    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        mock.secondsAllowed - Math.round((Date.now() - mock.startedAt) / 1000),
      );
      L(remaining);
      // Time is up: submit what was answered.
      if (remaining === 0) void finish(mock.examId, mock.items);
    }, 1000);
    return () => clearInterval(timer);
  }, [mock]);
  if (!readiness.length)
    return (
      <>
        <div className="pageHead">
          <h1>{t("جاهزية الامتحان", "Exam readiness")}</h1>
        </div>
        <Box>
          <p>
            {t(
              "لم يحدد مدرّسك موعد امتحان بعد. ستظهر جاهزيتك هنا عند تحديده.",
              "Your instructor has not set an exam date yet. Your readiness will appear here once they do.",
            )}
          </p>
        </Box>
      </>
    );
  if (mock) {
    const current = mock.items[index];
    const item = current.item.data;
    const next = () => {
      A("");
      shownAt.current = Date.now();
      const remaining = mock.items
        .map((_: any, i: number) => i)
        .filter((i: number) => !answered.current.has(i));
      if (!remaining.length) return void finish(mock.examId, mock.items);
      I(remaining.find((i: number) => i > index) ?? remaining[0]);
    };
    return (
      <>
        <div className="pageHead">
          <h1>{t("اختبار تجريبي", "Mock quiz")}</h1>
          <p role="timer">
            {t("الوقت المتبقي", "Time left")}: {Math.floor(left / 60)}:
            {String(left % 60).padStart(2, "0")} ·{" "}
            {t(
              `أُجيب ${answered.current.size} من ${mock.items.length}`,
              `${answered.current.size} of ${mock.items.length} answered`,
            )}
          </p>
        </div>
        <Box cls="practice">
          <p>
            <small>
              {t(`سؤال ${index + 1}`, `Question ${index + 1}`)}
              {flagged.includes(index) && ` · ${t("مؤشَّر للعودة", "flagged")}`}
            </small>
          </p>
          <h2 dir="auto">{localized(item.stem, lang)}</h2>
          <fieldset className="answer-options">
            <legend>{t("إجابتك", "Your answer")}</legend>
            {(item.options || []).map((o: any) => (
              <label key={o.id} className={answer === o.id ? "selected" : ""}>
                <input
                  type="radio"
                  name="mock"
                  checked={answer === o.id}
                  onChange={() => A(o.id)}
                />
                <span dir="auto">{localized(o.label, lang)}</span>
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <Button
              primary
              disabled={!answer}
              onClick={async () => {
                await perform("attempt", {
                  deliveryId: current.deliveryId,
                  answer,
                  elapsedMs: Date.now() - shownAt.current,
                  idempotencyKey: crypto.randomUUID(),
                });
                answered.current.add(index);
                next();
              }}
            >
              {t("ثبّت الإجابة", "Save answer")}
            </Button>
            <Button
              onClick={() => {
                F((x) => (x.includes(index) ? x : [...x, index]));
                next();
              }}
            >
              {t("أشّر وعُد لاحقًا", "Flag and come back")}
            </Button>
            <Button onClick={() => finish(mock.examId, mock.items)}>
              {t("سلّم الاختبار", "Submit quiz")}
            </Button>
          </div>
        </Box>
      </>
    );
  }
  return (
    <>
      <div className="pageHead">
        <h1>{t("جاهزية الامتحان", "Exam readiness")}</h1>
        <p>
          {t(
            "تقدير تقريبي من تدريبك، وليس توقّعًا لدرجتك.",
            "A rough estimate from your practice, not a prediction of your grade.",
          )}
        </p>
      </div>
      {result && (
        <Box>
          <h2>{t("نتيجة الاختبار التجريبي", "Mock quiz result")}</h2>
          <p>
            {t(
              `أجبت ${result.answered} من ${result.served}، منها ${result.correct} صحيحة. ما لم تُجب عنه يُحسب هنا فقط، لا في إتقانك.`,
              `You answered ${result.answered} of ${result.served}, ${result.correct} correctly. Unanswered questions count here only, not in your mastery.`,
            )}
          </p>
          {result.concepts.map((c: any) => {
            const label = (data.objectives || []).find(
              (o: any) => o.data.objectiveId === c.objectiveId,
            )?.data.title;
            return (
              <div className="row" key={c.objectiveId}>
                <span>
                  <strong>{localized(label, lang)}</strong>
                  <br />
                  <small>
                    {t(
                      `${c.correct} من ${c.served}`,
                      `${c.correct} of ${c.served}`,
                    )}
                  </small>
                </span>
                {c.correct < c.served && (
                  <Button onClick={() => learn(c.objectiveId)}>
                    {t("تدرّب على هذا", "Practise this")}
                  </Button>
                )}
              </div>
            );
          })}
        </Box>
      )}
      {readiness.map((r) => (
        <Box key={r.examId} cls={result ? "end" : ""}>
          <h2>
            {r.name} · {r.date}
          </h2>
          <p style={{ fontSize: 28, margin: "8px 0" }}>
            <strong>{t(`نحو ${r.about}٪`, `about ${r.about}%`)}</strong>
          </p>
          <p>
            {r.daysLeft > 0
              ? t(
                  `باقٍ ${r.daysLeft} يومًا. ${r.suggestedMinutesPerDay ? `اقتراح: نحو ${r.suggestedMinutesPerDay} دقيقة يوميًّا.` : ""}`,
                  `${r.daysLeft} days to go. ${r.suggestedMinutesPerDay ? `Suggested: about ${r.suggestedMinutesPerDay} minutes a day.` : ""}`,
                )
              : t(
                  "موعد الامتحان حلّ أو مضى.",
                  "The exam date is here or has passed.",
                )}
          </p>
          <small>
            {t(
              `مدى الثقة: هذا التقدير مبني على تدريبك في ${r.assessedShare}٪ من وزن مفاهيم الامتحان. كلما تدرّبت أكثر صار أدقّ.`,
              `How sure this is: the estimate rests on your practice in ${r.assessedShare}% of the exam's concept weight. The more you practise, the firmer it gets.`,
            )}
          </small>
          <h3>
            {t(
              "المفاهيم الأكثر تأثيرًا على جاهزيتك",
              "The concepts costing you the most",
            )}
          </h3>
          {r.costliest.map((c: any) => (
            <div className="row" key={c.conceptId}>
              <strong>{localized(c.label, lang) || c.conceptId}</strong>
              {c.objectiveId && (
                <Button onClick={() => learn(c.objectiveId)}>
                  {t("تدرّب على هذا", "Practise this")}
                </Button>
              )}
            </div>
          ))}
          <div className="actions">
            <Button
              primary
              onClick={async () => {
                const m = await perform("mock-start", { examId: r.examId });
                if (m?.items?.length) {
                  answered.current = new Set();
                  shownAt.current = Date.now();
                  I(0);
                  A("");
                  F([]);
                  R(null);
                  L(m.secondsAllowed);
                  M({ ...m, examId: r.examId, startedAt: Date.now() });
                } else
                  R({
                    served: 0,
                    answered: 0,
                    correct: 0,
                    concepts: [],
                    empty: true,
                  });
              }}
            >
              {t("ابدأ اختبارًا تجريبيًّا", "Take mock quiz")}
            </Button>
          </div>
          {result?.empty && (
            <p role="status">
              {t(
                "لا توجد أسئلة جديدة معتمدة لمفاهيم هذا الامتحان الآن.",
                "There are no fresh reviewed questions for this exam's concepts right now.",
              )}
            </p>
          )}
        </Box>
      ))}
    </>
  );
}

/** ST17: the tutor, reachable from every student screen. */
export function TutorChat({
  lang,
  t,
  concept,
  close,
}: {
  lang: Lang;
  t: Translate;
  concept?: { ar: string; en: string } | null;
  close: () => void;
}) {
  const [thread, T] = useState<any[]>([]),
    [question, Q] = useState(""),
    [busy, B] = useState(false);
  const ask = async (text: string, style = "short", mode = "chat") => {
    if (!text.trim()) return;
    B(true);
    try {
      const r = await request(
        "/api/tutor",
        {
          question: text,
          // The tutor replies in the language the student actually typed.
          language: /[\u0600-\u06ff]/.test(text)
            ? /[a-z]{3,}/i.test(text)
              ? "mixed"
              : "ar"
            : "en",
          style,
          mode,
          courseId: "CET351",
        },
        lang,
      );
      T((x) => [...x, { question: text, style, ...r }]);
      Q("");
    } catch (e) {
      T((x) => [
        ...x,
        { question: text, answer: (e as Error).message, citations: [] },
      ]);
    } finally {
      B(false);
    }
  };
  const modeLabel = (m: string) =>
    ({
      "guiding-question": t("سؤال يوجّهك", "A guiding question"),
      "stronger-hint": t("تلميح أقوى", "A stronger hint"),
      "worked-example": t("مثال محلول مشابه", "A similar worked example"),
    })[m];
  return (
    <aside
      role="dialog"
      aria-label={t("المساعد", "Tutor")}
      style={{
        position: "fixed",
        insetInlineEnd: 16,
        bottom: 16,
        width: "min(440px, calc(100vw - 32px))",
        maxHeight: "min(640px, calc(100vh - 32px))",
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #dcdfe8",
        borderRadius: 16,
        boxShadow: "0 12px 40px rgba(20,24,60,.18)",
        zIndex: 50,
      }}
    >
      <div className="sectionTop" style={{ padding: "12px 16px" }}>
        <strong>{t("المساعد", "Tutor")}</strong>
        <button className="textbtn" onClick={close}>
          {t("إغلاق", "Close")}
        </button>
      </div>
      <div style={{ overflowY: "auto", padding: "0 16px", flex: 1 }}>
        {concept && (
          <p>
            <span className="badge lavender">{localized(concept, lang)}</span>
          </p>
        )}
        {thread.length === 0 && (
          <p>
            <small>
              {t(
                "اسأل بالعربية أو الإنجليزية أو بخليط منهما. أجيب من مواد مقررك فقط، وأبدأ بتلميح قبل الإجابة المباشرة.",
                "Ask in Arabic, English or a mix. I answer only from your course material, and start with a hint before the direct answer.",
              )}
            </small>
          </p>
        )}
        {thread.map((m, i) => (
          <div key={i}>
            <p dir="auto">
              <strong>{m.question}</strong>
            </p>
            <div className="feedback">
              {m.answerMode && m.answerMode !== "direct" && (
                <small>{modeLabel(m.answerMode)}</small>
              )}
              <p dir="auto">{m.answer}</p>
              {(m.citations || []).map((c: any) => (
                <a
                  key={c.id}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="textbtn"
                  style={{ marginInlineEnd: 10 }}
                >
                  {c.title || c.sourceKey}{" "}
                  {c.page ? `${t("ص", "p.")} ${c.page}` : c.section} ↗
                </a>
              ))}
              {m.disposition === "insufficient_evidence" && (
                <small>
                  {t(
                    "هذا غير مغطّى في مواد مقررك. أبلغتُ مدرّسك به.",
                    "This isn't covered in your course material. I've flagged it for your instructor.",
                  )}
                </small>
              )}
              {m.disposition === "answered" && (
                <div className="actions">
                  {m.answerMode !== "direct" && (
                    <Button disabled={busy} onClick={() => ask(m.question)}>
                      {t("إجابة أوضح", "More direct")}
                    </Button>
                  )}
                  {FORMATS.slice(0, 3).map(([id, ar, en]) => (
                    <Button
                      key={id}
                      disabled={busy}
                      onClick={() => ask(m.question, id, "explain")}
                    >
                      {t(ar, en)}
                    </Button>
                  ))}
                  {m.memoryId && !m.rated && (
                    <>
                      {(["up", "down"] as const).map((rating) => (
                        <button
                          key={rating}
                          className="textbtn"
                          aria-label={
                            rating === "up"
                              ? t("إجابة مفيدة", "Helpful")
                              : t("إجابة غير مفيدة", "Not helpful")
                          }
                          onClick={async () => {
                            await request(
                              "/api/tutor/memory",
                              { action: "rate", id: m.memoryId, rating },
                              lang,
                            ).catch(() => undefined);
                            T((x) =>
                              x.map((y, j) =>
                                j === i ? { ...y, rated: rating } : y,
                              ),
                            );
                          }}
                        >
                          {rating === "up" ? "👍" : "👎"}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p role="status">{t("جارٍ التفكير…", "Thinking…")}</p>}
      </div>
      <form
        style={{ display: "flex", gap: 8, padding: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          dir="auto"
          value={question}
          onChange={(e) => Q(e.target.value)}
          placeholder={t("اكتب سؤالك…", "Type your question…")}
          aria-label={t("سؤالك", "Your question")}
          style={{ flex: 1 }}
        />
        <Button primary type="submit" disabled={busy || !question.trim()}>
          {t("إرسال", "Send")}
        </Button>
      </form>
    </aside>
  );
}

const post = (body: any, lang: Lang) => request("/api/course-end", body, lang);

/** ST2: what is recorded and who sees it, before anything else. */
export function ConsentGate({
  lang,
  t,
  done,
  onError,
}: {
  lang: Lang;
  t: Translate;
  done: () => void;
  onError: (s: string) => void;
}) {
  const [platform, P] = useState(false),
    [research, R] = useState(false);
  return (
    <>
      <div className="pageHead">
        <h1>{t("قبل أن تبدأ", "Before you start")}</h1>
      </div>
      <Box>
        <p>
          {t(
            "تسجّل المنصة إجاباتك، ووقت الإجابة، والتلميحات التي استخدمتها، واللغة التي اخترتها، لتساعدك بشكل أفضل. مدرّسك يرى تقدّمك أنت. الباحثون يرون بيانات مجهولة الهوية فقط، وإن وافقت.",
            "The platform records your answers, your response time, the hints you used and your language choices so it can help you better. Your instructor sees your individual progress. Researchers see only anonymized data, and only if you agree.",
          )}
        </p>
        <label className="checklabel">
          <input
            type="checkbox"
            checked={platform}
            onChange={(e) => P(e.target.checked)}
          />
          {t(
            "أوافق على استخدام المنصة (مطلوب)",
            "I agree to use the platform (required)",
          )}
        </label>
        <label className="checklabel">
          <input
            type="checkbox"
            checked={research}
            onChange={(e) => R(e.target.checked)}
          />
          {t(
            "أوافق على استخدام بياناتي مجهولة الهوية في البحث (اختياري)",
            "I agree to the anonymized use of my data in research (optional)",
          )}
        </label>
        <p>
          <small>
            {t(
              "يمكنك تغيير هذين الاختيارين في أي وقت من التفضيلات، وطلب حذف بياناتك. رفض البحث لا يغيّر شيئًا في ما تحصل عليه.",
              "You can change these settings at any time from Preferences, and you can request deletion of your data. Declining research changes nothing about what you get.",
            )}
          </small>
        </p>
        <Button
          primary
          disabled={!platform}
          onClick={async () => {
            try {
              await post({ action: "consent", platform: true, research }, lang);
              done();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          {t("متابعة", "Continue")}
        </Button>
      </Box>
    </>
  );
}

/** ST18 + SYS3: consent, download and deletion of the learner's own data. */
export function PrivacyBox({
  data,
  lang,
  t,
  refresh,
  onError,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  refresh: () => Promise<any>;
  onError: (s: string) => void;
}) {
  const [confirm, C] = useState(false),
    [asking, A] = useState(false),
    [note, N] = useState("");
  const research = data.consent?.research === true;
  return (
    <Box cls="end">
      <h2>{t("بياناتي وخصوصيتي", "My data and privacy")}</h2>
      <label className="checklabel">
        <input
          type="checkbox"
          checked={research}
          onChange={async (e) => {
            try {
              await post(
                {
                  action: "consent",
                  platform: true,
                  research: e.target.checked,
                },
                lang,
              );
              await refresh();
              N(t("حُفظ اختيارك.", "Your choice was saved."));
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        />
        {t(
          "أوافق على استخدام بياناتي مجهولة الهوية في البحث",
          "I agree to the anonymized use of my data in research",
        )}
      </label>
      <div className="actions">
        <Button
          onClick={async () => {
            try {
              const mine = await request(
                "/api/course-end?mine=1",
                undefined,
                lang,
              );
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(mine, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "my-tilwa-data.json";
              a.click();
              URL.revokeObjectURL(url);
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          {t("نزّل بياناتي", "Download my data")}
        </Button>
        <Button onClick={() => A(true)}>
          {t("اطلب حذف بياناتي", "Request data deletion")}
        </Button>
      </div>
      {asking && (
        <div className="notice">
          <p>
            {research
              ? t(
                  "سيُحذف كل ما يرتبط بك: إجاباتك، إتقانك، محادثاتك مع المساعد وتفضيلاتك. لأنك وافقت على البحث، تبقى إجاباتك كصفوف مجهولة لا يمكن ربطها بك. لا يمكن التراجع.",
                  "Everything linked to you will be deleted: your answers, mastery, tutor conversations and preferences. Because you agreed to research, your answers remain as anonymous rows that cannot be linked to you. This cannot be undone.",
                )
              : t(
                  "سيُحذف كل شيء: إجاباتك، إتقانك، محادثاتك مع المساعد وتفضيلاتك. لن يبقى شيء. لا يمكن التراجع.",
                  "Everything will be deleted: your answers, mastery, tutor conversations and preferences. Nothing remains. This cannot be undone.",
                )}
          </p>
          <label className="checklabel">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => C(e.target.checked)}
            />
            {t("أفهم وأريد الحذف", "I understand and want my data deleted")}
          </label>
          <div className="actions">
            <Button
              primary
              disabled={!confirm}
              onClick={async () => {
                try {
                  const r = await post(
                    { action: "delete-my-data", confirm: true },
                    lang,
                  );
                  A(false);
                  C(false);
                  N(
                    t(
                      `حُذف ${r.deleted} سجلًّا.${r.anonymizedRowsKept ? ` بقي ${r.anonymizedRowsKept} صفًّا مجهولًا للبحث.` : ""}`,
                      `${r.deleted} records deleted.${r.anonymizedRowsKept ? ` ${r.anonymizedRowsKept} anonymous rows remain for research.` : ""}`,
                    ),
                  );
                  await refresh();
                } catch (err) {
                  onError((err as Error).message);
                }
              }}
            >
              {t("تأكيد الحذف", "Confirm deletion")}
            </Button>
            <Button onClick={() => A(false)}>{t("إلغاء", "Cancel")}</Button>
          </div>
        </div>
      )}
      {note && <p role="status">{note}</p>}
    </Box>
  );
}

const SURVEY: [string, string, string][] = [
  ["usefulness", "المنصة ساعدتني على التعلّم", "The platform helped me learn"],
  ["trust", "أثق في إجابات المساعد", "I trust the tutor's answers"],
  ["language", "اللغة كانت مناسبة لي", "The language suited me"],
  ["ease", "المنصة سهلة الاستخدام", "The platform was easy to use"],
  ["hints", "التلميحات كانت مفيدة", "The hints were useful"],
  [
    "map",
    "خريطة المهارات وصفت مستواي بدقة",
    "The skill map described my level accurately",
  ],
  ["pace", "استطعت التعلّم بسرعتي", "I could learn at my own pace"],
  ["recommend", "أنصح زملائي بها", "I would recommend it to classmates"],
];

/** ST19–ST21: post-test, survey and summary. */
export function CourseFinish({
  data,
  lang,
  t,
  perform,
  refresh,
  back,
  onError,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  perform: Perform;
  refresh: () => Promise<any>;
  back: () => void;
  onError: (s: string) => void;
}) {
  const end = data.courseEnd || {};
  const [test, T] = useState<any>(null),
    [index, I] = useState(0),
    [answer, A] = useState(""),
    [left, L] = useState(0),
    [ratings, R] = useState<Record<string, number>>({}),
    [comment, C] = useState("");
  const shownAt = useRef(0);
  const finish = async (items: any[]) => {
    try {
      await post(
        {
          action: "posttest-finish",
          deliveryIds: items.map((i) => i.deliveryId),
        },
        lang,
      );
      T(null);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!test) return;
    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        test.secondsAllowed - Math.round((Date.now() - test.startedAt) / 1000),
      );
      L(remaining);
      if (remaining === 0) void finish(test.items);
    }, 1000);
    return () => clearInterval(timer);
  }, [test]);
  if (test) {
    const current = test.items[index];
    const item = current.item.data;
    return (
      <>
        <div className="pageHead">
          <h1>{t("الاختبار البعدي", "Post-test")}</h1>
          <p role="timer">
            {t("الوقت المتبقي", "Time left")}: {Math.floor(left / 60)}:
            {String(left % 60).padStart(2, "0")} ·{" "}
            {t(
              `سؤال ${index + 1} من ${test.items.length}`,
              `Question ${index + 1} of ${test.items.length}`,
            )}
          </p>
        </div>
        <Box cls="practice">
          <h2 dir="auto">{localized(item.stem, lang)}</h2>
          <fieldset className="answer-options">
            <legend>{t("إجابتك", "Your answer")}</legend>
            {(item.options || []).map((o: any) => (
              <label key={o.id} className={answer === o.id ? "selected" : ""}>
                <input
                  type="radio"
                  name="posttest"
                  checked={answer === o.id}
                  onChange={() => A(o.id)}
                />
                <span dir="auto">{localized(o.label, lang)}</span>
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <Button
              primary
              disabled={!answer}
              onClick={async () => {
                await perform("attempt", {
                  deliveryId: current.deliveryId,
                  answer,
                  elapsedMs: Date.now() - shownAt.current,
                  idempotencyKey: crypto.randomUUID(),
                });
                A("");
                shownAt.current = Date.now();
                if (index + 1 >= test.items.length) await finish(test.items);
                else I(index + 1);
              }}
            >
              {index + 1 >= test.items.length
                ? t("سلّم الاختبار", "Submit")
                : t("التالي", "Next")}
            </Button>
          </div>
        </Box>
      </>
    );
  }
  const nodes: Node[] = (data.path?.nodes || []).filter(
    (n: Node) => n.objectiveId,
  );
  const ready = nodes.filter((n) => n.status === "secure");
  const weak = nodes.filter((n) => n.status !== "secure");
  const pre = (data.attempts || []).filter((a: any) => a.data.diagnostic);
  const preShare = pre.length
    ? Math.round(
        (100 * pre.filter((a: any) => a.data.correct === true).length) /
          pre.length,
      )
    : null;
  const postShare = end.postTest
    ? Math.round(
        (100 * end.postTest.correct) / Math.max(1, end.postTest.served),
      )
    : null;
  return (
    <>
      <div className="pageHead">
        <h1>{t("نهاية المقرر", "End of course")}</h1>
      </div>
      {!end.postTest && (
        <Box>
          <h2>{t("الاختبار البعدي", "Post-test")}</h2>
          <p>
            {t(
              "يساعدنا على قياس ما تعلّمته. مؤقَّت، وبلا تلميحات ولا مساعد أثناءه.",
              "This helps us measure how much you learned. It is timed, with no hints and no tutor during it.",
            )}
          </p>
          <Button
            primary
            onClick={async () => {
              try {
                const r = await post({ action: "posttest-start" }, lang);
                if (!r.items.length) return back();
                shownAt.current = Date.now();
                I(0);
                A("");
                L(r.secondsAllowed);
                T({ ...r, startedAt: Date.now() });
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            {t("ابدأ الاختبار البعدي", "Start the post-test")}
          </Button>
        </Box>
      )}
      {end.postTest && !end.surveyDone && (
        <Box>
          <h2>{t("رأيك في دقيقتين", "Your feedback, in two minutes")}</h2>
          <p>
            <small>
              {t(
                "١ = لا أوافق إطلاقًا، ٥ = أوافق تمامًا",
                "1 = strongly disagree, 5 = strongly agree",
              )}
            </small>
          </p>
          {SURVEY.map(([id, ar, en]) => (
            <div className="row" key={id}>
              <span>{t(ar, en)}</span>
              <span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} style={{ marginInlineStart: 8 }}>
                    <input
                      type="radio"
                      name={`survey-${id}`}
                      checked={ratings[id] === n}
                      onChange={() => R({ ...ratings, [id]: n })}
                      aria-label={`${t(ar, en)}: ${n}`}
                    />{" "}
                    {n}
                  </label>
                ))}
              </span>
            </div>
          ))}
          <label>
            {t("تعليق (اختياري)", "Comment (optional)")}
            <textarea
              dir="auto"
              value={comment}
              onChange={(e) => C(e.target.value)}
            />
          </label>
          <Button
            primary
            disabled={Object.keys(ratings).length < SURVEY.length}
            onClick={async () => {
              try {
                await post({ action: "survey", ratings, comment }, lang);
                await refresh();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            {t("إرسال", "Submit")}
          </Button>
        </Box>
      )}
      {end.postTest && end.surveyDone && (
        <Box>
          <h2>{t("ملخص ما تعلّمته", "Your summary")}</h2>
          <p>
            {t(
              `المفاهيم الجاهزة: ${ready.length} من ${nodes.length}.`,
              `Concepts ready: ${ready.length} of ${nodes.length}.`,
            )}
          </p>
          {ready.length > 0 && (
            <p>
              {t("أتقنت", "Mastered")}: {list(ready, lang)}
            </p>
          )}
          {weak.length > 0 && (
            <p>
              {t("ما زال يحتاج تدريبًا", "Still weak")}: {list(weak, lang)}
            </p>
          )}
          <p>
            {preShare !== null && postShare !== null
              ? t(
                  `من ${preShare}٪ في اختبار البداية إلى ${postShare}٪ في الاختبار البعدي.`,
                  `From ${preShare}% on the starting check to ${postShare}% on the post-test.`,
                )
              : postShare !== null
                ? t(
                    `الاختبار البعدي: ${postShare}٪.`,
                    `Post-test: ${postShare}%.`,
                  )
                : ""}
          </p>
          <p>{t("شكرًا لمشاركتك.", "Thank you for taking part.")}</p>
          <div className="actions">
            <Button primary onClick={back}>
              {t("واصل التدريب", "Keep practising")}
            </Button>
            <Button onClick={() => window.print()}>
              {t("نزّل الملخص", "Download summary")}
            </Button>
          </div>
        </Box>
      )}
    </>
  );
}

/** ST12: the course as nested layers — lectures, the concepts inside each, and what each
 * concept is built on. Never more than about thirty nodes at once. */
export function Roadmap({
  data,
  lang,
  t,
  learn,
}: {
  data: any;
  lang: Lang;
  t: Translate;
  learn: (objectiveId: string) => void;
}) {
  const nodes: Node[] = data.path?.nodes || [];
  const [concepts, C] = useState<any[]>([]),
    [cluster, CL] = useState<string | null>(null),
    [trail, TR] = useState<string[]>([]);
  useEffect(() => {
    request("/api/knowledge/map", undefined, lang)
      .then((m) => C(m.concepts || []))
      .catch(() => undefined);
  }, []);
  const struggling = new Set(
    (data.diagnoses || []).map((d: any) => d.data.objectiveId),
  );
  const state = (n: Node) =>
    n.status === "developing" && n.objectiveId && struggling.has(n.objectiveId)
      ? { label: t("يحتاج دعمًا", "At risk"), color: "#d9534f" }
      : statusInfo(n.status, t);
  const clusterOf = (n: Node) =>
    concepts.find((c) => c.id === n.conceptId)?.lectureEvidence?.[0]?.title ||
    t("معرفة مساندة", "Background knowledge");
  const clusters = [...new Set(nodes.map(clusterOf))];
  const here = data.path?.next?.conceptId;
  const current = trail.length
    ? nodes.find((n) => n.conceptId === trail.at(-1))
    : null;
  const inside = (n: Node) =>
    nodes.filter((x) =>
      n.blockedBy
        .concat(n.covered as any)
        .some((b) => b.conceptId === x.conceptId),
    );
  const dependsOn = (n: Node) => {
    const detail = concepts.find((c) => c.id === n.conceptId);
    return { detail, parts: inside(n) };
  };
  const Card = ({ n }: { n: Node }) => {
    const s = state(n);
    return (
      <button
        onClick={() => TR([...trail, n.conceptId])}
        style={{
          border: `2px solid ${s.color}`,
          borderRadius: 12,
          padding: "10px 14px",
          margin: 6,
          background: n.conceptId === here ? "#eef2ff" : "#fff",
          textAlign: "start",
          minWidth: 180,
          cursor: "pointer",
        }}
      >
        <strong>{localized(n.label, lang)}</strong>
        <br />
        <small>
          <Dot color={s.color} />
          {s.label}
          {n.conceptId === here && ` · ${t("أنت هنا", "You are here")}`}
        </small>
      </button>
    );
  };
  if (!nodes.length)
    return (
      <>
        <div className="pageHead">
          <h1>{t("خريطة المقرر", "Roadmap")}</h1>
        </div>
        <Box>
          <p>
            {t(
              "لم تُنشر مفاهيم لها أسئلة بعد.",
              "No concepts with questions have been published yet.",
            )}
          </p>
        </Box>
      </>
    );
  return (
    <>
      <div className="pageHead">
        <h1>{t("خريطة المقرر", "Roadmap")}</h1>
        <p>
          <button className="textbtn" onClick={() => (CL(null), TR([]))}>
            {t("المقرر كله", "Whole course")}
          </button>
          {cluster && (
            <>
              {" › "}
              <button className="textbtn" onClick={() => TR([])}>
                {cluster}
              </button>
            </>
          )}
          {trail.map((id, i) => (
            <span key={id + i}>
              {" › "}
              <button
                className="textbtn"
                onClick={() => TR(trail.slice(0, i + 1))}
              >
                {localized(nodes.find((n) => n.conceptId === id)?.label, lang)}
              </button>
            </span>
          ))}
        </p>
        <p>
          {["secure", "inferred", "developing", "unassessed"].map((s) => (
            <span key={s} style={{ marginInlineEnd: 14 }}>
              <Dot color={statusInfo(s, t).color} />
              <small>{statusInfo(s, t).label}</small>
            </span>
          ))}
          <span>
            <Dot color="#d9534f" />
            <small>{t("يحتاج دعمًا", "At risk")}</small>
          </span>
        </p>
      </div>
      {!cluster && !current && (
        <Box>
          <h2>{t("اختر جزءًا لتفتحه", "Pick a part to open it")}</h2>
          {clusters.map((name) => {
            const inCluster = nodes.filter((n) => clusterOf(n) === name);
            const ready = inCluster.filter((n) => n.status === "secure").length;
            return (
              <button
                key={name}
                onClick={() => CL(name)}
                style={{
                  border: "2px solid #c9cde0",
                  borderRadius: 14,
                  padding: "14px 18px",
                  margin: 6,
                  background: inCluster.some((n) => n.conceptId === here)
                    ? "#eef2ff"
                    : "#fff",
                  textAlign: "start",
                  minWidth: 220,
                  cursor: "pointer",
                }}
              >
                <strong>{name}</strong>
                <br />
                <small>
                  {t(
                    `${inCluster.length} مفهومًا · جاهز ${ready}`,
                    `${inCluster.length} concepts · ${ready} ready`,
                  )}
                  {inCluster.some((n) => n.conceptId === here) &&
                    ` · ${t("أنت هنا", "You are here")}`}
                </small>
              </button>
            );
          })}
        </Box>
      )}
      {cluster && !current && (
        <Box>
          <h2>{cluster}</h2>
          {nodes
            .filter((n) => clusterOf(n) === cluster)
            .slice(0, 30)
            .map((n) => (
              <Card key={n.conceptId} n={n} />
            ))}
        </Box>
      )}
      {current && (
        <Box>
          <h2>{localized(current.label, lang)}</h2>
          <p>
            <Dot color={state(current).color} />
            {state(current).label}
          </p>
          {dependsOn(current).detail?.summary && (
            <p>{localized(dependsOn(current).detail.summary, lang)}</p>
          )}
          {!current.objectiveId && (
            <p className="notice">
              {t(
                "هذه معرفة مساندة، ليست من أسئلة مقررك. موجودة هنا لأنها تساعد على ما بعدها.",
                "This is background knowledge, not part of your course questions. It is here because it helps with what builds on it.",
              )}
            </p>
          )}
          {current.blockedBy.length > 0 && (
            <p className="notice">
              {t(
                `هذا المفهوم يعتمد على ${list(current.blockedBy, lang)}، ولم تتقنه بعد. الأفضل أن تبدأ من هناك.`,
                `This concept builds on ${list(current.blockedBy, lang)}, which you haven't mastered yet. It is better to start there first.`,
              )}
            </p>
          )}
          {current.objectiveId && (
            <Button primary onClick={() => learn(current.objectiveId!)}>
              {t("تدرّب على هذا", "Practise this")}
            </Button>
          )}
          <h3>
            {t("ما بداخله: ما يعتمد عليه", "Inside it: what it builds on")}
          </h3>
          {dependsOn(current).parts.length === 0 ? (
            <p>
              {t(
                "لا يعتمد على مفاهيم أخرى منشورة: هذا من الأساسيات.",
                "It does not build on other published concepts: this is a foundation.",
              )}
            </p>
          ) : (
            dependsOn(current).parts.map((n) => (
              <Card key={n.conceptId} n={n} />
            ))
          )}
          {current.unlocks.length > 0 && (
            <p>
              <small>
                {t("يفتح لك بعده", "It unlocks")}: {list(current.unlocks, lang)}
              </small>
            </p>
          )}
        </Box>
      )}
    </>
  );
}

/** SYS2: is each part of the system up? */
export function StatusPage({
  lang,
  t,
  back,
}: {
  lang: Lang;
  t: Translate;
  back: () => void;
}) {
  const [status, S] = useState<any>(null),
    [failed, F] = useState(false);
  const check = () => {
    F(false);
    request("/api/status", undefined, lang)
      .then(S)
      .catch(() => F(true));
  };
  useEffect(check, []);
  const names: Record<string, string> = {
    login: t("الدخول", "Sign-in"),
    practice: t("التدريب", "Practice"),
    tutor: t("المساعد", "Tutor"),
    dashboards: t("اللوحات", "Dashboards"),
  };
  return (
    <>
      <div className="pageHead">
        <button className="textbtn" onClick={back}>
          {lang === "ar" ? "→" : "←"} {t("رجوع", "Back")}
        </button>
        <h1>{t("حالة النظام", "System status")}</h1>
      </div>
      <Box>
        {failed && (
          <p>
            {t(
              "تعذّر الوصول إلى الخادم. تحقق من اتصالك ثم أعد المحاولة.",
              "The server could not be reached. Check your connection and try again.",
            )}
          </p>
        )}
        {status &&
          Object.entries(status.subsystems).map(([k, up]) => (
            <div className="row" key={k}>
              <strong>{names[k] || k}</strong>
              <span>
                <Dot color={up ? "#2e9e6b" : "#d9534f"} />
                {up ? t("يعمل", "Working") : t("متوقف", "Down")}
              </span>
            </div>
          ))}
        {status && (
          <p>
            <small>
              {t("آخر فحص", "Last checked")}:{" "}
              {String(status.checkedAt).slice(0, 19).replace("T", " ")}
            </small>
          </p>
        )}
        <Button onClick={check}>{t("افحص مجددًا", "Check again")}</Button>
      </Box>
    </>
  );
}
