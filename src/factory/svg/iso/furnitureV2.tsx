import {
  Box, Cylinder, Sphere, Plane, WallDecal,
  iso3, U, lighter, darker, pts,
} from "./primitives";

const fmt = (n: number) => n.toFixed(2);

// ────────────────── DESKS / TABLES ──────────────────

export function Desk({
  x = 0, y = 0, w = 1.8, d = 0.9, color = "#d8b78a", legColor, h = 1.3,
}: {
  x?: number; y?: number; w?: number; d?: number;
  color?: string; legColor?: string; h?: number;
}) {
  const lc = legColor ?? darker(color, 0.55);
  return (
    <g>
      <Box x={x + 0.08} y={y + 0.08} w={0.1} d={0.1} h={h} color={lc} />
      <Box x={x + w - 0.18} y={y + 0.08} w={0.1} d={0.1} h={h} color={lc} />
      <Box x={x + 0.08} y={y + d - 0.18} w={0.1} d={0.1} h={h} color={lc} />
      <Box x={x + w - 0.18} y={y + d - 0.18} w={0.1} d={0.1} h={h} color={lc} />
      <Box x={x - 0.05} y={y - 0.05} z={h} w={w + 0.1} d={d + 0.1} h={0.1} color={color} />
      <Plane
        corners={[
          [x - 0.05, y - 0.05, h - 0.005],
          [x + w + 0.05, y - 0.05, h - 0.005],
          [x + w + 0.05, y - 0.05, h],
          [x - 0.05, y - 0.05, h],
        ]}
        color={darker(color, 0.3)}
      />
    </g>
  );
}

export function LDesk({
  x = 0, y = 0, color = "#d8b78a",
}: {
  x?: number; y?: number; color?: string;
}) {
  return (
    <g>
      <Desk x={x} y={y} w={2.0} d={0.85} color={color} />
      <Desk x={x} y={y + 0.85} w={0.85} d={1.2} color={color} />
    </g>
  );
}

export function SideTable({
  x = 0, y = 0, color = "#9a7a5a",
}: {
  x?: number; y?: number; color?: string;
}) {
  return <Desk x={x} y={y} w={0.84} d={0.84} color={color} h={1.1} />;
}

// ────────────────── CHAIRS / SEATING ──────────────────

export function Armchair({
  x = 0, y = 0, color = "#bcc6d2", face = "back-left", size = 0.84,
}: {
  x?: number; y?: number; color?: string;
  face?: "back-left" | "back-right" | "front-left" | "front-right";
  size?: number;
}) {
  const s = size;
  const c2 = lighter(color, 0.1);
  const cdark = darker(color, 0.2);
  const seatH = 0.45;
  const backH = 0.7;
  const backT = s * 0.18;
  return (
    <g>
      <Box x={x} y={y} z={0} w={s} d={s} h={seatH} color={cdark} />
      <Box x={x + s * 0.12} y={y + s * 0.12} z={seatH} w={s - s * 0.24} d={s - s * 0.24} h={0.12} color={c2} />
      {face === "back-left" && (
        <Box x={x} y={y + s - backT} z={seatH} w={s} d={backT} h={backH} color={color} />
      )}
      {face === "back-right" && (
        <Box x={x + s - backT} y={y} z={seatH} w={backT} d={s} h={backH} color={color} />
      )}
      {face === "front-left" && (
        <Box x={x} y={y} z={seatH} w={s} d={backT} h={backH} color={color} />
      )}
      {face === "front-right" && (
        <Box x={x} y={y} z={seatH} w={backT} d={s} h={backH} color={color} />
      )}
    </g>
  );
}

export function Sofa({
  x = 0, y = 0, color = "#9aa7b4", face = "back-left",
}: {
  x?: number; y?: number; color?: string;
  face?: "back-left" | "back-right";
}) {
  const c2 = lighter(color, 0.06);
  if (face === "back-left") {
    const W = 1.8, D = 0.84;
    return (
      <g>
        <Box x={x + 0.08} y={y + 0.08} z={0.32} w={W - 0.16} d={D - 0.16} h={0.44} color={color} />
        <Box x={x + 0.1} y={y + 0.1} z={0.76} w={(W - 0.2) / 2 - 0.05} d={D - 0.28} h={0.14} color={c2} />
        <Box x={x + W / 2 + 0.05} y={y + 0.1} z={0.76} w={(W - 0.2) / 2 - 0.05} d={D - 0.28} h={0.14} color={c2} />
        <Box x={x + 0.08} y={y + D - 0.24} z={0.32} w={W - 0.16} d={0.2} h={1.0} color={color} />
        <Box x={x + 0.08} y={y + 0.08} z={0.78} w={0.14} d={D - 0.34} h={0.5} color={c2} />
        <Box x={x + W - 0.22} y={y + 0.08} z={0.78} w={0.14} d={D - 0.34} h={0.5} color={c2} />
      </g>
    );
  }
  const W = 0.84, D = 1.8;
  return (
    <g>
      <Box x={x + 0.08} y={y + 0.08} z={0.32} w={W - 0.16} d={D - 0.16} h={0.44} color={color} />
      <Box x={x + W - 0.24} y={y + 0.08} z={0.32} w={0.2} d={D - 0.16} h={1.0} color={color} />
    </g>
  );
}

export function Stool({
  x = 0, y = 0, color = "#6b7a8a",
}: {
  x?: number; y?: number; color?: string;
}) {
  return (
    <g>
      <Cylinder x={x + 0.3} y={y + 0.3} z={0} r={0.27} h={0.05} color={darker(color, 0.5)} />
      <Cylinder x={x + 0.3} y={y + 0.3} z={0.05} r={0.045} h={0.55} color={darker(color, 0.6)} />
      <Cylinder x={x + 0.3} y={y + 0.3} z={0.6} r={0.3} h={0.1} color={color} />
    </g>
  );
}

// ────────────────── STORAGE ──────────────────

export function Bookshelf({
  x = 0, y = 0, color = "#c4a37a", books = "#a45a4a",
  w = 1.4, d = 0.4, h = 2.4,
}: {
  x?: number; y?: number; color?: string; books?: string;
  w?: number; d?: number; h?: number;
}) {
  const bookColors = [books, darker(books, 0.2), lighter(books, 0.15), "#3c5a78", "#8a6f4a", darker(books, 0.35)];
  const shelves = [0.4, 0.95, 1.5, 2.05];
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} color={color} />
      {shelves.filter((s) => s < h - 0.2).map((zlv, si) => (
        <g key={si}>
          <Plane
            corners={[
              [x + 0.04, y - 0.001, zlv - 0.06],
              [x + w - 0.04, y - 0.001, zlv - 0.06],
              [x + w - 0.04, y - 0.001, zlv],
              [x + 0.04, y - 0.001, zlv],
            ]}
            color={darker(color, 0.25)}
          />
          {Array.from({ length: 7 }).map((_, bi) => {
            const bx = (bi * (w - 0.2)) / 7;
            const bh = 0.4 + ((si * 7 + bi * 3) % 5) * 0.03;
            const col = bookColors[(si * 3 + bi) % bookColors.length];
            return (
              <Plane
                key={bi}
                corners={[
                  [x + 0.1 + bx, y - 0.002, zlv],
                  [x + 0.1 + bx + (w - 0.2) / 8, y - 0.002, zlv],
                  [x + 0.1 + bx + (w - 0.2) / 8, y - 0.002, zlv + bh],
                  [x + 0.1 + bx, y - 0.002, zlv + bh],
                ]}
                color={col}
              />
            );
          })}
        </g>
      ))}
    </g>
  );
}

