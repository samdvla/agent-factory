#!/usr/bin/env python3
"""Compose SabiWabi marketplace banners from the existing mascot icon.

Free, no API: reuses branding/icons/icon-square-1480.png as a circular badge,
the sampled brand palette, and an Avenir Next wordmark. Renders one 4:1 layout
at each marketplace's native banner dimensions.

Run from the repo root:  python3 branding/build_banners.py
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(ROOT, "icons", "icon-square-1480.png")
OUT = os.path.join(ROOT, "banners")
os.makedirs(OUT, exist_ok=True)

# --- brand palette ----------------------------------------------------
src = Image.open(os.path.join(ROOT, "icons", "master.png")).convert("RGB")
BG_LIGHT = src.getpixel((1024, 60))     # cream, sampled from the master backdrop
BG_DEEP  = src.getpixel((60, 2000))     # warmer sand from the lower corner
INK      = (94, 64, 48)                 # deep clay brown — "Sabi"
CLAY     = (192, 116, 80)               # terracotta — "Wabi"
MUTED    = (132, 110, 92)               # tagline brown
SAGE     = (150, 168, 138)              # accent

# --- fonts: probe the Avenir Next .ttc for the faces we want ----------
TTC = "/System/Library/Fonts/Avenir Next.ttc"

def load_face(want, size):
    """Load the Avenir Next sub-face whose name contains `want`."""
    for idx in range(24):
        try:
            f = ImageFont.truetype(TTC, size, index=idx)
        except Exception:
            break
        name = " ".join(f.getname()).lower()
        if want in name:
            return f
    return ImageFont.truetype(TTC, size, index=0)


def gradient_bg(w, h):
    """Vertical cream gradient."""
    bg = Image.new("RGB", (w, h))
    px = bg.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        row = tuple(round(BG_LIGHT[i] + (BG_DEEP[i] - BG_LIGHT[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row
    return bg


def circular_badge(diameter):
    """Mascot icon masked to a circle, with a soft ring."""
    icon = Image.open(ICON).convert("RGB").resize((diameter, diameter), Image.LANCZOS)
    mask = Image.new("L", (diameter, diameter), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, diameter, diameter), fill=255)
    badge = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    badge.paste(icon, (0, 0), mask)
    # thin sage ring
    ring = max(2, diameter // 110)
    ImageDraw.Draw(badge).ellipse(
        (ring // 2, ring // 2, diameter - ring // 2, diameter - ring // 2),
        outline=SAGE, width=ring,
    )
    return badge


def render(name, w, h):
    H = h
    banner = gradient_bg(w, h).convert("RGBA")

    # soft highlight glow behind the badge
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = int(H * 0.62)
    gcx, gcy = int(H * 0.46), int(H * 0.5)
    gd.ellipse((gcx - gr, gcy - gr, gcx + gr, gcy + gr),
               fill=(255, 252, 244, 120))
    banner = Image.alpha_composite(banner, glow.filter(ImageFilter.GaussianBlur(H * 0.06)))

    # circular mascot badge with drop shadow
    d = int(H * 0.70)
    bx, by = int(H * 0.12), (H - d) // 2
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((bx, by + int(H * 0.03), bx + d, by + d + int(H * 0.03)),
               fill=(70, 48, 36, 90))
    banner = Image.alpha_composite(banner, shadow.filter(ImageFilter.GaussianBlur(H * 0.025)))
    banner.alpha_composite(circular_badge(d), (bx, by))

    draw = ImageDraw.Draw(banner)
    tx = bx + d + int(H * 0.085)

    # wordmark — two-tone "Sabi" + "Wabi"
    wm = load_face("heavy", int(H * 0.255)) or load_face("bold", int(H * 0.255))
    a_w = draw.textbbox((0, 0), "Sabi", font=wm)
    asc, desc = wm.getmetrics()
    word_h = asc + desc
    # vertical layout block: wordmark + rule + tagline, centered
    tag = load_face("medium", int(H * 0.083))
    tag_text = "Original character figurines  -  AI-designed, 3D-print-ready"
    tb = draw.textbbox((0, 0), tag_text, font=tag)
    tag_h = tb[3] - tb[1]
    gap1, rule_h, gap2 = int(H * 0.05), max(2, int(H * 0.012)), int(H * 0.055)
    block_h = word_h + gap1 + rule_h + gap2 + tag_h
    y0 = (H - block_h) // 2

    draw.text((tx, y0), "Sabi", font=wm, fill=INK)
    sabi_w = a_w[2] - a_w[0]
    draw.text((tx + sabi_w, y0), "Wabi", font=wm, fill=CLAY)

    # sage accent rule
    ry = y0 + word_h + gap1
    draw.rounded_rectangle((tx, ry, tx + int(H * 0.42), ry + rule_h),
                           radius=rule_h, fill=SAGE)

    # tagline
    draw.text((tx, ry + rule_h + gap2 - tb[1]), tag_text, font=tag, fill=MUTED)

    out = os.path.join(OUT, name)
    banner.convert("RGB").save(out, quality=95)
    print(f"wrote {name}  {w}x{h}")


# marketplace banner sizes (all 4:1 so the layout scales cleanly)
render("banner-etsy-3360x840.png",          3360, 840)
render("banner-cults3d-1600x400.png",       1600, 400)
render("banner-sketchfab-2000x500.png",     2000, 500)
render("banner-myminifactory-1920x480.png", 1920, 480)
