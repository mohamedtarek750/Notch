"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  ListFilter,
  Network,
  Pencil,
  Search,
} from "lucide-react";
import type {
  KGDetail,
  KGKind,
  KGNode,
  KGRelation,
  KGView,
} from "@/lib/knowledge-graph";
import {
  GraphCanvas,
  initialCamera,
  nodeIcons,
  type Camera,
} from "./GraphCanvas";
import { GraphInspector } from "./GraphInspector";
import { kinds, levelNames, relationStyles } from "./graph-layout";
import { searchKey } from "./concept-map-model";
import { KnowledgeTree } from "./KnowledgeTree";
import { request, type Translate } from "./Workspace";
import "./knowledge-graph.css";

type Lang = "ar" | "en";
type Frame = {
  trail: KGNode[];
  selected?: KGNode;
  camera: Camera;
  cursor: number;
  query: string;
  relation: KGRelation | "";
  scope: "" | "direct" | "external";
};
const frameFor = (trail: KGNode[] = []): Frame => ({
  trail,
  selected: trail.at(-1),
  camera: initialCamera,
  cursor: 0,
  query: "",
  relation: "",
  scope: "",
});
const emptyView: KGView = { nodes: [], edges: [], nextCursor: null };
const paths = new Map<string, Frame>();
const frameKey = (trail: KGNode[]) =>
  JSON.stringify(trail.map((n) => [n.kind, n.id, n.courseId]));
const endpoint = "/api/knowledge/graph?";

function readNode(
  node: Pick<KGNode, "kind" | "id" | "courseId" | "lectureId">,
  lang: Lang,
  course?: string,
  lecture?: string,
): Promise<KGDetail> {
  const q = new URLSearchParams({ kind: node.kind, id: node.id });
  const courseId =
    course || node.courseId || (node.kind === "course" ? node.id : "");
  if (courseId) q.set("courseId", courseId);
  if (lecture || node.lectureId)
    q.set("lectureId", (lecture || node.lectureId)!);
  return request(endpoint + q, undefined, lang, courseId);
}

