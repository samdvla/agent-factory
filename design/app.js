/* ========================================================================
   Factory Floor — main app
   ======================================================================== */

const { ROLES, ROOMS, INITIAL_AGENTS, CHAT_HISTORY, LOG_FIXTURES, QUEUE_FIXTURES, TICKER_FIXTURES, ALERTS, GATE } = window.FACTORY_DATA;
const { buildRoomShell, buildAvatarFigure, roomCenter, deskHotspot, iso, ROOM_W, ROOM_H, GAP, WALL_H } = window.FactoryScene;

/* ---------------- App state ---------------- */
const state = {
  agents: structuredClone(INITIAL_AGENTS),
  selected: null,
  sandbox: true,
  allStop: false,
  alertTrayOpen: false,
  gateOpen: false,
  budget: { spent: 4.20, cap: 10.00 },
  // walking handoffs in progress
  handoffs: [],
  // active subscribers for re-render
  rerender: () => {},
};

const STATE_LABELS = {
  idle: 'Idle', working: 'Working', walking: 'Walking',
  awaiting: 'Awaiting input', paused: 'Paused', crashed: 'Crashed',
  killed: 'Killed', quarantined: 'Quarantined',
};

const STATE_GLYPH = {
  working: '⌨', idle: '·', walking: '→', awaiting: '?',
  paused: 'Z', crashed: '!', killed: '×', quarantined: '⚠',
};

/* ---------------- Build the iso scene ---------------- */

