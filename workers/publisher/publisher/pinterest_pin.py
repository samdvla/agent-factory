"""Generate a 1000×1500 Pinterest pin from a designer preview PNG.

Why: Pinterest is the #1 external traffic source for Etsy (~41% of external
clicks per the Pinvine 2026 Strategy report). A vertical 2:3 pin with the
title overlaid gets more saves + clicks than the raw 1:1 product render.

What this does (and doesn't):
  • Resizes / letterboxes the source render onto a 1000×1500 canvas.
  • Overlays the listing title at the bottom with a translucent band so it
    reads against any background.
  • Stamps a small "STL · Digital Download" badge so the buyer sees the
    file format at a glance (Pinterest's first-impression is the image
    alone — no other context).
  • Saves the PNG to the assets dir and returns its path.

What this DOES NOT do:
  • Post to Pinterest. That requires an OAuth access token + Boards API
    setup which is intentionally NOT in this worker (operator credential
    boundary — see project memory). The operator picks up the generated
    pins from disk + posts them via a dedicated cron job once auth is
    wired separately.

The module is best-effort: any failure (missing source, font issue, write
error) returns None so publisher.handle() can ship the listing without a
pin instead of failing the whole cycle.
"""
from __future__ import annotations

import os
import sys
from typing import Optional

# Pinterest's recommended aspect ratio is 2:3; 1000×1500 is the sweet spot
# (large enough that the desktop feed doesn't downscale, small enough that
# the file stays under their 32MB cap with overhead to spare).
PIN_WIDTH = 1000
PIN_HEIGHT = 1500

# Background pad colour when the source render doesn't fill the 2:3 frame.
# Off-white reads cleaner than pure #fff against Pinterest's white grid.
PIN_BG_RGB = (250, 248, 244)

# Title band geometry. Sits at the bottom 1/4 of the pin so the buyer sees
# the product first, then the headline.
TITLE_BAND_HEIGHT = 360
TITLE_BAND_RGBA = (15, 15, 18, 215)
TITLE_TEXT_RGB = (245, 240, 232)

BADGE_TEXT = "STL · Digital Download"
BADGE_TEXT_RGB = (245, 240, 232)
BADGE_BG_RGBA = (210, 92, 36, 230)


def _log(msg: str) -> None:
    print(f"[pinterest-pin] {msg}", file=sys.stderr, flush=True)


def _load_font(size: int):
    """Best-effort font loader. Tries common system fonts first (better
    kerning than Pillow's default bitmap), falls back silently when none
    exist. Operating in a headless server context means we can't assume
    any specific font is installed."""
    try:
        from PIL import ImageFont  # type: ignore
    except ImportError:
        return None
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _wrap_title(title: str, font, max_width: int, draw) -> list[str]:
    """Greedy word-wrap that respects pixel width using the loaded font.
    Returns at most 4 lines so the title doesn't blow the band."""
    if not title:
        return []
    words = title.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = (current + " " + word).strip()
        bbox = draw.textbbox((0, 0), candidate, font=font) if font else None
        width = (bbox[2] - bbox[0]) if bbox else len(candidate) * 12
        if width <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
            if len(lines) >= 3:
                # Truncate the rest into the last line + ellipsis.
                if word != words[-1]:
                    current = (current + "…")
                break
    if current and len(lines) < 4:
        lines.append(current)
    return lines


