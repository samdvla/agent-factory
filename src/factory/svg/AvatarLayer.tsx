import { useEffect, useRef, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { ROLES } from "../state/fixtures";
import { deskHotspot, iso } from "./geometry";
import Avatar from "./Avatar";

export default function AvatarLayer({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  const agents = useFactoryStore((s) => s.agents);
  const selectAgent = useFactoryStore((s) => s.selectAgent);
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState<object>({});

  useEffect(() => {
    const reposition = () => force({});
    window.addEventListener("resize", reposition);
    requestAnimationFrame(reposition);
    return () => window.removeEventListener("resize", reposition);
  }, []);

  const project = (roomId: string): { left: number; top: number } | null => {
    const svg = svgRef.current;
    const layer = layerRef.current;
    if (!svg || !layer) return null;
    const hp = deskHotspot(roomId);
    const w = iso(hp.x, hp.y);
    const pt = svg.createSVGPoint();
    pt.x = w.x;
    pt.y = w.y;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const screen = pt.matrixTransform(ctm);
    const layerRect = layer.getBoundingClientRect();
    return { left: screen.x - layerRect.left, top: screen.y - layerRect.top };
  };

  return (
    <div
      ref={layerRef}
      id="avatar-layer"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {Object.values(ROLES).map((role) => {
        const agent = agents[role.id];
        if (!agent) return null;
        const pos = project(role.room);
        if (!pos) return null;
        return (
          <div
            key={role.id}
            style={{
              position: "absolute",
              left: pos.left,
              top: pos.top,
              transform: "translate(-50%, -100%)",
              transition: "left 1.6s cubic-bezier(.4,0,.2,1), top 1.6s cubic-bezier(.4,0,.2,1)",
              pointerEvents: "auto",
            }}
          >
            <Avatar
              role={role}
              state={agent.state}
              onClick={() => selectAgent(role.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
