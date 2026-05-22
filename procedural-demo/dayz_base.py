#!/usr/bin/env python3
"""DayZ raid-defense base — PNG plan.  v5: 3 floors, ring + core, aligned stairs.

  * Raid path is ONE ring corridor wrapping a central defender core. Raiders
    enter the OPEN garage (D1, the only door, no doors among the cars), run the
    ring through doors 2-19, climb the raid stairwell, and breach D20.
  * Two vertical stairwells are at FIXED positions on every floor they serve:
      RAID stairwell  (4-8, 15-19)  — F1 ring end -> F2 -> F3, gated by D20.
      OWNER stairwell (10-14,12-16) — F1 core -> F2 -> F3 -> roof; owners only.
  * The defender core is one connected centre space. Windows line all four
    core walls; defenders fire OUT, raiders cannot fire or step IN. No door
    joins the core to the ring; charges go on doors only, so all 20 are forced.

  Floor 1  raid ring (D1-D19) + central defender core + open garage
  Floor 2  main loot vault — entered by D20
  Floor 3  top-tier vault + owner quarters (past D20)
  Roof     3 helipads, owner heli access

Pure 2D compositing — no API, no credits.  python3 procedural-demo/dayz_base.py
"""
import os, math
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dayz-base.png")
S = 2
M = 13 * S
FW, FH = 44, 34

WALL  = (74, 66, 60)
CORR  = (228, 216, 195)
GAL   = (174, 194, 160)
VAULT = (231, 198, 128)
ROOM  = (236, 214, 158)
SHELF = (150, 116, 60)
DOOR  = (196, 84, 58)
PATH  = (170, 52, 44)
WIN   = (52, 78, 120)
FIRE  = (200, 96, 74)
CARC  = (108, 122, 132)
PADC  = (120, 132, 120)
CIRC  = (146, 166, 134)
INK   = (54, 47, 42)
PAPER = (245, 240, 230)
GREEN = (60, 116, 62)
SKY   = (214, 224, 230)

GARAGE = (3, 23, 41, 31)
RIGHTR = (35, 5, 41, 23)
TOPR   = (3, 5, 41, 11)
LEFTR  = (3, 11, 9, 23)
CORE   = (9, 11, 35, 23)
RING   = [GARAGE, RIGHTR, TOPR, LEFTR]
F1PATH = [(10, 32), (10, 27), (38, 27), (38, 8), (6, 8), (6, 17)]
DOORPATH = [(38, 24), (38, 8), (6, 8), (6, 13)]    # doors only after the garage

# stairwells — FIXED footprints, identical on every floor they reach
RAID_ST  = (4, 15)        # x0,y0  (4x4) — F1, F2, F3
OWNER_ST = (10, 12)       # x0,y0  (4x4) — F1, F2, F3, roof
STW = 4                   # stairwell size (m)


def face(want, size):
    ttc = "/System/Library/Fonts/Avenir Next.ttc"
    for i in range(24):
        try:
            f = ImageFont.truetype(ttc, size, index=i)
        except Exception:
            break
        if want in " ".join(f.getname()).lower():
            return f
    return ImageFont.truetype(ttc, size, index=0)

F_BIG = face("bold", 20 * S)
F_TTL = face("bold", 14 * S)
F_LBL = face("demi", 9 * S)
F_SM  = face("regular", 8 * S)
F_XS  = face("regular", 7 * S)
F_DR  = face("bold", 9 * S)


def rect(d, ox, oy, box, color):
    d.rectangle((ox + box[0] * M, oy + box[1] * M, ox + box[2] * M, oy + box[3] * M),
                fill=color)


def text(d, x, y, s, font, color, anchor="mm"):
    d.text((x, y), s, font=font, fill=color, anchor=anchor)


