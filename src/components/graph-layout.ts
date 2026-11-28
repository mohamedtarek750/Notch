import type { KGEdge, KGKind, KGNode, KGRelation } from "@/lib/knowledge-graph";

export const kinds: KGKind[] = ["major", "course", "lecture", "concept"];
export const kindNames = {
  major: ["تخصص", "Major"],
  course: ["مقرر", "Course"],
  lecture: ["محاضرة", "Lecture"],
  concept: ["مفهوم", "Concept"],
  external: ["مفهوم خارجي", "External concept"],
} as const;
export const levelNames = {
  major: ["التخصصات", "Majors"],
  course: ["المقررات", "Courses"],
  lecture: ["المحاضرات", "Lectures"],
  concept: ["المفاهيم", "Concepts"],
} as const;
export const relationStyles = {
  CONTAINS: { label: ["يحتوي على", "Contains"], color: "#74869f", dash: "" },
  PREREQUISITE_OF: {
    label: ["متطلب سابق لـ", "Prerequisite of"],
    color: "#315fc1",
    dash: "",
  },
  RELATED_TO: {
    label: ["مرتبط بـ", "Related to"],
    color: "#8c55a3",
    dash: "5 4",
  },
  OPTIONAL_BACKGROUND: {
    label: ["خلفية اختيارية", "Optional background"],
    color: "#ab6a24",
    dash: "2 5",
  },
  IS_A: { label: ["نوع من", "Is a"], color: "#6744a3", dash: "9 3" },
  PART_OF: { label: ["جزء من", "Part of"], color: "#117983", dash: "8 3 2 3" },
  USED_IN: { label: ["يُستخدم في", "Used in"], color: "#2c715a", dash: "5 3" },
  SOLVES: { label: ["يحلّ", "Solves"], color: "#a34761", dash: "" },
} as const satisfies Record<
  KGRelation,
  { label: readonly [string, string]; color: string; dash: string }
>;

export type Point = { x: number; y: number };
export const cardWidth = 194,
  cardHeight = 68;
const gapX = 38,
  gapY = 60;
const cellWidth = cardWidth + gapX,
  cellHeight = cardHeight + gapY;

// Keep the container at the top. Within the neighborhood, prerequisites
// precede their dependents, while unrelated nodes share a compact grid.
export function layoutGraph(
  nodes: KGNode[],
  edges: KGEdge[],
  level: KGKind,
  columns: number,
  rtl: boolean,
) {
  const children = nodes.filter((n) => n.kind === level);
  const anchor = nodes.find((n) => n.kind !== level);
  const childIds = new Set(children.map((n) => n.id));
  const incoming = new Map(children.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>();
  const ranks = new Map<string, number>();
  for (const edge of edges) {
    if (
      edge.type !== "PREREQUISITE_OF" ||
      !childIds.has(edge.from) ||
      !childIds.has(edge.to)
    )
      continue;
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const queue = children.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(id) ?? 0) + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (!incoming.get(next)) queue.push(next);
    }
  }
  const layers = new Map<number, KGNode[]>();
  for (const n of children) {
    const rank = ranks.get(n.id) ?? 0;
    const layer = layers.get(rank) ?? [];
    layer.push(n);
    layers.set(rank, layer);
  }
  const rows: KGNode[][] = anchor ? [[anchor]] : [];
  for (const [, layer] of [...layers].sort(([a], [b]) => a - b)) {
    for (let i = 0; i < layer.length; i += columns)
      rows.push(layer.slice(i, i + columns));
  }
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = widest * cellWidth + gapX,
    height = rows.length * cellHeight + gapY;
  const points = new Map<string, Point>();
  rows.forEach((row, y) =>
    row.forEach((n, x) => {
      // Keep all multi-row columns on the same grid for edge routing.
      const center =
        anchor === n ? width / 2 : gapX + cardWidth / 2 + x * cellWidth;
      points.set(n.id, {
        x: rtl ? width - center : center,
        y: gapY + cardHeight / 2 + y * cellHeight,
      });
    }),
  );
  return { points, width, height };
}

// Connect at card boundaries and use the clear space between rows/columns.
// Non-adjacent endpoints route along a column gutter to bypass other cards.
export function edgeRoute(start: Point, end: Point, lane: number) {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const sx = Math.sign(dx) || 1,
    sy = Math.sign(dy) || 1;
  const shift = ((lane % 5) - 2) * 3;
  let path: Point[];
  if (dy === 0) {
    const rail = start.y - cardHeight / 2 - 16 - shift;
    path = [
      { x: start.x + 18 * sx, y: start.y - cardHeight / 2 },
      { x: start.x + 18 * sx, y: rail },
      { x: end.x - 18 * sx, y: rail },
      { x: end.x - 18 * sx, y: end.y - cardHeight / 2 },
    ];
  } else {
    const a = { x: start.x + shift, y: start.y + (sy * cardHeight) / 2 };
    const b = { x: end.x + shift, y: end.y - (sy * cardHeight) / 2 };
    const first = a.y + sy * (gapY / 2 + shift);
    if (Math.abs(dy) <= cellHeight) {
      path = [a, { x: a.x, y: first }, { x: b.x, y: first }, b];
    } else {
      const gutter = end.x - sx * (cardWidth / 2 + gapX / 2) + shift;
      const last = b.y - sy * (gapY / 2 + shift);
      path = [
        a,
        { x: a.x, y: first },
        { x: gutter, y: first },
        { x: gutter, y: last },
        { x: b.x, y: last },
        b,
      ];
    }
  }
  const segments = path.slice(1).map((p, i) => ({
    a: path[i],
    b: p,
    length: Math.hypot(path[i].x - p.x, path[i].y - p.y),
  }));
  const middle = segments.reduce((a, b) => (a.length >= b.length ? a : b));
  return {
    d: path.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" "),
    label: {
      x: (middle.a.x + middle.b.x) / 2,
      y: (middle.a.y + middle.b.y) / 2 - 6,
    },
  };
}