export function HierarchicalKnowledgeMap({
  lang,
  t,
  onError,
  go,
  courseId,
  contextKey,
  onRecheck,
}: {
  lang: Lang;
  t: Translate;
  onError: (message: string) => void;
  go: (view: string) => void;
  courseId?: string;
  contextKey?: string;
  onRecheck: (courseId: string) => void;
}) {
  const key = contextKey && JSON.stringify([contextKey, courseId || ""]);
  const [frame, setFrame] = useState<Frame>(
    () => (key && paths.get(key)) || frameFor(),
  );
  const [history, setHistory] = useState<Frame[]>([]);
  const prior = useRef(new Map<string, Frame>());
  const sequence = useRef(0);
  const [editor, setEditor] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<{
    key: string;
    data?: KGView;
    error?: string;
  }>({ key: "" });
  const [inspector, setInspector] = useState<{
    key: string;
    data?: KGDetail;
    error?: string;
  }>({ key: "" });
  const level = kinds[frame.trail.length] || "concept";
  const [major, course, lecture] = frame.trail;
  const selected = frame.selected;
  const scopeId = course?.id || courseId;
  const patch = (update: Partial<Frame>) =>
    setFrame((f) => ({ ...f, ...update }));

  useEffect(() => {
    if (!key) return;
    paths.set(key, frame);
    if (paths.size > 12) paths.delete(paths.keys().next().value!);
  }, [key, frame]);
  useEffect(() => {
    if (!courseId || (key && paths.get(key)?.trail.length)) return;
    const ticket = ++sequence.current;
    readNode({ kind: "course", id: courseId }, lang)
      .then((r) => {
        const parent = r.parents.find((n) => n.kind === "major");
        if (ticket === sequence.current && parent)
          setFrame(frameFor([parent, r.node]));
      })
      .catch((e) => ticket === sequence.current && onError(e.message));
    return () => {
      sequence.current++;
    };
    // Each instance opens at its supplied course; switching UI language retains its path.
  }, [courseId, key, onError]);

  const params = new URLSearchParams({ level, cursor: String(frame.cursor) });
  if (major) params.set("majorId", major.id);
  if (course) params.set("courseId", course.id);
  if (lecture) params.set("lectureId", lecture.id);
  const pageUrl = endpoint + params;
  const pageKey = [pageUrl, lang, scopeId, version].join("|");
  useEffect(() => {
    let active = true;
    request(pageUrl, undefined, lang, scopeId)
      .then((data) => active && setPage({ key: pageKey, data }))
      .catch((e) => active && setPage({ key: pageKey, error: e.message }));
    return () => {
      active = false;
    };
  }, [pageKey, pageUrl, scopeId, lang]);
  const detailKey = JSON.stringify([
    selected?.kind,
    selected?.id,
    scopeId,
    lecture?.id,
    lang,
    version,
  ]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    readNode(
      selected,
      lang,
      selected.kind === "concept" ? scopeId : selected.courseId,
      lecture?.id,
    )
      .then((data) => active && setInspector({ key: detailKey, data }))
      .catch(
        (e) => active && setInspector({ key: detailKey, error: e.message }),
      );
    return () => {
      active = false;
    };
  }, [selected, detailKey, scopeId, lecture?.id, lang]);
  const data = page.key === pageKey && page.data ? page.data : emptyView;
  const detail = inspector.key === detailKey ? (inspector.data ?? null) : null;
  const shown = useMemo(() => {
    const query = searchKey(frame.query);
    const filteredEdges = data.edges.filter(
      (e) => !frame.relation || e.type === frame.relation,
    );
    const endpoints = new Set(filteredEdges.flatMap((e) => [e.from, e.to]));
    const children = data.nodes.filter(
      (n) =>
        n.kind === level &&
        (!frame.scope ||
          (frame.scope === "external") === Boolean(n.external)) &&
        (!frame.relation || endpoints.has(n.id)) &&
        (!query ||
          searchKey([n.label.en, n.label.ar, n.code].join(" ")).includes(
            query,
          )),
    );
    const nodes =
      children.length || (!frame.scope && !query && !frame.relation)
        ? [...data.nodes.filter((n) => n.kind !== level), ...children]
        : [];
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: filteredEdges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      nextCursor: data.nextCursor,
    };
  }, [data, level, frame.query, frame.relation, frame.scope]);

  function navigate(trail: KGNode[]) {
    const target = frameKey(trail);
    sequence.current++;
    if (target === frameKey(frame.trail)) {
      patch({ selected: trail.at(-1) });
      return;
    }
    prior.current.set(frameKey(frame.trail), frame);
    setHistory((h) => [...h.slice(-29), frame]);
    setFrame(prior.current.get(target) ?? frameFor(trail));
  }
  // Reconstruct the academic path when following a relationship outside this lecture.
  async function openNode(node: KGNode) {
    const token = ++sequence.current;
    if (node.kind === "concept") {
      patch({ selected: node });
      return;
    }
    const index = kinds.indexOf(node.kind);
    const current = frame.trail[index];
    if (current?.id === node.id && current.courseId === node.courseId) {
      navigate(frame.trail.slice(0, index + 1));
      return;
    }
    if (node.kind === "major") {
      navigate([node]);
      return;
    }
    if (
      node.kind === level &&
      (!node.majorId || node.majorId === major?.id) &&
      (node.kind === "course" || node.courseId === course?.id)
    ) {
      navigate([...frame.trail, node]);
      return;
    }
    try {
      const originCourse =
        node.kind === "course"
          ? node
          : (await readNode({ kind: "course", id: node.courseId! }, lang)).node;
      const origin = await readNode(originCourse, lang);
      const parent = origin.parents.find((n) => n.kind === "major");
      if (parent && token === sequence.current)
        navigate(
          node.kind === "course"
            ? [parent, origin.node]
            : [parent, origin.node, node],
        );
    } catch (e) {
      if (token === sequence.current) onError((e as Error).message);
    }
  }
  const onCanvasSelect = (n: KGNode) =>
    n.kind !== level && n.kind !== "concept"
      ? navigate(frame.trail.slice(0, -1))
      : void openNode(n);
  const back = () => {
    if (!history.length) return;
    sequence.current++;
    prior.current.set(frameKey(frame.trail), frame);
    setFrame(history.at(-1)!);
    setHistory(history.slice(0, -1));
  };
  if (editor)
    return (
      <>
        <button
          className="kg-action"
          onClick={() => {
            setVersion((v) => v + 1);
            setEditor(false);
          }}
        >
          <ArrowLeft size={16} />
          {t("العودة إلى الرسم", "Back to graph")}
        </button>
        <KnowledgeTree
          lang={lang}
          t={t}
          onError={onError}
          go={go}
          courseId={scopeId}
          initialScope="course"
        />
      </>
    );

  const loading = page.key !== pageKey;
  const levelTitle = t(levelNames[level][0], levelNames[level][1]);
  const error = page.key === pageKey ? page.error : "";
  const zeroChildren =
    !loading && !error && !data.nodes.some((n) => n.kind === level);
  return (
    <section className="kg" dir={lang === "ar" ? "rtl" : "ltr"}>
      <header className="kg-heading">
        <div>
          <span className="kg-heading-icon">
            <Network size={23} />
          </span>
          <h1>{t("خريطة المعرفة", "Knowledge graph")}</h1>
        </div>
        <button className="kg-action" onClick={() => setEditor(true)}>
          <Pencil size={15} />
          {t("محرر العلاقات", "Relationship editor")}
        </button>
      </header>
      <nav
        className="kg-crumbs"
        aria-label={t("مسار الرسم", "Graph breadcrumb")}
      >
        <button onClick={() => navigate([])}>
          {t("الجامعة", "University")}
        </button>
        {frame.trail.map((n, i) => (
          <span key={n.kind}>
            <ChevronRight size={13} />
            <button onClick={() => navigate(frame.trail.slice(0, i + 1))}>
              {n.label[lang] || n.label.en}
            </button>
          </span>
        ))}
      </nav>
      <div className="kg-main">
        <div className="kg-map">
          <nav
            className="kg-levels"
            aria-label={t("مستويات الرسم", "Graph levels")}
          >
            {kinds.map((kind, i) => {
              const Icon = nodeIcons[kind];
              return (
                <button
                  key={kind}
                  aria-current={kind === level ? "step" : undefined}
                  disabled={i > frame.trail.length}
                  onClick={() => navigate(frame.trail.slice(0, i))}
                >
                  <Icon size={16} />
                  {t(levelNames[kind][0], levelNames[kind][1])}
                </button>
              );
            })}
          </nav>
          <div className="kg-tools">
            <label className="kg-search">
              <Search size={16} />
              <input
                type="search"
                aria-label={t("بحث في العرض", "Search this view")}
                placeholder={t("بحث في العرض", "Search this view")}
                value={frame.query}
                onChange={(e) => patch({ query: e.target.value })}
              />
            </label>
            <label className="kg-filter">
              <ListFilter size={15} />
              <select
                aria-label={t("نوع العلاقة", "Relationship filter")}
                value={frame.relation}
                onChange={(e) =>
                  patch({ relation: e.target.value as Frame["relation"] })
                }
              >
                <option value="">{t("كل العلاقات", "All connections")}</option>
                {Object.entries(relationStyles).map(([type, style]) => (
                  <option key={type} value={type}>
                    {t(style.label[0], style.label[1])}
                  </option>
                ))}
              </select>
            </label>
            {level === "concept" && (
              <select
                className="kg-scope"
                aria-label={t("نطاق المفهوم", "Concept scope")}
                value={frame.scope}
                onChange={(e) =>
                  patch({ scope: e.target.value as Frame["scope"] })
                }
              >
                <option value="">{t("كل المفاهيم", "All concepts")}</option>
                <option value="direct">{t("مباشر", "Direct")}</option>
                <option value="external">{t("خارجي", "External")}</option>
              </select>
            )}
          </div>
          <div className="kg-canvas-bar">
            <strong>{levelTitle}</strong>
            <span>{shown.nodes.filter((n) => n.kind === level).length}</span>
            {history.length > 0 && (
              <button className="kg-back" onClick={back}>
                <ArrowLeft size={14} />
                {t("رجوع", "Back")}
              </button>
            )}
          </div>
          <GraphCanvas
            data={shown}
            lang={lang}
            t={t}
            level={level}
            chosen={selected?.id}
            onSelect={onCanvasSelect}
            camera={frame.camera}
            onCamera={(camera) => patch({ camera })}
            empty={t("لا توجد نتائج في هذا العرض.", "No matches in this view.")}
            status={
              error ||
              (loading
                ? t("جارٍ تحميل الرسم…", "Loading graph…")
                : zeroChildren
                  ? t(
                      "لا توجد عناصر منشورة في هذا المستوى.",
                      "No published nodes at this level.",
                    )
                  : undefined)
            }
          />
          {error && (
            <button
              className="kg-action"
              onClick={() => setVersion((v) => v + 1)}
            >
              {t("إعادة المحاولة", "Retry")}
            </button>
          )}
          {(frame.cursor > 0 || data.nextCursor !== null) && (
            <div className="kg-pagination">
              {frame.cursor > 0 && (
                <button
                  onClick={() =>
                    patch({
                      cursor: Math.max(0, frame.cursor - 30),
                      camera: initialCamera,
                    })
                  }
                >
                  {t("الصفحة السابقة", "Previous page")}
                </button>
              )}
              {data.nextCursor !== null && (
                <button
                  onClick={() =>
                    patch({ cursor: data.nextCursor!, camera: initialCamera })
                  }
                >
                  {t("الصفحة التالية", "Next page")}
                </button>
              )}
            </div>
          )}
          <div className="kg-legend">
            <h3>{t("دليل العلاقات", "Connection legend")}</h3>
            <div>
              {Object.entries(relationStyles).map(([name, style]) => (
                <span key={name}>
                  <svg width="24" height="10" aria-hidden="true">
                    <path
                      d="M1 5 H20"
                      stroke={style.color}
                      strokeWidth="2"
                      strokeDasharray={style.dash}
                    />
                    <path d="m17 2 6 3-6 3z" fill={style.color} />
                  </svg>
                  {t(style.label[0], style.label[1])}
                </span>
              ))}
            </div>
          </div>
        </div>
        <GraphInspector
          node={selected}
          detail={detail}
          lang={lang}
          t={t}
          open={(n) => void openNode(n)}
          rechecking={rechecking}
          recheck={async () => {
            if (
              selected?.kind !== "lecture" ||
              !selected.courseId ||
              rechecking
            )
              return;
            setRechecking(true);
            onError("");
            try {
              await request(
                "/api/knowledge/jobs",
                { action: "recheck-lecture", lectureId: selected.id },
                lang,
                selected.courseId,
              );
              onRecheck(selected.courseId);
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setRechecking(false);
            }
          }}
          status={
            selected && !detail
              ? (inspector.key === detailKey && inspector.error) ||
                t("جارٍ تحميل التفاصيل…", "Loading details…")
              : ""
          }
        />
      </div>
    </section>
  );
}
