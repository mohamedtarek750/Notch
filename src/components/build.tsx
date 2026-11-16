"use client";
import { useEffect, useRef, useState } from "react";
import { Box, Button, request, type Translate } from "./Workspace";
import { uploadLargePdf } from "./sources";
import { KnowledgeTree, TreePreview } from "./KnowledgeTree";

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
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  go: (view: string) => void;
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
    [proposals, setProposals] = useState<Proposal[]>([]),
    [failed, setFailed] = useState<string[]>([]),
    [decisions, setDecisions] = useState<
      Record<string, { keep: boolean; type: string }>
    >({}),
    [published, setPublished] = useState<Edge[]>([]),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    request("/api/materials", undefined, lang)
      .then((m) =>
        setHasReference(
          (m.umbrellas ?? []).some((u: any) => u.sections?.approved > 0) ||
            (m.sharedUmbrellas ?? []).some((u: any) => u.approved > 0),
        ),
      )
      .catch(() => {});
  }, [lang]);
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
    if (running.current) return;
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
    setPhase("working");
    let done = 0;
    const next = () => setCurrent(++done);
    const found: Proposal[] = [],
      problems: string[] = [];
    const upload = async (file: File, mode: "umbrella" | "lecture") => {
      const result = await uploadLargePdf(file, {
        mode,
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
      // Readable pages are approved here so the whole flow is one step; the instructor
      // still reviews every relationship before anything reaches a student.
      for (const id of result.versionIds)
        await request(
          `/api/materials/${id}`,
          { action: "approve-pending" },
          lang,
        );
      return result;
    };
    try {
      for (const file of references) {
        setDetail("");
        await upload(file, "umbrella");
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
            "قد يستغرق هذا دقيقة أو أكثر لكل محاضرة.",
            "This can take a minute or more for each lecture.",
          ),
        );
        for (const lectureSourceKey of sourceKeys) {
          // The provider can be busy for a while: try again a few times before giving up.
          for (let attempt = 0; ; attempt++) {
            try {
              const proposal = await request(
                "/api/knowledge",
                { action: "extract-prerequisites", lectureSourceKey },
                lang,
              );
              found.push({
                id: proposal.id,
                title: titleOf(file),
                graph: proposal.graph,
              });
              break;
            } catch (e) {
              if (attempt >= 2) {
                problems.push(`${titleOf(file)}: ${(e as Error).message}`);
                break;
              }
              setDetail(
                t(
                  "النموذج مزدحم؛ ننتظر قليلًا ثم نعيد المحاولة…",
                  "The model is busy; waiting a moment before trying again…",
                ),
              );
              await new Promise((r) => setTimeout(r, 20000));
            }
          }
        }
        next();
      }
      const knowledge = await request("/api/knowledge", undefined, lang).catch(
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
        await request(
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
      await request("/api/knowledge", { action: "publish" }, lang);
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
      </Box>
    );
  }
  if (phase === "done")
    return (
      <>
        <div className="notice">
          {t(
            "نُشرت الشجرة. تراها الآن مع بقية مقررات التخصص؛ حرّك المفاهيم وارسم خطوطًا إضافية كما تشاء، وبدّل «اعرض» لرؤية هذا المقرر وحده أو الجامعة كلها.",
            "The tree is published. You now see it with the other courses of the major; move concepts and draw more lines as you like, and switch “Show” to see this course alone or the whole university.",
          )}{" "}
          <button className="textbtn" onClick={() => go("bank")}>
            {t("التالي: بنك الأسئلة", "Next: question bank")}
          </button>
        </div>
        <KnowledgeTree
          lang={lang}
          t={t}
          onError={onError}
          go={go}
          initialScope="major"
        />
      </>
    );
  if (phase === "review")
    return (
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
      </>
    );
  const needsReference = !hasReference && !references.length;
  const blocked =
    !lectures.length ||
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
          set([...(e.target.files ?? [])].filter((f) => /\.pdf$/i.test(f.name)))
        }
      />
      {files.length > 0 && (
        <small style={{ display: "block", marginTop: 4 }}>
          {files.map(titleOf).join(" · ")}
        </small>
      )}
    </label>
  );
  return (
    <>
      <h1>{t("ابنِ شجرة المعرفة", "Build the knowledge tree")}</h1>
      <p>
        {t(
          "خطوة واحدة: اختر كل محاضراتك ومرجع المقرر معًا، ونحن نقرؤها ونستخرج المفاهيم وما يسبق كل مفهوم، ثم نعرض عليك الشجرة لتراجعها وتعتمدها.",
          "One step: choose all your lectures and the course reference together. We read them, find the concepts and what precedes each one, then show you the tree to review and approve.",
        )}
      </p>
      <Box>
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
    </>
  );
}