export function Cabinet({
  x = 0, y = 0, color = "#d2d4dc", w = 0.84, d = 0.6, h = 1.3,
}: {
  x?: number; y?: number; color?: string;
  w?: number; d?: number; h?: number;
}) {
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} color={color} />
      {[0.32, 0.66, 1.0].filter((z) => z < h).map((zlv, i) => (
        <g key={i}>
          <Plane
            corners={[
              [x + 0.05, y, zlv],
              [x + w - 0.05, y, zlv],
              [x + w - 0.05, y, zlv + 0.02],
              [x + 0.05, y, zlv + 0.02],
            ]}
            color={darker(color, 0.35)}
          />
          <Plane
            corners={[
              [x + w * 0.4, y - 0.002, zlv - 0.13],
              [x + w * 0.6, y - 0.002, zlv - 0.13],
              [x + w * 0.6, y - 0.002, zlv - 0.1],
              [x + w * 0.4, y - 0.002, zlv - 0.1],
            ]}
            color="#15171c"
          />
        </g>
      ))}
    </g>
  );
}

export function ServerRack({
  x = 0, y = 0, accent = "#22d3ee", w = 0.84, d = 0.6, h = 2.4,
}: {
  x?: number; y?: number; accent?: string;
  w?: number; d?: number; h?: number;
}) {
  const rows = 5;
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} color="#15171c" />
      {[0.25, 0.4, 0.55, 0.7].map((zlv, i) => (
        <Plane
          key={`v${i}`}
          corners={[
            [x + 0.08, y, zlv],
            [x + w - 0.08, y, zlv],
            [x + w - 0.08, y, zlv + 0.04],
            [x + 0.08, y, zlv + 0.04],
          ]}
          color="#08090d"
        />
      ))}
      {Array.from({ length: rows }).map((_, i) => {
        const zlv = 0.8 + i * 0.3;
        return (
          <g key={i}>
            <Plane
              corners={[
                [x + 0.08, y, zlv],
                [x + w - 0.08, y, zlv],
                [x + w - 0.08, y, zlv + 0.24],
                [x + 0.08, y, zlv + 0.24],
              ]}
              color="#0a0c11"
            />
            <Plane
              corners={[
                [x + 0.14, y - 0.001, zlv + 0.07],
                [x + 0.22, y - 0.001, zlv + 0.07],
                [x + 0.22, y - 0.001, zlv + 0.14],
                [x + 0.14, y - 0.001, zlv + 0.14],
              ]}
              color={i % 4 === 0 ? "#ef4444" : accent}
            >
              <animate attributeName="opacity" values="0.5;1;0.5" dur={`${1.2 + (i % 4) * 0.3}s`} repeatCount="indefinite" />
            </Plane>
            <Plane
              corners={[
                [x + 0.26, y - 0.001, zlv + 0.07],
                [x + 0.32, y - 0.001, zlv + 0.07],
                [x + 0.32, y - 0.001, zlv + 0.14],
                [x + 0.26, y - 0.001, zlv + 0.14],
              ]}
              color="#facc15"
            >
              <animate attributeName="opacity" values="0.3;1;0.3" dur={`${0.9 + (i % 3) * 0.4}s`} repeatCount="indefinite" />
            </Plane>
            <Plane
              corners={[
                [x + 0.4, y - 0.001, zlv + 0.1],
                [x + w - 0.12, y - 0.001, zlv + 0.1],
                [x + w - 0.12, y - 0.001, zlv + 0.14],
                [x + 0.4, y - 0.001, zlv + 0.14],
              ]}
              color={lighter(accent, 0.3)}
              opacity={0.5}
            />
          </g>
        );
      })}
      <Box x={x + 0.08} y={y + 0.08} z={h} w={w - 0.16} d={d - 0.16} h={0.04} color={darker(accent, 0.3)} />
    </g>
  );
}

export function BoxStack({
  x = 0, y = 0, color = "#c4945a",
}: {
  x?: number; y?: number; color?: string;
}) {
  const W = 0.84;
  return (
    <g>
      <Box x={x} y={y} w={W} d={W} h={0.55} color={color} />
      <Box x={x + 0.08} y={y + 0.08} z={0.55} w={W - 0.16} d={W - 0.16} h={0.46} color={lighter(color, 0.1)} />
      <Box x={x + 0.2} y={y + 0.2} z={1.01} w={W - 0.4} d={W - 0.4} h={0.4} color={color} />
      <Plane
        corners={[
          [x + 0.36, y - 0.002, 1.35],
          [x + 0.6, y - 0.002, 1.35],
          [x + 0.6, y - 0.002, 1.38],
          [x + 0.36, y - 0.002, 1.38],
        ]}
        color="#fafafa"
      />
    </g>
  );
}

// ────────────────── SCREENS / DEVICES ──────────────────

type ScreenContent = "chart" | "list" | "code" | "design" | "grid" | "world" | "multi";

