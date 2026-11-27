"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, GraduationCap, Lightbulb, Link2, Maximize, Minus, Network, Plus, Presentation } from "lucide-react";
import type { KGKind, KGNode, KGView } from "@/lib/knowledge-graph";
import { cardHeight, cardWidth, edgeRoute, kindNames, layoutGraph, relationStyles } from "./graph-layout";
import type { Translate } from "./Workspace";

export const nodeIcons = { major: GraduationCap, course: BookOpen, lecture: Presentation, concept: Lightbulb, external: Link2 };
export type Camera = { zoom?: number; x: number; y: number };
export const initialCamera: Camera = { x: 0, y: 0 };

export function GraphCanvas({ data, level, lang, t, chosen, onSelect, camera, onCamera, empty, status }: {
  data: KGView; level: KGKind; lang: "ar" | "en"; t: Translate; chosen?: string;
  onSelect: (node: KGNode) => void; camera: Camera; onCamera: (v: Camera) => void;
  empty: string; status?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera } | null>(null);
  const [size, setSize] = useState({ width: 650, height: 420 });
  const [hover, setHover] = useState("");
  const [activeEdge, setActiveEdge] = useState("");
  const uid = useId().replace(/:/g, "");
  const rtl = lang === "ar";
  const columns = Math.max(1, Math.min(3, Math.floor(size.width / 203)));
  const layout = useMemo(() => layoutGraph(data.nodes, data.edges, level, columns, rtl), [data.nodes, data.edges, level, columns, rtl]);
  const fit = Math.min((size.width - 12) / layout.width, (size.height - 50) / layout.height, 1.16);
  const scale = camera.zoom ?? Math.max(0.04, fit);
  const translateX = (size.width - scale * layout.width) / 2 + camera.x;
  const translateY = (size.height - 38 - scale * layout.height) / 2 + camera.y;
  const zoom = (value: number, x = size.width / 2, y = (size.height - 38) / 2) => {
    const next = Math.min(3, Math.max(Math.min(0.18, fit), value));
    const ratio = next / scale;
    onCamera({ zoom: next, x: camera.x * ratio + (x - size.width / 2) * (1 - ratio), y: camera.y * ratio + (y - (size.height - 38) / 2) * (1 - ratio) });
  };
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([item]) => {
      if (item.contentRect.width && item.contentRect.height)
        setSize({ width: item.contentRect.width, height: item.contentRect.height });
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheel.current = e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = svg.current!.getBoundingClientRect();
      zoom(scale * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    };
  });
  useEffect(() => {
    const element = svg.current;
    const handler = (event: WheelEvent) => wheel.current(event);
    element?.addEventListener("wheel", handler, { passive: false });
    return () => element?.removeEventListener("wheel", handler);
  }, []);
  const focus = hover || chosen;
  const adjacent = new Set([focus]);
  for (const edge of data.edges) {
    if (edge.from === focus) adjacent.add(edge.to);
    if (edge.to === focus) adjacent.add(edge.from);
  }
  return <div className="kg-surface">
    <svg direction="ltr" ref={svg} className="kg-svg" role="group" aria-label={t("الرسم البياني التفاعلي", "Interactive graph")} tabIndex={0}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        const steps: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
        const step = steps[e.key];
        if (step) { e.preventDefault(); onCamera({ ...camera, x: camera.x + step[0], y: camera.y + step[1] }); }
        if (e.key === "Home") { e.preventDefault(); onCamera(initialCamera); }
        if (e.key === "+" || e.key === "-") { e.preventDefault(); zoom(scale * (e.key === "+" ? 1.2 : 1 / 1.2)); }
      }}
      onPointerDown={e => {
        if (e.button !== 0 || (e.target as Element).closest("[data-graph-node], [data-graph-edge]")) return;
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, camera };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add("kg-dragging");
        setActiveEdge("");
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (d?.id === e.pointerId) onCamera({ ...d.camera, x: d.camera.x + e.clientX - d.x, y: d.camera.y + e.clientY - d.y });
      }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onLostPointerCapture={e => { drag.current = null; e.currentTarget.classList.remove("kg-dragging"); }}>
      <defs>{Object.entries(relationStyles).map(([type, style]) =>
        <marker key={type} id={uid + type} viewBox="0 0 8 8" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill={style.color} />
        </marker>)}</defs>
      <g transform={`translate(${translateX} ${translateY}) scale(${scale})`}>
        {data.edges.map((edge, i) => {
          const a = layout.points.get(edge.from), b = layout.points.get(edge.to);
          if (!a || !b) return null;
          const line = edgeRoute(a, b, i), style = relationStyles[edge.type];
          const key = [edge.from, edge.type, edge.to].join("|");
          const enabled = !focus || edge.from === focus || edge.to === focus;
          return <g key={key} data-graph-edge={edge.type} opacity={enabled || activeEdge === key ? 1 : 0.19}>
            <title>{t(style.label[0], style.label[1])}</title>
            <path d={line.d} fill="none" stroke={style.color} strokeWidth={activeEdge === key ? 3 : 1.7}
              strokeLinejoin="round" strokeDasharray={style.dash} markerEnd={`url(#${uid}${edge.type})`} />
            <path d={line.d} fill="none" stroke="transparent" strokeWidth={14} onMouseEnter={() => setActiveEdge(key)}
              onMouseLeave={() => setActiveEdge("")} onClick={() => setActiveEdge(key)} />
            {activeEdge === key && <text x={line.label.x} y={line.label.y} textAnchor="middle" className="kg-edge-label">{t(style.label[0], style.label[1])}</text>}
          </g>;
        })}
        {data.nodes.map(node => {
          const point = layout.points.get(node.id);
          if (!point) return null;
          const kind = node.external ? "external" : node.kind, Icon = nodeIcons[kind];
          const label = node.label[lang] || node.label.en || node.label.ar;
          const active = node.id === chosen;
          return <foreignObject key={node.kind + node.id} x={point.x - cardWidth / 2} y={point.y - cardHeight / 2}
            width={cardWidth} height={cardHeight} overflow="visible" opacity={!focus || adjacent.has(node.id) ? 1 : 0.36}>
            <button type="button" dir={rtl ? "rtl" : "ltr"} data-graph-node={node.kind} data-node-id={node.id}
              className={`kg-node kg-${kind}${active ? " kg-chosen" : ""}`} title={label + " · " + t(kindNames[kind][0], kindNames[kind][1])}
              aria-pressed={active} aria-label={label} onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover("")}
              onFocus={() => setHover(node.id)} onBlur={() => setHover("")}
              onClick={() => { setHover(""); setActiveEdge(""); onSelect(node); }}>
              <span className="kg-node-icon"><Icon size={21} strokeWidth={1.8} /></span>
              <span className="kg-node-name"><small>{node.code || t(kindNames[kind][0], kindNames[kind][1])}</small><strong>{label}</strong></span>
              {node.kind !== "concept" && <ChevronDown size={13} className={node.kind !== level ? "kg-collapse" : ""} />}
            </button>
          </foreignObject>;
        })}
      </g>
    </svg>
    {(status || !data.nodes.length) && <div className="kg-state" role="status"><Network size={25}/><span>{status || empty}</span></div>}
    <div className="kg-zoom" dir="ltr">
      <button title={t("تصغير", "Zoom out")} aria-label={t("تصغير", "Zoom out")} onClick={() => zoom(scale / 1.2)}><Minus size={16}/></button>
      <output aria-live="off">{Math.round(scale * 100)}%</output>
      <button title={t("تكبير", "Zoom in")} aria-label={t("تكبير", "Zoom in")} onClick={() => zoom(scale * 1.2)}><Plus size={16}/></button>
      <button title={t("ملاءمة الرسم", "Fit graph")} aria-label={t("ملاءمة الرسم", "Fit graph")} onClick={() => onCamera(initialCamera)}><Maximize size={15}/></button>
    </div>
  </div>;
}

