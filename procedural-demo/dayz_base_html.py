#!/usr/bin/env python3
"""DayZ raid-defense base — high-quality HTML/SVG plan.  v3: ring + core.

Design that actually makes sense for defender galleries + owner access:

  * The raid path is ONE ring corridor wrapping a central defender core.
    Raiders enter at the garage, traverse the whole ring through 19 doors,
    and exit at the vault stairs. The ring is broken at one point so it is
    a forced one-way run — raiders cannot reverse or short-cut.
  * The DEFENDER CORE sits in the centre — a single connected space. Owners
    and defenders move freely inside it; nothing crosses the raid path, so
    there is no catwalk and no breach shortcut.
  * Windows line all four core walls and cover the entire ring. Defenders
    fire OUT of the core into the ring; raiders cannot fire/enter back in.
  * No door connects the core to the ring (charges go on doors only, per
    the server rule) so raiders are obligated through all 20 doors.
  * Core holds the flagpole (central) + owner stairs up to vault & roof.

  Floor 1  raid ring (D1-D19) + central defender core
  Floor 2  loot vault — whole floor, behind D20
  Roof     3 helipads, owner heli access

Run:  python3 procedural-demo/dayz_base_html.py
"""
import os, math

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dayz-base.html")

WALL, CORR, GAL = "#4a423c", "#e4d8c3", "#aec2a0"
VAULT, ROOM, SHELF = "#e7c680", "#ecd69e", "#96743c"
DOOR, PATH, WIN = "#c45438", "#aa342c", "#34547a"
CARC, PADC, SEAL = "#6c7a84", "#788478", "#786c64"
CIRC, INK, GREEN = "#92a686", "#36302a", "#3c743e"
SKY, FIRE = "#d6e0e6", "#c8503c"

FW, FH = 44, 34
# floor-1 zones (x0,y0,x1,y1)
GARAGE  = (3, 23, 41, 31)
RIGHT   = (35, 5, 41, 23)
TOP     = (3, 5, 41, 11)
LEFTR   = (3, 11, 9, 23)
CORE    = (9, 11, 35, 23)
RING    = [GARAGE, RIGHT, TOP, LEFTR]
F1PATH  = [(10, 32), (10, 27), (38, 27), (38, 8), (6, 8), (6, 21)]


# --- svg primitives ---------------------------------------------------
def R(x0, y0, x1, y1, fill, stroke="none", sw=0, rx=0):
    return (f'<rect x="{x0:.2f}" y="{y0:.2f}" width="{x1-x0:.2f}" '
            f'height="{y1-y0:.2f}" rx="{rx}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{sw}"/>')


def L(x0, y0, x1, y1, stroke, sw, dash=""):
    da = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
            f'stroke="{stroke}" stroke-width="{sw}"{da} stroke-linecap="round"/>')


def POLY(pts, fill):
    p = " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)
    return f'<polygon points="{p}" fill="{fill}"/>'


def C(cx, cy, r, fill, stroke="none", sw=0):
    return (f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}"/>')


def T(x, y, s, size, fill, anchor="middle", weight=400):
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" fill="{fill}" '
            f'text-anchor="{anchor}" font-weight="{weight}" '
            f'dominant-baseline="middle">{s}</text>')


def door(num, x, y, orient, vehicle=False):
    half = 3.4 if vehicle else 2.0
    r = 1.7 if vehicle else 1.45
    bar = (R(x - 0.32, y - half, x + 0.32, y + half, DOOR) if orient == "v"
           else R(x - half, y - 0.32, x + half, y + 0.32, DOOR))
    return (bar + C(x, y, r, DOOR, "#f3eee2", 0.34)
            + T(x, y + 0.06, num, 1.75 if vehicle else 1.5, "#f3eee2", weight=700))


def window(x, y, orient):
    """A defender window in a core wall: a clean port + short fire line."""
    if orient in ("N", "S"):
        port = R(x - 1.5, y - 0.45, x + 1.5, y + 0.45, WIN)
        fy = 4.4 if orient == "S" else -4.4
        fire = L(x, y, x, y + fy, FIRE, 0.3, dash="0.9,0.9")
    else:
        port = R(x - 0.45, y - 1.5, x + 0.45, y + 1.5, WIN)
        fx = 4.4 if orient == "E" else -4.4
        fire = L(x, y, x + fx, y, FIRE, 0.3, dash="0.9,0.9")
    return fire + port