export function Monitor({
  x = 0, y = 0, z = 1.3, w = 0.9, accent = "#22d3ee",
  screenColor = "#0e1320", content = "chart" as ScreenContent,
  face = "+y" as "+y" | "+x",
}: {
  x?: number; y?: number; z?: number; w?: number;
  accent?: string; screenColor?: string; content?: ScreenContent;
  face?: "+y" | "+x";
}) {
  const depth = 0.06;
  const height = 0.62;
  const pad = 0.03;

  if (face === "+x") {
    const sx = x - 0.001;
    return (
      <g>
        <Box x={x + 0.04} y={y + w / 2 - 0.2} z={z - 0.03} w={0.24} d={0.4} h={0.04} color="#1a1d23" />
        <Box x={x + 0.1} y={y + w / 2 - 0.05} z={z + 0.01} w={0.06} d={0.1} h={0.24} color="#2a2d35" />
        <Box x={x} y={y} z={z} w={depth} d={w} h={height} color="#1a1d23" />
        <Plane corners={[[sx, y, z], [sx, y + w, z], [sx, y + w, z + height], [sx, y, z + height]]} color="#0a0d13" />
        <Plane
          corners={[
            [sx - 0.0005, y + pad, z + pad + 0.03],
            [sx - 0.0005, y + w - pad, z + pad + 0.03],
            [sx - 0.0005, y + w - pad, z + height - pad],
            [sx - 0.0005, y + pad, z + height - pad],
          ]}
          color={screenColor}
        />
        {content === "chart" && (
          <g>
            {[0.0, 0.1, 0.2, 0.3, 0.4].map((by, i) => {
              const bh = 0.08 + ((i * 7) % 9) * 0.018;
              return (
                <Plane
                  key={i}
                  corners={[
                    [sx - 0.001, y + pad + 0.06 + by, z + pad + 0.15],
                    [sx - 0.001, y + pad + 0.13 + by, z + pad + 0.15],
                    [sx - 0.001, y + pad + 0.13 + by, z + pad + 0.15 + bh],
                    [sx - 0.001, y + pad + 0.06 + by, z + pad + 0.15 + bh],
                  ]}
                  color={accent}
                  opacity={0.5 + i * 0.08}
                />
              );
            })}
          </g>
        )}
      </g>
    );
  }

  const sy = y - 0.001;
  return (
    <g>
      <Box x={x + w / 2 - 0.2} y={y + 0.04} z={z - 0.03} w={0.4} d={0.24} h={0.04} color="#1a1d23" />
      <Box x={x + w / 2 - 0.05} y={y + 0.1} z={z + 0.01} w={0.1} d={0.06} h={0.24} color="#2a2d35" />
      <Box x={x} y={y} z={z} w={w} d={depth} h={height} color="#1a1d23" />
      <Plane corners={[[x, sy, z], [x + w, sy, z], [x + w, sy, z + height], [x, sy, z + height]]} color="#0a0d13" />
      <Plane
        corners={[
          [x + pad, sy - 0.0005, z + pad + 0.03],
          [x + w - pad, sy - 0.0005, z + pad + 0.03],
          [x + w - pad, sy - 0.0005, z + height - pad],
          [x + pad, sy - 0.0005, z + height - pad],
        ]}
        color={screenColor}
      />
      {content === "chart" && (
        <g>
          <Plane
            corners={[
              [x + pad + 0.04, sy - 0.001, z + pad + 0.08],
              [x + pad + 0.28, sy - 0.001, z + pad + 0.08],
              [x + pad + 0.28, sy - 0.001, z + pad + 0.12],
              [x + pad + 0.04, sy - 0.001, z + pad + 0.12],
            ]}
            color={accent}
          />
          {[0.0, 0.1, 0.2, 0.3, 0.4].map((bx, i) => {
            const bh = 0.08 + ((i * 7) % 9) * 0.018;
            return (
              <Plane
                key={i}
                corners={[
                  [x + pad + 0.05 + bx, sy - 0.001, z + pad + 0.16],
                  [x + pad + 0.12 + bx, sy - 0.001, z + pad + 0.16],
                  [x + pad + 0.12 + bx, sy - 0.001, z + pad + 0.16 + bh],
                  [x + pad + 0.05 + bx, sy - 0.001, z + pad + 0.16 + bh],
                ]}
                color={accent}
                opacity={0.5 + i * 0.08}
              />
            );
          })}
        </g>
      )}
      {content === "list" && (
        <g>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <Plane
                corners={[
                  [x + pad + 0.04, sy - 0.001, z + pad + 0.08 + i * 0.09],
                  [x + pad + 0.08, sy - 0.001, z + pad + 0.08 + i * 0.09],
                  [x + pad + 0.08, sy - 0.001, z + pad + 0.13 + i * 0.09],
                  [x + pad + 0.04, sy - 0.001, z + pad + 0.13 + i * 0.09],
                ]}
                color={i < 3 ? accent : lighter(accent, 0.5)}
                opacity={i < 3 ? 1 : 0.4}
              />
              <Plane
                corners={[
                  [x + pad + 0.12, sy - 0.001, z + pad + 0.09 + i * 0.09],
                  [x + pad + 0.42 + ((i * 5) % 3) * 0.06, sy - 0.001, z + pad + 0.09 + i * 0.09],
                  [x + pad + 0.42 + ((i * 5) % 3) * 0.06, sy - 0.001, z + pad + 0.12 + i * 0.09],
                  [x + pad + 0.12, sy - 0.001, z + pad + 0.12 + i * 0.09],
                ]}
                color={lighter(accent, 0.5)}
                opacity={0.6}
              />
            </g>
          ))}
        </g>
      )}
      {content === "code" && (
        <g>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const ww = 0.1 + ((i * 11) % 5) * 0.06;
            return (
              <Plane
                key={i}
                corners={[
                  [x + pad + 0.04, sy - 0.001, z + pad + 0.08 + i * 0.07],
                  [x + pad + 0.04 + ww, sy - 0.001, z + pad + 0.08 + i * 0.07],
                  [x + pad + 0.04 + ww, sy - 0.001, z + pad + 0.10 + i * 0.07],
                  [x + pad + 0.04, sy - 0.001, z + pad + 0.10 + i * 0.07],
                ]}
                color={i % 3 === 0 ? accent : lighter(accent, 0.4)}
                opacity={0.7}
              />
            );
          })}
        </g>
      )}
      {content === "design" && (
        <g>
          <Plane
            corners={[
              [x + pad + 0.14, sy - 0.001, z + pad + 0.14],
              [x + w - pad - 0.1, sy - 0.001, z + pad + 0.14],
              [x + w - pad - 0.1, sy - 0.001, z + height - pad - 0.08],
              [x + pad + 0.14, sy - 0.001, z + height - pad - 0.08],
            ]}
            color={lighter(screenColor, 0.1)}
          />
          <Plane
            corners={[
              [x + pad + 0.22, sy - 0.001, z + pad + 0.22],
              [x + pad + 0.5, sy - 0.001, z + pad + 0.22],
              [x + pad + 0.5, sy - 0.001, z + pad + 0.4],
              [x + pad + 0.22, sy - 0.001, z + pad + 0.4],
            ]}
            color={accent}
            opacity={0.65}
          />
        </g>
      )}
    </g>
  );
}