def door(d, ox, oy, num, mx, my, orient, vehicle=False):
    cx, cy = ox + mx * M, oy + my * M
    half = (3.4 if vehicle else 2.0) * M
    if orient == "v":
        d.rectangle((cx - 3 * S, cy - half, cx + 3 * S, cy + half), fill=DOOR)
    else:
        d.rectangle((cx - half, cy - 3 * S, cx + half, cy + 3 * S), fill=DOOR)
    r = (10 if vehicle else 8.2) * S
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=DOOR, outline=PAPER, width=2 * S)
    text(d, cx, cy, str(num), F_DR, PAPER)


def window(d, ox, oy, mx, my, facing):
    cx, cy = ox + mx * M, oy + my * M
    if facing in ("N", "S"):
        d.rectangle((cx - 1.6 * M, cy - 0.45 * M, cx + 1.6 * M, cy + 0.45 * M), fill=WIN)
        d.line((cx, cy, cx, cy + (4.0 if facing == "S" else -4.0) * M), fill=FIRE, width=2 * S)
    else:
        d.rectangle((cx - 0.45 * M, cy - 1.6 * M, cx + 0.45 * M, cy + 1.6 * M), fill=WIN)
        d.line((cx, cy, cx + (4.0 if facing == "E" else -4.0) * M, cy), fill=FIRE, width=2 * S)


def dashed(d, ox, oy, pts, color, w=3, arrows=True):
    px = [(ox + x * M, oy + y * M) for x, y in pts]
    for (x0, y0), (x1, y1) in zip(px, px[1:]):
        seg = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(seg / (7 * S)))
        for i in range(0, n, 2):
            t0, t1 = i / n, min(1, (i + 1) / n)
            d.line((x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0,
                    x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1), fill=color, width=w * S)
        if arrows:
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            L = seg or 1
            dx, dy = (x1 - x0) / L, (y1 - y0) / L
            h = 6 * S
            d.polygon([(mx + dx * h, my + dy * h),
                       (mx - dx * h - dy * h * .7, my - dy * h + dx * h * .7),
                       (mx - dx * h + dy * h * .7, my - dy * h - dx * h * .7)], fill=color)


def stairwell(d, ox, oy, x0, y0, fill, label="", lcol=INK):
    """Draw a stairwell shaft at a fixed footprint (x0,y0)+STW, with a wall rim."""
    px0, py0 = ox + x0 * M, oy + y0 * M
    px1, py1 = ox + (x0 + STW) * M, oy + (y0 + STW) * M
    d.rectangle((px0, py0, px1, py1), fill=fill, outline=WALL, width=3 * S)
    for i in range(1, 6):
        d.line((px0, py0 + i * STW / 6 * M, px1, py0 + i * STW / 6 * M),
               fill=WALL, width=2 * S)
    if label:
        text(d, (px0 + px1) / 2, py0 - 7 * S, label, F_XS, lcol)


def car(d, ox, oy, mx, my):
    x0, y0 = ox + (mx - 2.6) * M, oy + (my - 1.6) * M
    x1, y1 = ox + (mx + 2.6) * M, oy + (my + 1.6) * M
    d.rounded_rectangle((x0, y0, x1, y1), radius=4 * S, fill=CARC, outline=INK, width=2 * S)
    d.rectangle((x0 + 1.3 * M, y0 + 0.5 * M, x1 - 1.3 * M, y1 - 0.5 * M), fill=(154, 166, 174))


def heli(d, cx, cy, r):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=PADC, outline=INK, width=2 * S)
    d.ellipse((cx - r + 4 * S, cy - r + 4 * S, cx + r - 4 * S, cy + r - 4 * S),
              outline=PAPER, width=2 * S)
    d.ellipse((cx - r * .36, cy - r * .3, cx + r * .36, cy + r * .5),
              fill=(86, 96, 104), outline=INK, width=2 * S)
    for a in (35, 125, 215, 305):
        d.line((cx, cy, cx + r * .78 * math.cos(math.radians(a)),
                cy + r * .78 * math.sin(math.radians(a))), fill=INK, width=2 * S)


