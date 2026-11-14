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
}: {
  data: any;
  lang: Lang;
  t: Translate;
  learn: (objectiveId: string) => void;
  startDiagnostic: () => void;
}) {
  const nodes: Node[] = data.path?.nodes || [];
  const next: Node | null = data.path?.next || null;
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
                disabled={explaining}
                onClick={() => explain(id)}
              >
                {t(ar, en)}
              </Button>
            ))}
          </div>
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