export function UltraWide({
  x = 0, y = 0, z = 1.3, w = 1.8, accent = "#22d3ee",
  screenColor = "#0a0d14", content = "multi" as ScreenContent,
}: {
  x?: number; y?: number; z?: number; w?: number;
  accent?: string; screenColor?: string; content?: ScreenContent;
}) {
  const seg = w / 3;
  const tilt = 0.13;
  const height = 0.6;
  const Lf = { x: x, y: y + tilt };
  const Lb = { x: x + seg, y: y };
  const Cf = Lb;
  const Cb = { x: x + 2 * seg, y: y };
  const Rf = Cb;
  const Rb = { x: x + w, y: y + tilt };
  const panels: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; key: string }> = [
    { a: Lf, b: Lb, key: "L" },
    { a: Cf, b: Cb, key: "C" },
    { a: Rf, b: Rb, key: "R" },
  ];
  return (
    <g>
      <Box x={x + w / 2 - 0.28} y={y + 0.06} z={z - 0.03} w={0.56} d={0.24} h={0.04} color="#1a1d23" />
      <Box x={x + w / 2 - 0.06} y={y + 0.14} z={z + 0.01} w={0.12} d={0.08} h={0.28} color="#2a2d35" />
      {panels.map(({ a, b, key }) => (
        <g key={key}>
          <Plane
            corners={[
              [a.x, a.y, z],
              [b.x, b.y, z],
              [b.x, b.y, z + height],
              [a.x, a.y, z + height],
            ]}
            color="#0a0d13"
          />
          <Plane
            corners={[
              [a.x + 0.03, a.y - 0.001, z + 0.04],
              [b.x - 0.03, b.y - 0.001, z + 0.04],
              [b.x - 0.03, b.y - 0.001, z + height - 0.04],
              [a.x + 0.03, a.y - 0.001, z + height - 0.04],
            ]}
            color={screenColor}
          />
        </g>
      ))}
      {panels.map(({ a, b, key }, idx) => {
        const type =
          content === "multi"
            ? (idx === 0 ? "chart" : idx === 1 ? "world" : "list")
            : content;
        const items: React.ReactNode[] = [];
        if (type === "chart") {
          for (let k = 0; k < 4; k++) {
            const t = (k + 0.5) / 4;
            const cx0 = a.x + (b.x - a.x) * t;
            const cy0 = a.y + (b.y - a.y) * t;
            const bh = 0.12 + ((k * 7 + idx * 3) % 5) * 0.04;
            items.push(
              <Plane
                key={k}
                corners={[
                  [cx0 - 0.035, cy0 - 0.002, z + 0.15],
                  [cx0 + 0.035, cy0 - 0.002, z + 0.15],
                  [cx0 + 0.035, cy0 - 0.002, z + 0.15 + bh],
                  [cx0 - 0.035, cy0 - 0.002, z + 0.15 + bh],
                ]}
                color={accent}
                opacity={0.6 + (k % 2) * 0.3}
              />,
            );
          }
        } else if (type === "world") {
          for (let k = 0; k < 6; k++) {
            const t = (k + 0.5) / 6;
            const cx0 = a.x + (b.x - a.x) * t;
            const cy0 = a.y + (b.y - a.y) * t;
            const zz = z + 0.14 + ((k * 11) % 5) * 0.07;
            const p = iso3(cx0, cy0 - 0.002, zz);
            items.push(
              <circle key={k} cx={p.x} cy={p.y} r={2} fill={accent} opacity={0.5 + (k % 3) * 0.18} />,
            );
          }
        } else {
          for (let k = 0; k < 4; k++) {
            const ww = 0.4 + ((k * 5) % 3) * 0.1;
            items.push(
              <Plane
                key={k}
                corners={[
                  [a.x + 0.03, a.y - 0.002, z + 0.12 + k * 0.1],
                  [a.x + 0.03 + ww * (b.x - a.x), a.y - 0.002 + ww * (b.y - a.y), z + 0.12 + k * 0.1],
                  [a.x + 0.03 + ww * (b.x - a.x), a.y - 0.002 + ww * (b.y - a.y), z + 0.14 + k * 0.1],
                  [a.x + 0.03, a.y - 0.002, z + 0.14 + k * 0.1],
                ]}
                color={accent}
                opacity={0.65}
              />,
            );
          }
        }
        return <g key={`${key}-c`}>{items}</g>;
      })}
    </g>
  );
}

export function WallScreen({
  wall = "left", u = 1.5, v = 2.4, w = 2.4, h = 1.2, accent = "#22d3ee",
  color = "#0d1320", content = "chart" as ScreenContent,
}: {
  wall?: "left" | "right";
  u?: number; v?: number; w?: number; h?: number;
  accent?: string; color?: string;
  content?: ScreenContent;
}) {
  const ww = w * U;
  const hh = h * U;
  const flip = wall === "right" ? "scale(-1, 1)" : "";
  return (
    <WallDecal wall={wall} u={u} v={v}>
      <g transform={flip}>
        <rect x={-3} y={3} width={ww + 6} height={-hh - 6} fill="#0a0d12" rx={3} />
        <rect x={0} y={0} width={ww} height={-hh} fill={color} rx={2} />
        {content === "chart" && (
          <g>
            <rect x={U * 0.2} y={-hh + U * 0.2} width={U * 1.2} height={U * 0.18} fill={accent} />
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const bw = U * 0.32;
              const bh = U * (0.32 + ((i * 7) % 6) * 0.12);
              return (
                <rect
                  key={i}
                  x={U * 0.3 + i * (bw + U * 0.1)}
                  y={-U * 0.3 - bh}
                  width={bw}
                  height={bh}
                  fill={accent}
                  opacity={0.4 + i * 0.1}
                >
                  <animate
                    attributeName="height"
                    values={`${bh};${bh * (0.7 + (i % 3) * 0.2)};${bh}`}
                    dur={`${2 + i * 0.4}s`}
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="y"
                    values={`${-U * 0.3 - bh};${-U * 0.3 - bh * (0.7 + (i % 3) * 0.2)};${-U * 0.3 - bh}`}
                    dur={`${2 + i * 0.4}s`}
                    repeatCount="indefinite"
                  />
                </rect>
              );
            })}
          </g>
        )}
        {content === "grid" && (
          <g>
            {[0, 1, 2, 3].map((r) =>
              [0, 1, 2, 3, 4].map((c) => {
                const i = r * 5 + c;
                const active = i % 3 === 0;
                return (
                  <rect
                    key={i}
                    x={U * 0.2 + c * U * 0.42}
                    y={-hh + U * 0.2 + r * U * 0.26}
                    width={U * 0.36}
                    height={U * 0.18}
                    fill={accent}
                    opacity={active ? 0.9 : 0.25}
                    rx={1}
                  >
                    {active && (
                      <animate
                        attributeName="opacity"
                        values="0.4;1;0.4"
                        dur={`${1.5 + (i % 5) * 0.3}s`}
                        repeatCount="indefinite"
                      />
                    )}
                  </rect>
                );
              }),
            )}
          </g>
        )}
        {content === "world" && (
          <g>
            {Array.from({ length: 30 }).map((_, i) => {
              const px = U * 0.2 + ((i * 173) % (ww - U * 0.4));
              const py = -hh + U * 0.2 + ((i * 97) % (hh - U * 0.3));
              return (
                <circle key={i} cx={px} cy={py} r={1.2} fill={accent} opacity={0.5 + (i % 3) * 0.18}>
                  {i % 5 === 0 && (
                    <animate
                      attributeName="opacity"
                      values="0.2;1;0.2"
                      dur={`${1.6 + (i % 6) * 0.3}s`}
                      repeatCount="indefinite"
                    />
                  )}
                </circle>
              );
            })}
          </g>
        )}
        <polygon
          points={`0,0 ${ww * 0.3},0 ${ww * 0.5},-${hh} 0,-${hh}`}
          fill="rgba(255,255,255,0.04)"
        />
      </g>
    </WallDecal>
  );
}

// ────────────────── DESKTOP ITEMS ──────────────────

