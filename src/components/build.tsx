"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Button, request, type Translate } from "./Workspace";
import { uploadLargePdf } from "./sources";
import { TreePreview } from "./KnowledgeTree";
import { HierarchicalKnowledgeMap } from "./HierarchicalKnowledgeMap";
import { ResetBox, type Catalog } from "./structure";

type Lang = "ar" | "en";
type Edge = {
  from: string;
  to: string;
  type: string;
  reason?: { ar: string; en: string };
};
type Concept = {
  id: string;
  label: { ar: string; en: string };
  scope?: string;
};
type Proposal = {
  id: string;
  title: string;
  graph: { concepts: Concept[]; edges: Edge[] };
};
type Step = { key: string; label: string };
const titleOf = (file: File) =>
  file.name.replace(/\.pdf$/i, "").trim() || file.name;
const edgeKey = (proposal: string, e: Edge) => `${proposal}|${e.from}|${e.to}`;

/** Would adding from -> to close a loop in the routing lines collected so far? */
function closesLoop(lines: Map<string, Set<string>>, from: string, to: string) {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === from) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return [...(lines.get(id) ?? [])].some(walk);
  };
  return walk(to);
}

/**
 * One place to build a course's knowledge tree: choose every lecture and the reference,
 * let the model read them all, look at the tree it produced, adjust it, and publish.
 */
