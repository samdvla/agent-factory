#!/usr/bin/env python3
"""
make-icon.py — generate the macOS 26 / Tahoe-compatible app icon for
agent-factory from the brand-mark glyph used inside the app.

Layout follows Apple's Big Sur → Sequoia template (which Tahoe still
respects when masking .icns inputs):

  - 1024 × 1024 canvas, transparent outside the body
  - Body is an Apple superellipse (n=5) sitting inside the central
    824 × 824 area (100 px margin on every side)
  - Inside the body: deep-black vertical gradient + a centered
    "brand-mark" tile (orange/copper gradient with a dark inset square)

Outputs:
  src-tauri/icons/icon.png            (1024 px master)
  src-tauri/icons/128x128.png         (128 px)
  src-tauri/icons/128x128@2x.png      (256 px, Tauri's @2x slot)
  src-tauri/icons/32x32.png           (32 px)
  src-tauri/icons/icon.icns           (full .icns built via iconutil)
  src-tauri/icons/icon.ico            (Windows: 256 + 64 + 32 + 16)

Dependencies: Pillow + `iconutil` (ships with macOS).
"""
from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"


# ── helpers ─────────────────────────────────────────────────────────

def superellipse_mask(size: int, radius_fraction: float = 0.4475) -> Image.Image:
    """1-channel mask of an Apple-style squircle (superellipse, n=5) that
    fills the entire `size × size` square. `radius_fraction` is unused —
    kept for API symmetry. n=5 matches the curve Apple uses for app-icon
    bodies on macOS Big Sur+ and iOS 13+."""
    mask = Image.new("L", (size, size), 0)
    px = mask.load()
    n = 5.0
    half = size / 2.0
    for y in range(size):
        ny = abs((y + 0.5) - half) / half
        ny_n = ny ** n
        # Solve |x|^n + |y|^n <= 1 for x
        if ny_n >= 1.0:
            continue
        nx_max = (1.0 - ny_n) ** (1.0 / n)
        x_max = nx_max * half
        x_lo = int(math.floor(half - x_max))
        x_hi = int(math.ceil(half + x_max))
        for x in range(max(0, x_lo), min(size, x_hi)):
            nx = abs((x + 0.5) - half) / half
            v = nx ** n + ny_n
            if v <= 1.0:
                px[x, y] = 255
            elif v < 1.02:
                # anti-alias the edge
                t = (1.02 - v) / 0.02
                px[x, y] = int(255 * max(0.0, min(1.0, t)))
    return mask


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int],
                      bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", (w, h), top)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def diagonal_gradient(size: tuple[int, int],
                      c0: tuple[int, int, int],
                      c1: tuple[int, int, int],
                      angle_deg: float = 140.0) -> Image.Image:
    """Linear gradient at `angle_deg` (CSS-style: 0° = bottom→top,
    90° = left→right, 140° ≈ top-left → bottom-right)."""
    w, h = size
    img = Image.new("RGB", (w, h), c0)
    px = img.load()
    # CSS-equivalent direction vector
    rad = math.radians(angle_deg - 90)
    dx, dy = math.cos(rad), math.sin(rad)
    # Project every pixel onto the direction; normalise by the projection
    # of the box's diagonal so t ranges [0, 1].
    proj_max = abs(w * dx) + abs(h * dy)
    for y in range(h):
        for x in range(w):
            t = ((x * dx) + (y * dy)) / proj_max + 0.5
            t = max(0.0, min(1.0, t))
            r = int(c0[0] + (c1[0] - c0[0]) * t)
            g = int(c0[1] + (c1[1] - c0[1]) * t)
            b = int(c0[2] + (c1[2] - c0[2]) * t)
            px[x, y] = (r, g, b)
    return img


def rounded_rect(size: tuple[int, int], radius: int,
                 fill: tuple[int, int, int, int]) -> Image.Image:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([(0, 0), (size[0] - 1, size[1] - 1)],
                           radius=radius, fill=fill)
    return img


# ── icon composition ────────────────────────────────────────────────