def place_doors(path, n, start):
    segs, total = [], 0
    for a, b in zip(path, path[1:]):
        dd = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append((a, b, dd))
        total += dd
    out = []
    for k in range(1, n + 1):
        td, acc = total * k / (n + 1), 0
        for a, b, dd in segs:
            if acc + dd >= td and dd > 0:
                t = (td - acc) / dd
                x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                orient = "v" if abs(b[0] - a[0]) > abs(b[1] - a[1]) else "h"
                out.append((start + k - 1, x, y, orient))
                break
            acc += dd
    return out

RING_DOORS = place_doors(DOORPATH, 18, 2)


def title(d, ox, oy, n, sub, col=(120, 70, 50)):
    text(d, ox, oy - 12 * S, n, F_TTL, INK, "lm")
    w = d.textlength(n, font=F_TTL)
    text(d, ox + w + 8 * S, oy - 12 * S, sub, F_LBL, col, "lm")


def vault_rooms(d, ox, oy, rooms):
    for (x0, y0, x1, y1), label, nr in rooms:
        rect(d, ox, oy, (x0, y0, x1, y1), ROOM)
        for k in range(nr):
            ry = y0 + 1.4 + k * 2.35
            rect(d, ox, oy, (x0 + 1, ry, x1 - 1, ry + 1.0), SHELF)
        text(d, ox + (x0 + x1) / 2 * M, oy + (y0 + 0.95) * M, label, F_XS, (110, 72, 18))
        mid, gy = (x0 + x1) / 2, (14.5 if y0 < 15 else 18.5)
        rect(d, ox, oy, (mid - 1.5, gy, mid + 1.5, gy + 1), ROOM)


# ====================== FLOOR 1 — raid ring + core ====================
def floor1(d, ox, oy):
    rect(d, ox, oy, (0, 0, FW, FH), WALL)
    for z in RING:
        rect(d, ox, oy, z, CORR)
    rect(d, ox, oy, CORE, GAL)
    d.line((ox + 3 * M, oy + 23 * M, ox + 9 * M, oy + 23 * M), fill=WALL, width=5 * S)
    for bx in (12, 22, 32):
        d.rectangle((ox + (bx - 4) * M, oy + 24 * M, ox + (bx + 4) * M, oy + 30.5 * M),
                    outline=(155, 140, 124), width=2 * S)
        car(d, ox, oy, bx, 27)
    dashed(d, ox, oy, F1PATH, PATH)
    door(d, ox, oy, 1, 10, 31.3, "h", True)
    for num, x, y, o in RING_DOORS:
        door(d, ox, oy, num, x, y, o)
    for wx in (13, 18, 23, 28, 32):
        window(d, ox, oy, wx, 23, "S")
        window(d, ox, oy, wx, 11, "N")
    for wy in (14, 17, 20):
        window(d, ox, oy, 35, wy, "E")
        window(d, ox, oy, 9, wy, "W")
    stairwell(d, ox, oy, *RAID_ST, CORR)
    text(d, ox + 6 * M, oy + 20.6 * M, "RAID STAIRS UP - D20", F_XS, INK)
    stairwell(d, ox, oy, *OWNER_ST, GAL)
    text(d, ox + 12 * M, oy + 17.0 * M, "OWNER STAIRS UP", F_XS, (40, 66, 38))
    text(d, ox + 12 * M, oy + 18.0 * M, "to vault & roof", F_XS, (40, 66, 38))
    fx, fy = ox + 25 * M, oy + 15 * M
    d.line((fx, fy - 2.3 * M, fx, fy + 2.4 * M), fill=INK, width=3 * S)
    d.polygon([(fx, fy - 2.3 * M), (fx + 2.3 * M, fy - 1.5 * M), (fx, fy - 0.7 * M)],
              fill=(154, 60, 52))
    text(d, fx, fy + 3.5 * M, "FLAGPOLE", F_XS, INK)
    text(d, ox + 23 * M, oy + 20.8 * M,
         "DEFENDER CORE — defenders fire OUT through the windows.", F_SM, (40, 66, 38))
    text(d, ox + 23 * M, oy + 22.0 * M,
         "No door connects the core to the raid ring.", F_SM, (40, 66, 38))
    text(d, ox + 22 * M, oy + 27 * M, "OPEN GARAGE — 3 cars, no doors among them",
         F_SM, (84, 96, 106))
    ex = ox + 10 * M
    d.polygon([(ex - 6 * S, oy + FH * M), (ex + 6 * S, oy + FH * M),
               (ex, oy + FH * M + 14 * S)], fill=PATH)
    text(d, ex, oy + FH * M + 26 * S, "ONLY ENTRY — D1 garage door (cars + raiders)",
         F_SM, PATH)
    title(d, ox, oy, "FLOOR 1", "raid ring — doors 1-19 wrapping the defender core")


