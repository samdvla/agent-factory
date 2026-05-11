import { useEffect, useState } from "react";
import { api, type BudgetStatus } from "../../api";

function fmt(v: number) {
  return `$${v.toFixed(2)}`;
}

function pct(num: number, den: number) {
  if (den <= 0) return 0;
  return Math.min(100, (num / den) * 100);
}

function tone(num: number, den: number): "ok" | "warn" | "danger" {
  const p = pct(num, den);
  if (p < 60) return "ok";
  if (p < 90) return "warn";
  return "danger";
}

export default function BudgetPill() {
  const [s, setS] = useState<BudgetStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.budgetStatus().then((v) => {
        if (!cancelled) setS(v);
      }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!s) return <div className="budget-pill loading">…</div>;

  const t = tone(s.today_usd, s.daily_cap_usd);

  return (
    <div className="budget-pill-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className={`budget-pill ${t}`} type="button">
        <span className="budget-pill-label">Today</span>
        <span className="budget-pill-value">{fmt(s.today_usd)}</span>
        <span className="budget-pill-sep">/</span>
        <span className="budget-pill-cap">{fmt(s.daily_cap_usd)}</span>
      </button>
      {open && (
        <div className="budget-pill-card" role="dialog">
          <Row label="Hour"  v={s.hour_usd}   cap={s.hourly_cap_usd} />
          <Row label="Day"   v={s.today_usd}  cap={s.daily_cap_usd} />
          <Row label="Month" v={s.month_usd}  cap={s.monthly_cap_usd} />
          <div className="budget-pill-burn">Burn: {fmt(s.burn_per_hour_usd)}/hr</div>
        </div>
      )}
    </div>
  );
}

function Row({ label, v, cap }: { label: string; v: number; cap: number }) {
  const t = tone(v, cap);
  return (
    <div className={`budget-pill-row ${t}`}>
      <span className="budget-pill-row-label">{label}</span>
      <div className="budget-pill-row-bar"><div className="budget-pill-row-fill" style={{ width: `${pct(v, cap)}%` }} /></div>
      <span className="budget-pill-row-num">{fmt(v)} / {fmt(cap)}</span>
    </div>
  );
}
