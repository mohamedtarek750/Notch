"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const W = 190,
  H = 46,
  COL = 270,
  ROW = 62,
  PAD = 16;

/** Column of each concept: one more than the deepest concept that comes before it. */
function layout(concepts: Concept[], edges: Edge[], lang: Lang) {
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
  const at = new Map<string, { x: number; y: number }>();
  let rows = 1;
  columns.forEach((column, x) => {
    // Connected concepts sit at the top so their lines stay short.
    column.sort(
      (a, b) =>
        Number(linked.has(b.id)) - Number(linked.has(a.id)) ||
        a.label[lang].localeCompare(b.label[lang]),
    );
    rows = Math.max(rows, column.length);
    column.forEach((c, y) =>
      at.set(c.id, { x: PAD + x * COL, y: PAD + y * ROW }),
    );
  });
  return {
    at,
    width: PAD * 2 + Math.max(1, columns.length) * COL - (COL - W),
    height: PAD * 2 + rows * ROW - (ROW - H),
  };
}

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
    [loaded, setLoaded] = useState(false),
    [pending, setPending] = useState(0),
    [busy, setBusy] = useState(false),
    [picked, setPicked] = useState(""),
    [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(
      null,
    ),
    [chosen, setChosen] = useState(""),
    [kind, setKind] = useState("prerequisite"),
    [first, setFirst] = useState(""),
    [then, setThen] = useState(""),
    [note, setNote] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const load = useCallback(async () => {
    try {
      const k = await request("/api/knowledge", undefined, lang);
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
  const concepts = useMemo(() => graph?.concepts ?? [], [graph]);
  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const { at, width, height } = useMemo(
    () => layout(concepts, edges, lang),
    [concepts, edges, lang],
  );
  const name = (id: string) =>
    concepts.find((c) => c.id === id)?.label[lang] ?? id;
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
      setDrag(null);
    }
  };
  const point = (e: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const release = (id: string) => {
    // A concept picked by an earlier press wins over the press that starts on this one.
    const from = picked && picked !== id ? picked : drag?.from || picked;
    setDrag(null);
    if (from && from !== id) void edit("add", from, id);
    else setPicked(picked === id ? "" : id);
  };
  const selected = edges.find((e) => `${e.from}|${e.to}` === chosen);
  const sorted = [...concepts].sort((a, b) =>
    a.label[lang].localeCompare(b.label[lang]),
  );
  const colour = (e: Edge) =>
    e.origin === "instructor" ? "#b45309" : "#4b4f8a";
  if (!loaded) return <p role="status">{t("جارٍ التحميل…", "Loading…")}</p>;
  return (
    <>
      <h1>{t("شجرة المعرفة", "Knowledge tree")}</h1>
      <p>
        {t(
          "كل مفاهيم المقرر المنشورة وما يسبق كل مفهوم. الخطوط التي اقترحها النموذج من المرجع واعتمدتَها تظهر هنا، وتستطيع أن ترسم خطوطك أنت. كل محاضرة جديدة تنشر مفاهيمها تنضم إلى الشجرة نفسها.",
          "Every published concept of the course and what comes before it. Lines the model proposed from the reference and you accepted appear here, and you can draw your own. Each new lecture you publish joins the same tree.",
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
            <h2>{t("ارسم خطًّا", "Draw a line")}</h2>
            <p>
              {t(
                "اسحب من المفهوم الذي يُدرَس أولًا إلى المفهوم الذي يليه، أو اضغط الأول ثم الثاني. اضغط أي خط لتغيير نوعه أو حذفه.",
                "Drag from the concept learned first to the one that follows, or press the first then the second. Press any line to change its type or remove it.",
              )}
            </p>
            <div className="split">
              <label>
                {t("نوع الخط الجديد", "New line type")}
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
            <p role="status" aria-live="polite">
              {picked
                ? t(
                    `اخترت «${name(picked)}». اضغط المفهوم الذي يليه.`,
                    `“${name(picked)}” picked. Press the concept that follows it.`,
                  )
                : note}
            </p>
          </Box>
          <Box>
            <p>
              <span style={{ color: "#4b4f8a" }}>━</span>{" "}
              {t("من المرجع (اقترحه النموذج)", "From the reference (model)")}
              {" · "}
              <span style={{ color: "#b45309" }}>━</span>{" "}
              {t("رسمه المحاضر", "Drawn by the instructor")}
              {" · "}┄ {t("خلفية اختيارية", "Optional background")}
              {" · "}
              {t(
                `${concepts.length} مفهومًا، ${edges.length} خطًّا`,
                `${concepts.length} concepts, ${edges.length} lines`,
              )}
            </p>
            <div
              dir="ltr"
              style={{
                overflow: "auto",
                maxHeight: "70vh",
                touchAction: "none",
              }}
            >
              <svg
                ref={svg}
                width={width}
                height={height}
                role="group"
                aria-label={t("شجرة المعرفة", "Knowledge tree")}
                onPointerMove={(e) => drag && setDrag({ ...drag, ...point(e) })}
                onPointerUp={() => setDrag(null)}
                onPointerLeave={() => setDrag(null)}
              >
                <defs>
                  {["#4b4f8a", "#b45309"].map((c) => (
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
                {edges.map((e) => {
                  const a = at.get(e.from),
                    b = at.get(e.to);
                  if (!a || !b) return null;
                  const x1 = a.x + W,
                    y1 = a.y + H / 2,
                    x2 = b.x,
                    y2 = b.y + H / 2,
                    bend = Math.max(40, (x2 - x1) / 2),
                    d = `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`,
                    key = `${e.from}|${e.to}`;
                  return (
                    <g key={key}>
                      <path
                        d={d}
                        fill="none"
                        stroke={colour(e)}
                        strokeWidth={chosen === key ? 3.5 : 1.6}
                        strokeDasharray={
                          e.type === "prerequisite" ? undefined : "5 5"
                        }
                        markerEnd={`url(#tip${colour(e).slice(1)})`}
                      />
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        style={{ cursor: "pointer" }}
                        role="button"
                        tabIndex={0}
                        aria-label={`${name(e.from)} → ${name(e.to)}`}
                        onClick={() => setChosen(chosen === key ? "" : key)}
                        onKeyDown={(k) =>
                          k.key === "Enter" &&
                          setChosen(chosen === key ? "" : key)
                        }
                      />
                    </g>
                  );
                })}
                {drag && at.get(drag.from) && (
                  <line
                    x1={at.get(drag.from)!.x + W}
                    y1={at.get(drag.from)!.y + H / 2}
                    x2={drag.x}
                    y2={drag.y}
                    stroke="#b45309"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    pointerEvents="none"
                  />
                )}
                {concepts.map((c) => {
                  const p = at.get(c.id)!;
                  const active = picked === c.id || drag?.from === c.id;
                  return (
                    <g
                      key={c.id}
                      transform={`translate(${p.x} ${p.y})`}
                      style={{ cursor: "grab" }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={active}
                      aria-label={c.label[lang]}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setDrag({ from: c.id, ...point(e) });
                      }}
                      onPointerUp={(e) => {
                        e.stopPropagation();
                        release(c.id);
                      }}
                      onKeyDown={(k) => k.key === "Enter" && release(c.id)}
                    >
                      <rect
                        width={W}
                        height={H}
                        rx={9}
                        fill={
                          active
                            ? "#fde9c8"
                            : c.scope === "foundation"
                              ? "#eef0f6"
                              : "#ffffff"
                        }
                        stroke={active ? "#b45309" : "#4b4f8a"}
                        strokeWidth={active ? 2.5 : 1.2}
                      />
                      <foreignObject width={W} height={H} pointerEvents="none">
                        <div
                          dir={lang === "ar" ? "rtl" : "ltr"}
                          style={{
                            height: H,
                            padding: "0 8px",
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
                          {c.label[lang]}
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            </div>
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
                      "اقترحه النموذج من المرجع واعتمده المحاضر.",
                      "Proposed by the model from the reference and accepted by the instructor.",
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
        </>
      )}
    </>
  );
}