# ====================== FLOOR 2 — main loot vault =====================
def floor2(d, ox, oy):
    rect(d, ox, oy, (0, 0, FW, FH), WALL)
    vault_rooms(d, ox, oy, [
        ((3, 2.5, 17, 14), "TIER-1 / RARE", 4),
        ((17.5, 2.5, 29.5, 14), "WEAPONS", 4),
        ((30, 2.5, 41.5, 14), "AMMUNITION", 4),
        ((3, 19.5, 13, 31.5), "FOOD & WATER", 4),
        ((13.5, 19.5, 23, 31.5), "CLOTHING & GEAR", 4),
        ((23.5, 19.5, 33, 31.5), "BUILD & FORTIFY", 4),
        ((33.5, 19.5, 41.5, 31.5), "MEDICAL", 4)])
    rect(d, ox, oy, (8, 15, 42, 19), CORR)          # vault aisle
    stairwell(d, ox, oy, *RAID_ST, CORR, "RAID STAIRS from F1")
    door(d, ox, oy, 20, 8, 17, "v")
    stairwell(d, ox, oy, *OWNER_ST, GAL, "OWNER STAIRS", (40, 66, 38))
    text(d, ox + 27 * M, oy + 17 * M, "VAULT AISLE — stairs continue to floor 3",
         F_XS, (110, 80, 30))
    title(d, ox, oy, "FLOOR 2", "main loot vault — entered by door 20",
          col=(120, 80, 16))


# ====================== FLOOR 3 — top vault + quarters ================
def floor3(d, ox, oy):
    rect(d, ox, oy, (0, 0, FW, FH), WALL)
    vault_rooms(d, ox, oy, [
        ((3, 2.5, 17, 14), "TOP-TIER VAULT", 4),
        ((17.5, 2.5, 29.5, 14), "RARE WEAPONS", 4),
        ((30, 2.5, 41.5, 14), "GOLD & VALUABLES", 4),
        ((3, 19.5, 22, 31.5), "OWNER QUARTERS", 3),
        ((22.5, 19.5, 41.5, 31.5), "AMMO & EXPLOSIVE RESERVE", 4)])
    rect(d, ox, oy, (8, 15, 42, 19), CORR)
    stairwell(d, ox, oy, *RAID_ST, CORR, "STAIRS from F2 (past D20)")
    stairwell(d, ox, oy, *OWNER_ST, GAL, "OWNER STAIRS", (40, 66, 38))
    text(d, ox + 27 * M, oy + 17 * M, "VAULT AISLE — owner stairs up to roof",
         F_XS, (110, 80, 30))
    title(d, ox, oy, "FLOOR 3", "top-tier vault + owner quarters (past door 20)",
          col=(120, 80, 16))


# ====================== ROOF ==========================================
def roof(d, ox, oy):
    rect(d, ox, oy, (0, 0, FW, FH), WALL)
    rect(d, ox, oy, (2.5, 2.5, 41.5, 31.5), PADC)
    for i, cx in enumerate((12, 24, 36)):
        heli(d, ox + cx * M, oy + 24 * M, 5.7 * M)
        text(d, ox + cx * M, oy + 16.6 * M, f"HELIPAD {i+1}", F_SM, INK)
    stairwell(d, ox, oy, *OWNER_ST, GAL)
    text(d, ox + 12 * M, oy + 17.2 * M, "OWNER STAIRS (heli access)", F_XS, (40, 66, 38))
    text(d, ox + 22 * M, oy + 6 * M,
         "flat deck on pillars — reached by stairs, not heli-only", F_SM, (90, 90, 82))
    title(d, ox, oy, "ROOF", "3 helipads — owner heli access", col=(84, 96, 106))


