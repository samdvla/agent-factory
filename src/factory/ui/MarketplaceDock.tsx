import { useEffect, useState } from "react";
import { api } from "../../api";

type MarketId =
  | "etsy"
  | "cults3d"
  | "sketchfab"
  | "printify"
  | "pinterest"
  | "gumroad"
  | "mmf";

type Market = {
  id: MarketId;
  name: string;
  initials: string;
};

const MARKETS: Market[] = [
  { id: "etsy",      name: "Etsy",          initials: "ET" },
  { id: "cults3d",   name: "Cults3D",       initials: "C3" },
  { id: "sketchfab", name: "Sketchfab",     initials: "SF" },
  { id: "printify",  name: "Printify",      initials: "PR" },
  { id: "pinterest", name: "Pinterest",     initials: "PI" },
  { id: "gumroad",   name: "Gumroad",       initials: "GR" },
  { id: "mmf",       name: "MyMiniFactory", initials: "MF" },
];

type Conn = { connected: boolean; detail?: string };
type ConnMap = Partial<Record<MarketId, Conn>>;

async function loadConnections(): Promise<ConnMap> {
  const [etsy, cults3d, sketchfab, printify, pinterest, gumroad, mmf] =
    await Promise.allSettled([
      api.etsyStatus(),
      api.cults3dStatus(),
      api.sketchfabStatus(),
      api.printifyStatus(),
      api.pinterestStatus(),
      api.gumroadStatus(),
      api.mmfStatus(),
    ]);

  const out: ConnMap = {};

  if (etsy.status === "fulfilled") {
    out.etsy = {
      connected: !!etsy.value.connected && !etsy.value.needs_refresh,
      detail: etsy.value.shop_name ?? undefined,
    };
  }
  if (cults3d.status === "fulfilled") {
    out.cults3d = {
      connected:
        !!cults3d.value.creds_present && !!cults3d.value.asset_host_configured,
    };
  }
  if (sketchfab.status === "fulfilled") {
    out.sketchfab = { connected: !!sketchfab.value.creds_present };
  }
  if (printify.status === "fulfilled") {
    out.printify = {
      connected: !!printify.value.key_present && printify.value.shop_id != null,
    };
  }
  if (pinterest.status === "fulfilled") {
    out.pinterest = {
      connected: !!pinterest.value.creds_present,
      detail: pinterest.value.board_name ?? undefined,
    };
  }
  if (gumroad.status === "fulfilled") {
    out.gumroad = { connected: !!gumroad.value.creds_present };
  }
  if (mmf.status === "fulfilled") {
    out.mmf = { connected: !!mmf.value.creds_present };
  }

  return out;
}

export default function MarketplaceDock() {
  const [conns, setConns] = useState<ConnMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await loadConnections();
        if (!cancelled) setConns(data);
      } catch {
        /* swallow — keep last known state */
      }
    };
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!conns) return null;

  const live = MARKETS.filter((m) => conns[m.id]?.connected);
  if (live.length === 0) return null;

  return (
    <div
      className="market-dock"
      role="status"
      aria-label={`Connected marketplaces: ${live.map((m) => m.name).join(", ")}`}
    >
      {live.map((m) => {
        const detail = conns[m.id]?.detail;
        const title = detail ? `${m.name} — ${detail}` : m.name;
        return (
          <span key={m.id} className="market-dock-item" title={title}>
            <span className="market-dock-dot" aria-hidden />
            <span className="market-dock-initials">{m.initials}</span>
          </span>
        );
      })}
    </div>
  );
}
