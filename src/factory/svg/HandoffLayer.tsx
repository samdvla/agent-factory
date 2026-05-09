import { useEffect, useRef, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { deskHotspot, iso } from "./geometry";

type Trail = { id: string; left: number; top: number; color: string };

export default function HandoffLayer({
  svgRef,
  zoom,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  zoom: number;
}) {
  const handoffs = useFactoryStore((s) => s.handoffs);
  const expireHandoffs = useFactoryStore((s) => s.expireHandoffs);
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState<object>({});
  const [trails, setTrails] = useState<Trail[]>([]);
  const lastTrailAt = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      force({});
      const now = Date.now();
      if (handoffs.length && now - lastTrailAt.current > 60) {
        lastTrailAt.current = now;
        const newTrails: Trail[] = [];
        const layer = layerRef.current;
        const svg = svgRef.current;
        if (layer && svg) {
          const layerRect = layer.getBoundingClientRect();
          for (const h of handoffs) {
            const pos = projectAt(svg, layerRect, h, now);
            if (pos) {
              newTrails.push({
                id: `${h.id}-${now}`,
                left: pos.left,
                top: pos.top,
                color: h.color,
              });
            }
          }
        }
        if (newTrails.length) {
          setTrails((t) => [...t.slice(-30), ...newTrails]);
          setTimeout(() => {
            setTrails((t) => t.filter((x) => !newTrails.find((n) => n.id === x.id)));
          }, 800);
        }
      }
      expireHandoffs(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [handoffs, expireHandoffs, svgRef]);

  useEffect(() => {
    const reposition = () => force({});
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, []);

  return (
    <div ref={layerRef} id="handoff-layer">
      {trails.map((t) => (
        <span
          key={t.id}
          className="handoff-trail"
          style={
            {
              left: t.left,
              top: t.top,
              transform: `scale(${zoom})`,
              ["--doc-color" as string]: t.color,
            } as React.CSSProperties
          }
        />
      ))}
      {handoffs.map((h) => {
        const svg = svgRef.current;
        const layer = layerRef.current;
        if (!svg || !layer) return null;
        const pos = projectAt(svg, layer.getBoundingClientRect(), h, Date.now());
        if (!pos) return null;
        const arc = pos.arcRotate;
        return (
          <div
            key={h.id}
            className="handoff-doc"
            style={
              {
                left: pos.left,
                top: pos.top,
                transform: `scale(${zoom}) rotate(${arc}deg)`,
                ["--doc-color" as string]: h.color,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

function projectAt(
  svg: SVGSVGElement,
  layerRect: DOMRect,
  h: { fromRoom: string; toRoom: string; startedAt: number; durationMs: number },
  now: number,
): { left: number; top: number; arcRotate: number } | null {
  const tRaw = (now - h.startedAt) / h.durationMs;
  const t = Math.max(0, Math.min(1, tRaw));
  const ease = t < 0.5
    ? 2 * t * t
    : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const fromW = iso(deskHotspot(h.fromRoom).x, deskHotspot(h.fromRoom).y);
  const toW = iso(deskHotspot(h.toRoom).x, deskHotspot(h.toRoom).y);
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const fp = svg.createSVGPoint();
  fp.x = fromW.x; fp.y = fromW.y;
  const tp = svg.createSVGPoint();
  tp.x = toW.x; tp.y = toW.y;
  const fromS = fp.matrixTransform(ctm);
  const toS = tp.matrixTransform(ctm);
  const arcLift = -Math.min(120, Math.hypot(toS.x - fromS.x, toS.y - fromS.y) * 0.35);
  const mx = (fromS.x + toS.x) / 2;
  const my = (fromS.y + toS.y) / 2 + arcLift;
  const oneMinus = 1 - ease;
  const x = oneMinus * oneMinus * fromS.x + 2 * oneMinus * ease * mx + ease * ease * toS.x;
  const y = oneMinus * oneMinus * fromS.y + 2 * oneMinus * ease * my + ease * ease * toS.y;

  const dx = 2 * oneMinus * (mx - fromS.x) + 2 * ease * (toS.x - mx);
  const dy = 2 * oneMinus * (my - fromS.y) + 2 * ease * (toS.y - my);
  const arcRotate = (Math.atan2(dy, dx) * 180) / Math.PI;

  return {
    left: x - layerRect.left,
    top: y - layerRect.top,
    arcRotate,
  };
}