# ====================== SECTION ========================================
def section(d, ox, oy, w, h):
    fl = 4.0
    th = 3 * fl + 1.6
    scale = min((w - 40 * S) / 64.0, (h - 64 * S) / 18.0)
    g = oy + h - 38 * S
    cx = ox + w / 2
    def X(mx): return cx - 22 * scale + mx * scale
    def Y(m):  return g - m * scale
    d.rectangle((ox, oy + 13 * S, ox + w, g), fill=SKY)
    d.rectangle((ox, g, ox + w, g + 7 * S), fill=(170, 158, 130))
    for x0, x1, col in [(0, 3, WALL), (3, 9, CORR), (9, 35, GAL),
                        (35, 41, CORR), (41, 44, WALL)]:
        d.rectangle((X(x0), Y(fl), X(x1), Y(0)), fill=col)
    d.rectangle((X(0), Y(fl), X(44), Y(0)), outline=WALL, width=2 * S)
    for wx, dirn in ((9, -1), (35, 1)):
        d.rectangle((X(wx) - 4 * S, Y(2.4), X(wx) + 4 * S, Y(1.4)), fill=WIN)
        d.line((X(wx), Y(1.9), X(wx + dirn * 4.5), Y(1.9)), fill=FIRE, width=2 * S)
    d.rectangle((X(8), Y(3), X(13), Y(0)), fill=DOOR)
    text(d, X(10.5), Y(0) + 8 * S, "D1", F_XS, "#f3eee2")
    text(d, X(24), Y(fl / 2), "FLOOR 1   raid ring + central defender core",
         F_SM, INK)
    for label, base, hh, col in [("FLOOR 2   main loot vault", fl, fl, VAULT),
                                 ("FLOOR 3   top vault + owner quarters", 2 * fl, fl, VAULT),
                                 ("ROOF   3 helipads", 3 * fl, 1.6, PADC)]:
        d.rectangle((X(0), Y(base + hh), X(44), Y(base)), fill=col,
                    outline=WALL, width=2 * S)
        text(d, X(24), Y(base + hh / 2), label, F_SM, INK)
    for hc in (11, 22, 33):
        heli(d, X(hc), Y(th) - 2.4 * scale, 2.2 * scale)
    # the two aligned stairwells, shown as vertical shafts through the floors
    for sx, top_m, col, lab in [(6, 2 * fl, PATH, "raid stairwell"),
                                (12, th, GREEN, "owner stairwell")]:
        for yy in range(int(Y(top_m)), int(Y(0)), 7 * S):
            d.line((X(sx) - 1.2 * scale, yy, X(sx) + 1.2 * scale, yy + 4 * S),
                   fill=col, width=3 * S)
        text(d, X(sx), Y(top_m) - 9 * S, lab, F_XS, col)
    d.line((X(46.5), Y(0), X(46.5), Y(th)), fill=INK, width=2 * S)
    text(d, X(46.5) + 6 * S, Y(th / 2), f"~{th:.0f} m (limit 15 m)", F_XS, INK, "lm")
    fxp = X(22)
    d.line((fxp - 30 * scale, g + 13 * S, fxp + 30 * scale, g + 13 * S),
           fill=CIRC, width=3 * S)
    for s in (-1, 0, 1):
        d.line((fxp + s * 30 * scale, g + 8 * S, fxp + s * 30 * scale, g + 18 * S),
               fill=CIRC, width=3 * S)
    text(d, fxp, g + 26 * S, "30 m flag radius (60 m across) — flagpole at centre",
         F_XS, (90, 110, 80))
    text(d, ox + 4 * S, oy + 2 * S,
         "SECTION  —  both stairwells run as fixed vertical shafts, aligned on "
         "every floor; the raid stairwell is gated by D20", F_LBL, INK, "lm")


