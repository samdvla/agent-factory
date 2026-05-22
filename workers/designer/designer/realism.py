"""Realism-mode reference acquisition.

Creative mode renders a reference image from a text prompt via
nanobanana → Meshy/Tripo. Realism mode targets real people / licensed
characters where we cannot generate an accurate likeness, so we search
the web for the best existing photo and feed THAT to image-to-3D
instead.

Output from realism mode is always IP-loaded (real-person likeness or
licensed character), so research forces brief['ip_risk']='high' when
brief['mode']=='realism' — the publisher then holds the draft for
operator approval before any marketplace upload. This module focuses
purely on finding the best available reference.

Pipeline:
  1. SerpAPI Google Images search for real full-body photographs of the
     subject (filters: photo type, large; framing hint appended to query)
  2. Download top-N candidates (default 12)
  3. Gate on min resolution (1040px per Meshy guidance), reasonable
     aspect ratio, and — when a face detector is installed — presence of
     a face (no face = slop, not the subject)
  4. Score survivors by sharpness + resolution + framing (full-body shots
     beat tight headshots, which 3D-print as floating heads)
  5. Optional background-removal pass via rembg (skipped if not
     installed) — keeps v1 free; BRIA RMBG can be wired later

Why NOT face-crop / commercial-license filters (regression fix): the
original version searched with itp:face (Google's face-crop type) and
sur:fmc (free-to-modify-commercial license). itp:face guarantees tight
headshots — the opposite of the full-body reference image-to-3D needs —
and sur:fmc filters out essentially every real photo of a famous person,
leaving only random CC slop. Realism output is IP-high and held for
operator approval regardless, so the license filter protected nothing
while wrecking subject relevance. Both are now off by default.

Face detection is optional (mirrors the rembg pattern): if OpenCV is
importable we reject faceless candidates and prefer full-body framing;
without it we degrade to the search-filter + aspect heuristics. Install
`opencv-python-headless` to enable the strict face/full-body gate.

Env:
  SERPAPI_API_KEY      required; module disabled without it
  REALISM_CANDIDATES   int, default 12 — search results to download/score
  REALISM_MIN_RES      int, default 1040 — long-edge gate in pixels
  REALISM_FRAMING      str, default "full body" — framing hint appended to
                       the search query; set "" to disable
  REALISM_SAFE_LICENSE bool, default 0 — when 1, re-add the sur:fmc
                       license bias (drops most real-person photos)

Raises:
  RealismError on any hard failure (no key, search empty, all candidates
  rejected, download errors). Caller treats this as a hard 3D failure;
  no text-to-3D fallback because text-to-3D cannot produce a real
  likeness — falling back would silently ship a wrong-face product.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"

# Budget-ledger identifier for cost stamping. SerpAPI charges per
# successful search (~$0.015 on the dev plan); we stamp one charge per
# acquire_reference call regardless of how many candidates we score.
SOURCE_MODEL_ID = "serpapi-google-images"

# Sharpness gate — Laplacian variance below this is "too blurry" even
# if SerpAPI tagged it as a face photo. Tuned to reject obvious motion
# blur and low-quality thumbnails; sharp portraits typically score 200+.
SHARPNESS_FLOOR = 80.0

# Framing: a detected face occupying more than this fraction of the image
# is a headshot/portrait crop — usable, but it 3D-prints as a floating
# head. Below it the subject reads as full/three-quarter body, which is
# what we want. Used only to *rank* (not gate) when a detector is present.
FACE_AREA_FULLBODY_MAX = 0.12


class RealismError(Exception):
    """Hard failure in realism-mode reference acquisition. Caller MUST
    NOT silently fall back to text-to-3D — that would generate a
    different face than the one the brief targets."""


def is_configured() -> bool:
    return bool(os.environ.get("SERPAPI_API_KEY", "").strip())


def acquire_reference(
    query: str,
    *,
    job_id: int,
    assets_dir: str,
) -> tuple[str, str]:
    """Find the best real-world reference image for `query`, save it
    under `assets_dir/{job_id}-ref.png`, and return
    `(path, source_model_id)` matching nanobanana.generate_reference_image's
    contract so the designer's image-to-3D step is a drop-in swap.

    The returned PNG is what Meshy/Tripo image-to-3D receives. It is the
    raw best candidate by default; if rembg is importable the alpha is
    cut to subject-only first (cleaner Meshy input, no API cost).
    """
    if not is_configured():
        raise RealismError(
            "SERPAPI_API_KEY not set — realism mode requires a SerpAPI key. "
            "Get one at https://serpapi.com/users/sign_up"
        )
    if not isinstance(query, str) or not query.strip():
        raise RealismError("realism mode needs a non-empty subject query")

    work = Path(assets_dir)
    work.mkdir(parents=True, exist_ok=True)

    n = _int_env("REALISM_CANDIDATES", 12)
    min_res = _int_env("REALISM_MIN_RES", 1040)
    safe_license = _bool_env("REALISM_SAFE_LICENSE", False)

    results = _search_serpapi(query.strip(), n=n, safe_license=safe_license)
    if not results:
        raise RealismError(
            f"SerpAPI returned 0 face-tagged candidates for query={query!r} — "
            "try a more specific subject name or relax REALISM_SAFE_LICENSE"
        )

    scored: list[tuple[float, Path, dict]] = []
    for idx, item in enumerate(results):
        url = item.get("original") or item.get("thumbnail")
        if not url:
            continue
        cand_path = work / f"{job_id}-cand-{idx:02d}.png"
        try:
            _download(url, cand_path)
        except Exception as e:
            print(f"[realism] candidate {idx} download failed ({url}): {e}",
                  file=sys.stderr, flush=True)
            continue
        score = _score(cand_path, min_res=min_res)
        if score is None:
            cand_path.unlink(missing_ok=True)
            continue
        scored.append((score, cand_path, item))

    if not scored:
        raise RealismError(
            f"all {len(results)} candidates failed quality gates for "
            f"query={query!r} (min_res={min_res}, sharpness>={SHARPNESS_FLOOR})"
        )

    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, best_path, best_meta = scored[0]
    print(
        f"[realism] picked candidate {best_path.name} score={best_score:.3f} "
        f"source={best_meta.get('source') or best_meta.get('source_name') or '?'} "
        f"({len(scored)}/{len(results)} passed gates)",
        file=sys.stderr, flush=True,
    )

    ref_path = work / f"{job_id}-ref.png"
    cleaned = _optional_bg_cleanup(best_path, ref_path)
    if cleaned is None:
        # No rembg — just copy the raw candidate to the canonical ref slot.
        Image.open(best_path).convert("RGBA").save(ref_path, format="PNG")

    for _, cand_path, _ in scored:
        if cand_path != ref_path:
            cand_path.unlink(missing_ok=True)

    return str(ref_path), SOURCE_MODEL_ID


def _search_serpapi(query: str, *, n: int, safe_license: bool) -> list[dict]:
    """Hit SerpAPI google_images for real full-body photos of the subject.

    tbs= flags:
      itp:photo    real photographs — filters out clipart/lineart/fan art
                   without forcing the tight face crop that itp:face does.
      isz:l        large size — biases toward >=1024px
      sur:fmc      (opt-in via REALISM_SAFE_LICENSE) free to modify/share/
                   use commercially. Off by default: it drops virtually
                   every real photo of a famous subject, and realism
                   output is IP-high + operator-gated regardless, so the
                   license bias buys no protection while gutting relevance.

    The query is augmented with a framing hint (REALISM_FRAMING, default
    "full body") so Google ranks standing/whole-body shots first — a tight
    headshot reference 3D-prints as a floating head. Subject stays
    front-loaded since early tokens carry the most weight.
    """
    api_key = os.environ["SERPAPI_API_KEY"].strip()
    tbs_parts = ["itp:photo", "isz:l"]
    if safe_license:
        tbs_parts.append("sur:fmc")
    framing = os.environ.get("REALISM_FRAMING", "full body").strip()
    q = f"{query} {framing}".strip() if framing else query
    params = {
        "engine": "google_images",
        "q": q,
        "ijn": "0",
        "tbs": ",".join(tbs_parts),
        "api_key": api_key,
        "num": str(max(10, n)),
    }
    url = f"{SERPAPI_ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:400]
        raise RealismError(f"SerpAPI HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RealismError(f"SerpAPI network error: {e}") from e

    images = payload.get("images_results") or []
    return images[:n]


def _download(url: str, dest: Path, *, timeout: int = 30) -> None:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "agent-factory-realism/1.0",
            "Accept": "image/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if len(data) < 2048:
        raise RuntimeError(f"image too small ({len(data)} bytes)")
    dest.write_bytes(data)


def _score(path: Path, *, min_res: int) -> float | None:
    """Composite quality score in [0, 1] or None if the image fails a
    hard gate (resolution, aspect ratio, sharpness, or — when a face
    detector is available — absence of any face)."""
    try:
        img = Image.open(path)
        img.load()
    except Exception:
        return None
    w, h = img.size
    long_edge = max(w, h)
    if long_edge < min_res:
        return None
    aspect = w / h if h else 0.0
    # Allow taller full-body portraits (down to ~1:2.5) while still
    # rejecting banner-wide images that can't anchor a character.
    if not (0.4 <= aspect <= 2.0):
        return None

    sharpness = _laplacian_variance(img)
    if sharpness < SHARPNESS_FLOOR:
        return None

    faces = _detect_faces(img)
    if faces is not None and len(faces) == 0:
        # Detector ran and found no face — this is slop, not the subject.
        return None

    # Normalize sharpness via tanh — saturates around variance 400 so a
    # razor-sharp image doesn't dominate purely on edge contrast.
    sharp_norm = float(np.tanh(sharpness / 200.0))
    res_norm = min(1.0, long_edge / 2048.0)
    framing = _framing_score((w, h), faces)
    return 0.4 * sharp_norm + 0.3 * res_norm + 0.3 * framing


def _framing_score(size: tuple[int, int], faces: list | None) -> float:
    """Prefer full-body, portrait-oriented references in [0, 1].

    Portrait (taller than wide) beats landscape because standing figures
    need vertical room. When faces were detected, a face filling a small
    fraction of the frame reads as full/three-quarter body (good) while a
    face filling the frame is a headshot (3D-prints as a floating head)."""
    w, h = size
    # Square scores 1.0; landscape decays; portrait holds at 1.0.
    portrait = 1.0 if h >= w else max(0.0, h / w)
    if faces:
        img_area = float(w * h) or 1.0
        largest = max((fw * fh) for (_x, _y, fw, fh) in faces)
        ratio = largest / img_area
        full_body = max(0.0, min(1.0,
                                 (FACE_AREA_FULLBODY_MAX - ratio) / FACE_AREA_FULLBODY_MAX))
        return 0.5 * portrait + 0.5 * full_body
    return portrait


def _detect_faces(img: Image.Image) -> list | None:
    """Detect frontal faces, returning a list of (x, y, w, h) boxes, or
    None when no detector is installed (caller must NOT gate on faces in
    that case). Optional dependency — mirrors _optional_bg_cleanup — so
    the base install stays numpy + Pillow only.

    Install `opencv-python-headless` to enable the face/full-body gate."""
    try:
        import cv2  # type: ignore
    except ImportError:
        return None
    try:
        gray = np.asarray(img.convert("L"))
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            return None
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                         minSize=(40, 40))
        return [tuple(int(v) for v in box) for box in faces]
    except Exception as e:
        print(f"[realism] face detection failed ({e}) — skipping face gate",
              file=sys.stderr, flush=True)
        return None


def _laplacian_variance(img: Image.Image) -> float:
    """Laplacian variance — standard cheap blur detector. Pillow's
    builtin FIND_EDGES kernel is a close enough proxy for the 3x3
    discrete Laplacian, and avoids dragging in opencv."""
    gray = img.convert("L")
    # Downscale large images first — the variance signal is preserved
    # but the kernel pass becomes ~10x faster on 4k photos.
    if max(gray.size) > 1024:
        scale = 1024 / max(gray.size)
        gray = gray.resize((int(gray.size[0] * scale), int(gray.size[1] * scale)))
    edges = gray.filter(ImageFilter.FIND_EDGES)
    arr = np.asarray(edges, dtype=np.float32)
    return float(arr.var())


def _optional_bg_cleanup(src: Path, dest: Path) -> Path | None:
    """If rembg is importable, cut the background and save the alpha
    PNG to dest. Returns dest on success, None when rembg isn't
    available (caller falls back to copying the raw candidate).

    rembg is intentionally optional — adding it as a hard dep pulls
    onnxruntime which is heavy. Operators who want clean alpha installs
    it explicitly; otherwise we ship the raw photo and let Meshy handle
    the background internally (it tolerates plain backgrounds well per
    its own docs)."""
    try:
        from rembg import remove  # type: ignore
    except ImportError:
        return None
    try:
        raw = src.read_bytes()
        cut = remove(raw)
        dest.write_bytes(cut)
        return dest
    except Exception as e:
        print(f"[realism] rembg cleanup failed ({e}) — using raw candidate",
              file=sys.stderr, flush=True)
        return None


def _int_env(name: str, default: int) -> int:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return max(1, int(v))
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in {"1", "true", "yes", "on"}