export function Laptop({
  x = 0, y = 0, z = 1.3, color = "#1f2128", accent = "#a3e635",
}: {
  x?: number; y?: number; z?: number; color?: string; accent?: string;
}) {
  return (
    <g>
      <Box x={x} y={y} z={z} w={0.65} d={0.45} h={0.03} color={lighter(color, 0.1)} />
      <Plane
        corners={[
          [x + 0.05, y + 0.25, z + 0.031],
          [x + 0.6, y + 0.25, z + 0.031],
          [x + 0.6, y + 0.4, z + 0.031],
          [x + 0.05, y + 0.4, z + 0.031],
        ]}
        color={darker(color, 0.4)}
      />
      <Box x={x} y={y + 0.42} z={z + 0.03} w={0.65} d={0.04} h={0.42} color={color} />
      <Plane
        corners={[
          [x + 0.04, y + 0.418, z + 0.08],
          [x + 0.61, y + 0.418, z + 0.08],
          [x + 0.61, y + 0.418, z + 0.42],
          [x + 0.04, y + 0.418, z + 0.42],
        ]}
        color="#0a0d12"
      />
      <Plane
        corners={[
          [x + 0.08, y + 0.417, z + 0.12],
          [x + 0.38, y + 0.417, z + 0.12],
          [x + 0.38, y + 0.417, z + 0.16],
          [x + 0.08, y + 0.417, z + 0.16],
        ]}
        color={accent}
      />
      <Plane
        corners={[
          [x + 0.08, y + 0.417, z + 0.2],
          [x + 0.48, y + 0.417, z + 0.2],
          [x + 0.48, y + 0.417, z + 0.23],
          [x + 0.08, y + 0.417, z + 0.23],
        ]}
        color={accent}
        opacity={0.5}
      />
    </g>
  );
}

export function Keyboard({
  x = 0, y = 0, z = 1.3, w = 0.7, accent = "#5a5d65",
}: {
  x?: number; y?: number; z?: number; w?: number; accent?: string;
}) {
  return (
    <g>
      <Box x={x} y={y} z={z} w={w} d={0.22} h={0.03} color="#22252c" />
      <Plane
        corners={[
          [x + 0.18, y + 0.04, z + 0.031],
          [x + w - 0.18, y + 0.04, z + 0.031],
          [x + w - 0.18, y + 0.05, z + 0.031],
          [x + 0.18, y + 0.05, z + 0.031],
        ]}
        color={accent}
        opacity={0.7}
      />
    </g>
  );
}

export function Mouse({
  x = 0, y = 0, z = 1.3, color = "#22252c",
}: {
  x?: number; y?: number; z?: number; color?: string;
}) {
  const c = iso3(x + 0.07, y + 0.1, z + 0.015);
  return (
    <g>
      <ellipse cx={c.x} cy={c.y} rx={U * 0.085} ry={U * 0.055} fill={color} />
      <ellipse cx={c.x} cy={c.y - 1.4} rx={U * 0.07} ry={U * 0.045} fill={lighter(color, 0.1)} />
    </g>
  );
}

export function Mug({
  x = 0, y = 0, z = 1.3, color = "#ecf0f4", drink = "#5a3a24",
}: {
  x?: number; y?: number; z?: number; color?: string; drink?: string;
}) {
  return (
    <g>
      <Cylinder x={x + 0.1} y={y + 0.1} z={z} r={0.1} h={0.22} color={color} />
      <Cylinder x={x + 0.1} y={y + 0.1} z={z + 0.21} r={0.078} h={0.022} color={drink} />
    </g>
  );
}

export function Papers({
  x = 0, y = 0, z = 1.32, color = "#f8f5ee", accent = "#666",
}: {
  x?: number; y?: number; z?: number; color?: string; accent?: string;
}) {
  const a = iso3(x, y, z);
  const b = iso3(x + 0.4, y, z);
  const c = iso3(x + 0.4, y + 0.3, z);
  const d = iso3(x, y + 0.3, z);
  return (
    <g>
      <polygon
        points={`${fmt(a.x)},${fmt(a.y)} ${fmt(b.x)},${fmt(b.y)} ${fmt(c.x)},${fmt(c.y)} ${fmt(d.x)},${fmt(d.y)}`}
        fill={color}
      />
      {[0.06, 0.13, 0.2].map((dz, i) => {
        const p1 = iso3(x + 0.05, y + dz, z + 0.001);
        const q1 = iso3(x + 0.35, y + dz, z + 0.001);
        return (
          <line key={i} x1={p1.x} y1={p1.y} x2={q1.x} y2={q1.y} stroke={accent} strokeWidth={0.7} opacity={0.5} />
        );
      })}
    </g>
  );
}

// ────────────────── ROOM-SPECIFIC ──────────────────

export function Printer3D({
  x = 0, y = 0, accent = "#f472b6",
}: {
  x?: number; y?: number; accent?: string;
}) {
  const W = 0.82;
  return (
    <g>
      <Box x={x} y={y} w={W} d={W} h={1.1} color="#34373d" />
      <Plane corners={[[x + 0.13, y, 0.36], [x + W - 0.13, y, 0.36], [x + W - 0.13, y, 0.84], [x + 0.13, y, 0.84]]} color="#0a0c11" />
      <Plane corners={[[x + 0.22, y - 0.001, 0.42], [x + W - 0.22, y - 0.001, 0.42], [x + W - 0.22, y - 0.001, 0.46], [x + 0.22, y - 0.001, 0.46]]} color={lighter(accent, 0.4)} />
      <Plane corners={[[x + 0.36, y - 0.002, 0.46], [x + 0.5, y - 0.002, 0.46], [x + 0.5, y - 0.002, 0.66], [x + 0.36, y - 0.002, 0.66]]} color={accent} opacity={0.85} />
      <Plane corners={[[x + 0.14, y, 0.14], [x + 0.42, y, 0.14], [x + 0.42, y, 0.3], [x + 0.14, y, 0.3]]} color="#0a0c11" />
      <Plane corners={[[x + 0.18, y - 0.001, 0.18], [x + 0.38, y - 0.001, 0.18], [x + 0.38, y - 0.001, 0.22], [x + 0.18, y - 0.001, 0.22]]} color={accent} />
      <Box x={x} y={y} z={1.1} w={W} d={W} h={0.04} color={accent} />
    </g>
  );
}

export function Pedestal({
  x = 0, y = 0, accent = "#f472b6", display = "cube" as "cube" | "sphere" | "vase" | "figure",
  color = "#f0ebe1",
}: {
  x?: number; y?: number; accent?: string;
  display?: "cube" | "sphere" | "vase" | "figure";
  color?: string;
}) {
  const W = 0.7;
  return (
    <g>
      <Box x={x + 0.03} y={y + 0.03} w={W} d={W} h={0.08} color={darker(color, 0.18)} />
      <Box x={x + 0.07} y={y + 0.07} z={0.08} w={W - 0.08} d={W - 0.08} h={0.85} color={color} />
      <Box x={x + 0.03} y={y + 0.03} z={0.93} w={W} d={W} h={0.05} color={lighter(color, 0.1)} />
      {display === "cube" && <Box x={x + 0.24} y={y + 0.24} z={0.98} w={0.32} d={0.32} h={0.32} color={accent} />}
      {display === "sphere" && <Sphere x={x + W / 2 + 0.03} y={y + W / 2 + 0.03} z={1.18} r={0.22} color={accent} />}
      {display === "vase" && (
        <g>
          <Cylinder x={x + W / 2 + 0.03} y={y + W / 2 + 0.03} z={0.98} r={0.15} h={0.08} color={darker(accent, 0.3)} />
          <Cylinder x={x + W / 2 + 0.03} y={y + W / 2 + 0.03} z={1.06} r={0.12} h={0.22} color={accent} />
          <Sphere x={x + W / 2 + 0.03} y={y + W / 2 + 0.03} z={1.32} r={0.16} color={accent} />
        </g>
      )}
      {display === "figure" && (
        <g>
          <Box x={x + 0.3} y={y + 0.3} z={0.98} w={0.18} d={0.18} h={0.28} color={accent} />
          <Sphere x={x + W / 2 + 0.03} y={y + W / 2 + 0.03} z={1.32} r={0.1} color={lighter(accent, 0.15)} />
        </g>
      )}
    </g>
  );
}

