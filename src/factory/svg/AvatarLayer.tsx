import { useEffect, useRef, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { iso } from "./geometry";
import { homeStationFor, stationCount, stationWorld } from "./stations";
import Avatar from "./Avatar";
import SpawnFx from "./kit/SpawnFx";
import DissolveFx from "./kit/DissolveFx";
import { DetailLevel } from "./viewport";

const STATION_DWELL_MIN_MS = 2400;
const STATION_DWELL_JITTER_MS = 2200;

// Avatar SVG box: 32×44 with feet at element-local (16, 38). We anchor the
// element so its feet sit on the projected station point and scale around
// that same anchor so growing/shrinking with zoom never lifts the avatar
// off the floor.
const FOOT_X = 16;
const FOOT_Y = 38;

export default function AvatarLayer({
  svgRef,
  zoom,
  pan,
  detailLevels,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  zoom: number;
  pan: { x: number; y: number };
  /**
   * Optional per-room detail map. Avatars whose room is "hidden" skip
   * projection + DOM mounting entirely; "shell" avatars still mount but
   * forgo expensive transitions (their room is off-screen so the user
   * can't see motion anyway).
   */
  detailLevels?: Map<string, DetailLevel>;
}) {
  const agents = useFactoryStore((s) => s.agents);
  const agentTravel = useFactoryStore((s) => s.agentTravel);
  const selectAgent = useFactoryStore((s) => s.selectAgent);
  const roles = useFactoryStore((s) => s.roles);
  const wealthByRole = useFactoryStore((s) => s.wealthByRole);
  const realActivityAt = useFactoryStore((s) => s.realActivityAt);
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState<object>({});

  // Tick at 250ms while any agent's pulse window (1500ms after last real
  // event) is active, so the `.is-pulsing` class drops cleanly when it
  // expires without waiting for the next event.
  useEffect(() => {
    const anyRecent = Object.values(realActivityAt).some(
      (t) => t && Date.now() - t < 1500,
    );
    if (!anyRecent) return;
    const id = setInterval(() => force({}), 250);
    return () => clearInterval(id);
  }, [realActivityAt]);

  const [stationByRole, setStationByRole] = useState<Record<string, number>>(
    () => {
      const init: Record<string, number> = {};
      for (const role of Object.values(useFactoryStore.getState().roles)) {
        init[role.id] = homeStationFor(role.id, role.room);
      }
      return init;
    },
  );

  const lastMoveAt = useRef<Record<string, number>>({});
  const [movingRoles, setMovingRoles] = useState<Set<string>>(new Set());

  // Track previous view (zoom + pan). On the render where it changed, we
  // suppress the position transition so avatars snap to the new projection
  // instead of sliding 1.4s through the scene.
  const prevViewRef = useRef({ zoom, panX: pan.x, panY: pan.y });
  const viewChanged =
    prevViewRef.current.zoom !== zoom ||
    prevViewRef.current.panX !== pan.x ||
    prevViewRef.current.panY !== pan.y;
  useEffect(() => {
    prevViewRef.current = { zoom, panX: pan.x, panY: pan.y };
  });

  // Resize → reproject
  useEffect(() => {
    const reposition = () => force({});
    window.addEventListener("resize", reposition);
    requestAnimationFrame(reposition);
    return () => window.removeEventListener("resize", reposition);
  }, []);

  // Master station-rotation tick
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const liveAgents = useFactoryStore.getState().agents;
      let changed = false;
      const next = { ...stationByRole };
      const nowMoving = new Set(movingRoles);

      for (const role of Object.values(useFactoryStore.getState().roles)) {
        const agent = liveAgents[role.id];
        if (!agent) continue;
        const last = lastMoveAt.current[role.id] ?? 0;
        const dwell =
          STATION_DWELL_MIN_MS + Math.random() * STATION_DWELL_JITTER_MS;

        if (agent.state === "working" || agent.state === "awaiting") {
          if (now - last < dwell) continue;
          const count = stationCount(role.room);
          if (count <= 1) continue;
          let pick = next[role.id] ?? 0;
          for (let tries = 0; tries < 5 && pick === (next[role.id] ?? 0); tries++) {
            pick = Math.floor(Math.random() * count);
          }
          if (pick !== next[role.id]) {
            next[role.id] = pick;
            lastMoveAt.current[role.id] = now;
            nowMoving.add(role.id);
            setTimeout(() => {
              setMovingRoles((s) => {
                if (!s.has(role.id)) return s;
                const cp = new Set(s);
                cp.delete(role.id);
                return cp;
              });
            }, 1700);
            changed = true;
          }
        } else if (agent.state === "idle" || agent.state === "paused") {
          const home = homeStationFor(role.id, role.room);
          if ((next[role.id] ?? home) !== home && now - last > 3500) {
            next[role.id] = home;
            lastMoveAt.current[role.id] = now;
            nowMoving.add(role.id);
            setTimeout(() => {
              setMovingRoles((s) => {
                if (!s.has(role.id)) return s;
                const cp = new Set(s);
                cp.delete(role.id);
                return cp;
              });
            }, 1700);
            changed = true;
          }
        }
      }

      if (changed) setStationByRole(next);
      if (nowMoving.size !== movingRoles.size) setMovingRoles(nowMoving);
    }, 700);
    return () => clearInterval(id);
  }, [stationByRole, movingRoles]);

  // While any agent has a waypoint travel in flight, drive a rAF loop that
  // re-projects them every frame. The loop stops when all travel is done and
  // re-arms via a store subscription whenever new travel begins.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const active = Object.values(useFactoryStore.getState().agentTravel).some(
        (t) => t?.waypoints && t.waypoints.length > 1,
      );
      if (!active) {
        raf = 0;
        return;
      }
      force({});
      raf = requestAnimationFrame(tick);
    };
    // Subscribe to agentTravel changes — re-arm the loop when a new travel starts.
    const unsub = useFactoryStore.subscribe((state, prev) => {
      if (state.agentTravel === prev.agentTravel) return;
      const nowActive = Object.values(state.agentTravel).some(
        (t) => t?.waypoints && t.waypoints.length > 1,
      );
      if (nowActive && raf === 0) {
        raf = requestAnimationFrame(tick);
      }
    });
    // Initial check on mount
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
  }, []);

  const project = (
    roleId: string,
    roomId: string,
  ): { left: number; top: number; label: string } | null => {
    const svg = svgRef.current;
    const layer = layerRef.current;
    if (!svg || !layer) return null;

    const travel = agentTravel[roleId];

    // Waypoint-based travel: interpolate along the polyline so the agent
    // visibly walks through the corridors instead of cutting across rooms.
    let world: { x: number; y: number; label: string } | null = null;
    if (
      travel?.waypoints && travel.waypoints.length > 1 &&
      travel.startedAt !== undefined &&
      travel.durationPerSegmentMs
    ) {
      const wps = travel.waypoints;
      const segments = wps.length - 1;
      const total = segments * travel.durationPerSegmentMs;
      const elapsed = Math.min(total, Date.now() - travel.startedAt);
      const segIdx = Math.min(segments - 1, Math.floor(elapsed / travel.durationPerSegmentMs));
      const tRaw = (elapsed - segIdx * travel.durationPerSegmentMs) / travel.durationPerSegmentMs;
      const t = Math.max(0, Math.min(1, tRaw));
      // Smooth ease in/out per segment
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const a = wps[segIdx];
      const b = wps[segIdx + 1];
      world = {
        x: a.x + (b.x - a.x) * ease,
        y: a.y + (b.y - a.y) * ease,
        label: "in transit",
      };
    } else {
      const targetRoom = travel?.roomId ?? roomId;
      const idx = travel?.stationIdx ?? stationByRole[roleId] ?? 0;
      const stWorld = stationWorld(targetRoom, idx);
      if (!stWorld) return null;
      world = stWorld;
    }

    const w = iso(world.x, world.y);
    const pt = svg.createSVGPoint();
    pt.x = w.x;
    pt.y = w.y;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const screen = pt.matrixTransform(ctm);
    const layerRect = layer.getBoundingClientRect();
    return {
      left: screen.x - layerRect.left,
      top: screen.y - layerRect.top,
      label: world.label,
    };
  };

  // Position each avatar so its feet (FOOT_X, FOOT_Y in unscaled coords)
  // land on the projected screen point. The Avatar component handles size
  // scaling internally (by setting the SVG's width/height attributes), so
  // the SVG is always rasterized natively and stays crisp at any zoom.
  const transitionStyle = viewChanged
    ? "none"
    : "left 1.4s cubic-bezier(.4,0,.2,1), top 1.4s cubic-bezier(.4,0,.2,1)";

  return (
    <div
      ref={layerRef}
      id="avatar-layer"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {Object.values(roles).map((role) => {
        const agent = agents[role.id];
        if (!agent) return null;
        // Viewport cull: don't mount avatars whose room is off-screen. Also
        // covers the in-flight travel case via the travel.roomId destination
        // since we project against `role.room` here.
        const travel = agentTravel[role.id];
        const visRoom = travel?.roomId ?? role.room;
        const tier = detailLevels?.get(visRoom);
        if (tier === "hidden") return null;
        const pos = project(role.id, role.room);
        if (!pos) return null;
        const moving = movingRoles.has(role.id);
        const isTraveling = !!(travel?.waypoints && travel.waypoints.length > 1);
        const lastEventAt = realActivityAt[role.id] ?? 0;
        const isPulsing = lastEventAt > 0 && Date.now() - lastEventAt < 1500;
        // Round to 100ms buckets so back-to-back events still produce
        // distinct keys, but rapid micro-events don't thrash React.
        const pulseKey = lastEventAt > 0 ? Math.floor(lastEventAt / 100) : 0;
        // "shell" tier: avatar is off-screen but might be entering soon;
        // skip the smooth left/top transition so we don't waste compositor
        // time animating something the user can't see.
        const perAgentTransition =
          tier === "shell" || isTraveling ? "none" : transitionStyle;
        return (
          <div
            key={role.id}
            className={`avatar-anchor${moving || isTraveling ? " is-moving" : ""}`}
            data-pulse={isPulsing ? pulseKey : undefined}
            style={{
              position: "absolute",
              left: pos.left - FOOT_X * zoom,
              top: pos.top - FOOT_Y * zoom,
              transition: perAgentTransition,
              pointerEvents: "auto",
              willChange: "left, top",
            }}
            title={`${role.name} · ${role.title} · ${pos.label} · net $${
              (wealthByRole[role.id]?.lifetime_net_usd ?? 0).toFixed(2)
            }`}
          >
            <Avatar
              role={role}
              state={moving || isTraveling ? "walking" : agent.state}
              sizeScale={zoom}
              lifetimeNet={wealthByRole[role.id]?.lifetime_net_usd}
              onClick={() => selectAgent(role.id)}
            />
            {agent.state === "materializing" && (
              <SpawnFx accent={role.hex} scale={zoom} />
            )}
            {agent.state === "dissolving" && (
              <DissolveFx accent={role.hex} scale={zoom} />
            )}
            {isPulsing && (
              // Keyed on event timestamp so back-to-back events remount this
              // element and restart the CSS animation — without the key, the
              // class persists and the keyframes never replay.
              <span
                key={`pulse-${pulseKey}`}
                className="avatar-event-pulse"
                style={{ "--role-color": role.hex } as React.CSSProperties}
                aria-hidden
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
