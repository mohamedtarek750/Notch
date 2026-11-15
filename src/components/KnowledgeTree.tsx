"use client";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Box, Button, request, type Translate } from "./Workspace";

type Lang = "ar" | "en";
type Concept = {
  id: string;
  label: { ar: string; en: string };
  scope?: string;
};
type Edge = {
  from: string;
  to: string;
  type: string;
  reason?: { ar: string; en: string };
  origin?: string;
};
type Point = { x: number; y: number };
const W = 190,
  H = 46,
  COL = 270,
  ROW = 62,
  PAD = 24,
  MODEL = "#4b4f8a",
  MINE = "#b45309";

/** Starting place of each concept: one column further than the deepest concept before it. */
function arrange(concepts: Concept[], edges: Edge[], lang: Lang) {
  const depth = new Map(concepts.map((c) => [c.id, 0]));
  for (let round = 0; round < concepts.length; round++) {
    let moved = false;
    for (const e of edges) {
      const next = (depth.get(e.from) ?? 0) + 1;
      if (
        depth.has(e.to) &&
        (depth.get(e.to) ?? 0) < next &&
        next < concepts.length
      ) {
        depth.set(e.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const columns: Concept[][] = [];
  for (const c of concepts) (columns[depth.get(c.id) ?? 0] ??= []).push(c);
  const at: Record<string, Point> = {};
  columns.forEach((column, x) => {
    // Connected concepts sit at the top so their lines stay short.
    column.sort(
      (a, b) =>
        Number(linked.has(b.id)) - Number(linked.has(a.id)) ||
        a.label[lang].localeCompare(b.label[lang]),
    );
    column.forEach(
      (c, y) => (at[c.id] = { x: PAD + x * COL, y: PAD + y * ROW }),
    );
  });
  return at;
}
/** A line leaves and enters on the sides that face each other, wherever the boxes are. */
function route(a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  if (Math.abs(dx) >= W * 0.6) {
    const forward = dx > 0,
      x1 = a.x + (forward ? W : 0),
      x2 = b.x + (forward ? 0 : W),
      y1 = a.y + H / 2,
      y2 = b.y + H / 2,
      bend = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
    return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const down = dy > 0,
    x1 = a.x + W / 2,
    x2 = b.x + W / 2,
    y1 = a.y + (down ? H : 0),
    y2 = b.y + (down ? 0 : H),
    bend = Math.max(20, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}

const Line = memo(function Line({
  edge,
  a,
  b,
  chosen,
  label,
  onChoose,
}: {
  edge: Edge;
  a: Point;
  b: Point;
  chosen: boolean;
  label: string;
  onChoose: (key: string) => void;
}) {
  const d = route(a, b),
    colour = edge.origin === "instructor" ? MINE : MODEL,
    key = `${edge.from}|${edge.to}`;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={colour}
        strokeWidth={chosen ? 3.5 : 1.6}
        strokeDasharray={edge.type === "prerequisite" ? undefined : "5 5"}
        markerEnd={`url(#tip${colour.slice(1)})`}
      />
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: "pointer" }}
        role="button"
        tabIndex={0}
        aria-label={label}
        data-line={key}
        onKeyDown={(k) => k.key === "Enter" && onChoose(key)}
      />
    </g>
  );
});
const Card = memo(function Card({
  concept,
  at,
  active,
  target,
  lang,
}: {
  concept: Concept;
  at: Point;
  active: boolean;
  target: boolean;
  lang: Lang;
}) {
  return (
    <g
      transform={`translate(${at.x} ${at.y})`}
      data-node={concept.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={concept.label[lang]}
      style={{ cursor: "grab", outline: "none" }}
    >
      <rect
        width={W}
        height={H}
        rx={9}
        fill={
          active || target
            ? "#fde9c8"
            : concept.scope === "foundation"
              ? "#eef0f6"
              : "#ffffff"
        }
        stroke={active || target ? MINE : MODEL}
        strokeWidth={active || target ? 2.5 : 1.2}
      />
      <foreignObject width={W} height={H} pointerEvents="none">
        <div
          dir={lang === "ar" ? "rtl" : "ltr"}
          style={{
            height: H,
            padding: "0 14px 0 8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            font: "600 12px/1.25 Arial, 'Tilwa Arabic', sans-serif",
            color: "#20233c",
            overflow: "hidden",
            userSelect: "none",
          }}
        >
          {concept.label[lang]}
        </div>
      </foreignObject>
      {/* Pull from this dot to draw a line to another concept. */}
      <circle
        cx={W}
        cy={H / 2}
        r={7}
        fill={MINE}
        stroke="#fff"
        strokeWidth={2}
        data-port={concept.id}
        style={{ cursor: "crosshair" }}
      />
    </g>
  );
});

type Gesture =
  | { kind: "move"; id: string; dx: number; dy: number; moved: boolean }
  | { kind: "link"; from: string; x: number; y: number; over: string }
  | { kind: "pan"; x: number; y: number; ox: number; oy: number };

export function KnowledgeTree({
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
  const [graph, setGraph] = useState<{
      concepts: Concept[];
      edges: Edge[];
    } | null>(null),
    [places, setPlaces] = useState<Record<string, Point>>({}),
    [view, setView] = useState({ x: 0, y: 0, k: 1 }),
    [loaded, setLoaded] = useState(false),
    [pending, setPending] = useState(0),
    [busy, setBusy] = useState(false),
    [picked, setPicked] = useState(""),
    [gesture, setGesture] = useState<Gesture | null>(null),
    [chosen, setChosen] = useState(""),
    [kind, setKind] = useState("prerequisite"),
    [first, setFirst] = useState(""),
    [then, setThen] = useState(""),
    [note, setNote] = useState("");
  const svg = useRef<SVGSVGElement>(null),
    frame = useRef(0),
    live = useRef<Gesture | null>(null),
    saved = useRef<Record<string, Point>>({});
  const concepts = useMemo(() => graph?.concepts ?? [], [graph]);
  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const load = useCallback(async () => {
    try {
      const k = await request("/api/knowledge", undefined, lang);
      saved.current = k.layout ?? {};
      setGraph(k.releases?.[0]?.data?.graph ?? null);
      setPending(
        (k.proposals ?? []).filter(
          (p: any) =>
            p.data?.graph &&
            (p.data.status === "pending" || p.data.status === "approved"),
        ).length,
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [lang, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  // Keep every place the instructor chose; only new concepts get an automatic place.
  useEffect(() => {
    if (!concepts.length) return;
    const auto = arrange(concepts, edges, lang);
    setPlaces((current) => {
      const next: Record<string, Point> = {};
      const taken = Object.values({ ...saved.current, ...current });
      const floor = taken.length ? Math.max(...taken.map((p) => p.y)) + ROW : 0;
      for (const c of concepts)
        next[c.id] = current[c.id] ??
          saved.current[c.id] ?? {
            x: auto[c.id].x,
            y: auto[c.id].y + (taken.length ? floor : 0),
          };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [concepts]);
  const name = (id: string) =>
    concepts.find((c) => c.id === id)?.label[lang] ?? id;
  const store = (positions: Record<string, Point>) => {
    saved.current = positions;
    request(
      "/api/knowledge",
      { action: "tree-layout", data: { positions } },
      lang,
    ).catch((e) => onError((e as Error).message));
  };
  const edit = async (
    op: "add" | "remove" | "retype",
    from: string,
    to: string,
    type = kind,
  ) => {
    if (busy || !from || !to || from === to) return;
    setBusy(true);
    onError("");
    try {
      const result = await request(
        "/api/knowledge",
        { action: "tree-edit", data: { op, from, to, type } },
        lang,
      );
      setGraph(result.graph);
      setChosen(op === "remove" ? "" : `${from}|${to}`);
      setNote(
        op === "add"
          ? t(
              `أُضيف الخط: «${name(from)}» قبل «${name(to)}». مسار الطلاب تحدّث.`,
              `Line added: “${name(from)}” before “${name(to)}”. The student path is updated.`,
            )
          : op === "remove"
            ? t("حُذف الخط.", "Line removed.")
            : t("تغيّر نوع الخط.", "Line type changed."),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setPicked("");
    }
  };
  const world = (e: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    return {
      x: (e.clientX - box.left - view.x) / view.k,
      y: (e.clientY - box.top - view.y) / view.k,
    };
  };
  const under = (e: { clientX: number; clientY: number }, attribute: string) =>
    (
      document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest(`[${attribute}]`) as HTMLElement | null
    )?.getAttribute(attribute) ?? "";
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const port = under(e, "data-port"),
      node = under(e, "data-node"),
      p = world(e);
    svg.current!.setPointerCapture(e.pointerId);
    const next: Gesture = port
      ? { kind: "link", from: port, x: p.x, y: p.y, over: "" }
      : node
        ? {
            kind: "move",
            id: node,
            dx: p.x - places[node].x,
            dy: p.y - places[node].y,
            moved: false,
          }
        : { kind: "pan", x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    live.current = next;
    setGesture(next);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = live.current;
    if (!g) return;
    const point = { clientX: e.clientX, clientY: e.clientY };
    // One update per frame keeps dragging smooth on a slow machine.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (g.kind === "pan")
        setView((v) => ({
          ...v,
          x: g.ox + point.clientX - g.x,
          y: g.oy + point.clientY - g.y,
        }));
      else if (g.kind === "move") {
        const p = world(point);
        g.moved = true;
        setPlaces((all) => ({
          ...all,
          [g.id]: { x: p.x - g.dx, y: p.y - g.dy },
        }));
      } else {
        const p = world(point);
        const over = under(point, "data-node");
        const next = {
          ...g,
          x: p.x,
          y: p.y,
          over: over === g.from ? "" : over,
        };
        live.current = next;
        setGesture(next);
      }
    });
  };
  const up = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = live.current;
    live.current = null;
    setGesture(null);
    cancelAnimationFrame(frame.current);
    if (!g) return;
    if (g.kind === "link") {
      const to = under(e, "data-node");
      if (to && to !== g.from) void edit("add", g.from, to);
    } else if (g.kind === "move") {
      if (g.moved) {
        const p = world(e);
        const next = { ...places, [g.id]: { x: p.x - g.dx, y: p.y - g.dy } };
        setPlaces(next);
        store(next);
      } else if (picked && picked !== g.id) void edit("add", picked, g.id);
      else setPicked(picked === g.id ? "" : g.id);
    } else if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 4) {
      // A plain press on a line selects it; on empty space it clears the selection.
      const line = under(e, "data-line");
      setChosen(line && line !== chosen ? line : "");
      setPicked("");
    }
  };
  const zoom = (factor: number) =>
    setView((v) => {
      const box = svg.current?.getBoundingClientRect();
      const cx = (box?.width ?? 800) / 2,
        cy = (box?.height ?? 500) / 2,
        k = Math.min(2, Math.max(0.3, v.k * factor));
      return {
        k,
        x: cx - ((cx - v.x) / v.k) * k,
        y: cy - ((cy - v.y) / v.k) * k,
      };
    });
  const fit = (positions = places) => {
    const all = Object.values(positions);
    const box = svg.current?.getBoundingClientRect();
    if (!all.length || !box) return;
    const minX = Math.min(...all.map((p) => p.x)),
      minY = Math.min(...all.map((p) => p.y)),
      maxX = Math.max(...all.map((p) => p.x)) + W,
      maxY = Math.max(...all.map((p) => p.y)) + H,
      k = Math.min(
        1,
        Math.max(
          0.3,
          Math.min(
            box.width / (maxX - minX + PAD * 2),
            box.height / (maxY - minY + PAD * 2),
          ),
        ),
      );
    setView({ k, x: PAD - minX * k, y: PAD - minY * k });
  };
  const tidy = () => {
    const next = arrange(concepts, edges, lang);
    setPlaces(next);
    store(next);
    fit(next);
  };
  const choose = useCallback(
    (key: string) => setChosen((c) => (c === key ? "" : key)),
    [],
  );
  const selected = edges.find((e) => `${e.from}|${e.to}` === chosen);
  const sorted = useMemo(
    () =>
      [...concepts].sort((a, b) => a.label[lang].localeCompare(b.label[lang])),
    [concepts, lang],
  );
  if (!loaded) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  const linking = gesture?.kind === "link" ? gesture : null;
  return (
    <>
      <h1>{t("شجرة المعرفة", "Knowledge tree")}</h1>
      <p>
        {t(
          "كل مفاهيم المقرر المنشورة وما يسبق كل مفهوم. حرّك المفاهيم كما تشاء، وارسم خطوطك بنفسك. كل محاضرة جديدة تنشر مفاهيمها تنضم إلى الشجرة نفسها.",
          "Every published concept of the course and what comes before it. Move the concepts wherever you like and draw your own lines. Each new lecture you publish joins the same tree.",
        )}
      </p>
      {pending > 0 && (
        <div className="notice">
          {t(
            `يوجد ${pending} استخراج لم يُنشر بعد؛ لن يظهر في الشجرة قبل مراجعته ونشره.`,
            `${pending} extraction(s) are not published yet; they appear in the tree after review and publishing.`,
          )}{" "}
          <button className="textbtn" onClick={() => go("knowledge")}>
            {t("اذهب إلى المراجعة", "Go to review")}
          </button>
        </div>
      )}
      {!concepts.length ? (
        <Box>
          <p>
            {t(
              "لا توجد مفاهيم منشورة بعد. استخرج مفاهيم محاضرة وراجعها وانشرها لتظهر الشجرة.",
              "No published concepts yet. Extract a lecture's concepts, review and publish them to see the tree.",
            )}
          </p>
          <Button primary onClick={() => go("knowledge")}>
            {t("المفاهيم والمتطلبات", "Concepts & prerequisites")}
          </Button>
        </Box>
      ) : (
        <>
          <Box>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <Button onClick={() => zoom(1.2)}>{t("تكبير", "Zoom in")}</Button>
              <Button onClick={() => zoom(1 / 1.2)}>
                {t("تصغير", "Zoom out")}
              </Button>
              <Button onClick={() => fit()}>{t("أظهر الكل", "Fit all")}</Button>
              <Button onClick={tidy}>{t("رتّب تلقائيًّا", "Auto-arrange")}</Button>
              <label style={{ marginInlineStart: "auto" }}>
                {t("نوع الخط الجديد", "New line type")}{" "}
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="prerequisite">
                    {t(
                      "متطلب سابق (يوجّه الطالب)",
                      "Prerequisite (routes the learner)",
                    )}
                  </option>
                  <option value="optional_bridge">
                    {t(
                      "خلفية اختيارية (لا توجّه)",
                      "Optional background (does not route)",
                    )}
                  </option>
                </select>
              </label>
            </div>
            <p>
              {t(
                "اسحب المفهوم لتحريكه. اسحب من النقطة البرتقالية على حافته إلى مفهوم آخر لرسم خط. اسحب الخلفية لتحريك اللوحة. اضغط أي خط لتغيير نوعه أو حذفه.",
                "Drag a concept to move it. Drag from the orange dot on its edge to another concept to draw a line. Drag the background to pan. Press any line to change its type or remove it.",
              )}
            </p>
            <p>
              <span style={{ color: MODEL }}>━</span>{" "}
              {t(
                "من المرجع أو المحاضرة (اقترحه النموذج)",
                "From the sources (model)",
              )}
              {" · "}
              <span style={{ color: MINE }}>━</span>{" "}
              {t("رسمه المحاضر", "Drawn by the instructor")}
              {" · "}┄ {t("خلفية اختيارية", "Optional background")}
              {" · "}
              {t(
                `${concepts.length} مفهومًا، ${edges.length} خطًّا`,
                `${concepts.length} concepts, ${edges.length} lines`,
              )}
            </p>
            <svg
              ref={svg}
              width="100%"
              height={560}
              role="group"
              aria-label={t("شجرة المعرفة", "Knowledge tree")}
              style={{
                touchAction: "none",
                direction: "ltr",
                background: "#fafbfe",
                border: "1px solid #dfe2ee",
                borderRadius: 10,
                cursor: gesture?.kind === "pan" ? "grabbing" : "default",
              }}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
              }}
            >
              <defs>
                {[MODEL, MINE].map((c) => (
                  <marker
                    key={c}
                    id={"tip" + c.slice(1)}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerUnits="userSpaceOnUse"
                    markerWidth="11"
                    markerHeight="11"
                    orient="auto"
                  >
                    <path d="M0 0L10 5L0 10z" fill={c} />
                  </marker>
                ))}
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {edges.map((e) =>
                  places[e.from] && places[e.to] ? (
                    <Line
                      key={`${e.from}|${e.to}`}
                      edge={e}
                      a={places[e.from]}
                      b={places[e.to]}
                      chosen={chosen === `${e.from}|${e.to}`}
                      label={`${name(e.from)} → ${name(e.to)}`}
                      onChoose={choose}
                    />
                  ) : null,
                )}
                {linking && places[linking.from] && (
                  <line
                    x1={places[linking.from].x + W}
                    y1={places[linking.from].y + H / 2}
                    x2={linking.x}
                    y2={linking.y}
                    stroke={MINE}
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    pointerEvents="none"
                  />
                )}
                {concepts.map((c) =>
                  places[c.id] ? (
                    <Card
                      key={c.id}
                      concept={c}
                      at={places[c.id]}
                      active={picked === c.id || linking?.from === c.id}
                      target={linking?.over === c.id}
                      lang={lang}
                    />
                  ) : null,
                )}
              </g>
            </svg>
            <p role="status" aria-live="polite">
              {picked
                ? t(
                    `اخترت «${name(picked)}». اضغط المفهوم الذي يليه لرسم خط.`,
                    `“${name(picked)}” picked. Press the concept that follows it to draw a line.`,
                  )
                : note}
            </p>
          </Box>
          {selected && (
            <Box>
              <h2>
                {name(selected.from)} → {name(selected.to)}
              </h2>
              <p>
                {selected.origin === "instructor"
                  ? t("رسمه المحاضر.", "Drawn by the instructor.")
                  : t(
                      "اقترحه النموذج من المصادر واعتمده المحاضر.",
                      "Proposed by the model from the sources and accepted by the instructor.",
                    )}{" "}
                {selected.type === "prerequisite"
                  ? t(
                      "متطلب سابق: يوجّه مسار الطالب.",
                      "Prerequisite: routes the student path.",
                    )
                  : t(
                      "خلفية اختيارية: لا تغيّر المسار.",
                      "Optional background: does not change the path.",
                    )}
              </p>
              {selected.origin !== "instructor" && selected.reason && (
                <p>{selected.reason[lang]}</p>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void edit(
                      "retype",
                      selected.from,
                      selected.to,
                      selected.type === "prerequisite"
                        ? "optional_bridge"
                        : "prerequisite",
                    )
                  }
                >
                  {selected.type === "prerequisite"
                    ? t("اجعله خلفية اختيارية", "Make it optional background")
                    : t("اجعله متطلبًا سابقًا", "Make it a prerequisite")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void edit("remove", selected.from, selected.to)
                  }
                >
                  {t("احذف الخط", "Remove line")}
                </Button>
              </div>
            </Box>
          )}
          <Box>
            <h2>{t("أو اختر من القوائم", "Or choose from lists")}</h2>
            <div className="split">
              <label>
                {t("يُدرَس أولًا", "Learned first")}
                <select
                  value={first}
                  onChange={(e) => setFirst(e.target.value)}
                >
                  <option value="">
                    {t("اختر مفهومًا", "Choose a concept")}
                  </option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label[lang]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("ثم", "Then")}
                <select value={then} onChange={(e) => setThen(e.target.value)}>
                  <option value="">
                    {t("اختر مفهومًا", "Choose a concept")}
                  </option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label[lang]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Button
              primary
              disabled={busy || !first || !then || first === then}
              onClick={() => void edit("add", first, then)}
            >
              {t("أضف الخط", "Add line")}
            </Button>
          </Box>
        </>
      )}
    </>
  );
}
