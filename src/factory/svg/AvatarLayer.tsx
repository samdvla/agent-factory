import { useEffect, useMemo, useRef, useState } from "react";
import { useFactoryStore } from "../state/factoryStore";
import { iso, ROOM_W, ROOM_H, roomOrigin } from "./geometry";
import { homeStationFor, stationCount, stationWorld } from "./stations";
import Avatar from "./Avatar";
import SpawnFx from "./kit/SpawnFx";
import DissolveFx from "./kit/DissolveFx";
import { DetailLevel } from "./viewport";
import { deriveThoughts } from "./thoughtText";

const STATION_DWELL_MIN_MS = 2600;
const STATION_DWELL_JITTER_MS = 2400;
const STATION_DWELL_IDLE_MS = 4200;       // idle agents linger longer
const WALK_SEGMENT_MS = 900;              // ms per waypoint segment

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
  const rewardsByRole = useFactoryStore((s) => s.rewardsByRole);
  const supervisorRunning = useFactoryStore((s) => s.supervisorRunning);

  // Per-role natural "thought" string for the speech-bubble cloud above each
  // avatar. Derived purely from agent state + counters (see deriveThoughts),
  // so it reads like a human thought rather than echoing raw ticker logs.
  // Keyed on `agents` so it recomputes only when an agent's state/job changes.
  const thoughts = useMemo(() => deriveThoughts(agents), [agents]);
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState<object>({});

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
  // Track which agentTravel entries WE installed (intra-room walks). Key is
  // role id, value is the `startedAt` we passed in — if the live travel's
  // startedAt no longer matches, ownership was taken over (e.g. by the
  // orchestrator's cross-room visit hook) and we hand it off.
  const intraTravelRef = useRef<Map<string, number>>(new Map());
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

  // Master station-rotation tick. Only fires while the supervisor is
  // running — when stopped, every agent stands at its home station and
  // animates with the gentle idle-breath cycle (matches user request:
  // "when they are idle make them just stand in place but when i tap on
  // start they should start moving around walking like the ones in the
  // zip"). Paused / crashed / killed agents stay put even while running.
  useEffect(() => {
    if (!supervisorRunning) return;
    const id = setInterval(() => {
      const now = Date.now();
      const store = useFactoryStore.getState();
      const liveAgents = store.agents;
      const liveTravel = store.agentTravel;
      const setAgentTravel = store.setAgentTravel;
      let changed = false;
      const next = { ...stationByRole };
      const nowMoving = new Set(movingRoles);

      for (const role of Object.values(store.roles)) {
        const agent = liveAgents[role.id];
        if (!agent) continue;

        // Cross-room travel (handoff) owns motion while in flight — skip.
        const travel = liveTravel[role.id];
        if (travel?.waypoints && travel.waypoints.length > 1 &&
            travel.startedAt !== undefined && travel.durationPerSegmentMs) {
          const segments = travel.waypoints.length - 1;
          const total = segments * travel.durationPerSegmentMs;
          if (now - travel.startedAt < total) continue;
          // Travel landed. Only auto-clear walks WE installed — match the
          // exact `startedAt` to confirm ownership. Orchestrator visit
          // hooks own their own travel and clear it themselves.
          if (intraTravelRef.current.get(role.id) === travel.startedAt) {
            setAgentTravel(role.id, null);
            intraTravelRef.current.delete(role.id);
          } else {
            intraTravelRef.current.delete(role.id);
            continue;
          }
        }

        const last = lastMoveAt.current[role.id] ?? 0;
        const isActive = agent.state === "working" || agent.state === "awaiting"
          || agent.state === "idle";
        if (!isActive) continue;

        const baseDwell = agent.state === "idle"
          ? STATION_DWELL_IDLE_MS
          : STATION_DWELL_MIN_MS;
        const dwell = baseDwell + Math.random() * STATION_DWELL_JITTER_MS;
        if (now - last < dwell) continue;

        const count = stationCount(role.room);
        if (count <= 1) continue;
        let pick = next[role.id] ?? homeStationFor(role.id, role.room);
        const current = next[role.id] ?? homeStationFor(role.id, role.room);
        for (let tries = 0; tries < 6 && pick === current; tries++) {
          pick = Math.floor(Math.random() * count);
        }
        if (pick === current) continue;

        // Fire a waypoint travel through a "corner" so the avatar walks
        // visibly along a path rather than sliding diagonally across the
        // room. The corner is biased toward the room front so the path
        // reads as "leave desk → cross open floor → arrive at new spot".
        const from = stationWorld(role.room, current);
        const to = stationWorld(role.room, pick);
        if (from && to) {
          const { wx, wy } = roomOrigin(
            store.rooms[role.room].col,
            store.rooms[role.room].row,
          );
          const corner = {
            x: wx + ROOM_W * 0.5 + (Math.random() - 0.5) * 1.0,
            y: wy + ROOM_H * 0.78 + (Math.random() - 0.5) * 0.6,
          };
          setAgentTravel(role.id, {
            roomId: role.room,
            stationIdx: pick,
            waypoints: [
              { x: from.x, y: from.y },
              corner,
              { x: to.x, y: to.y },
            ],
            startedAt: now,
            durationPerSegmentMs: WALK_SEGMENT_MS,
          });
          intraTravelRef.current.set(role.id, now);
        }

        next[role.id] = pick;
        lastMoveAt.current[role.id] = now;
        nowMoving.add(role.id);
        const walkMs = WALK_SEGMENT_MS * 2 + 80;
        setTimeout(() => {
          setMovingRoles((s) => {
            if (!s.has(role.id)) return s;
            const cp = new Set(s);
            cp.delete(role.id);
            return cp;
          });
        }, walkMs);
        changed = true;
      }

      if (changed) setStationByRole(next);
      if (nowMoving.size !== movingRoles.size) setMovingRoles(nowMoving);
    }, 700);
    return () => clearInterval(id);
  }, [stationByRole, movingRoles, supervisorRunning]);

  // When the supervisor stops, retire any of OUR intra-room travels so
  // every avatar settles back to its station rather than freezing mid-step.
  useEffect(() => {
    if (supervisorRunning) return;
    const setAgentTravel = useFactoryStore.getState().setAgentTravel;
    const liveTravel = useFactoryStore.getState().agentTravel;
    for (const roleId of Array.from(intraTravelRef.current.keys())) {
      const t = liveTravel[roleId];
      if (t && intraTravelRef.current.get(roleId) === t.startedAt) {
        setAgentTravel(roleId, null);
      }
      intraTravelRef.current.delete(roleId);
    }
    setMovingRoles(new Set());
  }, [supervisorRunning]);

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
    svg: SVGSVGElement,
    ctm: DOMMatrix,
    layerRect: DOMRect,
  ): { left: number; top: number; label: string } | null => {
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
    const screen = pt.matrixTransform(ctm);
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
  // Avatars are positioned with a GPU `transform` rather than `left`/`top`.
  // Animating left/top reflows the layer every frame (and forces the avatar's
  // drop-shadow filter to re-rasterize); a translate3d is compositor-only, so
  // a moving avatar's shadow rasterizes once and just composites. Visually
  // identical — same pixels, far cheaper.
  const transitionStyle = viewChanged
    ? "none"
    : "transform 1.4s cubic-bezier(.4,0,.2,1)";

  // The screen CTM and layer rect are identical for every avatar in a given
  // render, but reading them forces a synchronous layout. Hoist both out of
  // the per-avatar projection so each frame does one layout read instead of
  // one-per-avatar (the dominant cost while many agents are in transit).
  const svg = svgRef.current;
  const layer = layerRef.current;
  const ctm = svg?.getScreenCTM() ?? null;
  const layerRect = layer?.getBoundingClientRect() ?? null;

  return (
    <div
      ref={layerRef}
      id="avatar-layer"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {svg && ctm && layerRect && Object.values(roles).map((role) => {
        const agent = agents[role.id];
        if (!agent) return null;
        // Viewport cull: don't mount avatars whose room is off-screen. Also
        // covers the in-flight travel case via the travel.roomId destination
        // since we project against `role.room` here.
        const travel = agentTravel[role.id];
        const visRoom = travel?.roomId ?? role.room;
        const tier = detailLevels?.get(visRoom);
        if (tier === "hidden") return null;
        const pos = project(role.id, role.room, svg, ctm, layerRect);
        if (!pos) return null;
        const moving = movingRoles.has(role.id);
        const isTraveling = !!(travel?.waypoints && travel.waypoints.length > 1);
        // "shell" tier: avatar is off-screen but might be entering soon;
        // skip the smooth left/top transition so we don't waste compositor
        // time animating something the user can't see.
        const perAgentTransition =
          tier === "shell" || isTraveling ? "none" : transitionStyle;
        return (
          <div
            key={role.id}
            className={`avatar-anchor${moving || isTraveling ? " is-moving" : ""}`}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `translate3d(${pos.left - FOOT_X * zoom}px, ${
                pos.top - FOOT_Y * zoom
              }px, 0)`,
              transition: perAgentTransition,
              pointerEvents: "auto",
              willChange: "transform",
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
              rewards={rewardsByRole[role.id]}
              thought={thoughts[role.id]}
              onClick={() => selectAgent(role.id)}
            />
            {agent.state === "materializing" && (
              <SpawnFx accent={role.hex} scale={zoom} />
            )}
            {agent.state === "dissolving" && (
              <DissolveFx accent={role.hex} scale={zoom} />
            )}
          </div>
        );
      })}
    </div>
  );
}