def compose_master() -> Image.Image:
    CANVAS = 1024
    PAD = 100  # Apple template margin
    BODY = CANVAS - 2 * PAD  # 824

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    # Body — near-uniform deep black with a barely-there top-down lift,
    # matching the flat Tahoe dark-icon look (Terminal, Settings, Kali).
    body_rgb = vertical_gradient((BODY, BODY),
                                 top=(0x0c, 0x0b, 0x0a),
                                 bottom=(0x06, 0x05, 0x05))
    body_mask = superellipse_mask(BODY)
    body = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    body.paste(body_rgb, (0, 0), body_mask)

    # Tahoe "liquid glass" rim — a thin bright crescent that hugs the
    # top of the squircle, fading to nothing by mid-icon. Built by
    # subtracting an inset superellipse from the outer mask, then
    # multiplying by a vertical falloff so only the upper half lights.
    inner_mask = superellipse_mask(BODY - 14)
    inner_full = Image.new("L", (BODY, BODY), 0)
    inner_full.paste(inner_mask, (7, 7))
    rim = Image.new("L", (BODY, BODY), 0)
    op_outer = body_mask.load()
    op_inner = inner_full.load()
    rim_px = rim.load()
    for yy in range(BODY):
        falloff = max(0.0, 1.0 - (yy / (BODY * 0.42))) ** 1.6
        if falloff <= 0:
            continue
        for xx in range(BODY):
            d = op_outer[xx, yy] - op_inner[xx, yy]
            if d > 0:
                rim_px[xx, yy] = int(min(255, d * falloff))
    rim = rim.filter(ImageFilter.GaussianBlur(1.2))
    rim_alpha = rim.point(lambda v: int(v * 0.85))
    rim_rgba = Image.new("RGBA", (BODY, BODY), (255, 255, 255, 0))
    rim_rgba.putalpha(rim_alpha)
    body = Image.alpha_composite(body, rim_rgba)

    # Very faint top-half diffuse sheen — adds depth without going 3D
    sheen = Image.new("L", (BODY, BODY), 0)
    sd = ImageDraw.Draw(sheen)
    sd.ellipse([(-BODY * 0.1, -BODY * 0.85),
                (BODY * 1.1, BODY * 0.20)], fill=22)
    sheen = sheen.filter(ImageFilter.GaussianBlur(BODY * 0.06))
    sheen_rgba = Image.new("RGBA", (BODY, BODY), (255, 255, 255, 0))
    sheen_rgba.putalpha(sheen)
    body = Image.alpha_composite(body, Image.composite(
        sheen_rgba, Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0)),
        body_mask))

    # Paste body onto canvas
    canvas.alpha_composite(body, (PAD, PAD))

    # ── Brand-mark tile ────────────────────────────────────────────
    # Scale ratio: app uses 24px tile inside ~80px chrome. Here we want
    # the tile to read as the icon's hero glyph, so we make it ~46% of
    # the body width.
    TILE = int(BODY * 0.46)  # ~379
    INSET = int(TILE * 0.27)  # inset square = tile - 2*INSET
    OUTER_R = int(TILE * 0.22)
    INNER_R = max(2, int((TILE - 2 * INSET) * 0.07))

    # Outer tile — copper→warm gradient
    tile_grad = diagonal_gradient((TILE, TILE),
                                  c0=(0xd9, 0x77, 0x57),
                                  c1=(0xe8, 0xa8, 0x57),
                                  angle_deg=140.0)
    tile_mask = rounded_rect((TILE, TILE), OUTER_R, (255, 255, 255, 255))
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    tile.paste(tile_grad, (0, 0), tile_mask.split()[3])

    # Subtle top-left radial highlight inside the tile (matches the CSS
    # radial-gradient at 30% 28%).
    glow = Image.new("L", (TILE, TILE), 0)
    gd = ImageDraw.Draw(glow)
    cx, cy = int(TILE * 0.30), int(TILE * 0.28)
    rad = int(TILE * 0.55)
    gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(TILE * 0.10))
    glow_rgba = Image.new("RGBA", (TILE, TILE), (255, 220, 180, 0))
    glow_rgba.putalpha(glow)
    tile = Image.alpha_composite(tile, Image.composite(
        glow_rgba, Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0)),
        tile_mask.split()[3]))

    # Inner dark inset square
    inner_size = TILE - 2 * INSET
    inner = rounded_rect((inner_size, inner_size), INNER_R,
                         (0x14, 0x11, 0x0d, 230))  # ~90% opacity
    # 1-px hairline accent outline around the inner square
    outline = rounded_rect((inner_size, inner_size), INNER_R,
                           (0, 0, 0, 0))
    od = ImageDraw.Draw(outline)
    od.rounded_rectangle([(0, 0), (inner_size - 1, inner_size - 1)],
                         radius=INNER_R,
                         outline=(0xd9, 0x77, 0x57, 140), width=2)
    tile.alpha_composite(inner, (INSET, INSET))
    tile.alpha_composite(outline, (INSET, INSET))

    # Drop a soft shadow under the tile so it floats on the dark body
    shadow = Image.new("RGBA", (TILE + 80, TILE + 80), (0, 0, 0, 0))
    sd2 = ImageDraw.Draw(shadow)
    sd2.rounded_rectangle([(40, 50), (40 + TILE, 50 + TILE)],
                          radius=OUTER_R, fill=(0, 0, 0, 140))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    tile_x = PAD + (BODY - TILE) // 2
    tile_y = PAD + (BODY - TILE) // 2
    canvas.alpha_composite(shadow, (tile_x - 40, tile_y - 50))
    canvas.alpha_composite(tile, (tile_x, tile_y))

    return canvas


# ── output pipeline ─────────────────────────────────────────────────

def main() -> None:
    if not ICONS.exists():
        raise SystemExit(f"icons dir missing: {ICONS}")
    master = compose_master()
    master_path = ICONS / "icon.png"
    master.save(master_path, "PNG")
    print(f"wrote {master_path} ({master.size[0]}×{master.size[1]})")

    # Tauri's required PNG sizes
    for sz, name in [(32, "32x32.png"),
                     (128, "128x128.png"),
                     (256, "128x128@2x.png")]:
        out = ICONS / name
        master.resize((sz, sz), Image.LANCZOS).save(out, "PNG")
        print(f"wrote {out} ({sz}×{sz})")

    # .icns via iconutil (the only sanctioned macOS path)
    with tempfile.TemporaryDirectory() as tmp:
        iset = Path(tmp) / "icon.iconset"
        iset.mkdir()
        for sz, name in [
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
        ]:
            master.resize((sz, sz), Image.LANCZOS).save(iset / name, "PNG")
        icns_out = ICONS / "icon.icns"
        subprocess.run(
            ["iconutil", "-c", "icns", str(iset), "-o", str(icns_out)],
            check=True,
        )
        print(f"wrote {icns_out}")

    # Windows .ico — small embedded sizes
    ico_out = ICONS / "icon.ico"
    master.save(ico_out, format="ICO",
                sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                       (128, 128), (256, 256)])
    print(f"wrote {ico_out}")


if __name__ == "__main__":
    main()
