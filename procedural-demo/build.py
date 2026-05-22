#!/usr/bin/env python3
"""Procedural isometric architecture — composed in-repo, no API, no credits.

A proof that code-drawn graphics handle geometric/architectural subjects well:
every building, window, roof, shrub and shadow here is computed from a seed and
drawn as plain polygons, then framed by an analytic bounding box. Run:

    python3 procedural-demo/build.py
"""
import os, random
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "town.png")
SS = 3                                   # supersample factor for clean edges
TW, TH = 132 * SS, 66 * SS               # iso tile (2:1)
PAD = 80 * SS
OX = OY = 0                              # projection origin, set after bbox

# --- brand palette ----------------------------------------------------
BG_TOP, BG_BOT = (242, 234, 221), (221, 207, 186)
GROUND = (231, 221, 203)
WALLS = [(196, 120, 84), (212, 177, 134), (172, 112, 98), (201, 190, 170)]
WIN_LIT, WIN_DIM = (247, 231, 196), (118, 132, 116)
SAGE, SAGE_DK = (152, 169, 139), (120, 141, 112)


def shade(c, f):
    return tuple(min(255, max(0, round(ch * f))) for ch in c)


def proj(x, y, z):
    """World (x, y in tiles; z in pixels) -> screen point."""
    return (OX + (x - y) * (TW // 2), OY + (x + y) * (TH // 2) - z)


def quad(d, pts, color):
    d.polygon([proj(*p) for p in pts], fill=color)


# --- geometry ---------------------------------------------------------
def make_buildings():
    """Deterministic parametric building specs (footprint + height + setback)."""
    plots = [(-3.8, -3.4, 2.4, 2.2, 1.05), (-0.9, -4.0, 2.0, 2.5, 1.5),
             (1.9, -2.9, 2.5, 2.0, 0.85), (-4.2, 0.0, 2.2, 2.3, 1.3),
             (-1.2, -0.5, 2.7, 2.5, 1.75), (2.2, 0.7, 2.0, 2.1, 1.1),
             (0.3, 2.7, 2.3, 2.0, 0.75)]
    out = []
    for i, (gx, gy, fw, fd, hf) in enumerate(plots):
        rng = random.Random(i * 7 + 3)
        bh = (130 + hf * 135) * SS
        base = WALLS[i % len(WALLS)]
        setback = None
        if rng.random() < 0.6 and fw > 1.4 and fd > 1.4:
            sw, sd = fw * 0.52, fd * 0.52
            setback = dict(gx=gx + (fw - sw) / 2, gy=gy + (fd - sd) / 2,
                           fw=sw, fd=sd, bh=bh * rng.uniform(0.4, 0.62),
                           base=shade(base, 1.06))
        out.append(dict(gx=gx, gy=gy, fw=fw, fd=fd, bh=bh, base=base,
                         setback=setback, rng=rng))
    return out


def draw_box(d, gx, gy, fw, fd, z0, z1, base, rng):
    """One iso box from z0..z1 with shaded faces, window grid, parapet rim."""
    x0, y0, x1, y1 = gx, gy, gx + fw, gy + fd
    top = shade(base, 1.20)
    fxp = shade(base, 1.00)              # +x face — catches light
    fyp = shade(base, 0.74)             # +y face — in shade

    if z0 == 0:                          # soft contact shadow on the ground
        quad(d, [(x0 + .16, y0 + .32, 0), (x1 + .32, y0 + .32, 0),
                 (x1 + .32, y1 + .16, 0), (x0 + .16, y1 + .16, 0)],
             shade(GROUND, 0.87))

    quad(d, [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], fxp)
    quad(d, [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], fyp)
    quad(d, [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], top)

    rim = 7 * SS                         # parapet rim under the roof edge
    quad(d, [(x1, y0, z1), (x1, y1, z1), (x1, y1, z1 - rim), (x1, y0, z1 - rim)], shade(base, 1.06))
    quad(d, [(x0, y1, z1), (x1, y1, z1), (x1, y1, z1 - rim), (x0, y1, z1 - rim)], shade(base, 0.82))

    def windows(axis):                   # window grid on a face
        span = fd if axis == "x" else fw
        cols = max(1, int(span / 0.64))
        rows = max(1, int((z1 - z0) / (52 * SS)))
        mw, mh = 0.30, 30 * SS
        for r in range(rows):
            for c in range(cols):
                u = (c + 0.5) / cols * span + (gy if axis == "x" else gx)
                cz = z0 + (r + 0.55) / rows * (z1 - z0)
                lit = WIN_LIT if rng.random() < 0.6 else WIN_DIM
                if axis == "x":
                    pts = [(x1, u - mw / 2, cz - mh / 2), (x1, u + mw / 2, cz - mh / 2),
                           (x1, u + mw / 2, cz + mh / 2), (x1, u - mw / 2, cz + mh / 2)]
                    quad(d, pts, lit)
                else:
                    pts = [(u - mw / 2, y1, cz - mh / 2), (u + mw / 2, y1, cz - mh / 2),
                           (u + mw / 2, y1, cz + mh / 2), (u - mw / 2, y1, cz + mh / 2)]
                    quad(d, pts, shade(lit, 0.82))
    windows("x")
    windows("y")


def draw_building(d, b):
    draw_box(d, b["gx"], b["gy"], b["fw"], b["fd"], 0, b["bh"], b["base"], b["rng"])
    s = b["setback"]
    if s:
        draw_box(d, s["gx"], s["gy"], s["fw"], s["fd"], b["bh"], b["bh"] + s["bh"],
                 s["base"], b["rng"])


def draw_shrub(d, x, y):
    cx, cy = proj(x, y, 0)
    d.ellipse((cx - 34 * SS, cy - 34 * SS, cx + 34 * SS, cy + 17 * SS), fill=SAGE_DK)
    d.ellipse((cx - 27 * SS, cy - 50 * SS, cx + 27 * SS, cy - 6 * SS), fill=SAGE)


def main():
    global OX, OY
    buildings = make_buildings()
    shrubs = [(-3.3, -0.6), (1.6, -2.5), (-1.9, 3.4), (3.1, -0.7)]

    gxs = [b["gx"] for b in buildings] + [b["gx"] + b["fw"] for b in buildings]
    gys = [b["gy"] for b in buildings] + [b["gy"] + b["fd"] for b in buildings]
    ground = [(min(gxs) - 1.1, min(gys) - 1.1), (max(gxs) + 1.1, min(gys) - 1.1),
              (max(gxs) + 1.1, max(gys) + 1.1), (min(gxs) - 1.1, max(gys) + 1.1)]

    # analytic bounding box -> canvas size + projection origin
    pts = []
    for b in buildings:
        ztop = b["bh"] + (b["setback"]["bh"] if b["setback"] else 0)
        for cx, cy in [(b["gx"], b["gy"]), (b["gx"] + b["fw"], b["gy"]),
                       (b["gx"] + b["fw"], b["gy"] + b["fd"]), (b["gx"], b["gy"] + b["fd"])]:
            pts += [proj(cx, cy, 0), proj(cx, cy, ztop)]
    for cx, cy in ground:
        pts.append(proj(cx, cy, 0))
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    W = int(max(xs) - min(xs) + 2 * PAD)
    H = int(max(ys) - min(ys) + 2 * PAD)
    OX, OY = int(PAD - min(xs)), int(PAD - min(ys))

    img = Image.new("RGB", (W, H))
    px = img.load()
    for yy in range(H):
        t = yy / (H - 1)
        row = tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
        for xx in range(W):
            px[xx, yy] = row
    d = ImageDraw.Draw(img)

    d.polygon([proj(cx, cy, 0) for cx, cy in ground], fill=GROUND)

    # depth-sorted draw list: back (small x+y) to front
    items = [("b", b, b["gx"] + b["gy"]) for b in buildings]
    items += [("s", xy, xy[0] + xy[1]) for xy in shrubs]
    for kind, obj, _ in sorted(items, key=lambda it: it[2]):
        if kind == "b":
            draw_building(d, obj)
        else:
            draw_shrub(d, *obj)

    img.resize((W // SS, H // SS), Image.LANCZOS).save(OUT, quality=95)
    print(f"wrote {OUT}  {W // SS}x{H // SS}")


if __name__ == "__main__":
    main()
