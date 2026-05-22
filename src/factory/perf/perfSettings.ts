import { create } from "zustand";

// Persisted performance settings. Each toggle DISABLES one rendering cost when
// true. Defaults reflect the measured sweet spot: avatar drop-shadow and SVG
// blur are the two real costs (drop-shadow re-rasterizes every animation
// frame), while glass/backdrop blur measured as near-zero — so it stays on.
//
// State is mirrored to <body> classes (CSS in factory-floor.css) and to
// localStorage, and applied at module load so first paint already reflects the
// saved choice.

export type PerfToggleKey = "noBackdrop" | "noShadow" | "noAnim" | "noSvgFilter";

export const PERF_TOGGLE_META: {
  key: PerfToggleKey;
  cls: string;
  hotkey: string;
  label: string;
  help: string;
}[] = [
  {
    key: "noShadow",
    cls: "diag-no-shadow",
    hotkey: "2",
    label: "Disable avatar shadow",
    help: "Removes the per-avatar drop-shadow filter. Large FPS gain — the shadow re-rasterizes on every animation frame.",
  },
  {
    key: "noSvgFilter",
    cls: "diag-no-svgfilter",
    hotkey: "4",
    label: "Disable SVG blur",
    help: "Removes the soft-blur filters on corridor rails and junction dots. Small FPS gain.",
  },
  {
    key: "noBackdrop",
    cls: "diag-no-backdrop",
    hotkey: "1",
    label: "Disable glass blur",
    help: "Turns off backdrop-filter blur on panels. Measured near-zero cost, so this is safe to leave on for the look.",
  },
  {
    key: "noAnim",
    cls: "diag-no-anim",
    hotkey: "3",
    label: "Disable all animation",
    help: "Freezes every CSS animation and transition. Largest single gain, but the floor stops feeling alive — diagnostic use mostly.",
  },
];

type PerfPersisted = {
  toggles: Record<PerfToggleKey, boolean>;
  hudVisible: boolean;
};

type PerfState = PerfPersisted & {
  setToggle: (k: PerfToggleKey, disabled: boolean) => void;
  toggleKey: (k: PerfToggleKey) => void;
  resetToggles: () => void;
  setHud: (v: boolean) => void;
  toggleHud: () => void;
};

const STORAGE_KEY = "agentFactory.perf.v1";

const DEFAULTS: PerfPersisted = {
  toggles: { noBackdrop: false, noShadow: true, noAnim: false, noSvgFilter: true },
  hudVisible: false,
};

function load(): PerfPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PerfPersisted>;
    return {
      toggles: { ...DEFAULTS.toggles, ...(parsed.toggles ?? {}) },
      hudVisible:
        typeof parsed.hudVisible === "boolean" ? parsed.hudVisible : DEFAULTS.hudVisible,
    };
  } catch {
    return DEFAULTS;
  }
}

function applyClasses(toggles: Record<PerfToggleKey, boolean>): void {
  if (typeof document === "undefined") return;
  for (const meta of PERF_TOGGLE_META) {
    document.body.classList.toggle(meta.cls, toggles[meta.key]);
  }
}

function persist(state: PerfPersisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / unavailable
  }
}

const initial = load();
// Apply persisted toggles immediately so the visual state is correct on the
// very first paint, before React mounts anything.
applyClasses(initial.toggles);

export const usePerfSettings = create<PerfState>((set, get) => ({
  toggles: initial.toggles,
  hudVisible: initial.hudVisible,
  setToggle: (k, disabled) => {
    const toggles = { ...get().toggles, [k]: disabled };
    applyClasses(toggles);
    set({ toggles });
    persist({ toggles, hudVisible: get().hudVisible });
  },
  toggleKey: (k) => get().setToggle(k, !get().toggles[k]),
  resetToggles: () => {
    const toggles: Record<PerfToggleKey, boolean> = {
      noBackdrop: false,
      noShadow: false,
      noAnim: false,
      noSvgFilter: false,
    };
    applyClasses(toggles);
    set({ toggles });
    persist({ toggles, hudVisible: get().hudVisible });
  },
  setHud: (v) => {
    set({ hudVisible: v });
    persist({ toggles: get().toggles, hudVisible: v });
  },
  toggleHud: () => get().setHud(!get().hudVisible),
}));
