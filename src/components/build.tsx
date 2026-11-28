"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Button, request, type Translate } from "./Workspace";
import { KnowledgeBuildBatch } from "./KnowledgeBuildBatch";
import type { BuildJob } from "@/server/build-job-types";
import { TreePreview } from "./KnowledgeTree";
import { HierarchicalKnowledgeMap } from "./HierarchicalKnowledgeMap";
import { type Catalog } from "./structure";

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
  identityCandidates?: {id:string;label:{ar:string;en:string}}[];
  scope?: string;
};
type Proposal = {
  id: string;
  title: string;
  graph: { concepts: Concept[]; edges: Edge[] };
};
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
  destination,
  onActive, storageKey, onNotice,
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  go: (view: string) => void;
  catalog: Catalog | null;
  destination: {id:string} | null;
  storageKey: string; onNotice: (value: string) => void; onActive: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<"pick" | "working" | "review" | "done">(
      "pick",
    ),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [failed, setFailed] = useState<string[]>([]),
    [decisions, setDecisions] = useState<
      Record<string, { keep: boolean; type: string }>
    >({}),
    [published, setPublished] = useState<Edge[]>([]),
    [busy, setBusy] = useState(false),
    [treeVersion, setTreeVersion] = useState(0),
    [questionsBusy, setQuestionsBusy] = useState(false);
  const [resolutions, resolve] = useState<Record<string,string>>({});
  const [target, select] = useState("");
  const [recheckCourses, setRecheckCourses] = useState<string[]>([]);
  const openBuildCourse = (id: string) => {
    select(id);
    localStorage.setItem(storageKey,id);
    setPhase("pick");
  };
  const [uploading, setUploading] = useState(false);
  useEffect(() => { select(localStorage.getItem(storageKey) || ""); }, [storageKey]);
  useEffect(() => {
    if (!destination) return;
    select(destination.id);
    setPhase("pick");
    localStorage.setItem(storageKey, destination.id);
  }, [destination, storageKey]);
  const courseId = catalog?.courses.some(c => c.id === target) ? target : "";
  const scopedRequest = (url: string, body?: unknown, locale: Lang = lang) => request(url, body, locale, courseId);
  useEffect(() => { onActive(uploading || questionsBusy); return () => onActive(false); }, [uploading, questionsBusy, onActive]);  // The question run keeps one fixed place among the children so its progress survives
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
  const reviewJob = async (job: BuildJob) => {
    const knowledge = await scopedRequest("/api/knowledge");
    const docs = new Map(job.documents.map(d => [d.proposalId, d.title]));
    const found: Proposal[] = knowledge.proposals.filter((p: {id:string; data:{status:string}}) => docs.has(p.id) && p.data.status === "pending")
      .map((p: {id:string; data:{graph:Proposal["graph"]}}) => ({ id:p.id, title:docs.get(p.id)!, graph:p.data.graph }));
    if (!found.length) throw new Error(t("تمت مراجعة النتائج بالفعل.", "These results have already been reviewed."));
    resolve({});
    setProposals(found);
    setFailed([]);
    setPublished(knowledge.releases?.[0]?.data?.graph?.edges ?? []);
    setDecisions(Object.fromEntries(found.flatMap(p => p.graph.edges.map(e => [edgeKey(p.id,e), {keep:true,type:e.type}]))));
    setPhase("review");
  };  // What will actually be published: the kept lines, minus any that would close a loop
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
            resolutions: Object.fromEntries(p.graph.concepts.flatMap(c => resolutions[p.id+c.id] ? [[c.id,resolutions[p.id+c.id]]] : [])),
            rejectConcepts: [],
          },
          lang,
        );
      const release = await scopedRequest("/api/knowledge", { action: "publish" }, lang);
      setRecheckCourses(release.recheckCourses ?? []);
      setTreeVersion((n) => n + 1);
      setPhase("done");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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


              setPhase("pick");
            }}
          >
            {t("ارفع محاضرات أخرى", "Upload more lectures")}
          </button>
        </div>
        {!!recheckCourses.length && <div className="notice" role="status">
          {t("بدأ فحص العلاقات تلقائيًا في المقررات التالية. افتح سجل المقرر لمراجعة الاقتراحات.", "Automatic cross-course checks were queued. Open a course to review suggestions in its build history.")}
          <div className="row">{catalog?.courses.filter(c => recheckCourses.includes(c.id)).map(c => <Button key={c.id} onClick={() => openBuildCourse(c.id)}>{c.title[lang]}</Button>)}</div>
        </div>}
        <HierarchicalKnowledgeMap key={treeVersion} lang={lang} t={t} onError={onError} go={go} courseId={courseId} onRecheck={openBuildCourse} />
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
            {p.graph.concepts.filter(c=>c.identityCandidates?.length).map(c=><label key={c.id}>{c.label[lang]} · {t("تحقق من هوية المفهوم","Review concept identity")}
              <select value={resolutions[p.id+c.id] || ""} onChange={e=>resolve({...resolutions,[p.id+c.id]:e.target.value})}>
                <option value="">{t("مفهوم مستقل","Keep distinct")}</option>
                {c.identityCandidates?.map(k=><option key={k.id} value={k.id}>{k.label[lang]} · {k.label[lang==="ar"?"en":"ar"]}</option>)}
              </select></label>)}
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
                    {([["related","مرتبط بـ","Related to"],["is_a","نوع من","Is a"],["part_of","جزء من","Part of"],["used_in","يستخدم في","Used in"],["solves","يحلّ","Solves"]]).map(([v,ar,en]) => <option key={v} value={v}>{t(ar,en)}</option>)}
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
  return frame(<h1>{t("بناء نموذج المعرفة", "Build the knowledge model")}</h1>, <>
    <Box><label>{t("المقرر المستهدف", "Target course")}
      <select value={courseId} disabled={uploading || questionsBusy} onChange={e => { select(e.target.value); localStorage.setItem(storageKey,e.target.value); onNotice(""); }}>
        <option value="">{t("اختر مقررًا", "Select course")}</option>
        {catalog?.courses.map(c => <option key={c.id} value={c.id}>{c.code} · {c.title[lang]}</option>)}
      </select></label>
      <Button disabled={uploading || questionsBusy} onClick={() => go("structure")}>
        {t("إضافة مقرر", "Add a course")}
      </Button>
    </Box>
    {courseId && <KnowledgeBuildBatch key={courseId} courseId={courseId} lang={lang} t={t} onBusy={setUploading} onNotice={onNotice} onReview={reviewJob}/>}
  </>, Boolean(courseId));
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