export function LabBench({
  x = 0, y = 0, w = 2.4, color = "#e6eaed",
}: {
  x?: number; y?: number; w?: number; color?: string;
}) {
  const D = 0.84;
  return (
    <g>
      <Box x={x} y={y} w={w} d={D} h={0.9} color={color} />
      {Array.from({ length: Math.floor(w / 0.6) }).map((_, i) => (
        <Plane
          key={i}
          corners={[
            [x + 0.08 + i * 0.6, y, 0.14],
            [x + 0.52 + i * 0.6, y, 0.14],
            [x + 0.52 + i * 0.6, y, 0.74],
            [x + 0.08 + i * 0.6, y, 0.74],
          ]}
          color={darker(color, 0.12)}
        />
      ))}
      <Box x={x} y={y} z={0.9} w={w} d={D} h={0.06} color={lighter(color, 0.12)} />
      <Box x={x + w - 0.84} y={y + 0.14} z={0.92} w={0.7} d={0.62} h={0.04} color={darker(color, 0.4)} />
      <Box x={x + w - 0.8} y={y + 0.18} z={0.94} w={0.62} d={0.54} h={0.015} color="#5a7a8a" />
      <Cylinder x={x + w - 0.3} y={y + 0.3} z={0.96} r={0.03} h={0.25} color="#cfd6dc" />
      <Box x={x + w - 0.32} y={y + 0.28} z={1.21} w={0.04} d={0.32} h={0.03} color="#cfd6dc" />
    </g>
  );
}

export function Microscope({
  x = 0, y = 0, z = 1.3, accent = "#38bdf8",
}: {
  x?: number; y?: number; z?: number; accent?: string;
}) {
  return (
    <g>
      <Box x={x} y={y} z={z} w={0.5} d={0.4} h={0.08} color="#2a2c34" />
      <Box x={x + 0.18} y={y + 0.13} z={z + 0.08} w={0.14} d={0.14} h={0.04} color="#4a4d56" />
      <Box x={x + 0.13} y={y + 0.16} z={z + 0.12} w={0.08} d={0.12} h={0.36} color="#3a3d44" />
      <Box x={x + 0.14} y={y + 0.12} z={z + 0.48} w={0.12} d={0.16} h={0.12} color="#1a1c22" />
      <Cylinder x={x + 0.2} y={y + 0.22} z={z + 0.14} r={0.045} h={0.13} color="#1a1c22" />
      <Cylinder x={x + 0.2} y={y + 0.22} z={z + 0.12} r={0.03} h={0.018} color={accent} />
      <Cylinder x={x + 0.2} y={y + 0.2} z={z + 0.58} r={0.035} h={0.08} color="#0a0c11" />
    </g>
  );
}

export function Treadmill({
  x = 0, y = 0, accent = "#a78bfa",
}: {
  x?: number; y?: number; accent?: string;
}) {
  return (
    <g>
      <Box x={x} y={y} w={0.7} d={1.6} h={0.12} color="#2a2c34" />
      <Box x={x + 0.03} y={y + 0.03} z={0.12} w={0.64} d={1.3} h={0.04} color="#0e1015" />
      {[0.22, 0.5, 0.78, 1.06].map((dz, i) => (
        <Plane
          key={i}
          corners={[
            [x + 0.04, y + dz, 0.161],
            [x + 0.66, y + dz, 0.161],
            [x + 0.66, y + dz + 0.015, 0.161],
            [x + 0.04, y + dz + 0.015, 0.161],
          ]}
          color="#3a3d44"
        />
      ))}
      <Box x={x + 0.07} y={y + 1.34} z={0.12} w={0.12} d={0.12} h={0.85} color="#2a2c34" />
      <Box x={x + 0.51} y={y + 1.34} z={0.12} w={0.12} d={0.12} h={0.85} color="#2a2c34" />
      <Box x={x + 0.07} y={y + 1.36} z={0.92} w={0.56} d={0.1} h={0.28} color="#1a1d23" />
      <Plane
        corners={[
          [x + 0.13, y + 1.36 - 0.001, 1.0],
          [x + 0.57, y + 1.36 - 0.001, 1.0],
          [x + 0.57, y + 1.36 - 0.001, 1.14],
          [x + 0.13, y + 1.36 - 0.001, 1.14],
        ]}
        color={accent}
        opacity={0.9}
      />
      <Box x={x + 0.04} y={y + 0.86} z={0.78} w={0.04} d={0.5} h={0.04} color="#cfd6dc" />
      <Box x={x + 0.62} y={y + 0.86} z={0.78} w={0.04} d={0.5} h={0.04} color="#cfd6dc" />
    </g>
  );
}

export function DeskPhone({
  x = 0, y = 0, z = 1.3, accent = "#60a5fa",
}: {
  x?: number; y?: number; z?: number; accent?: string;
}) {
  return (
    <g>
      <Box x={x} y={y} z={z} w={0.38} d={0.3} h={0.05} color="#1f222a" />
      <Plane
        corners={[
          [x + 0.05, y + 0.06, z + 0.051],
          [x + 0.34, y + 0.06, z + 0.051],
          [x + 0.34, y + 0.2, z + 0.051],
          [x + 0.05, y + 0.2, z + 0.051],
        ]}
        color="#0f1117"
      />
      <Plane
        corners={[
          [x + 0.05, y + 0.22, z + 0.051],
          [x + 0.34, y + 0.22, z + 0.051],
          [x + 0.34, y + 0.27, z + 0.051],
          [x + 0.05, y + 0.27, z + 0.051],
        ]}
        color={accent}
      />
      <Box x={x + 0.03} y={y + 0.03} z={z + 0.05} w={0.35} d={0.08} h={0.07} color="#2a2d35" />
    </g>
  );
}

export function Headset({
  x = 0, y = 0, z = 1.3, accent = "#60a5fa",
}: {
  x?: number; y?: number; z?: number; accent?: string;
}) {
  const c = iso3(x + 0.18, y + 0.18, z + 0.3);
  return (
    <g>
      <Cylinder x={x + 0.18} y={y + 0.18} z={z} r={0.11} h={0.03} color="#22252c" />
      <Cylinder x={x + 0.18} y={y + 0.18} z={z + 0.03} r={0.028} h={0.27} color="#34373d" />
      <path
        d={`M ${fmt(c.x - 7)} ${fmt(c.y + 1)} Q ${fmt(c.x)} ${fmt(c.y - 8)} ${fmt(c.x + 7)} ${fmt(c.y + 1)}`}
        stroke="#22252c"
        strokeWidth={2.4}
        fill="none"
      />
      <ellipse cx={c.x - 7} cy={c.y + 3} rx={4} ry={2.4} fill={accent} />
      <ellipse cx={c.x + 7} cy={c.y + 3} rx={4} ry={2.4} fill={accent} />
    </g>
  );
}

