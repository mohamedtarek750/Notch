export function FieldArt() {
  const project = (x: number, y: number, z: number) => [
    165 + 80 * x - 61 * y,
    114 + 24 * x + 30 * y - 54 * z,
  ];
  const h = (x: number, y: number) =>
    0.85 * Math.exp(-((x + 0.25) ** 2 + (y - 0.02) ** 2) * 2.4) -
    0.5 * x +
    0.17 * Math.cos(y * 2);
  const line = (a: number[][]) =>
    a.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
  const seq = Array.from({ length: 23 }, (_, i) => -1 + i / 11);
  return (
    <svg
      className="fieldArt"
      viewBox="0 0 330 220"
      role="img"
      aria-label="Machine learning decision surface"
    >
      <defs>
        <pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r=".8" fill="#ada9ef" opacity=".4" />
        </pattern>
      </defs>
      <rect width="330" height="220" fill="url(#dots)" />
      {seq
        .filter((_, i) => i % 2 === 0)
        .map((v, i) => (
          <g
            key={i}
            fill="none"
            stroke="#a8a4e7"
            opacity=".24"
            strokeWidth=".6"
          >
            <polyline points={line(seq.map((w) => project(v, w, -0.72)))} />
            <polyline points={line(seq.map((w) => project(w, v, -0.72)))} />
          </g>
        ))}
      {seq.map((v, i) => (
        <g
          key={i}
          fill="none"
          stroke={i > 13 ? "#f6ac91" : "#bdb4ff"}
          strokeWidth={i % 4 === 0 ? 1.45 : 0.8}
          opacity=".92"
        >
          <polyline points={line(seq.map((w) => project(v, w, h(v, w))))} />
          <polyline points={line(seq.map((w) => project(w, v, h(w, v))))} />
        </g>
      ))}
      {[
        [0.55, -0.5],
        [-0.5, 0.38],
        [0.7, 0.45],
        [-0.8, -0.45],
        [0.08, -0.75],
      ].map(([x, y], i) => {
        const [cx, cy] = project(x, y, h(x, y));
        return (
          <g key={i}>
            <circle
              cx={cx}
              cy={cy}
              r="6.5"
              fill="none"
              stroke="#ffb697"
              opacity=".5"
            />
            <circle cx={cx} cy={cy} r="3" fill="#ffc2a2" />
          </g>
        );
      })}
    </svg>
  );
}