# ====================== compose =======================================
def main():
    margin = 40 * S
    pw, ph = FW * M, FH * M
    colgap, rowgap = 56 * S, 66 * S
    sec_h, leg_h = 240 * S, 250 * S
    W = 2 * pw + 2 * margin + colgap
    head = 84 * S
    r1 = head + 24 * S
    r2 = r1 + ph + 24 * S + rowgap
    sec_y = r2 + ph + 28 * S
    H = sec_y + sec_h + 28 * S + leg_h
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    text(d, W // 2, 32 * S, "DAYZ RAID-DEFENSE BASE  —  3 FLOORS, RING & CORE",
         F_BIG, INK)
    text(d, W // 2, 58 * S, "44 x 34 m  ·  3 floors + roof (~13.6 m)  ·  raid path "
         "is one ring around a central defender core  ·  one exterior door  ·  "
         "two stairwells aligned through every floor", F_LBL, (110, 95, 80))

    c0, c1 = margin, margin + pw + colgap
    floor1(d, c0, r1)
    floor2(d, c1, r1)
    floor3(d, c0, r2)
    roof(d, c1, r2)
    section(d, margin, sec_y, W - 2 * margin, sec_h)

    ly = H - leg_h + 16 * S
    text(d, margin, ly, "LEGEND", F_TTL, INK, "lm")
    items = [
        (DOOR,  "Codelocked door 1-20 — D1 garage (only entry), D20 vault. Breach in order."),
        (PATH,  "Raid ring + raid stairwell — one forced lap, then up to D20."),
        (WIN,   "Defender window — set in the core walls; fires OUT into the ring."),
        (GAL,   "Defender core / owner stairwell — owners & defenders, raider-proof."),
        (CORR,  "Raid ring corridor + open garage — where raiders are exposed."),
        (VAULT, "Loot vault — floors 2 and 3, all behind door 20."),
        (CIRC,  "30 m flag radius — the base footprint sits inside it."),
        (PADC,  "Roof helipad deck — owner heli access, stair-reachable."),
    ]
    yy = ly + 26 * S
    for col, label in items:
        d.rectangle((margin, yy - 7 * S, margin + 22 * S, yy + 7 * S),
                    fill=col, outline=INK, width=S)
        text(d, margin + 32 * S, yy, label, F_LBL, INK, "lm")
        yy += 23 * S

    nx = margin + (W - 2 * margin) // 2 + 24 * S
    text(d, nx, ly, "STAIRWELLS  +  WHY RAIDERS CANNOT SKIP", F_TTL, INK, "lm")
    notes = [
        "RAID stairwell sits at the same spot on F1, F2, F3 — a true shaft.",
        "OWNER stairwell sits at the same spot on F1, F2, F3 and the roof.",
        "Garage is OPEN — no doors among the cars; D1 is the only garage door.",
        "The core has NO door to the ring — only windows. Raiders cannot enter it.",
        "Charges go on doors only (server rule) — core walls cannot be breached.",
        "The ring is broken by one wall, so raiders run the full lap — all 20 doors.",
        "4.2  ~13.6 m tall (limit 15 m); base fits the 30 m flag radius.",
        "4.3  exactly 20 codelocked doors.",
        "4.5  ring + stairs are walkable — no ladder, crouch, jump or boost.",
        "4.8  no peeks — BBP Large Window / Window-Hatch pieces, bars on.",
        "BBP  every frame + its door built Tier 3; protection = the lower tier.",
    ]
    yy = ly + 26 * S
    for n in notes:
        text(d, nx, yy, n, F_LBL, INK, "lm")
        yy += 21 * S

    img.resize((W // S, H // S), Image.LANCZOS).save(OUT, quality=95)
    print(f"wrote {OUT}  {W // S}x{H // S}")


if __name__ == "__main__":
    main()