function buildScene() {
  // figure out scene bounds
  const bounds = Object.values(ROOMS).reduce((acc, r) => {
    const x0 = r.col * (ROOM_W + GAP), y0 = r.row * (ROOM_H + GAP);
    const x1 = x0 + ROOM_W, y1 = y0 + ROOM_H;
    [iso(x0,y0), iso(x1,y0), iso(x1,y1), iso(x0,y1)].forEach(p => {
      acc.minX = Math.min(acc.minX, p.x); acc.maxX = Math.max(acc.maxX, p.x);
      acc.minY = Math.min(acc.minY, p.y - WALL_H); acc.maxY = Math.max(acc.maxY, p.y);
    });
    return acc;
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  const pad = 60;
  const vbX = bounds.minX - pad;
  const vbY = bounds.minY - pad;
  const vbW = bounds.maxX - bounds.minX + pad * 2;
  const vbH = bounds.maxY - bounds.minY + pad * 2;

  // Render rooms in painter's order: top-back-most first.
  // Sort by (col + row) ascending so back rooms drawn first.
  const roomOrder = Object.keys(ROOMS).sort((a, b) => {
    const ra = ROOMS[a], rb = ROOMS[b];
    return (ra.row + ra.col) - (rb.row + rb.col);
  });

  const roomSvg = roomOrder.map(buildRoomShell).join('');

  // ground glow
  const groundCenter = iso(((Object.values(ROOMS).map(r=>r.col*(ROOM_W+GAP))).reduce((a,b)=>a+b,0)/7) + ROOM_W/2,
                           ((Object.values(ROOMS).map(r=>r.row*(ROOM_H+GAP))).reduce((a,b)=>a+b,0)/7) + ROOM_H/2);

  return {
    svg: `
      <svg viewBox="${vbX} ${vbY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" id="iso-svg">
        <defs>
          <radialGradient id="ground-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#5fd4f0" stop-opacity="0.06" />
            <stop offset="100%" stop-color="#5fd4f0" stop-opacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="${groundCenter.x}" cy="${groundCenter.y + 80}" rx="${vbW * 0.45}" ry="${vbH * 0.3}" fill="url(#ground-glow)" />
        ${roomSvg}
      </svg>
    `,
    viewBox: { x: vbX, y: vbY, w: vbW, h: vbH },
  };
}

/* ---------------- Avatar layer ---------------- */

function buildAvatarLayer() {
  const layer = document.getElementById('avatar-layer');
  layer.innerHTML = '';
  Object.values(ROLES).forEach(role => {
    const el = document.createElement('div');
    el.className = 'avatar';
    el.dataset.roleId = role.id;
    el.style.cssText = `
      position: absolute;
      left: 0; top: 0;
      width: 32px; height: 44px;
      transform-origin: 50% 100%;
      transition: left 1.6s cubic-bezier(.4,0,.2,1), top 1.6s cubic-bezier(.4,0,.2,1);
      cursor: pointer;
      pointer-events: auto;
    `;
    el.innerHTML = buildAvatarFigure(role);
    el.title = `${role.name} · ${role.title}`;
    el.addEventListener('click', () => openDrawer(role.id));
    layer.appendChild(el);
  });
  positionAvatars();
}

// project a (world x, y) point into the on-screen pixel coords of #avatar-layer
function worldToScreen(wx, wy) {
  const svg = document.getElementById('iso-svg');
  if (!svg) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  const p = iso(wx, wy);
  pt.x = p.x; pt.y = p.y;
  const ctm = svg.getScreenCTM();
  const layer = document.getElementById('avatar-layer');
  const layerRect = layer.getBoundingClientRect();
  const screen = pt.matrixTransform(ctm);
  return { x: screen.x - layerRect.left, y: screen.y - layerRect.top };
}

function positionAvatars() {
  Object.values(ROLES).forEach(role => {
    const agent = state.agents[role.id];
    if (!agent || agent.state === 'killed') {
      const el = document.querySelector(`.avatar[data-role-id="${role.id}"]`);
      if (el) el.style.opacity = '0';
      return;
    }
    const el = document.querySelector(`.avatar[data-role-id="${role.id}"]`);
    if (!el) return;
    el.style.opacity = agent.state === 'crashed' ? '0.55' : agent.state === 'quarantined' ? '0.65' : '1';

    const hot = deskHotspot(role.room);
    // small per-role offset so they don't all stand on the exact same tile
    const idx = Object.keys(ROLES).indexOf(role.id);
    const dx = ((idx % 3) - 1) * 0.4;
    const dy = (Math.floor(idx / 3) % 2) * 0.3;
    const screen = worldToScreen(hot.x + dx, hot.y + dy);
    el.style.left = (screen.x - 16) + 'px';
    el.style.top  = (screen.y - 44) + 'px';
  });
  positionBubbles();
}

function positionBubbles() {
  document.querySelectorAll('.avatar-bubble').forEach(b => {
    const id = b.dataset.bubbleFor;
    const av = document.querySelector(`.avatar[data-role-id="${id}"]`);
    if (!av) return;
    const rect = av.getBoundingClientRect();
    const layer = document.getElementById('avatar-layer').getBoundingClientRect();
    b.style.left = (rect.left - layer.left + rect.width / 2) + 'px';
    b.style.top  = (rect.top - layer.top) + 'px';
  });
}

function renderBubbles() {
  const layer = document.getElementById('avatar-layer');
  // remove existing
  layer.querySelectorAll('.avatar-bubble').forEach(b => b.remove());
  Object.values(ROLES).forEach(role => {
    const agent = state.agents[role.id];
    if (!agent || agent.state === 'killed') return;
    let bubble = null;
    if (agent.state === 'working' && agent.task) {
      bubble = `<span class="glyph" style="color:${role.colorHex}">${STATE_GLYPH.working}</span><span>${agent.task}</span>`;
    } else if (agent.state === 'awaiting') {
      bubble = `<span class="glyph" style="color:var(--accent-warm)">?</span><span>awaiting input</span>`;
    } else if (agent.state === 'paused') {
      bubble = `<span class="glyph" style="color:var(--ink-2)">Z</span><span>paused</span>`;
    } else if (agent.state === 'crashed') {
      bubble = `<span class="glyph" style="color:var(--accent-bad)">!</span><span>crashed · restart in 12s</span>`;
    } else if (agent.state === 'walking' && agent.task) {
      bubble = `<span class="glyph" style="color:${role.colorHex}">→</span><span>${agent.task}</span>`;
    } else if (agent.state === 'quarantined') {
      bubble = `<span class="glyph" style="color:var(--accent-warm)">⚠</span><span>quarantined</span>`;
    }
    if (!bubble) return;
    const el = document.createElement('div');
    el.className = 'avatar-bubble';
    el.dataset.bubbleFor = role.id;
    el.innerHTML = bubble;
    layer.appendChild(el);
  });
  positionBubbles();
}

/* ---------------- Top bar ---------------- */

function renderTopbar() {
  const pct = (state.budget.spent / state.budget.cap) * 100;
  const pctClass = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  document.getElementById('budget-fill').style.width = pct + '%';
  document.getElementById('budget-fill').className = 'budget-bar-fill ' + pctClass;
  document.getElementById('budget-spent').textContent = '$' + state.budget.spent.toFixed(2);
  document.getElementById('budget-cap').textContent = ' / $' + state.budget.cap.toFixed(2);

  const gateBtn = document.getElementById('gate-pill');
  const awaitingCount = Object.values(state.agents).filter(a => a.state === 'awaiting').length;
  if (awaitingCount > 0) {
    gateBtn.classList.remove('is-hidden');
    gateBtn.querySelector('.gate-count').textContent = awaitingCount;
  } else {
    gateBtn.classList.add('is-hidden');
  }

  document.getElementById('alert-count').textContent = ALERTS.length;
}

/* ---------------- Ticker ---------------- */

function renderTicker() {
  const track = document.getElementById('ticker-content');
  const now = new Date();
  const lines = TICKER_FIXTURES.map((line, i) => {
    const role = ROLES[line.role] || { colorHex: '#ef4f5a', name: 'Guardian' };
    const age = (i + 1) * 7 + 's ago';
    return `
      <span class="ticker-line" data-role="${line.role}">
        <span class="ts">${age}</span>
        <span class="role" style="color:${role.colorHex}">${(role.name || line.role).split(' ')[0]}</span>
        <span class="msg">${line.msg}</span>
        <span class="sep">·</span>
      </span>
    `;
  }).join('');
  // duplicate for seamless scroll
  track.innerHTML = lines + lines;
}

/* ---------------- Drawer ---------------- */

function openDrawer(roleId) {
  state.selected = roleId;
  renderDrawer();
  document.getElementById('drawer').classList.add('is-open');
  document.getElementById('drawer-scrim').classList.add('is-open');
  // mark room active
  document.querySelectorAll('.iso-room').forEach(r => r.classList.remove('is-active'));
  const role = ROLES[roleId];
  document.querySelector(`.iso-room[data-room="${role.room}"]`)?.classList.add('is-active');
}

function closeDrawer() {
  state.selected = null;
  document.getElementById('drawer').classList.remove('is-open');
  document.getElementById('drawer-scrim').classList.remove('is-open');
  document.querySelectorAll('.iso-room').forEach(r => r.classList.remove('is-active'));
}

function renderDrawer() {
  if (!state.selected) return;
  const role = ROLES[state.selected];
  const agent = state.agents[state.selected];
  const drawer = document.getElementById('drawer');
  drawer.style.setProperty('--role-color', role.colorHex);

  // header
  drawer.querySelector('.drawer-portrait').innerHTML = `
    <span style="font-size:22px; font-weight:600; color:${role.colorHex}">${role.portrait}</span>
  `;
  drawer.querySelector('.drawer-role').textContent = role.title;
  drawer.querySelector('.drawer-name').textContent = role.name;

  const pill = drawer.querySelector('.state-pill');
  pill.dataset.state = agent.state;
  pill.querySelector('.state-label').textContent = STATE_LABELS[agent.state] || agent.state;

  drawer.querySelector('.drawer-tokens').innerHTML = `<strong>${agent.tokens.toLocaleString()}</strong> tokens today`;
  drawer.querySelector('.drawer-model').textContent = agent.model;

  // chat
  const chatList = drawer.querySelector('.chat-list');
  const history = CHAT_HISTORY[role.id] || [];
  if (history.length === 0) {
    chatList.innerHTML = `<div style="color:var(--ink-3); font-size:11px; padding:20px 0; text-align:center; font-style:italic;">No conversation yet — type below to start.</div>`;
  } else {
    chatList.innerHTML = history.map(m => `
      <div class="chat-msg ${m.who}">
        <div class="chat-bubble">${m.text}</div>
        <div class="chat-time">${m.t}</div>
      </div>
    `).join('');
    chatList.scrollTop = chatList.scrollHeight;
  }

  // log
  const logList = drawer.querySelector('.log-list');
  const logs = LOG_FIXTURES[role.id] || [];
  drawer.querySelector('.log-section .count').textContent = logs.length;
  logList.innerHTML = logs.map(l => `
    <div class="log-line is-${l.kind}">
      <span class="l-ts">${l.t.slice(3)}</span>
      <span class="l-tag">${l.tag}</span>
      <span class="l-msg">${l.msg}</span>
    </div>
  `).join('');

  // queue
  const queueList = drawer.querySelector('.queue-list');
  const queue = QUEUE_FIXTURES[role.id] || [];
  drawer.querySelector('.queue-section .count').textContent = queue.length;
  queueList.innerHTML = queue.map(j => `
    <div class="queue-item" data-status="${j.status}">
      <span class="queue-status"></span>
      <span class="queue-title">${j.title}</span>
      <span class="queue-time">${j.time}</span>
      <span class="queue-cost">${j.cost}</span>
    </div>
  `).join('') || `<div style="color:var(--ink-3); font-size:11px; padding:18px 20px; font-style:italic;">No jobs in queue.</div>`;

  // controls
  const ctlPause = drawer.querySelector('[data-action="pause"]');
  if (agent.state === 'paused') {
    ctlPause.querySelector('.ctl-label').textContent = 'Resume';
    ctlPause.querySelector('.ctl-glyph').textContent = '▶';
    ctlPause.classList.add('primary');
  } else {
    ctlPause.querySelector('.ctl-label').textContent = 'Pause';
    ctlPause.querySelector('.ctl-glyph').textContent = '❚❚';
    ctlPause.classList.remove('primary');
  }
}

/* ---------------- Mock event stream ---------------- */
// Drives state changes so the floor feels alive.

const EVENT_SCRIPT = [
  // Each entry: { delay (ms after prev), apply: (state) => void }
  { delay: 4500, apply: () => {
      // designer finishes render → handoff to listing
      state.agents.designer.task = 'finalizing render';
      pushTicker('designer', 'render complete · packing brief for listing desk');
      animateHandoff('design', 'listing', '#ff6b9d');
      state.agents.listing.task = 'reading brief';
      state.agents.listing.state = 'working';
    }
  },
  { delay: 5000, apply: () => {
      state.agents.designer.state = 'idle';
      state.agents.designer.task = '';
      state.agents.listing.task = 'drafting copy v3';
      pushTicker('listing', 'drafting copy v3 · "Wabi-Sabi Ceramic Mug"');
    }
  },
  { delay: 4000, apply: () => {
      // research dispatches new findings
      state.agents.research.task = 'pricing scan';
      pushTicker('research', 'competitor pricing pulled · 14 listings sampled');
    }
  },
  { delay: 3500, apply: () => {
      // budget tick
      state.budget.spent = Math.min(state.budget.cap, state.budget.spent + 0.18);
      pushTicker('cfo', `budget tick · $${state.budget.spent.toFixed(2)} / $${state.budget.cap.toFixed(2)}`);
    }
  },
  { delay: 4500, apply: () => {
      // designer back to working — new variant request
      state.agents.designer.state = 'working';
      state.agents.designer.task = 'sdxl render';
      pushTicker('designer', 'new render request · seed 4915');
    }
  },
  { delay: 5500, apply: () => {
      // SI lab resumes briefly
      state.agents.si.state = 'working';
      state.agents.si.task = 'eval_patch';
      pushTicker('si', 'resumed · evaluating patch p-0120');
    }
  },
  { delay: 4500, apply: () => {
      state.agents.si.state = 'paused';
      state.agents.si.task = '';
      pushTicker('si', 'paused · score 0.58 below threshold');
    }
  },
];

function pushTicker(roleId, msg) {
  TICKER_FIXTURES.unshift({ role: roleId, msg });
  TICKER_FIXTURES.length = Math.min(TICKER_FIXTURES.length, 14);
  renderTicker();
}

function startEventStream() {
  let i = 0;
  function step() {
    if (state.allStop) { setTimeout(step, 500); return; }
    const ev = EVENT_SCRIPT[i % EVENT_SCRIPT.length];
    setTimeout(() => {
      ev.apply();
      renderBubbles();
      renderTopbar();
      if (state.selected) renderDrawer();
      i++;
      step();
    }, ev.delay);
  }
  step();
}

/* ---------------- Handoff animation ---------------- */
function animateHandoff(fromRoom, toRoom, color) {
  const layer = document.getElementById('avatar-layer');
  const a = roomCenter(fromRoom), b = roomCenter(toRoom);
  // use SVG-to-screen conversion
  const svg = document.getElementById('iso-svg');
  const pt = svg.createSVGPoint();
  const ctm = svg.getScreenCTM();
  const layerRect = layer.getBoundingClientRect();
  pt.x = a.x; pt.y = a.y;
  const sa = pt.matrixTransform(ctm);
  pt.x = b.x; pt.y = b.y;
  const sb = pt.matrixTransform(ctm);

  const doc = document.createElement('div');
  doc.className = 'handoff-doc';
  doc.style.cssText = `
    position: absolute;
    left: ${sa.x - layerRect.left - 6}px;
    top:  ${sa.y - layerRect.top - 24}px;
    width: 12px; height: 16px;
    background: ${color};
    border-radius: 2px;
    box-shadow: 0 0 12px ${color};
    transition: left 1.4s ease-in-out, top 1.4s ease-in-out, opacity 0.4s;
    z-index: 5;
  `;
  layer.appendChild(doc);
  requestAnimationFrame(() => {
    doc.style.left = (sb.x - layerRect.left - 6) + 'px';
    doc.style.top  = (sb.y - layerRect.top - 24) + 'px';
  });
  setTimeout(() => { doc.style.opacity = '0'; }, 1400);
  setTimeout(() => doc.remove(), 1900);
}

/* ---------------- Alert tray ---------------- */
function renderAlertTray() {
  const tray = document.getElementById('alert-tray');
  tray.innerHTML = `
    <div class="alert-tray-head">Alerts (${ALERTS.length})</div>
    ${ALERTS.map(a => `
      <div class="alert-row">
        <div class="alert-icon ${a.kind}">${a.kind === 'warn' ? '!' : '×'}</div>
        <div style="flex:1">
          <div class="a-title">${a.title}</div>
          <div class="a-sub">${a.sub}</div>
          <div class="a-time">${a.time}</div>
        </div>
      </div>
    `).join('')}
  `;
}

/* ---------------- Gate modal ---------------- */
function renderGateModal() {
  const role = ROLES[GATE.agent];
  const m = document.getElementById('gate-modal');
  m.querySelector('.modal-tag').textContent = `Gate · ${role.title}`;
  m.querySelector('.modal-title').textContent = GATE.title;
  m.querySelector('.modal-sub').textContent = `Action: ${GATE.action}`;
  m.querySelector('.gate-rationale').textContent = GATE.rationale;
  // payload
  const p = GATE.payload;
  const fmt = JSON.stringify(p, null, 2)
    .replace(/"([^"]+)":/g, '<span class="k">"$1":</span>')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (\d+)/g, ': <span class="n">$1</span>');
  m.querySelector('.payload').innerHTML = fmt;
}
function openGate() { state.gateOpen = true; document.getElementById('gate-scrim').classList.add('is-open'); }
function closeGate() { state.gateOpen = false; document.getElementById('gate-scrim').classList.remove('is-open'); }

/* ---------------- Wiring ---------------- */

function wireUp() {
  // close drawer
  document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);
  document.querySelector('.drawer-close').addEventListener('click', closeDrawer);

  // room click → open drawer for primary occupant
  document.querySelectorAll('.iso-room').forEach(r => {
    r.addEventListener('click', () => {
      const roomId = r.dataset.room;
      const role = Object.values(ROLES).find(rl => rl.room === roomId);
      if (role) openDrawer(role.id);
    });
    r.addEventListener('mouseenter', e => {
      const tip = document.getElementById('room-tooltip');
      tip.classList.add('is-visible');
      tip.querySelector('.t-name').textContent = r.dataset.name;
      tip.querySelector('.t-occupant').textContent = r.dataset.occupant;
    });
    r.addEventListener('mousemove', e => {
      const tip = document.getElementById('room-tooltip');
      const f = document.getElementById('floor').getBoundingClientRect();
      tip.style.left = (e.clientX - f.left) + 'px';
      tip.style.top  = (e.clientY - f.top)  + 'px';
    });
    r.addEventListener('mouseleave', () => {
      document.getElementById('room-tooltip').classList.remove('is-visible');
    });
  });

  // ticker line click → pulse the corresponding avatar
  document.getElementById('ticker-content').addEventListener('click', e => {
    const line = e.target.closest('.ticker-line');
    if (!line) return;
    const roleId = line.dataset.role;
    const av = document.querySelector(`.avatar[data-role-id="${roleId}"]`);
    if (!av) return;
    av.animate(
      [{ transform:'scale(1)' }, { transform:'scale(1.3)' }, { transform:'scale(1)' }],
      { duration: 700, easing: 'cubic-bezier(.4,0,.2,1)' }
    );
  });

  // alert tray toggle
  document.getElementById('alert-pill').addEventListener('click', () => {
    state.alertTrayOpen = !state.alertTrayOpen;
    document.getElementById('alert-tray').classList.toggle('is-open', state.alertTrayOpen);
  });
  document.addEventListener('click', e => {
    if (state.alertTrayOpen && !e.target.closest('#alert-pill') && !e.target.closest('#alert-tray')) {
      state.alertTrayOpen = false;
      document.getElementById('alert-tray').classList.remove('is-open');
    }
  });

  // gate pill
  document.getElementById('gate-pill').addEventListener('click', openGate);
  document.getElementById('gate-scrim').addEventListener('click', e => {
    if (e.target.id === 'gate-scrim') closeGate();
  });
  document.querySelector('.gate-approve').addEventListener('click', () => {
    state.agents.publisher.state = 'working';
    state.agents.publisher.task = 'publishing';
    closeGate();
    pushTicker('publisher', 'gate approved · publishing listing #41');
    renderTopbar();
    renderBubbles();
    setTimeout(() => {
      state.agents.publisher.state = 'idle';
      state.agents.publisher.task = '';
      pushTicker('publisher', 'listing #41 published · sandbox response 200');
      renderBubbles();
    }, 2500);
  });
  document.querySelector('.gate-reject').addEventListener('click', () => {
    state.agents.publisher.state = 'idle';
    state.agents.publisher.task = '';
    closeGate();
    pushTicker('publisher', 'gate rejected by user · listing #41 returned to listing desk');
    renderTopbar();
    renderBubbles();
  });

  // all-stop
  document.getElementById('all-stop').addEventListener('click', () => {
    state.allStop = true;
    document.getElementById('app').classList.add('is-allstop');
    document.getElementById('allstop-overlay').classList.add('is-open');
  });
  document.getElementById('allstop-resume').addEventListener('click', () => {
    state.allStop = false;
    document.getElementById('app').classList.remove('is-allstop');
    document.getElementById('allstop-overlay').classList.remove('is-open');
  });

  // sandbox banner dismiss
  document.querySelector('.sandbox-banner .close').addEventListener('click', () => {
    state.sandbox = false;
    document.getElementById('app').classList.remove('has-sandbox');
    document.querySelector('.sandbox-banner').classList.add('is-hidden');
  });

  // drawer controls
  document.querySelector('[data-action="pause"]').addEventListener('click', () => {
    if (!state.selected) return;
    const a = state.agents[state.selected];
    a.state = a.state === 'paused' ? 'idle' : 'paused';
    a.task = '';
    renderDrawer(); renderBubbles();
  });
  document.querySelector('[data-action="kill"]').addEventListener('click', () => {
    if (!state.selected) return;
    state.agents[state.selected].state = 'killed';
    state.agents[state.selected].task = '';
    renderDrawer(); renderBubbles(); positionAvatars();
  });
  document.querySelector('[data-action="restart"]').addEventListener('click', () => {
    if (!state.selected) return;
    state.agents[state.selected].state = 'idle';
    state.agents[state.selected].task = '';
    renderDrawer(); renderBubbles(); positionAvatars();
  });

  // chat send
  const chatInput = document.querySelector('.chat-input');
  const chatSend = document.querySelector('.chat-send');
  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !state.selected) return;
    const t = new Date().toTimeString().slice(0,5);
    if (!CHAT_HISTORY[state.selected]) CHAT_HISTORY[state.selected] = [];
    CHAT_HISTORY[state.selected].push({ who:'user', t, text });
    chatInput.value = '';
    renderDrawer();
    setTimeout(() => {
      CHAT_HISTORY[state.selected].push({ who:'agent', t: new Date().toTimeString().slice(0,5), text:'On it. Will share progress in the live log.' });
      renderDrawer();
    }, 900);
  }
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // collapsible sections
  document.querySelectorAll('.drawer-section-head').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('is-collapsed'));
  });

  // Esc to close anything
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.gateOpen) closeGate();
      else if (state.allStop) { /* no-op, force button */ }
      else if (state.selected) closeDrawer();
    }
  });

  // resize → reposition avatars
  window.addEventListener('resize', () => { positionAvatars(); });
}

/* ---------------- Boot ---------------- */

function boot() {
  // Sandbox state
  if (state.sandbox) document.getElementById('app').classList.add('has-sandbox');

  // Build scene
  const scene = buildScene();
  document.getElementById('floor-scene').innerHTML = scene.svg;

  // Avatars over the SVG
  buildAvatarLayer();

  // Top chrome
  renderTopbar();
  renderTicker();
  renderAlertTray();
  renderGateModal();

  // Wire everything
  wireUp();
  renderBubbles();

  // Auto-open the drawer for the designer so the prototype lands on a populated state
  setTimeout(() => {
    openDrawer('designer');
  }, 600);

  // Begin mocked event stream
  startEventStream();

  // Live budget ticker (every 4s small drift)
  setInterval(() => {
    if (state.allStop) return;
    state.budget.spent = Math.min(state.budget.cap, state.budget.spent + 0.01);
    renderTopbar();
  }, 4000);

  // Reposition avatars after fonts/layout settle
  setTimeout(positionAvatars, 200);
  setTimeout(positionAvatars, 800);
}

document.addEventListener('DOMContentLoaded', boot);