def generate_pin(
    source_image: str,
    title: str,
    output_path: str,
    *,
    badge_text: str = BADGE_TEXT,
) -> Optional[str]:
    """Render a Pinterest pin to `output_path`. Returns the path on success,
    None on any failure (caller logs + ships the listing without a pin).

    Layout:
      ┌────────────────────────────────────┐
      │                                    │
      │      [source image, fit-cover]     │   ← top 75% of canvas
      │                                    │
      │                                    │
      ├────────────────────────────────────┤
      │  [badge: STL · Digital Download]   │
      │                                    │   ← bottom title band
      │  Title goes here, wrapped to 3-4   │
      │  lines max with a translucent      │
      │  band behind it for legibility.    │
      └────────────────────────────────────┘
    """
    try:
        from PIL import Image, ImageDraw  # type: ignore
    except ImportError:
        _log("Pillow not installed — skipping pin generation")
        return None
    if not os.path.exists(source_image):
        _log(f"source image missing: {source_image}")
        return None
    try:
        src = Image.open(source_image).convert("RGB")
    except Exception as e:
        _log(f"failed to open source {source_image}: {e}")
        return None

    canvas = Image.new("RGB", (PIN_WIDTH, PIN_HEIGHT), PIN_BG_RGB)

    # Fit the source into the top 75% with letterbox preserving aspect.
    image_area_h = PIN_HEIGHT - TITLE_BAND_HEIGHT
    src_w, src_h = src.size
    scale = min(PIN_WIDTH / src_w, image_area_h / src_h)
    new_w = max(1, int(src_w * scale))
    new_h = max(1, int(src_h * scale))
    try:
        resized = src.resize((new_w, new_h), Image.LANCZOS)
    except AttributeError:
        # Older Pillow lacks Image.LANCZOS as an attribute on Image directly.
        from PIL.Image import Resampling  # type: ignore
        resized = src.resize((new_w, new_h), Resampling.LANCZOS)
    off_x = (PIN_WIDTH - new_w) // 2
    off_y = (image_area_h - new_h) // 2
    canvas.paste(resized, (off_x, off_y))

    # Title band — semi-transparent dark slab at the bottom. We composite
    # an RGBA overlay onto the RGB canvas to get the translucency.
    overlay = Image.new("RGBA", (PIN_WIDTH, PIN_HEIGHT), (0, 0, 0, 0))
    draw_overlay = ImageDraw.Draw(overlay)
    band_top = PIN_HEIGHT - TITLE_BAND_HEIGHT
    draw_overlay.rectangle(
        [(0, band_top), (PIN_WIDTH, PIN_HEIGHT)],
        fill=TITLE_BAND_RGBA,
    )

    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    # Badge: small pill above the title band.
    badge_font = _load_font(32)
    badge_w = 380
    badge_h = 60
    badge_x = (PIN_WIDTH - badge_w) // 2
    badge_y = band_top + 24
    # Round-ish corners: Pillow's rounded_rectangle since v9.2.
    try:
        draw.rounded_rectangle(
            [(badge_x, badge_y), (badge_x + badge_w, badge_y + badge_h)],
            radius=12,
            fill=BADGE_BG_RGBA[:3],
        )
    except AttributeError:
        draw.rectangle(
            [(badge_x, badge_y), (badge_x + badge_w, badge_y + badge_h)],
            fill=BADGE_BG_RGBA[:3],
        )
    if badge_font:
        bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.text(
            (badge_x + (badge_w - tw) // 2, badge_y + (badge_h - th) // 2 - 4),
            badge_text,
            font=badge_font,
            fill=BADGE_TEXT_RGB,
        )

    # Title text.
    title_font_size = 56
    title_font = _load_font(title_font_size)
    max_text_width = PIN_WIDTH - 80
    lines = _wrap_title(title, title_font, max_text_width, draw)
    line_height = title_font_size + 14
    text_top = badge_y + badge_h + 28
    for i, line in enumerate(lines[:4]):
        if title_font:
            bbox = draw.textbbox((0, 0), line, font=title_font)
            tw = bbox[2] - bbox[0]
            x = (PIN_WIDTH - tw) // 2
        else:
            x = 40
        draw.text(
            (x, text_top + i * line_height),
            line,
            font=title_font,
            fill=TITLE_TEXT_RGB,
        )

    try:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        canvas.save(output_path, "PNG", optimize=True)
    except OSError as e:
        _log(f"failed to write {output_path}: {e}")
        return None

    _log(f"wrote pin {output_path}")
    return output_path


def derive_pin_path(asset_path: Optional[str], job_id: int, data_dir: str) -> str:
    """Pick a deterministic pin filename. Lives under the same assets dir as
    the rest of the cycle's artifacts so cleanup logic doesn't have to
    discover yet another location."""
    assets_dir = os.path.join(data_dir, "assets")
    return os.path.join(assets_dir, f"{job_id}_pinterest.png")