export function BuildStudio({
  lang,
  t,
  onError,
  go,
  catalog,
  onActive,
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  go: (view: string) => void;
  catalog: Catalog | null;
  onActive: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<"pick" | "working" | "review" | "done">(
      "pick",
    ),
    [lectures, setLectures] = useState<File[]>([]),
    [references, setReferences] = useState<File[]>([]),
    [rights, setRights] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [hasReference, setHasReference] = useState(false),
    [steps, setSteps] = useState<Step[]>([]),
    [current, setCurrent] = useState(0),
    [detail, setDetail] = useState(""),
    [tip, setTip] = useState(0),
    [log, setLog] = useState<string[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [failed, setFailed] = useState<string[]>([]),
    [decisions, setDecisions] = useState<
      Record<string, { keep: boolean; type: string }>
    >({}),
    [published, setPublished] = useState<Edge[]>([]),
    [busy, setBusy] = useState(false),
    [treeVersion, setTreeVersion] = useState(0),
    [questionsBusy, setQuestionsBusy] = useState(false);
  const running = useRef(false);
  const [targetCourse, setTargetCourse] = useState("");
  const courseId = targetCourse || catalog?.current || "";
  const scopedRequest = (url: string, body?: any, locale: Lang = lang) => request(url, body, locale, courseId);
  useEffect(() => { onActive(phase === "working" || phase === "review" || questionsBusy); }, [phase, questionsBusy, onActive]);
  // The question run keeps one fixed place among the children so its progress survives
  // every change of the screen around it.
  const frame = (before: ReactNode, after: ReactNode, show: boolean) => (
    <>
      {questionsBusy ? null : before}
      <QuestionRun
        key={courseId}
        courseId={courseId}
        lang={lang}
        t={t}
        onError={onError}
        go={go}
        hidden={!show}
        version={treeVersion}
        onBusy={setQuestionsBusy}
      />
      {questionsBusy ? null : after}
    </>
  );
  useEffect(() => {
    setHasReference(false);
    if (!courseId) return;
    let cancelled = false;
    scopedRequest("/api/materials", undefined, lang)
      .then((m) => !cancelled &&
        setHasReference(
          (m.umbrellas ?? []).some((u: any) => u.sections?.approved > 0) ||
            (m.sharedUmbrellas ?? []).some((u: any) => u.approved > 0),
        ),
      )
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lang, courseId]);
  // A calm line that changes while the model works, so a long wait never looks stuck.
  const tips = [
    t(
      "النموذج يقرأ كل صفحة حتى لا تفوته معلومة. هذا عمل دقيق ويستحق وقته.",
      "The model reads every page so nothing is missed. Careful work takes a little time.",
    ),
    t(
      "كل علاقة ستُعرض عليك مع الصفحة التي استندت إليها، ولن يُنشر شيء قبل موافقتك.",
      "Every relationship will come with the page it rests on, and nothing is published before you approve.",
    ),
    t(
      "يمكنك ترك هذه الصفحة مفتوحة ومتابعة عملك؛ سنخبرك حين تجهز الشجرة.",
      "You can leave this tab open and carry on; the tree will be here when it is ready.",
    ),
    t(
      "عند ازدحام النموذج ننتظر ونعيد المحاولة تلقائيًّا بدل أن نتوقف.",
      "When the model is busy we wait and retry by ourselves instead of stopping.",
    ),
  ];
  useEffect(() => {
    if (phase !== "working") return;
    const timer = setInterval(() => setTip((n) => n + 1), 7000);
    return () => clearInterval(timer);
  }, [phase]);

  const run = async () => {
    if (running.current || !courseId) return;
    running.current = true;
    onError("");
    const plan: Step[] = [
      ...references.map((f, i) => ({
        key: "ref" + i,
        label: t(
          `قراءة المرجع: ${titleOf(f)}`,
          `Reading the reference: ${titleOf(f)}`,
        ),
      })),
      ...lectures.map((f, i) => ({
        key: "lec" + i,
        label: t(
          `قراءة المحاضرة: ${titleOf(f)}`,
          `Reading the lecture: ${titleOf(f)}`,
        ),
      })),
      ...lectures.map((f, i) => ({
        key: "ext" + i,
        label: t(
          `استخراج المفاهيم وما يسبقها: ${titleOf(f)}`,
          `Finding concepts and what precedes them: ${titleOf(f)}`,
        ),
      })),
    ];
    setSteps(plan);
    setCurrent(0);
    setProposals([]);
    setFailed([]);
    setLog([]);
    setPhase("working");
    let done = 0;
    const next = () => setCurrent(++done);
    // What the model is doing right now, in plain words, kept as a short running log.
    const say = (line: string) => {
      setDetail(line);
      setLog((all) => [...all.slice(-5), line]);
    };
    const describe = (step: {
      kind: string;
      part: number;
      of: number;
      about: string[];
    }) =>
      step.kind === "concepts"
        ? t(
            `يقرأ الصفحات ${step.about[0]}–${step.about[1]} ويستخرج ما تشرحه من مفاهيم (جزء ${step.part} من ${step.of})`,
            `Reading pages ${step.about[0]}–${step.about[1]} and listing the concepts they teach (part ${step.part} of ${step.of})`,
          )
        : step.kind === "links"
          ? t(
              `يبحث في المرجع عمّا يسبق: ${step.about.join("، ")} (مجموعة ${step.part} من ${step.of})`,
              `Searching the reference for what comes before: ${step.about.join(", ")} (group ${step.part} of ${step.of})`,
            )
          : t(
              `يراجع مرة ثانية ما لم يجد له سابقًا: ${step.about.join("، ")} (${step.part} من ${step.of})`,
              `Taking a second look at what had no prerequisite: ${step.about.join(", ")} (${step.part} of ${step.of})`,
            );
    const found: Proposal[] = [],
      problems: string[] = [];
    const upload = async (file: File, mode: "umbrella" | "lecture") => {
      const result = await uploadLargePdf(file, {
        mode,
        courseId,
        rejectDuplicate: true,
        title: titleOf(file),
        rights: rights || "Course reference provided by the instructor",
        confirmed: true,
        lang,
        progress: (n, total) =>
          setDetail(t(`صفحة ${n} من ${total}`, `Page ${n} of ${total}`)),
        slides: (n, total) =>
          setDetail(
            t(
              `النموذج يقرأ الشرائح المصوّرة: ${n} من ${total}`,
              `The model is reading picture slides: ${n} of ${total}`,
            ),
          ),
      });
      if (result.duplicates) problems.push(`${titleOf(file)}: ${t("تم تخطي الأجزاء المكررة", "Duplicate parts skipped")}`);
      // Readable pages are approved here so the whole flow is one step; the instructor
      // still reviews every relationship before anything reaches a student.
      for (const id of result.versionIds)
        await scopedRequest(
          `/api/materials/${id}`,
          { action: "approve-pending" },
          lang,
        );
      return result;
    };
    try {
      for (const file of references) {
        setDetail("");
        try { await upload(file, "umbrella"); } catch (e) { problems.push(`${titleOf(file)}: ${(e as Error).message}`); }
        next();
      }
      const keys: { file: File; keys: string[] }[] = [];
      for (const file of lectures) {
        setDetail("");
        try {
          keys.push({ file, keys: (await upload(file, "lecture")).sourceKeys });
        } catch (e) {
          problems.push(`${titleOf(file)}: ${(e as Error).message}`);
          keys.push({ file, keys: [] });
        }
        next();
      }
      for (const { file, keys: sourceKeys } of keys) {
        setDetail(
          t(
            "يأخذ النموذج وقته كاملًا هنا حتى لا تفوته علاقة؛ قد يستغرق عدة دقائق لكل محاضرة.",
            "The model takes all the time it needs here so no relationship is missed; this can take several minutes per lecture.",
          ),
        );
        for (const lectureSourceKey of sourceKeys) {
          // One model call per request: each answer is saved, so the run can take as
          // long as it needs, and a busy provider only means waiting, never starting over.
          let waits = 0;
          for (;;) {
            try {
              const r = await scopedRequest(
                "/api/knowledge",
                { action: "extract-step", lectureSourceKey },
                lang,
              );
              waits = 0;
              if (r.done) {
                found.push({
                  id: r.proposal.id,
                  title: titleOf(file),
                  graph: r.proposal.graph,
                });
                say(
                  t(
                    `اكتملت «${titleOf(file)}»: ${r.proposal.graph.concepts.length} مفهومًا و${r.proposal.graph.edges.length} علاقة.`,
                    `“${titleOf(file)}” is done: ${r.proposal.graph.concepts.length} concepts and ${r.proposal.graph.edges.length} relationships.`,
                  ),
                );
                break;
              }
              say(describe(r.next));
            } catch (e) {
              if (++waits > 12) {
                problems.push(`${titleOf(file)}: ${(e as Error).message}`);
                break;
              }
              setDetail(
                t(
                  "النموذج مزدحم الآن؛ ننتظر ثم نكمل من حيث توقفنا…",
                  "The model is busy right now; waiting, then carrying on from where we stopped…",
                ),
              );
              await new Promise((r) => setTimeout(r, 30000));
            }
          }
        }
        next();
      }
      const knowledge = await scopedRequest("/api/knowledge", undefined, lang).catch(
        () => null,
      );
      setPublished(knowledge?.releases?.[0]?.data?.graph?.edges ?? []);
      setProposals(found);
      setFailed(problems);
      setDecisions(
        Object.fromEntries(
          found.flatMap((p) =>
            p.graph.edges.map((e) => [
              edgeKey(p.id, e),
              { keep: true, type: e.type },
            ]),
          ),
        ),
      );
      setPhase(found.length ? "review" : "pick");
      if (!found.length)
        onError(
          problems.join(" · ") ||
            t("لم يُستخرج شيء.", "Nothing could be extracted."),
        );
    } catch (e) {
      onError((e as Error).message);
      setPhase("pick");
    } finally {
      running.current = false;
    }
  };

  // What will actually be published: the kept lines, minus any that would close a loop
  // with the lines already published or kept from an earlier lecture.
  const lines = new Map<string, Set<string>>();
  const link = (from: string, to: string) =>
    lines.set(from, (lines.get(from) ?? new Set()).add(to));
  for (const e of published) if (e.type === "prerequisite") link(e.from, e.to);
  const accepted = new Map<string, Edge[]>();
  const conflicts = new Set<string>();
  for (const p of proposals) {
    const list: Edge[] = [];
    for (const e of p.graph.edges) {
      const d = decisions[edgeKey(p.id, e)];
      if (!d?.keep) continue;
      if (d.type === "prerequisite") {
        if (closesLoop(lines, e.from, e.to)) {
          conflicts.add(edgeKey(p.id, e));
          continue;
        }
        link(e.from, e.to);
      }
      list.push({ ...e, type: d.type });
    }
    accepted.set(p.id, list);
  }
  const union = {
    concepts: [
      ...new Map(
        proposals.flatMap((p) => p.graph.concepts).map((c) => [c.id, c]),
      ).values(),
    ],
    edges: [
      ...new Map(
        [...accepted.values()].flat().map((e) => [`${e.from}|${e.to}`, e]),
      ).values(),
    ],
  };
  const name = (id: string) =>
    union.concepts.find((c) => c.id === id)?.label[lang] ?? id;

  const approve = async () => {
    setBusy(true);
    onError("");
    try {
      for (const p of proposals)
        await scopedRequest(
          "/api/knowledge",
          {
            action: "review-edges",
            id: p.id,
            accept: (accepted.get(p.id) ?? []).map((e) => ({
              from: e.from,
              to: e.to,
              type: e.type,
            })),
            rejectConcepts: [],
          },
          lang,
        );
      await scopedRequest("/api/knowledge", { action: "publish" }, lang);
      setTreeVersion((n) => n + 1);
      setPhase("done");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === "working") {
    const percent = steps.length
      ? Math.round((100 * current) / steps.length)
      : 0;
    return frame(
      null,
      <Box>
        <div className="working" role="status" aria-live="polite">
          <div className="working-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 0c1 6.5 5.5 11 12 12-6.5 1-11 5.5-12 12-1-6.5-5.5-11-12-12 6.5-1 11-5.5 12-12z"
                fill="#8b5cf6"
              />
            </svg>
          </div>
          <h2>
            {t("نبني شجرة المعرفة لمقررك", "Building your knowledge tree")}
          </h2>
          <p>{tips[tip % tips.length]}</p>
          <div
            className="working-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <i style={{ width: `${Math.max(4, percent)}%` }} />
          </div>
          <strong>
            {steps[current]?.label ??
              t("نجمع الشجرة…", "Putting the tree together…")}
          </strong>
          <small>
            {detail}
            {detail ? " · " : ""}
            {t(
              `الخطوة ${Math.min(current + 1, steps.length)} من ${steps.length}`,
              `Step ${Math.min(current + 1, steps.length)} of ${steps.length}`,
            )}
          </small>
          {log.length > 0 && (
            <ul
              className="working-log"
              aria-label={t("ما تمّ للتو", "Just done")}
            >
              {log.map((line, i) => (
                <li key={i} className={i === log.length - 1 ? "now" : ""}>
                  {line}
                </li>
              ))}
            </ul>
          )}
          <ul className="working-steps">
            {steps.map((s, i) => (
              <li
                key={s.key}
                className={i < current ? "done" : i === current ? "now" : ""}
              >
                <span aria-hidden="true">
                  {i < current ? "✓" : i === current ? "●" : "○"}
                </span>
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      </Box>,
      false,
    );
  }
  if (phase === "done")
    return frame(
      <div className="notice">
        {t(
          "نُشرت الشجرة. الخطوة التالية أسفل هذا السطر: توليد أسئلة لكل مفهوم.",
          "The tree is published. The next step is right below: drafting questions for every concept.",
        )}
      </div>,
      <>
        <div className="notice">
          {t(
            "نُشرت الشجرة. تراها الآن مع بقية مقررات التخصص؛ حرّك المفاهيم وارسم خطوطًا إضافية كما تشاء، وبدّل «اعرض» لرؤية هذا المقرر وحده أو الجامعة كلها.",
            "The tree is published. You now see it with the other courses of the major; move concepts and draw more lines as you like, and switch “Show” to see this course alone or the whole university.",
          )}{" "}
          <button
            className="textbtn"
            onClick={() => {
              setLectures([]);
              setReferences([]);
              setPhase("pick");
            }}
          >
            {t("ارفع محاضرات أخرى", "Upload more lectures")}
          </button>
        </div>
        <HierarchicalKnowledgeMap key={treeVersion} lang={lang} t={t} onError={onError} go={go} courseId={courseId} />
      </>,
      true,
    );
  if (phase === "review")
    return frame(
      null,
      <>
        <h1>{t("راجع الشجرة الناتجة", "Review the tree that was produced")}</h1>
        <p>
          {t(
            `هذه الشجرة الناتجة من ${proposals.length} محاضرة وحدها، قبل ضمّها إلى بقية التخصص. أزل أي علاقة لا توافق عليها أو غيّر نوعها، ثم اعتمد.`,
            `This is the tree produced from ${proposals.length} lecture(s) alone, before it joins the rest of the major. Remove any relationship you disagree with or change its type, then approve.`,
          )}
        </p>
        {failed.length > 0 && (
          <div className="error" role="alert">
            {t("تعذّر إكمال: ", "Could not finish: ")}
            {failed.join(" · ")}
          </div>
        )}
        <Box>
          <p>
            {t(
              `${union.concepts.length} مفهومًا · ${union.edges.length} علاقة ستُنشر`,
              `${union.concepts.length} concepts · ${union.edges.length} relationships will be published`,
            )}
          </p>
          <TreePreview
            concepts={union.concepts}
            edges={union.edges}
            lang={lang}
          />
        </Box>
        {proposals.map((p) => (
          <Box key={p.id}>
            <h2>{p.title}</h2>
            <p>
              {t(
                `${p.graph.concepts.length} مفهومًا، ${p.graph.edges.length} علاقة مقترحة`,
                `${p.graph.concepts.length} concepts, ${p.graph.edges.length} proposed relationships`,
              )}
            </p>
            {p.graph.edges.map((e) => {
              const key = edgeKey(p.id, e);
              const d = decisions[key] ?? { keep: true, type: e.type };
              return (
                <div
                  key={key}
                  className="row"
                  style={{ alignItems: "flex-start", gap: 12 }}
                >
                  <label className="checklabel">
                    <input
                      type="checkbox"
                      checked={d.keep}
                      onChange={(x) =>
                        setDecisions({
                          ...decisions,
                          [key]: { ...d, keep: x.target.checked },
                        })
                      }
                    />{" "}
                    <span>
                      <strong>
                        {name(e.from)} → {name(e.to)}
                      </strong>
                      <br />
                      <small>
                        {e.reason?.[lang]}
                        {conflicts.has(key)
                          ? " · " +
                            t(
                              "لن تُنشر: تصنع حلقة مع علاقة أخرى.",
                              "Will not be published: it loops with another relationship.",
                            )
                          : ""}
                      </small>
                    </span>
                  </label>
                  <select
                    aria-label={t("نوع العلاقة", "Relationship type")}
                    value={d.type}
                    disabled={!d.keep}
                    onChange={(x) =>
                      setDecisions({
                        ...decisions,
                        [key]: { ...d, type: x.target.value },
                      })
                    }
                  >
                    <option value="prerequisite">
                      {t("متطلب سابق", "Prerequisite")}
                    </option>
                    <option value="optional_bridge">
                      {t("خلفية اختيارية", "Optional background")}
                    </option>
                  </select>
                </div>
              );
            })}
            {!p.graph.edges.length && (
              <small>
                {t(
                  "لم يجد النموذج علاقات لهذه المحاضرة؛ يمكنك رسمها بنفسك بعد النشر.",
                  "The model found no relationships for this lecture; you can draw them yourself after publishing.",
                )}
              </small>
            )}
          </Box>
        ))}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button primary disabled={busy} onClick={() => void approve()}>
            {busy
              ? t("جارٍ النشر…", "Publishing…")
              : t("اعتمد وانشر الشجرة", "Approve and publish the tree")}
          </Button>
          <Button disabled={busy} onClick={() => setPhase("pick")}>
            {t("ارجع دون نشر", "Go back without publishing")}
          </Button>
        </div>
      </>,
      false,
    );
  const needsReference = !hasReference && !references.length;
  const blocked =
    !courseId || !lectures.length ||
    needsReference ||
    (references.length > 0 && (!confirmed || rights.trim().length < 5));
  const picker = (
    label: string,
    hint: string,
    files: File[],
    set: (files: File[]) => void,
  ) => (
    <label style={{ display: "block", marginBottom: 14 }}>
      <strong>{label}</strong>
      <br />
      <small>{hint}</small>
      <br />
      <input
        type="file"
        multiple
        accept="application/pdf,.pdf"
        onChange={(e) =>
          set([...files, ...[...(e.target.files ?? [])].filter((f) => /\.pdf$/i.test(f.name) && !files.some((old) => old.name === f.name && old.size === f.size && old.lastModified === f.lastModified))])
        }
      />
      {files.length > 0 && (
        <small style={{ display: "block", marginTop: 4 }}>
          {files.map((file, i) => <span key={`${file.name}-${i}`} style={{ display: "block" }}>{titleOf(file)}{" "}<button type="button" className="textbtn" onClick={() => set(files.filter((_, n) => n !== i))}>{t("إزالة", "Remove")}</button></span>)}
        </small>
      )}
    </label>
  );
  return frame(
    <>
      <h1>{t("ابنِ شجرة المعرفة", "Build the knowledge tree")}</h1>
      <p>
        {t(
          "خطوة واحدة: اختر كل محاضراتك ومرجع المقرر معًا، ونحن نقرؤها ونستخرج المفاهيم وما يسبق كل مفهوم، ثم نعرض عليك الشجرة لتراجعها وتعتمدها. بعدها نولّد أسئلة لكل مفهوم.",
          "One step: choose all your lectures and the course reference together. We read them, find the concepts and what precedes each one, then show you the tree to review and approve. After that we draft questions for every concept.",
        )}
      </p>
    </>,
    <>
      <Box>
        <label style={{ display: "block", marginBottom: 16 }}>
          <strong>{t("المقرر المستهدف", "Target course")}</strong><br />
          <select aria-label={t("المقرر المستهدف", "Target course")} value={courseId} onChange={(e) => { setTargetCourse(e.target.value); setHasReference(false); }}>
            <option value="" disabled>{t("اختر مقررًا", "Select course")}</option>
            {(catalog?.courses ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.title?.[lang]}</option>)}
          </select><br /><small>{t("كل الملفات في هذه الدفعة تخص هذا المقرر.", "All files in this batch are assigned to this course.")}</small>
        </label>
        {picker(
          t("المحاضرات (PDF)", "Lectures (PDF)"),
          t(
            "اختر كل ملفات المحاضرات دفعة واحدة. اسم كل ملف يصبح عنوان المحاضرة.",
            "Choose all lecture files at once. Each file's name becomes the lecture title.",
          ),
          lectures,
          setLectures,
        )}
        {picker(
          t("المرجع (PDF)", "Reference (PDF)"),
          hasReference
            ? t(
                "لهذا التخصص مرجع معتمد بالفعل، فهذا الحقل اختياري. أضف مرجعًا آخر إن أردت.",
                "This major already has an approved reference, so this is optional. Add another if you wish.",
              )
            : t(
                "كتاب المقرر أو مذكرة الأساسيات. يُرفع مرة واحدة ويخدم كل مقررات التخصص.",
                "The course textbook or a foundations handout. Uploaded once, it serves every course of the major.",
              ),
          references,
          setReferences,
        )}
        {references.length > 0 && (
          <>
            <label style={{ display: "block", marginBottom: 10 }}>
              {t(
                "مرجع التصريح باستخدام الكتاب",
                "Permission to use the reference",
              )}
              <input
                value={rights}
                maxLength={200}
                placeholder={t(
                  "مثال: كتاب المقرر المعتمد من القسم",
                  "For example: the department's adopted textbook",
                )}
                onChange={(e) => setRights(e.target.value)}
              />
            </label>
            <label className="checklabel">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              {t(
                "أؤكد أن لي تصريحًا باستخراج هذا المرجع وعرض مقاطعه وإرسالها إلى النموذج المعتمد.",
                "I confirm permission to extract this reference, display its passages and send them to the approved model.",
              )}
            </label>
          </>
        )}
        <div style={{ marginTop: 16 }}>
          <Button primary disabled={blocked} onClick={() => void run()}>
            {t("ارفع واستخرج الشجرة", "Upload and build the tree")}
          </Button>
          {needsReference && lectures.length > 0 && (
            <small style={{ display: "block", marginTop: 6 }}>
              {t(
                "أضف مرجعًا: العلاقات بين المفاهيم تُستخرج منه.",
                "Add a reference: relationships between concepts are taken from it.",
              )}
            </small>
          )}
        </div>
      </Box>
      <p>
        <small>
          {t(
            "الصفحات المقروءة تُعتمد تلقائيًّا في هذه الخطوة، ولا يصل شيء إلى الطلاب قبل أن تعتمد الشجرة. للتحكم التفصيلي استخدم الخطوات ١ و٢ من القائمة.",
            "Readable pages are approved automatically in this step, and nothing reaches students before you approve the tree. For fine control use steps 1 and 2 in the menu.",
          )}
        </small>
      </p>
      <ResetBox lang={lang} t={t} onError={onError} />
    </>,
    true,
  );
}

type Draft = {
  id: string;
  conceptId: string;
  concept: { ar: string; en: string };
  kind: string;
  difficulty: string;
  stem: { ar: string; en: string };
  steps?: { ar: string; en: string }[];
  options: { id: string; label: { ar: string; en: string } }[];
  answer: string;
  feedback: { ar: string; en: string };
  rubric: { ar: string; en: string };
  source: string;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Second half of the one-step page: draft questions for every published concept that has
 * none, show each draft with its answer, and publish the ones the instructor keeps.
 */
function QuestionRun({
  courseId,
  lang,
  t,
  onError,
  go,
  hidden,
  version,
  onBusy,
}: {
  courseId: string;
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  go: (view: string) => void;
  hidden: boolean;
  version: number;
  onBusy: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "review" | "done">(
      "idle",
    ),
    [missing, setMissing] = useState(0),
    [total, setTotal] = useState(0),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [dropped, setDropped] = useState<Record<string, boolean>>({}),
    [progress, setProgress] = useState({ done: 0, of: 0, written: 0 }),
    [now, setNow] = useState(""),
    [log, setLog] = useState<string[]>([]),
    [left, setLeft] = useState<string[]>([]),
    [publishedCount, setPublishedCount] = useState(0),
    [busy, setBusy] = useState(false);
  const running = useRef(false),
    stop = useRef(false);
  const show = (next: typeof phase) => {
    setPhase(next);
    onBusy(next === "working" || next === "review");
  };
  const scopedRequest = (url: string, body?: any, locale: Lang = lang) => request(url, body, locale, courseId);
  const load = async () => {
    const k = await scopedRequest("/api/knowledge", undefined, lang);
    const pending: Draft[] = (k.proposals ?? [])
      .map((p: any) => ({ id: p.id, d: p.data ?? p }))
      .filter(
        ({ d }: any) =>
          d.kind === "question-bank" && d.status === "pending" && d.item,
      )
      .map(({ id, d }: any) => ({
        id,
        conceptId: d.item.conceptId,
        concept: d.item.conceptLabel,
        kind: d.item.kind,
        difficulty: d.item.difficulty,
        stem: d.item.stem,
        steps: d.item.steps,
        options: d.item.options ?? [],
        answer: d.item.key,
        feedback: d.item.feedback,
        rubric: d.item.rubric,
        source: [d.item.sourceKey, d.item.locator].filter(Boolean).join(" · "),
      }));
    const own = (k.releases?.[0]?.data?.graph?.concepts ?? []).filter(
      (c: any) => !c.importedFrom,
    );
    const has = new Set([
      ...Object.keys(k.bank?.coverage ?? {}),
      ...pending.map((d) => d.conceptId),
    ]);
    setTotal(own.length);
    setMissing(own.filter((c: any) => !has.has(c.id)).length);
    setDrafts(pending);
    return pending;
  };
  useEffect(() => {
    if (running.current || !courseId) return;
    load().catch(() => {});
  }, [lang, version, courseId]);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    stop.current = false;
    onError("");
    setLog([]);
    setLeft([]);
    setNow("");
    setProgress({ done: 0, of: missing, written: 0 });
    show("working");
    const skip: string[] = [],
      retried = new Set<string>(),
      unanswered: string[] = [];
    let waits = 0,
      written = 0,
      of = missing;
    const say = (line: string) => setLog((all) => [...all.slice(-5), line]);
    try {
      while (!stop.current) {
        const r = await scopedRequest(
          "/api/knowledge",
          { action: "bank-step", data: { skip } },
          lang,
        );
        if (r.done) break;
        const label = r.concept.label[lang] ?? r.concept.label.en;
        if (r.wait) {
          if (++waits > 14)
            throw new Error(
              t(
                "النموذج مزدحم منذ مدة. ما كُتب حتى الآن محفوظ؛ أكمل لاحقًا من الزر نفسه.",
                "The model has been busy for a while. What was written is saved; carry on later with the same button.",
              ),
            );
          setNow(
            t(
              "النموذج مزدحم الآن؛ ننتظر ثم نكمل من حيث توقفنا…",
              "The model is busy right now; waiting, then carrying on from where we stopped…",
            ),
          );
          await pause(25000);
          continue;
        }
        waits = 0;
        if (r.skipped) {
          // A malformed answer gets one more try; a concept with no approved page is left.
          if (r.skipped === "invalid_output" && !retried.has(r.concept.id)) {
            retried.add(r.concept.id);
            continue;
          }
          skip.push(r.concept.id);
          unanswered.push(label);
          say(
            r.skipped === "insufficient_evidence"
              ? t(
                  `«${label}»: لا صفحات معتمدة كافية لكتابة سؤال.`,
                  `“${label}”: not enough approved pages to write a question.`,
                )
              : t(
                  `«${label}»: لم تصلح صياغة النموذج فتُرك.`,
                  `“${label}”: the model's draft was not usable, so it was left.`,
                ),
          );
        } else {
          written += r.created;
          say(
            t(
              `«${label}»: ${r.created} أسئلة.`,
              `“${label}”: ${r.created} questions.`,
            ),
          );
        }
        if (of < r.remaining + 1) of = r.remaining + 1;
        setProgress({
          done: Math.max(0, of - r.remaining),
          of,
          written,
        });
        setNow(
          t(
            `يكتب أسئلة المفهوم التالي… بقي ${r.remaining}`,
            `Writing questions for the next concept… ${r.remaining} left`,
          ),
        );
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      running.current = false;
      setLeft(unanswered);
      const pending = await load().catch(() => [] as Draft[]);
      setDropped({});
      show(pending.length ? "review" : "idle");
    }
  };

  const publish = async () => {
    setBusy(true);
    onError("");
    try {
      const approve = drafts.filter((d) => !dropped[d.id]).map((d) => d.id),
        reject = drafts.filter((d) => dropped[d.id]).map((d) => d.id);
      // In portions, so a large bank never rides on one long request.
      for (let i = 0; i < approve.length || i < reject.length; i += 60)
        await scopedRequest(
          "/api/knowledge",
          {
            action: "bank-review",
            data: {
              approve: approve.slice(i, i + 60),
              reject: reject.slice(i, i + 60),
            },
          },
          lang,
        );
      if (approve.length)
        await scopedRequest("/api/knowledge", { action: "publish" }, lang);
      setPublishedCount(approve.length);
      await load().catch(() => {});
      show("done");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (hidden && phase !== "working" && phase !== "review") return null;
  if (phase === "working") {
    const percent = progress.of
      ? Math.round((100 * progress.done) / progress.of)
      : 0;
    return (
      <Box>
        <div className="working" role="status" aria-live="polite">
          <div className="working-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 0c1 6.5 5.5 11 12 12-6.5 1-11 5.5-12 12-1-6.5-5.5-11-12-12 6.5-1 11-5.5 12-12z"
                fill="#8b5cf6"
              />
            </svg>
          </div>
          <h2>
            {t("نكتب أسئلة لكل مفهوم", "Writing questions for every concept")}
          </h2>
          <p>
            {t(
              "كل سؤال يُكتب من صفحات معتمدة في موادك، ومعه إجابته وتلميحان. لن يرى الطلاب شيئًا قبل أن تراجع وتعتمد.",
              "Each question is written from approved pages of your material, with its answer and two hints. Students see nothing before you review and approve.",
            )}
          </p>
          <div
            className="working-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <i style={{ width: `${Math.max(4, percent)}%` }} />
          </div>
          <strong>
            {t(
              `${progress.done} من ${progress.of} مفهومًا · ${progress.written} سؤالًا مكتوبًا`,
              `${progress.done} of ${progress.of} concepts · ${progress.written} questions written`,
            )}
          </strong>
          <small>{now}</small>
          {log.length > 0 && (
            <ul
              className="working-log"
              aria-label={t("ما تمّ للتو", "Just done")}
            >
              {log.map((line, i) => (
                <li key={i} className={i === log.length - 1 ? "now" : ""}>
                  {line}
                </li>
              ))}
            </ul>
          )}
          <Button
            onClick={() => {
              stop.current = true;
              setNow(
                t(
                  "سنتوقف بعد المفهوم الحالي ونعرض ما كُتب…",
                  "Stopping after the current concept and showing what was written…",
                ),
              );
            }}
          >
            {t("توقف واعرض ما كُتب", "Stop and show what was written")}
          </Button>
        </div>
      </Box>
    );
  }
  if (phase === "review") {
    const kindName: Record<string, string> = {
      choice: t("اختيار من متعدد", "Multiple choice"),
      critique: t("اكتشف الخطأ", "Find the error"),
      open: t("إجابة مفتوحة", "Open answer"),
      transfer: t("تطبيق في موقف جديد", "Applied to a new situation"),
    };
    const levelName: Record<string, string> = {
      easy: t("سهل", "Easy"),
      medium: t("متوسط", "Medium"),
      hard: t("صعب", "Hard"),
    };
    const groups = new Map<string, Draft[]>();
    for (const d of drafts)
      groups.set(d.conceptId, [...(groups.get(d.conceptId) ?? []), d]);
    const kept = drafts.filter((d) => !dropped[d.id]).length;
    return (
      <>
        <h1>{t("راجع الأسئلة المكتوبة", "Review the drafted questions")}</h1>
        <p>
          {t(
            `${drafts.length} سؤالًا لـ ${groups.size} مفهومًا. الإجابة الصحيحة معلَّمة تحت كل سؤال. أزل علامة أي سؤال لا تريده ثم اعتمد.`,
            `${drafts.length} questions for ${groups.size} concepts. The correct answer is marked under each question. Untick any question you do not want, then approve.`,
          )}
        </p>
        {left.length > 0 && (
          <div className="notice">
            {t(
              `مفاهيم بقيت بلا أسئلة (${left.length}): ${left.join("، ")}. اعتمد صفحات تشرحها ثم أعد التوليد.`,
              `Concepts left without questions (${left.length}): ${left.join(", ")}. Approve pages that explain them, then draft again.`,
            )}
          </div>
        )}
        {[...groups.entries()].map(([conceptId, list]) => (
          <Box key={conceptId}>
            <h2>{list[0].concept?.[lang] ?? conceptId}</h2>
            {list.map((d) => (
              <div key={d.id} style={{ marginBottom: 18 }}>
                <label className="checklabel">
                  <input
                    type="checkbox"
                    checked={!dropped[d.id]}
                    onChange={(x) =>
                      setDropped({ ...dropped, [d.id]: !x.target.checked })
                    }
                  />{" "}
                  <span>
                    <small>
                      {kindName[d.kind] ?? d.kind} ·{" "}
                      {levelName[d.difficulty] ?? d.difficulty}
                      {d.source ? ` · ${d.source}` : ""}
                    </small>
                    <br />
                    <strong dir="auto">{d.stem[lang]}</strong>
                  </span>
                </label>
                {d.kind === "critique" && d.steps && (
                  <ol dir="auto">
                    {d.steps.map((step, i) => (
                      <li key={i}>
                        {step[lang]}
                        {d.answer === `s${i + 1}` ||
                        d.options[i]?.id === d.answer
                          ? " ← " + t("الخطأ هنا", "the error is here")
                          : ""}
                      </li>
                    ))}
                  </ol>
                )}
                {d.kind !== "critique" && d.options.length > 0 && (
                  <ul
                    dir="auto"
                    style={{ listStyle: "none", paddingInline: 26 }}
                  >
                    {d.options.map((o) => (
                      <li key={o.id}>
                        {o.id === d.answer ? "✓ " : "○ "}
                        {o.id === d.answer ? (
                          <strong>{o.label[lang]}</strong>
                        ) : (
                          o.label[lang]
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <small
                  dir="auto"
                  style={{ display: "block", paddingInline: 26 }}
                >
                  {d.kind === "open"
                    ? t("الإجابة الكاملة تتضمن: ", "A full answer contains: ") +
                      d.rubric[lang]
                    : t("الشرح: ", "Explanation: ") + d.feedback[lang]}
                </small>
              </div>
            ))}
          </Box>
        ))}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button primary disabled={busy} onClick={() => void publish()}>
            {busy
              ? t("جارٍ النشر…", "Publishing…")
              : t(
                  `اعتمد وانشر ${kept} سؤالًا`,
                  `Approve and publish ${kept} questions`,
                )}
          </Button>
          <Button disabled={busy} onClick={() => show("idle")}>
            {t("أراجعها لاحقًا", "Review later")}
          </Button>
          <Button disabled={busy} onClick={() => go("bank")}>
            {t(
              "تعديل صياغة سؤال أو أسلوب الأسئلة",
              "Edit a question's wording or the question style",
            )}
          </Button>
        </div>
      </>
    );
  }
  if (!total) return null;
  return (
    <Box>
      <h2>{t("أسئلة المفاهيم", "Concept questions")}</h2>
      {phase === "done" && (
        <p className="notice">
          {t(
            `نُشر ${publishedCount} سؤالًا. صار الطلاب يُختبرون في هذه المفاهيم وتُحسب نتائجهم في مسارهم.`,
            `${publishedCount} questions were published. Students are now assessed on these concepts and the results count in their path.`,
          )}
        </p>
      )}
      <p>
        {missing > 0
          ? t(
              `${missing} من ${total} مفهومًا في هذا المقرر بلا أسئلة بعد. نكتب لكل مفهوم أسئلته من صفحاتك المعتمدة ثم نعرضها عليك قبل النشر.`,
              `${missing} of ${total} concepts in this course have no questions yet. We write each concept's questions from your approved pages and show them to you before publishing.`,
            )
          : t(
              `لكل مفاهيم المقرر (${total}) أسئلة.`,
              `Every concept of the course (${total}) has questions.`,
            )}
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {missing > 0 && (
          <Button primary onClick={() => void run()}>
            {t("ولّد أسئلة لكل المفاهيم", "Draft questions for every concept")}
          </Button>
        )}
        {drafts.length > 0 && (
          <Button
            primary={missing === 0}
            onClick={() => {
              setDropped({});
              show("review");
            }}
          >
            {t(
              `راجع ${drafts.length} سؤالًا ينتظر اعتمادك`,
              `Review ${drafts.length} questions awaiting your approval`,
            )}
          </Button>
        )}
      </div>
    </Box>
  );
}
