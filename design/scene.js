/* ========================================================================
   Factory Floor — Isometric scene builder (SVG)
   2:1 isometric. Tile = 64 wide, 32 tall in screen space.
   World coordinates: (x, y) → screen (sx = (x - y) * TW/2, sy = (x + y) * TH/2)
   ======================================================================== */

const TW = 64;       // tile width
const TH = 32;       // tile height
const WALL_H = 60;   // wall height in screen px

const ROOM_W = 6;    // tiles per room (room is square)
const ROOM_H = 6;
const GAP = 1;       // tile gap between rooms

// project world point to screen
function iso(x, y) {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}

function roomOrigin(col, row) {
  // top-left tile of the room (in world coords)
  return {
    wx: col * (ROOM_W + GAP),
    wy: row * (ROOM_H + GAP),
  };
}

// All rooms anchored so the centroid of the layout is roughly (0,0)
function getRoomBounds(roomId) {
  const room = window.FACTORY_DATA.ROOMS[roomId];
  const { wx, wy } = roomOrigin(room.col, room.row);
  return { x0: wx, y0: wy, x1: wx + ROOM_W, y1: wy + ROOM_H };
}

// returns center of a room in screen coords (relative to scene origin)
function roomCenter(roomId) {
  const b = getRoomBounds(roomId);
  return iso((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
}

// Build iso polygon points for a floor tile-rectangle (x0..x1, y0..y1 world)
function floorPoly(x0, y0, x1, y1) {
  const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), d = iso(x0, y1);
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;
}

// extruded wall along south edge (y1 line, from x0..x1) — facing camera lower-left
function wallSouthPoly(x0, y0, x1, y1, h) {
  const c = iso(x1, y1), d = iso(x0, y1);
  return `${d.x},${d.y} ${c.x},${c.y} ${c.x},${c.y - h} ${d.x},${d.y - h}`;
}
// wall east edge (x1 line, from y0..y1)
function wallEastPoly(x0, y0, x1, y1, h) {
  const b = iso(x1, y0), c = iso(x1, y1);
  return `${c.x},${c.y} ${b.x},${b.y} ${b.x},${b.y - h} ${c.x},${c.y - h}`;
}
// wall north (y0 line)
function wallNorthPoly(x0, y0, x1, y1, h) {
  const a = iso(x0, y0), b = iso(x1, y0);
  return `${a.x},${a.y} ${b.x},${b.y} ${b.x},${b.y - h} ${a.x},${a.y - h}`;
}
// wall west (x0 line)
function wallWestPoly(x0, y0, x1, y1, h) {
  const a = iso(x0, y0), d = iso(x0, y1);
  return `${a.x},${a.y} ${d.x},${d.y} ${d.x},${d.y - h} ${a.x},${a.y - h}`;
}

// draw an iso "box" prop (a small extruded rectangle) at world (x,y) with size (w, d, h_screen)
function isoBox(x, y, w, d, h, fillTop, fillRight, fillLeft) {
  // world corners
  const a = iso(x, y);
  const b = iso(x + w, y);
  const c = iso(x + w, y + d);
  const dd = iso(x, y + d);
  const top = `${a.x},${a.y - h} ${b.x},${b.y - h} ${c.x},${c.y - h} ${dd.x},${dd.y - h}`;
  const right = `${b.x},${b.y - h} ${b.x},${b.y} ${c.x},${c.y} ${c.x},${c.y - h}`;
  const left  = `${dd.x},${dd.y - h} ${dd.x},${dd.y} ${c.x},${c.y} ${c.x},${c.y - h}`;
  return `
    <polygon points="${left}"  fill="${fillLeft}"  />
    <polygon points="${right}" fill="${fillRight}" />
    <polygon points="${top}"   fill="${fillTop}"   />`;
}

// Convenience: draw a flat panel on a wall (e.g. holo screen)
// `face` = 'south' | 'east' | 'north' | 'west'
function wallPanel(face, x0, y0, x1, y1, baseY, height, color) {
  // returns a polygon stuck on the inner face of the wall, slightly inset
  if (face === 'south') {
    const a = iso(x0 + 0.2, y1 - 0.05), b = iso(x1 - 0.2, y1 - 0.05);
    return `<polygon points="${a.x},${a.y - baseY} ${b.x},${b.y - baseY} ${b.x},${b.y - baseY - height} ${a.x},${a.y - baseY - height}" fill="${color}" />`;
  }
  if (face === 'east') {
    const a = iso(x1 - 0.05, y0 + 0.2), b = iso(x1 - 0.05, y1 - 0.2);
    return `<polygon points="${a.x},${a.y - baseY} ${b.x},${b.y - baseY} ${b.x},${b.y - baseY - height} ${a.x},${a.y - baseY - height}" fill="${color}" />`;
  }
  return '';
}

/* ============== Per-room prop layouts ==============
   Each room is 6x6 tiles. Origin at room top-left.
   Avatars are positioned at "desk" hot-spots (in world coords) returned below.
*/

function deskHotspot(roomId) {
  const b = getRoomBounds(roomId);
  // central hot-spot toward the south of the room (so wall is behind)
  const cx = (b.x0 + b.x1) / 2;
  const cy = b.y0 + (ROOM_H * 0.55);
  return { x: cx, y: cy };
}

function buildRoomProps(roomId) {
  const room = window.FACTORY_DATA.ROOMS[roomId];
  const b = getRoomBounds(roomId);
  const ox = b.x0, oy = b.y0;
  const TOP = '#1f2a37', RIGHT = '#15202b', LEFT = '#1a2532';
  const SCREEN_TINT = 'rgba(95, 212, 240, 0.5)';

  let svg = '';

  // central holo / desk varies by room kind
  if (room.kind === 'bridge') {
    // command bridge: ring table + tall data wall on north + 2 chairs
    svg += isoBox(ox + 2, oy + 2.2, 2, 2, 8, '#243140', '#1a2532', '#1f2a37');     // round table base
    svg += isoBox(ox + 2.4, oy + 2.6, 1.2, 1.2, 12, '#2c3a4d', '#1f2a37', '#243140'); // holo emitter
    // holo cylinder (faked)
    const ce = iso(ox + 3, oy + 3.2);
    svg += `<ellipse cx="${ce.x}" cy="${ce.y - 26}" rx="22" ry="6" fill="rgba(245,166,35,0.18)" />`;
    svg += `<ellipse cx="${ce.x}" cy="${ce.y - 32}" rx="14" ry="3.5" fill="rgba(245,166,35,0.32)" />`;
    // data wall on north
    svg += wallPanel('south', ox + 0.5, oy, ox + 5.5, oy + 0.5, 18, 28, 'rgba(245, 166, 35, 0.18)');
    // chairs
    svg += isoBox(ox + 1.3, oy + 3.5, 0.6, 0.6, 6, '#2a3849', '#1a2532', '#1f2a37');
    svg += isoBox(ox + 4.1, oy + 3.5, 0.6, 0.6, 6, '#2a3849', '#1a2532', '#1f2a37');
  }
  else if (room.kind === 'analyst') {
    // dual terminal desk + scrolling data wall + sample shelves
    svg += isoBox(ox + 1.5, oy + 3,   3,   1.4, 8, TOP, RIGHT, LEFT); // desk
    svg += isoBox(ox + 1.8, oy + 3.1, 1, 0.4, 12, '#101820', '#0c141b', '#0e161e'); // monitor 1 base
    svg += isoBox(ox + 1.8, oy + 3.1, 1, 0.1, 22, 'rgba(95, 212, 240, 0.55)', '#0c141b', '#0e161e'); // screen 1
    svg += isoBox(ox + 3.2, oy + 3.1, 1, 0.4, 12, '#101820', '#0c141b', '#0e161e'); // monitor 2
    svg += isoBox(ox + 3.2, oy + 3.1, 1, 0.1, 22, 'rgba(95, 212, 240, 0.55)', '#0c141b', '#0e161e');
    // data wall (north face)
    svg += wallPanel('south', ox + 0.5, oy, ox + 5.5, oy + 0.5, 14, 32, 'rgba(95, 212, 240, 0.18)');
    // shelves on east wall
    svg += wallPanel('east', ox + 5.5, oy + 1.8, ox + 6, oy + 4.4, 10, 6, 'rgba(95, 212, 240, 0.12)');
    svg += wallPanel('east', ox + 5.5, oy + 1.8, ox + 6, oy + 4.4, 22, 6, 'rgba(95, 212, 240, 0.12)');
  }
  else if (room.kind === 'fab') {
    // fabrication bay: design tablet + mood-board wall + small fab unit
    svg += isoBox(ox + 1.4, oy + 3, 2.4, 1.4, 8, TOP, RIGHT, LEFT); // workbench
    // tablet (tilted screen)
    svg += isoBox(ox + 1.8, oy + 3.2, 1.6, 0.9, 10, 'rgba(255, 107, 157, 0.45)', '#1a2532', '#1f2a37');
    // mood-board wall (multi-tile north face)
    svg += wallPanel('south', ox + 0.4, oy, ox + 5.6, oy + 0.5, 14, 30, 'rgba(255, 107, 157, 0.18)');
    // mini swatches across mood board
    for (let i = 0; i < 6; i++) {
      const xs = ox + 0.6 + i * 0.85;
      svg += wallPanel('south', xs, oy, xs + 0.6, oy + 0.5, 22 + (i % 2) * 4, 6, ['rgba(255,107,157,0.4)','rgba(95,212,240,0.4)','rgba(245,166,35,0.4)'][i % 3]);
    }
    // fab unit
    svg += isoBox(ox + 4.2, oy + 3, 1, 1.2, 16, '#243140', '#1a2532', '#1f2a37');
    svg += isoBox(ox + 4.3, oy + 3.1, 0.8, 1, 4, 'rgba(255, 107, 157, 0.35)', '#1a2532', '#1f2a37');
  }
  else if (room.kind === 'dispatch') {
    // dispatch console: long desk + 3 broadcast monitors + outbound tray
    svg += isoBox(ox + 1, oy + 3, 4, 1.2, 8, TOP, RIGHT, LEFT);
    for (let i = 0; i < 3; i++) {
      svg += isoBox(ox + 1.2 + i * 1.3, oy + 3.05, 1, 0.3, 14, 'rgba(107, 217, 104, 0.45)', '#0c141b', '#0e161e');
    }
    // outbound tray
    svg += isoBox(ox + 4.4, oy + 3.2, 0.6, 0.7, 4, '#2a3849', '#1a2532', '#1f2a37');
    // comms array on north wall
    svg += wallPanel('south', ox + 1, oy, ox + 5, oy + 0.5, 22, 6, 'rgba(107, 217, 104, 0.15)');
  }
  else if (room.kind === 'comms') {
    // comms station: small desk + chat windows on wall screens + hold-music indicator
    svg += isoBox(ox + 2, oy + 3, 2, 1.2, 8, TOP, RIGHT, LEFT);
    svg += isoBox(ox + 2.2, oy + 3.05, 1.6, 0.3, 12, 'rgba(106, 169, 255, 0.5)', '#0c141b', '#0e161e');
    // headset prop (small box)
    svg += isoBox(ox + 2.1, oy + 3.7, 0.4, 0.3, 4, '#2a3849', '#1a2532', '#1f2a37');
    // chat windows on north
    for (let i = 0; i < 3; i++) {
      svg += wallPanel('south', ox + 1 + i * 1.3, oy, ox + 1.9 + i * 1.3, oy + 0.5, 18, 14, 'rgba(106, 169, 255, 0.18)');
    }
  }
  else if (room.kind === 'control') {
    // resource control room: ledger displays (3 big screens) + secure terminal + budget gauge
    svg += isoBox(ox + 1.6, oy + 3, 2.8, 1.4, 8, TOP, RIGHT, LEFT);
    svg += isoBox(ox + 1.8, oy + 3.1, 2.4, 0.4, 12, '#101820', '#0c141b', '#0e161e');
    svg += isoBox(ox + 1.8, oy + 3.1, 2.4, 0.1, 22, 'rgba(196, 217, 67, 0.55)', '#0c141b', '#0e161e');
    // budget gauge on north
    svg += wallPanel('south', ox + 0.5, oy, ox + 5.5, oy + 0.5, 16, 4, 'rgba(196, 217, 67, 0.18)');
    svg += wallPanel('south', ox + 0.5, oy, ox + 2.6, oy + 0.5, 16, 4, 'rgba(196, 217, 67, 0.55)'); // 42% fill
    // secure terminal on east
    svg += wallPanel('east', ox + 5.5, oy + 2.5, ox + 6, oy + 4, 14, 18, 'rgba(196, 217, 67, 0.18)');
  }
  else if (room.kind === 'rd') {
    // R&D bay: experimental rigs + code on screens + server rack + holo-models
    svg += isoBox(ox + 1, oy + 3, 1.4, 1.4, 8, TOP, RIGHT, LEFT);
    svg += isoBox(ox + 1.1, oy + 3.1, 1.2, 0.35, 12, 'rgba(179, 147, 245, 0.45)', '#0c141b', '#0e161e');
    // server rack
    svg += isoBox(ox + 4, oy + 3, 1, 1.6, 22, '#1a2532', '#0c141b', '#15202b');
    for (let i = 0; i < 4; i++) {
      svg += isoBox(ox + 4, oy + 3, 1, 0.04, 6 + i * 5, 'rgba(179, 147, 245, 0.55)', '#0c141b', '#15202b');
    }
    // holo-model on east
    const ce = iso(ox + 3, oy + 4);
    svg += `<ellipse cx="${ce.x}" cy="${ce.y - 18}" rx="12" ry="3" fill="rgba(179, 147, 245, 0.35)" />`;
    svg += `<ellipse cx="${ce.x}" cy="${ce.y - 24}" rx="8" ry="2" fill="rgba(179, 147, 245, 0.5)" />`;
    // data wall
    svg += wallPanel('south', ox + 0.5, oy, ox + 5.5, oy + 0.5, 18, 24, 'rgba(179, 147, 245, 0.16)');
  }

  return svg;
}

function buildRoomShell(roomId) {
  const room = window.FACTORY_DATA.ROOMS[roomId];
  const b = getRoomBounds(roomId);
  const role = Object.values(window.FACTORY_DATA.ROLES).find(r => r.room === roomId);
  const accent = role ? role.colorHex : '#5fd4f0';

  // Floor tile pattern — slightly tinted by accent for "owned by role" feel
  const floor = floorPoly(b.x0, b.y0, b.x1, b.y1);

  // Accent strip along south edge — faint
  const stripA = iso(b.x0 + 0.05, b.y1 - 0.05);
  const stripB = iso(b.x1 - 0.05, b.y1 - 0.05);
  const accentLine = `<line x1="${stripA.x}" y1="${stripA.y}" x2="${stripB.x}" y2="${stripB.y}" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.2" />`;

  // Inner grid lines (subtle)
  let gridLines = '';
  for (let i = 1; i < ROOM_W; i++) {
    const a = iso(b.x0 + i, b.y0), c = iso(b.x0 + i, b.y1);
    gridLines += `<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#1f2a37" stroke-width="0.5" stroke-opacity="0.6" />`;
    const e = iso(b.x0, b.y0 + i), f = iso(b.x1, b.y0 + i);
    gridLines += `<line x1="${e.x}" y1="${e.y}" x2="${f.x}" y2="${f.y}" stroke="#1f2a37" stroke-width="0.5" stroke-opacity="0.6" />`;
  }

  // Walls — only north + east drawn (back walls); south + west are open toward camera
  const wallN = wallNorthPoly(b.x0, b.y0, b.x1, b.y1, WALL_H);
  const wallE = wallEastPoly(b.x0, b.y0, b.x1, b.y1, WALL_H);

  // Floor glow when active (animated agent)
  const glowPad = 0.15;
  const glowPoly = floorPoly(b.x0 - glowPad, b.y0 - glowPad, b.x1 + glowPad, b.y1 + glowPad);

  return `
    <g class="iso-room" data-room="${roomId}" data-name="${room.name}" data-occupant="${room.occupant}">
      <polygon class="room-glow" points="${glowPoly}" fill="${accent}" fill-opacity="0.06" />
      <polygon class="room-floor" points="${floor}" fill="#0f1620" stroke="#1a2532" stroke-width="0.6" />
      <polygon class="room-wall room-wall-n" points="${wallN}" fill="#0d141c" stroke="#1a2532" stroke-width="0.5" />
      <polygon class="room-wall room-wall-e" points="${wallE}" fill="#0a1118" stroke="#1a2532" stroke-width="0.5" />
      ${gridLines}
      ${accentLine}
      <g class="room-props">${buildRoomProps(roomId)}</g>
      <g class="room-label">${roomLabel(roomId, accent)}</g>
    </g>
  `;
}

function roomLabel(roomId, accent) {
  const room = window.FACTORY_DATA.ROOMS[roomId];
  const b = getRoomBounds(roomId);
  // Place a small ground-decal label inside the room near south edge
  const c = iso((b.x0 + b.x1) / 2, b.y1 - 0.4);
  // lift it just above floor
  return `
    <text x="${c.x}" y="${c.y}" text-anchor="middle"
          font-family="Geist Mono, monospace" font-size="6.5" letter-spacing="1.2"
          fill="${accent}" fill-opacity="0.7" style="text-transform:uppercase;">
      ${room.name.toUpperCase()}
    </text>
  `;
}

/* ============== Avatar (DOM-positioned, not SVG) ============== */
// Avatars live in a DOM layer positioned over the SVG so we can animate
// position smoothly (CSS transforms) and easily attach state bubbles.

function buildAvatarFigure(role) {
  // Simple stylized figure: head + torso + glow ring at base
  // Uses inline SVG inside a div so we can position with translate3d
  const c = role.colorHex;
  const archetype = role.archetype;
  // archetype-specific silhouette tweaks
  const torsoH = archetype === 'authoritative' ? 18 : archetype === 'slim' ? 16 : archetype === 'lab' ? 19 : 17;
  const torsoW = archetype === 'formal' ? 11 : archetype === 'lab' ? 12 : 10;
  const headR  = 4;
  const isLab  = archetype === 'lab';
  const isAuth = archetype === 'authoritative';

  return `
    <svg viewBox="-16 -36 32 44" width="32" height="44" style="overflow: visible;">
      <!-- glow ring at feet -->
      <ellipse cx="0" cy="2" rx="11" ry="3" fill="${c}" fill-opacity="0.35" filter="blur(2px)" />
      <ellipse cx="0" cy="2" rx="7"  ry="2" fill="${c}" fill-opacity="0.7"  />
      <!-- shadow under feet -->
      <ellipse cx="0" cy="3" rx="9" ry="2" fill="#000" fill-opacity="0.45" />
      <!-- legs -->
      <rect x="-3" y="-12" width="2.2" height="14" rx="1" fill="#1f2a37" />
      <rect x="0.8" y="-12" width="2.2" height="14" rx="1" fill="#1f2a37" />
      <!-- torso -->
      <rect x="${-torsoW/2}" y="${-torsoH-12}" width="${torsoW}" height="${torsoH+2}" rx="2.5" fill="#2a3849" />
      <!-- vest accent (role color) -->
      <rect x="${-torsoW/2 + 1.5}" y="${-torsoH-9}" width="${torsoW - 3}" height="${torsoH - 6}" rx="1.5" fill="${c}" fill-opacity="0.85" />
      ${isAuth ? `<rect x="${-torsoW/2 - 1}" y="${-torsoH-10}" width="${torsoW + 2}" height="3" rx="0.5" fill="#0e1620" />` : ''}
      ${isLab ? `<rect x="${-torsoW/2 - 0.5}" y="${-torsoH-8}" width="${torsoW + 1}" height="${torsoH-4}" rx="1.5" fill="#cdd5df" fill-opacity="0.85" />` : ''}
      <!-- head -->
      <circle cx="0" cy="${-torsoH-12-headR-0.5}" r="${headR}" fill="#d8b894" />
      <!-- hair cap -->
      <path d="M ${-headR-0.5} ${-torsoH-12-headR+0.5} Q 0 ${-torsoH-12-headR*2-1} ${headR+0.5} ${-torsoH-12-headR+0.5} L ${headR-0.5} ${-torsoH-12-headR+1} L ${-headR+0.5} ${-torsoH-12-headR+1} Z"
            fill="#1f2a37" />
    </svg>
  `;
}

/* ============== Mount ============== */

window.FactoryScene = {
  TW, TH, WALL_H, ROOM_W, ROOM_H, GAP,
  iso, roomCenter, getRoomBounds, deskHotspot,
  buildRoomShell, buildAvatarFigure,
};
