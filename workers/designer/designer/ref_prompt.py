"""Studio-reference prompt builder for nanobanana / Gemini image gen.

Single source of truth for the wrapping prompt that turns the Designer's
brief into a Nano-Banana / Gemini-image studio plate. Both backends
(`gemini_image.py` direct REST path AND `nanobanana.py` Higgsfield CLI
fallback) MUST call `build_ref_prompt()` — having the prompt in two
places caused a real production bug: prompt iterations landed in the
CLI path while the Gemini path silently kept the old wording and shipped
matte-grey clay characters to Meshy.

Quality target: AAA-game-asset / 3D-marketplace-listing aesthetic — the
hi-poly PBR look you see on FAB / ArtStation / CharacterCreator hero
renders (think Naked Singularity dragon/Sauron-warrior turntables,
Unreal Engine 5 Nanite-class character art). Premium shop pricing
depends on premium-looking previews, and the preview is generated from
this prompt.

Hard tradeoff with image-to-3D: Meshy/Tripo BAKE the ref-image lighting
into the diffuse texture. Dramatic cinematic key+rim contrast (the look
in the operator's reference images) would imprint deep shadow patches
on the GLB as permanent dirt. So we keep the LIGHTING soft and even
(image-to-3D-safe) and push the premium feel through MATERIAL FIDELITY
language: visible scales, threads, rivets, sub-surface skin, edge wear.
Surface detail transfers cleanly through Meshy's texture bake; baked
shadows do not.

Operator-facing knob: `MESHY_TEXTURES_ENABLED` (set by Settings → Mesh
Generation → Textures, propagated by `src-tauri/src/commands.rs` as an
env var on the designer worker).

  ON  → AAA-game-asset render: hi-poly PBR materials, each material
        category in its natural real-world color. We name CATEGORIES
        (skin, fabric, metal, leather, wood, hair, accents) but do NOT
        enumerate specific tones — an earlier attempt that prescribed
        "leather brown, wood brown, stone earth-tones" collapsed the
        whole figure into a green/brown wash because the enumeration
        biased the palette. Hard negatives against monochrome /
        single-hue / all-green / color-cast plus low-poly / untextured
        / blurry-surface failure modes.

  OFF → matte single-color surface — the printable-mesh mode. Operators
        who flipped textures off want a flat-shaded mesh from Meshy/Tripo
        and would be fighting the texture bake otherwise.

Default model is `gemini-3-pro-image-preview` (Nano Banana Pro) at
$0.134/image — chosen because mesh quality is upper-bounded by the
ref-image PBR fidelity and Pro renders visibly cleaner materials. Set
`GEMINI_IMAGE_MODEL=gemini-2.5-flash-image` to drop to ~$0.067/image
if budget pressure changes (clay-textured cost).
"""
from __future__ import annotations

import os


def _textures_enabled() -> bool:
    """Mirror of designer/meshy.py::_textures_enabled. Default ON."""
    return (os.environ.get("MESHY_TEXTURES_ENABLED", "true") or "true").strip().lower() != "false"


_STYLE_TEXTURED = (
    "Style: AAA-game-asset character render at 3D-marketplace listing "
    "quality. Photoreal hi-poly PBR sculpt — every surface zone rendering "
    "its real-world material: skin reads as skin with subtle sub-surface "
    "scattering and pore-level detail; metal reads as polished or "
    "weathered metal with anisotropic specular and edge wear; fabric "
    "reads as woven cloth with visible thread weave and folds; leather "
    "reads as tanned leather with grain and stitches; scales read as "
    "individual scale plates with rim highlights; hair reads as discrete "
    "strands; wood reads as wood-grain. Hyper-detailed surfaces — "
    "individual scales, threads, rivets, stitches, micro-scratches, "
    "edge wear, fabric folds, skin pores, wood grain are visible at "
    "1024px. Restrained realistic palette at natural studio saturation — "
    "every material zone is clearly a different color from adjacent "
    "zones, so the subject does NOT collapse into a single hue. "
    "Inspiration: Unreal Engine 5 Nanite hero character, top-page "
    "ArtStation render, premium FAB / CharacterCreator marketplace "
    "listing (Naked-Singularity-grade fidelity, Soulslike-tier armor "
    "detail).\n"
    "(negative: monochrome, single-color render, single-hue tint, "
    "all-green tint, all-grey tint, all-brown tint, uniform clay color, "
    "color cast over the entire figure, low-poly look, untextured, bare "
    "clay sculpt, unpainted miniature, blocky topology, soft / blurry "
    "surfaces, smoothed-out surfaces that hide detail, low-resolution "
    "texture, washed-out, plastic-toy look, hobbyist sculpey, "
    "oversaturated, neon, candy color, cartoon palette, anime cel-shade, "
    "matte flat shading, no text, no logos, no watermarks, no UI "
    "overlays, no multiple subjects, no environment, no humans not "
    "described in brief, no measuring tools, no film grain, no "
    "depth-of-field blur, no motion blur, no second figure, no props "
    "occluding the subject, no rigging visible, no joint seams, no "
    "moving parts)"
)


_STYLE_MATTE = (
    "Style: photorealistic studio-reference render of a single 3D-printable "
    "object. Matte single-color surface. No painted decals, no PBR textures, "
    "no rigging, no moving parts.\n"
    "(negative: no text, no logos, no watermarks, no UI overlays, no "
    "multiple subjects, no environment, no humans, no measuring tools, no "
    "film grain, no depth-of-field blur, no specular highlights, no second "
    "figure, no props occluding the subject)"
)


def build_ref_prompt(brief: str, aspect_ratio: str) -> str:
    """Wrap the Designer's brief into a studio-reference plate for image-to-3D.

    `brief` is whatever the Designer wrote in `brief_for_image_gen` (subject,
    pose, stylization). The wrapper adds Composition / Background / Lighting
    / Style blocks following Nano Banana Pro's documented prompt formula,
    with command syntax — no conversational filler, every line is a hard
    instruction the model can act on.

    Aspect ratio is requested in-text because the Gemini API's image config
    fields are in flux across preview models; plain-text steering composes
    reliably even when the structured config doesn't take effect.
    """
    style = _STYLE_TEXTURED if _textures_enabled() else _STYLE_MATTE
    return (
        f"{brief}\n\n"
        f"Aspect ratio: {aspect_ratio} vertical portrait.\n"
        "Composition: single hero subject, centered, fills 60-70% of frame, "
        "three-quarter view for characters / front-elevation for symmetric "
        "props / top-down for terrain tiles. Full subject visible from base "
        "to top — no edge cropping.\n"
        "Background: clean neutral light-grey #E8E8E8 seamless studio cyc, "
        "completely uniform — NO horizon line, no environment, no shadow on "
        "backdrop, no vignette, no gradient that could imprint on the mesh "
        "(Meshy/Tripo need a flat backdrop to segment the subject cleanly).\n"
        "Lighting: soft three-point studio — gentle key light from front-"
        "camera-upper-left, soft fill from opposite side, subtle rim from "
        "behind defining silhouette. Shadows on the SUBJECT are soft and "
        "shallow — no deep cast shadows or dark patches, because the "
        "downstream image-to-3D step bakes diffuse shadows into the GLB "
        "texture and they become permanent dirt. The subject is fully lit "
        "and readable from base to top, every material surface visible.\n"
        f"{style}"
    )