export function YogaMat({
  x = 0, y = 0, color = "#a78bfa", w = 1.5, d = 0.62,
}: {
  x?: number; y?: number; color?: string; w?: number; d?: number;
}) {
  const p = (px: number, py: number) => iso3(x + px, y + py, 0.012);
  return (
    <g>
      <polygon points={pts([p(0, 0), p(w, 0), p(w, d), p(0, d)])} fill={color} />
      <polygon
        points={pts([p(0.05, 0.05), p(w - 0.05, 0.05), p(w - 0.05, d - 0.05), p(0.05, d - 0.05)])}
        fill={lighter(color, 0.12)}
        opacity={0.6}
      />
    </g>
  );
}

// ───── OvalTable ─────
export function OvalTable({
  x = 0, y = 0, w = 2.8, d = 1.7, color = "#b8855a",
}: {
  x?: number; y?: number; w?: number; d?: number; color?: string;
}) {
  const cx = x + w / 2;
  const cy = y + d / 2;
  const top = iso3(cx, cy, 1.18);
  const rx = (w * U) / 2 + 4;
  const ry = (d * U) / 2 - 3;
  return (
    <g>
      <Cylinder x={cx} y={cy} z={0} r={0.32} h={1.1} color={darker(color, 0.5)} />
      <ellipse cx={top.x} cy={top.y + 8} rx={rx * 1.05} ry={ry * 1.05} fill="rgba(0,0,0,0.15)" />
      <ellipse cx={top.x} cy={top.y + 5} rx={rx} ry={ry} fill={darker(color, 0.22)} />
      <ellipse cx={top.x} cy={top.y} rx={rx} ry={ry} fill={lighter(color, 0.05)} />
      <ellipse cx={top.x - rx * 0.3} cy={top.y - ry * 0.2} rx={rx * 0.4} ry={ry * 0.15} fill="rgba(255,255,255,0.18)" />
    </g>
  );
}

// ───── OfficeChair (4 facing directions) ─────
type ChairFace = "back-left" | "back-right" | "front-left" | "front-right";
export function OfficeChair({
  x = 0, y = 0, color = "#2d2f38", accent, face = "back-left", size = 0.66,
}: {
  x?: number; y?: number; color?: string; accent?: string;
  face?: ChairFace;
  /**
   * Chair footprint in world units. Default 0.66 (≈ 11% of a 6×6 room),
   * matching the handoff's 1.1 chair in a 10×10 room when both rooms are
   * scaled to the same on-screen proportion.
   */
  size?: number;
}) {
  const s = size;
  const halfR = s / 2;
  const cx = x + halfR;
  const cy = y + halfR;
  const baseR = halfR * 0.95; // outer radius of the rolling base star

  // 10-pt star points for the rolling base
  const basePts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? baseR : baseR * 0.32;
    const ex = cx + Math.cos(ang) * r;
    const ey = cy + Math.sin(ang) * r;
    const p = iso3(ex, ey, 0.04);
    basePts.push(`${fmt(p.x)},${fmt(p.y)}`);
  }

  // 5 wheel caps at outer star tips
  const wheels: React.ReactNode[] = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const ex = cx + Math.cos(ang) * baseR;
    const ey = cy + Math.sin(ang) * baseR;
    const p = iso3(ex, ey, 0.04);
    wheels.push(
      <ellipse key={i} cx={p.x} cy={p.y + 2} rx={U * 0.13 * (s / 1.1)} ry={U * 0.06 * (s / 1.1)} fill="#08090d" />,
    );
  }

  const seat = accent || color;
  const seatInset = s * 0.13;
  const seatW = s - seatInset * 2;
  const armInset = s * 0.07;
  const armLen = s - armInset * 2;
  const armT = s * 0.055;
  const backThick = s * 0.13;

  return (
    <g>
      {wheels}
      <polygon points={basePts.join(" ")} fill="#15171c" />
      {(() => {
        const hub = iso3(cx, cy, 0.07);
        return <ellipse cx={hub.x} cy={hub.y} rx={U * 0.12 * (s / 1.1)} ry={U * 0.06 * (s / 1.1)} fill="#2a2d35" />;
      })()}
      {/* Gas lift */}
      <Box x={cx - s * 0.055} y={cy - s * 0.055} z={0.07} w={s * 0.11} d={s * 0.11} h={0.7} color="#15171c" />
      {/* Seat — slightly rounded look via two stacked slabs */}
      <Box x={x + seatInset} y={y + seatInset} z={0.77} w={seatW} d={seatW} h={0.1} color={darker(seat, 0.18)} />
      <Box x={x + seatInset + s * 0.04} y={y + seatInset + s * 0.04} z={0.87} w={seatW - s * 0.08} d={seatW - s * 0.08} h={0.1} color={seat} />
      {/* Arm rests — orientation depends on chair face */}
      {(face === "back-left" || face === "front-left") && (
        <>
          <Box x={x + armInset - armT / 2} y={y + armInset} z={0.95} w={armT} d={armLen} h={0.05} color="#15171c" />
          <Box x={x + s - armInset - armT / 2} y={y + armInset} z={0.95} w={armT} d={armLen} h={0.05} color="#15171c" />
        </>
      )}
      {(face === "back-right" || face === "front-right") && (
        <>
          <Box x={x + armInset} y={y + armInset - armT / 2} z={0.95} w={armLen} d={armT} h={0.05} color="#15171c" />
          <Box x={x + armInset} y={y + s - armInset - armT / 2} z={0.95} w={armLen} d={armT} h={0.05} color="#15171c" />
        </>
      )}
      {/* Back rest */}
      {face === "back-left" && (
        <>
          <Box x={x + seatInset} y={y + s - seatInset - backThick} z={0.87} w={seatW} d={backThick} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset + s * 0.04} y={y + s - seatInset - backThick + 0.02} z={1.42} w={seatW - s * 0.08} d={backThick - 0.04} h={0.9} color={seat} />
          <Box x={x + seatInset + s * 0.13} y={y + s - seatInset - backThick + 0.02} z={2.32} w={seatW - s * 0.26} d={backThick - 0.06} h={0.18} color={darker(seat, 0.3)} />
        </>
      )}
      {face === "back-right" && (
        <>
          <Box x={x + s - seatInset - backThick} y={y + seatInset} z={0.87} w={backThick} d={seatW} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + s - seatInset - backThick + 0.02} y={y + seatInset + s * 0.04} z={1.42} w={backThick - 0.04} d={seatW - s * 0.08} h={0.9} color={seat} />
          <Box x={x + s - seatInset - backThick + 0.02} y={y + seatInset + s * 0.13} z={2.32} w={backThick - 0.06} d={seatW - s * 0.26} h={0.18} color={darker(seat, 0.3)} />
        </>
      )}
      {face === "front-left" && (
        <>
          <Box x={x + seatInset} y={y + seatInset - backThick + 0.06} z={0.87} w={seatW} d={backThick} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset + s * 0.04} y={y + seatInset - backThick + 0.06} z={1.42} w={seatW - s * 0.08} d={backThick - 0.04} h={0.9} color={seat} />
        </>
      )}
      {face === "front-right" && (
        <>
          <Box x={x + seatInset - backThick + 0.06} y={y + seatInset} z={0.87} w={backThick} d={seatW} h={0.55} color={darker(seat, 0.15)} />
          <Box x={x + seatInset - backThick + 0.06} y={y + seatInset + s * 0.04} z={1.42} w={backThick - 0.04} d={seatW - s * 0.08} h={0.9} color={seat} />
        </>
      )}
    </g>
  );
}