def stairs(x, y, w=4.6, h=4.6):
    g = R(x, y, x + w, y + h, CORR, WALL, 0.3)
    for i in range(1, 6):
        g += L(x, y + i * h / 6, x + w, y + i * h / 6, WALL, 0.24)
    return g


def car(x, y):
    return (R(x - 2.6, y - 1.6, x + 2.6, y + 1.6, CARC, INK, 0.32, rx=0.7)
            + R(x - 1.4, y - 1.05, x + 1.4, y + 1.05, "#9aa6ae"))


def heli(cx, cy, r):
    g = C(cx, cy, r, PADC, INK, 0.32) + C(cx, cy, r - 0.7, "none", "#f3eee2", 0.3)
    g += C(cx, cy, r * 0.36, "#56606a", INK, 0.3)
    for a in (35, 125, 215, 305):
        g += L(cx, cy, cx + r * .78 * math.cos(math.radians(a)),
               cy + r * .78 * math.sin(math.radians(a)), INK, 0.3)
    return g


def path_poly(pts, stroke, sw, dash="2.2,1.7", arrow=True):
    p = " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)
    mk = ' marker-mid="url(#arr)"' if arrow else ""
    return (f'<polyline points="{p}" fill="none" stroke="{stroke}" '
            f'stroke-width="{sw}" stroke-dasharray="{dash}" '
            f'stroke-linejoin="round" stroke-linecap="round"{mk}/>')


