// TEMPORARY performance instrumentation. A single module-level collector that
// every measuring surface writes into; the PerfHUD samples it ~2x/sec. The
// goal is to SEE where frame time goes instead of guessing:
//
//   - frame timing (fps, avg ms, worst ms in the window, dropped frames)
//   - React commit cost, split by subtree (<Profiler> id) — renders/sec + ms/sec
//   - main-thread long tasks (>50ms) and total blocking time
//   - forced layout reads/sec (getBoundingClientRect / getScreenCTM)
//   - scene scale (DOM nodes, SVG nodes, avatars, rooms)
//
// The React vs paint split is the decisive one: if React ms/sec is tiny but
// fps is still low, the cost is paint/composite (CSS filters / backdrop-blur),
// not re-renders. Remove this module + PerfHUD once the bottleneck is fixed.

type RenderAgg = { count: number; totalMs: number };

let installed = false;

// --- accumulators (reset on each snapshot) ---
let frameCount = 0;
let frameMsSum = 0;
let frameMsWorst = 0;
let droppedFrames = 0; // frames whose dt implies we missed a 60hz vsync
let lastFrameTs = 0;

let layoutReads = 0;

let longTaskCount = 0;
let blockingMs = 0;

const renders = new Map<string, RenderAgg>();

// --- persistent (not reset) ---
let windowStart = performance.now();

export function recordRender(id: string, actualDurationMs: number): void {
  const cur = renders.get(id) ?? { count: 0, totalMs: 0 };
  cur.count += 1;
  cur.totalMs += actualDurationMs;
  renders.set(id, cur);
}

// Drop-in callback for React's <Profiler onRender={...}>. Typed loosely so it
// can be shared without importing React types into this plain module.
export function profilerCallback(
  id: string,
  _phase: unknown,
  actualDurationMs: number,
): void {
  recordRender(id, actualDurationMs);
}

export function initCollector(): void {
  if (installed) return;
  installed = true;

  // Frame timing loop.
  lastFrameTs = performance.now();
  const frameTick = () => {
    const now = performance.now();
    const dt = now - lastFrameTs;
    lastFrameTs = now;
    frameCount += 1;
    frameMsSum += dt;
    if (dt > frameMsWorst) frameMsWorst = dt;
    // A clean 60hz frame is ~16.7ms. Count how many vsyncs we blew past.
    if (dt > 18) droppedFrames += Math.round(dt / 16.7) - 1;
    requestAnimationFrame(frameTick);
  };
  requestAnimationFrame(frameTick);

  // Long tasks: anything that blocks the main thread >50ms. Blocking time is
  // the portion beyond the 50ms "responsive" budget.
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        blockingMs += Math.max(0, entry.duration - 50);
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask not supported in this engine — skip silently.
  }

  // Count forced layout reads. These are the calls that synchronously flush
  // layout; a storm of them per frame is the classic SVG-projection cost.
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  const origGBCR = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    layoutReads += 1;
    return origGBCR.call(this);
  };
  const svgProto = (window as unknown as {
    SVGGraphicsElement?: { prototype: { getScreenCTM: () => DOMMatrix | null } };
  }).SVGGraphicsElement?.prototype;
  if (svgProto) {
    const origCTM = svgProto.getScreenCTM;
    svgProto.getScreenCTM = function (this: SVGGraphicsElement) {
      layoutReads += 1;
      return origCTM.call(this);
    };
  }
}

export type PerfSnapshot = {
  fps: number;
  frameAvgMs: number;
  frameWorstMs: number;
  droppedFrames: number;
  layoutReadsPerSec: number;
  longTaskCount: number;
  blockingMsPerSec: number;
  renders: { id: string; perSec: number; msPerSec: number }[];
  domNodes: number;
  svgNodes: number;
  avatars: number;
  rooms: number;
};

export function snapshot(): PerfSnapshot {
  const now = performance.now();
  const elapsed = Math.max(1, now - windowStart) / 1000; // seconds

  const renderRows = Array.from(renders.entries())
    .map(([id, agg]) => ({
      id,
      perSec: agg.count / elapsed,
      msPerSec: agg.totalMs / elapsed,
    }))
    .sort((a, b) => b.msPerSec - a.msPerSec);

  const snap: PerfSnapshot = {
    fps: frameCount / elapsed,
    frameAvgMs: frameCount ? frameMsSum / frameCount : 0,
    frameWorstMs: frameMsWorst,
    droppedFrames,
    layoutReadsPerSec: layoutReads / elapsed,
    longTaskCount,
    blockingMsPerSec: blockingMs / elapsed,
    renders: renderRows,
    domNodes: document.getElementsByTagName("*").length,
    svgNodes: document.querySelectorAll("svg *").length,
    avatars: document.querySelectorAll(".avatar-anchor").length,
    rooms: document.querySelectorAll(".iso-room").length,
  };

  // reset window accumulators
  frameCount = 0;
  frameMsSum = 0;
  frameMsWorst = 0;
  droppedFrames = 0;
  layoutReads = 0;
  longTaskCount = 0;
  blockingMs = 0;
  renders.clear();
  windowStart = now;

  return snap;
}