// ───── PendantLamp: cord + bell shade + glow disc ─────
export function PendantLamp({
  x = 0, y = 0, ceilZ = 4, dropTo = 3.0,
  color = "#f5d77a", shade: shadeC = "#f0eee5",
}: {
  x?: number; y?: number;
  ceilZ?: number; dropTo?: number;
  color?: string; shade?: string;
}) {
  const top = iso3(x, y, ceilZ);
  const bot = iso3(x, y, dropTo);
  return (
    <g>
      <line x1={top.x} y1={top.y} x2={bot.x} y2={bot.y} stroke="#1a1d23" strokeWidth={1.2} />
      <ellipse cx={bot.x} cy={bot.y - 2} rx={U * 0.32} ry={U * 0.14} fill={shadeC} />
      <ellipse cx={bot.x} cy={bot.y + 2} rx={U * 0.32} ry={U * 0.14} fill={darker(shadeC, 0.15)} />
      <ellipse cx={bot.x} cy={bot.y + 5} rx={U * 0.22} ry={U * 0.1} fill={color} opacity={0.95} />
    </g>
  );
}

// ───── Plant: clustered foliage on a pot, optional taller variant ─────
export function Plant({
  x = 0, y = 0, color = "#4a8f5a", pot = "#8e6748", tall = false, size = 0.48,
}: {
  x?: number; y?: number;
  color?: string; pot?: string;
  tall?: boolean;
  /** Footprint in world units. Default 0.48 ≈ scaled-down version of handoff's 0.8. */
  size?: number;
}) {
  const baseH = tall ? 1.6 : 0.5;
  const half = size / 2;
  return (
    <g>
      <Cylinder x={x + half} y={y + half} z={0} r={half * 0.8} h={baseH * 0.5} color={pot} />
      <Cylinder x={x + half} y={y + half} z={baseH * 0.5} r={half * 0.75} h={0.05} color="#4a3a2a" />
      <Sphere x={x + half} y={y + half} z={baseH + 0.05} r={half * 1.05} color={color} />
      <Sphere x={x + half + size * 0.25} y={y + half - size * 0.1} z={baseH + 0.22} r={half * 0.75} color={lighter(color, 0.12)} />
      <Sphere x={x + half - size * 0.25} y={y + half + size * 0.2} z={baseH + 0.18} r={half * 0.7} color={darker(color, 0.1)} />
      <Sphere x={x + half + size * 0.06} y={y + half + size * 0.19} z={baseH + 0.35} r={half * 0.55} color={lighter(color, 0.18)} />
    </g>
  );
}

// ───── TallPlant: tall stem + clustered foliage at top ─────
export function TallPlant({
  x = 0, y = 0, color = "#4a8f5a", pot = "#23262c", size = 0.48,
}: {
  x?: number; y?: number;
  color?: string; pot?: string;
  size?: number;
}) {
  const half = size / 2;
  return (
    <g>
      <Cylinder x={x + half} y={y + half} z={0} r={half * 0.95} h={0.65} color={pot} />
      <Cylinder x={x + half} y={y + half} z={0.65} r={half * 0.9} h={0.04} color={darker(pot, 0.3)} />
      <Box x={x + half - 0.02} y={y + half - 0.02} z={0.69} w={0.04} d={0.04} h={1.5} color={darker(color, 0.4)} />
      <Sphere x={x + half} y={y + half} z={1.95} r={half * 1.35} color={color} />
      <Sphere x={x + half + size * 0.28} y={y + half - size * 0.13} z={2.1} r={half * 1.0} color={lighter(color, 0.12)} />
      <Sphere x={x + half - size * 0.25} y={y + half + size * 0.19} z={2.05} r={half * 0.9} color={darker(color, 0.08)} />
      <Sphere x={x + half + size * 0.025} y={y + half + size * 0.25} z={2.3} r={half * 0.8} color={lighter(color, 0.05)} />
      <Sphere x={x + half - size * 0.13} y={y + half - size * 0.19} z={2.35} r={half * 0.7} color={color} />
    </g>
  );
}

// ───── Rug: rounded floor mat with subtle inner highlight ─────
export function Rug({
  x = 0, y = 0, w = 2, d = 2, color = "#d4a373", opacity = 1,
}: {
  x?: number; y?: number; w?: number; d?: number;
  color?: string; opacity?: number;
}) {
  const p = (px: number, py: number) => iso3(x + px, y + py, 0.006);
  return (
    <g>
      <polygon points={pts([p(0, 0), p(w, 0), p(w, d), p(0, d)])} fill={color} opacity={opacity} />
      <polygon
        points={pts([p(0.1, 0.1), p(w - 0.1, 0.1), p(w - 0.1, d - 0.1), p(0.1, d - 0.1)])}
        fill={lighter(color, 0.12)}
        opacity={opacity * 0.6}
      />
    </g>
  );
}

// ───── Clock: pasted onto a wall, with an animated second hand ─────
export function Clock({
  wall = "right", u = 4.0, v = 2.5, size = 1.0,
}: {
  wall?: "left" | "right";
  u?: number; v?: number;
  /** Multiplier for the clock face radius (1 = standard). */
  size?: number;
}) {
  const r = U * 0.5 * size;
  return (
    <WallDecal wall={wall} u={u} v={v}>
      <circle cx={0} cy={0} r={r} fill="#0d0f14" />
      <circle cx={0} cy={0} r={r * 0.92} fill="#fafafa" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
        const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const r1 = r * 0.76;
        const r2 = i % 3 === 0 ? r * 0.6 : r * 0.68;
        return (
          <line
            key={i}
            x1={Math.cos(ang) * r1}
            y1={Math.sin(ang) * r1}
            x2={Math.cos(ang) * r2}
            y2={Math.sin(ang) * r2}
            stroke="#1a1a1e"
            strokeWidth={i % 3 === 0 ? 2 : 1}
          />
        );
      })}
      <line x1={0} y1={0} x2={0} y2={-r * 0.6} stroke="#1a1a1e" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={0} y1={0} x2={r * 0.44} y2={r * 0.16} stroke="#1a1a1e" strokeWidth={1.6} strokeLinecap="round" />
      <line x1={0} y1={0} x2={0} y2={-r * 0.8} stroke="#c96442" strokeWidth={1} strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="60s" repeatCount="indefinite" />
      </line>
      <circle cx={0} cy={0} r={1.8} fill="#c96442" />
    </WallDecal>
  );
}

// Re-export a few primitives so room compositions can grab everything from one
// entry point.
export { FloorLightPool, FloorRect } from "./primitives";