def place_doors(path, n, start):
    """Evenly space n doors along the polyline; orient set by local heading."""
    segs, total = [], 0
    for a, b in zip(path, path[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append((a, b, d))
        total += d
    out = []
    for k in range(1, n + 1):
        td, acc = total * k / (n + 1), 0
        for a, b, d in segs:
            if acc + d >= td and d > 0:
                t = (td - acc) / d
                x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                orient = "v" if abs(b[0] - a[0]) > abs(b[1] - a[1]) else "h"
                out.append((start + k - 1, x, y, orient))
                break
            acc += d
    return out

RING_DOORS = place_doors(F1PATH, 18, 2)        # D2..D19 around the ring

DEFS = ('<defs><marker id="arr" markerWidth="2.6" markerHeight="2.6" refX="1.3" '
        'refY="1.3" orient="auto"><path d="M0,0 L2.6,1.3 L0,2.6 Z" '
        f'fill="{PATH}"/></marker></defs>')


def svg(body, vb="-2 -3 48 44"):
    return (f'<svg viewBox="{vb}" xmlns="http://www.w3.org/2000/svg" '
            f'font-family="Avenir Next,Segoe UI,sans-serif">{DEFS}{body}</svg>')


# --- floor 1: raid ring + defender core -------------------------------
def floor1_svg():
    b = R(0, 0, FW, FH, WALL)
    for z in RING:
        b += R(*z, CORR)
    b += R(*CORE, GAL)
    b += L(3, 23, 9, 23, WALL, 0.7)                 # ring break wall (start|end)
    for bx in (12, 22, 32):                          # garage car bays
        b += R(bx - 4, 24, bx + 4, 30.5, "none", "#9b8c7c", 0.26)
        b += car(bx, 27)
    b += path_poly(F1PATH, PATH, 0.62)
    b += door(1, 10, 31.4, "h", True)
    for num, x, y, o in RING_DOORS:
        b += door(num, x, y, o)
    # defender windows along the 4 core walls
    for wx in (13, 18, 23, 28, 32):
        b += window(wx, 23, "S")
        b += window(wx, 11, "N")
    for wy in (14, 17, 20):
        b += window(35, wy, "E")
        b += window(9, wy, "W")
    # owner stairs inside the core (upper-left)
    b += stairs(10.5, 12.9, 4, 4)
    b += T(12.5, 17.7, "OWNER STAIRS ↑", 0.8, "#2c4a2a", weight=600)
    b += T(12.5, 18.7, "vault &amp; roof", 0.8, "#2c4a2a")
    # flagpole, core centre
    fx, fy = 25, 14.8
    b += L(fx, fy - 2.3, fx, fy + 2.3, INK, 0.34)
    b += POLY([(fx, fy - 2.3), (fx + 2.2, fy - 1.5), (fx, fy - 0.7)], "#9a3c34")
    b += T(fx, fy + 3.4, "FLAGPOLE", 0.82, INK)
    # raid stairs at the end of the ring (left run)
    b += stairs(4.2, 18.0, 3.6, 3.6)
    b += T(6, 22.4, "RAID STAIRS ↑ D20", 0.78, INK)
    # core caption
    b += T(22, 20.7, "DEFENDER CORE — defenders fire OUT through the windows.",
           0.82, "#2c4a2a", weight=600)
    b += T(22, 21.8, "No door connects the core to the raid ring.", 0.82, "#2c4a2a")
    # garage + entry
    b += T(6.6, 27, "GARAGE", 0.85, "#54606a", weight=600)
    b += POLY([(10, 34.4), (8.6, 34.4), (9.3, 36)], PATH)
    b += POLY([(10, 34.4), (11.4, 34.4), (10.7, 36)], PATH)
    b += T(10, 37.4, "ONLY ENTRY — D1 garage door (cars + raiders)", 1.15, PATH)
    return svg(b)


# --- floor 2: loot vault ---------------------------------------------
def floor2_svg():
    b = R(0, 0, FW, FH, WALL)
    b += R(6, 15, 42, 19, CORR) + R(3, 14, 9, 24, GAL)
    rooms = [((10, 2.5, 19, 14), "TIER-1 / RARE", 4),
             ((19.5, 2.5, 29, 14), "WEAPONS", 4),
             ((29.5, 2.5, 41.5, 14), "AMMUNITION", 4),
             ((10, 20, 19, 31.5), "FOOD &amp; WATER", 4),
             ((19.5, 20, 29, 31.5), "CLOTHING &amp; GEAR", 4),
             ((29.5, 20, 37, 31.5), "BUILD &amp; FORTIFY", 4),
             ((37.5, 20, 41.5, 31.5), "MEDICAL", 3)]
    for (x0, y0, x1, y1), label, nr in rooms:
        b += R(x0, y0, x1, y1, ROOM)
        for k in range(nr):
            ry = y0 + 1.5 + k * 2.4
            b += R(x0 + 1, ry, x1 - 1, ry + 1.0, SHELF)
        b += T((x0 + x1) / 2, y0 + 0.95, label, 1.0, "#6e4812", weight=600)
        mid, gy = (x0 + x1) / 2, (14 if y0 < 15 else 19)
        b += R(mid - 1.5, gy, mid + 1.5, gy + 1, ROOM)
    b += door(20, 6, 19, "h")
    b += stairs(3.4, 15.4, 4, 4)
    b += T(8.5, 14, "RAID STAIRS from F1", 0.95, INK)
    b += stairs(4.4, 19.4, 3.4, 3.4)
    b += T(6, 23.6, "OWNER STAIRS", 0.92, "#2c4a2a", weight=600)
    b += T(24, 17, "VAULT AISLE", 1.0, "#6e5020")
    b += POLY([(40, 34.4), (38.6, 34.4), (39.3, 36)], GREEN)
    b += T(40, 37.4, "ONE-WAY DROP EXIT (defenders; not a door)", 1.05, GREEN)
    return svg(b)


# --- roof -------------------------------------------------------------
def roof_svg():
    b = R(0, 0, FW, FH, WALL) + R(2.5, 2.5, 41.5, 31.5, PADC)
    for i, cx in enumerate((11.5, 22, 32.5)):
        b += heli(cx, 18.5, 6.4)
        b += T(cx, 10.6, f"HELIPAD {i+1}", 1.0, INK, weight=600)
    b += stairs(3.4, 3.4, 4, 4)
    b += T(5.4, 8.4, "OWNER STAIRS (heli access)", 0.95, "#2c4a2a", weight=600)
    b += T(22, 30, "flat deck on pillars — reached by stairs, not heli-only",
           1.0, "#5e5e54")
    return svg(b)


# --- section ----------------------------------------------------------
def section_svg():
    fl = 4.0
    th = 3 * fl + 1.6
    H = th + 9

    def Y(m):
        return (H - 4.5) - m
    b = R(-9, -2, 54, H - 2.5, SKY) + R(-9, H - 4.5, 54, H - 3.5, "#aa9e82")
    # floor 1 cut: outer | ring | core(window) ... (window)ring | outer
    segs = [(0, 3, WALL), (3, 9, CORR), (9, 35, GAL), (35, 41, CORR), (41, 44, WALL)]
    for x0, x1, col in segs:
        b += R(x0, Y(fl), x1, Y(0), col)
    b += R(0, Y(fl), 44, Y(fl), "none")
    b += (f'<rect x="0" y="{Y(fl):.2f}" width="44" height="{fl}" fill="none" '
          f'stroke="{WALL}" stroke-width="0.3"/>')
    # core windows firing into the ring corridors
    for wx, d in ((9, -1), (35, 1)):
        b += R(wx - 0.55, Y(2.4), wx + 0.55, Y(1.4), WIN)
        b += L(wx, Y(1.9), wx + d * 4, Y(1.9), FIRE, 0.34, dash="1,0.9")
        b += POLY([(wx + d * 4, Y(2.4)), (wx + d * 4, Y(1.4)),
                   (wx + d * 5.4, Y(1.9))], FIRE)
    b += T(22, Y(fl / 2), "FLOOR 1   raid ring  +  defender core", 1.15, INK,
           weight=600)
    b += R(8, Y(3), 13, Y(0), DOOR)
    b += T(10.5, Y(0) + 1.5, "D1", 1.1, "#f3eee2", weight=700)
    # floors 2 + roof
    for label, base, h, col in [("FLOOR 2   loot vault", fl, fl, VAULT),
                                ("ROOF   3 helipads", 2 * fl, 1.6, PADC)]:
        b += (f'<rect x="0" y="{Y(base+h):.2f}" width="44" height="{h:.2f}" '
              f'fill="{col}" stroke="{WALL}" stroke-width="0.3"/>')
        b += T(22, Y(base + h / 2), label, 1.15, INK, weight=600)
    for hc in (11, 22, 33):
        b += heli(hc, Y(2 * fl + 1.6) - 2.5, 2.4)
    # owner core->vault->roof stair (sealed from the ring)
    b += L(20, Y(0), 20, Y(2 * fl + 1.6), GREEN, 0.4, dash="1.4,1")
    b += T(20, Y(2 * fl + 2.7), "owner stairs", 0.95, GREEN)
    b += L(46, Y(0), 46, Y(2 * fl + 1.6), INK, 0.3)
    b += T(48, Y((2 * fl + 1.6) / 2), f"~{2*fl+1.6:.0f} m", 1.15, INK, "start")
    b += T(48, Y((2 * fl + 1.6) / 2) + 1.5, "(limit 15 m)", 1.0, INK, "start")
    gy = H - 3.0
    b += L(22 - 30, gy, 22 + 30, gy, CIRC, 0.36)
    for s in (-1, 0, 1):
        b += L(22 + s * 30, gy - 0.7, 22 + s * 30, gy + 0.7, CIRC, 0.36)
    b += T(22, gy + 1.9, "30 m flag radius (60 m across) — flagpole at centre",
           1.05, "#5a6e4a")
    b += T(22, Y(fl) + 1.6,
           "core windows fire out into the ring — raiders cannot fire or step back in",
           1.0, FIRE)
    return svg(b, vb=f"-10 -3 64 {H+2}")


# --- assemble ---------------------------------------------------------
LEGEND = [
    (DOOR, "Codelocked door 1-20 — D1 garage (only entry), D20 vault. Breached in order."),
    (PATH, "Raid ring — one forced lap; broken at the start so there is no shortcut."),
    (WIN, "Defender window — set in the core walls; fires OUT into the ring."),
    (GAL, "Defender core — one connected room; owners/defenders move freely."),
    (CORR, "Raid ring corridor + garage — where raiders are exposed."),
    (VAULT, "Loot vault — all of floor 2, seven rooms behind door 20."),
    (CIRC, "30 m flag radius — the base footprint sits inside it."),
    (GREEN, "One-way drop exit — defenders bail; not a door, not re-enterable."),
]
NOTES = [
    "The core has NO door to the ring — only windows. Raiders cannot enter it.",
    "Charges go on doors only (server rule), so the core walls cannot be breached.",
    "The ring is broken by one wall, so raiders must run the full lap, all 20 doors.",
    "Owners/defenders reach the core by stairs from the vault/roof — never the ring.",
    "Windows cover all four core walls — every door on the ring is overlooked.",
    "4.2  ~9.6 m tall (&lt;15 m); base fits the 30 m flag radius.",
    "4.3  exactly 20 codelocked doors; the drop exit is not a door.",
    "4.5  ring is walkable stairs/ramps — no ladder, crouch, jump or boost.",
    "4.8  no peeks — BBP Large Window / Window-Hatch pieces with bars on.",
    "BBP  every frame + its door built Tier 3; protection = the lower tier.",
]


def main():
    leg = "".join(f'<li><i style="background:{c}"></i>{t}</li>' for c, t in LEGEND)
    notes = "".join(f"<li>{n}</li>" for n in NOTES)
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DayZ Raid-Defense Base — Ring &amp; Core</title>
<style>
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:#e8e1d1; color:{INK};
    font-family:"Avenir Next","Segoe UI",system-ui,sans-serif; }}
  .wrap {{ max-width:1180px; margin:0 auto; padding:32px 22px 60px; }}
  header h1 {{ margin:0 0 4px; font-size:25px; letter-spacing:.4px; }}
  header p {{ margin:0 0 24px; color:#7a6f5e; font-size:14px; }}
  figure {{ margin:0 0 20px; background:#f3eee2; border:1px solid #cdc2ab;
    border-radius:10px; padding:14px 14px 8px; box-shadow:0 1px 3px rgba(0,0,0,.07); }}
  figcaption {{ display:flex; align-items:baseline; gap:9px; margin-bottom:6px;
    flex-wrap:wrap; }}
  figcaption b {{ font-size:15px; letter-spacing:.5px; }}
  figcaption span {{ font-size:12px; color:#9a4a36; }}
  svg {{ width:100%; height:auto; display:block; }}
  .row {{ display:grid; grid-template-columns:1fr 1fr; gap:20px; }}
  .info {{ display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:4px; }}
  .info h2 {{ font-size:13px; letter-spacing:.8px; margin:0 0 10px;
    text-transform:uppercase; color:#6a5f4e; }}
  ul {{ list-style:none; margin:0; padding:0; font-size:12.5px; line-height:1.5; }}
  .legend li {{ display:flex; gap:9px; margin-bottom:7px; }}
  .legend i {{ flex:none; width:16px; height:16px; border-radius:3px;
    border:1px solid {INK}; margin-top:1px; }}
  .notes li {{ margin-bottom:7px; padding-left:14px; position:relative; }}
  .notes li::before {{ content:"\\25B8"; position:absolute; left:0; color:#9a4a36; }}
  footer {{ margin-top:24px; font-size:11.5px; color:#8a7f6c; }}
</style></head><body><div class="wrap">
<header>
  <h1>DayZ Raid-Defense Base &mdash; Ring &amp; Core</h1>
  <p>44&times;34&nbsp;m &middot; raid path is one ring around a central defender
     core &middot; one exterior door &middot; loot vault on top &middot; BBP&nbsp;2.0,
     built to the server raid rules</p>
</header>
<figure><figcaption><b>FLOOR 1</b><span>raid ring (doors 1-19) wrapping the
  central defender core</span></figcaption>{floor1_svg()}</figure>
<div class="row">
  <figure><figcaption><b>FLOOR 2</b><span>loot vault — behind door 20</span>
    </figcaption>{floor2_svg()}</figure>
  <figure><figcaption><b>ROOF</b><span>3 helipads — owner heli access</span>
    </figcaption>{roof_svg()}</figure>
</div>
<figure><figcaption><b>SECTION</b><span>side cut — core windows fire out into
  the ring; the core has no door to the raid path</span></figcaption>
  {section_svg()}</figure>
<div class="info">
  <div><h2>Legend</h2><ul class="legend">{leg}</ul></div>
  <div><h2>Why raiders cannot skip &mdash; rule &amp; BBP notes</h2>
    <ul class="notes">{notes}</ul></div>
</div>
<footer>Generated by procedural-demo/dayz_base_html.py &mdash; inline SVG, crisp
at any zoom. BBP uses a snap-point system with no published meter sizes, so treat
dimensions as a layout guide and verify spacing in-game.</footer>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
