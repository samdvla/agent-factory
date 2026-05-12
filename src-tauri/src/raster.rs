use anyhow::{Context, Result};
use std::path::Path;

pub const DEFAULT_TARGET_PX: u32 = 2048;

/// Print-resolution target for Printify stickers (kiss-cut, up to ~5"). The
/// Printify recommendation is 300 DPI, so 5" * 300 = 1500 px / edge. We round
/// up to 1800 to leave headroom for slightly larger sticker variants.
pub const STICKER_PRINT_TARGET_PX: u32 = 1800;

/// Render an SVG byte slice to a PNG byte vector. The output's longest edge
/// is scaled to `target_px` while preserving aspect ratio. A solid white
/// background is composited beneath the rendered SVG because Etsy listing
/// thumbnails sometimes render transparent PNGs as black on dark themes.
pub fn svg_to_png(svg_bytes: &[u8], target_px: u32) -> Result<Vec<u8>> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_data(svg_bytes, &opt).context("parse SVG")?;
    let size = tree.size();
    let max_dim = size.width().max(size.height());
    if max_dim <= 0.0 {
        anyhow::bail!("SVG has zero size");
    }
    let scale = target_px as f32 / max_dim;
    let pixmap_w = (size.width() * scale).ceil() as u32;
    let pixmap_h = (size.height() * scale).ceil() as u32;
    let mut pixmap = tiny_skia::Pixmap::new(pixmap_w, pixmap_h).context("alloc pixmap")?;
    // Fill white background — Etsy doesn't accept transparent backgrounds
    // well for listing images (renders as black on dark theme).
    pixmap.fill(tiny_skia::Color::WHITE);
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let png = pixmap.encode_png().context("encode PNG")?;
    Ok(png)
}

/// Convert `svg_path` to a sibling `.png` (e.g. `123.svg` → `123.png`) at
/// `DEFAULT_TARGET_PX` on the longest edge. Idempotent: if the .png already
/// exists, returns `Ok(None)` without touching disk.
pub fn rasterize_to_sibling(svg_path: &Path) -> Result<Option<std::path::PathBuf>> {
    let png_path = svg_path.with_extension("png");
    if png_path.exists() {
        return Ok(None); // already done, idempotent skip
    }
    let svg_bytes = std::fs::read(svg_path).context("read svg")?;
    let png = svg_to_png(&svg_bytes, DEFAULT_TARGET_PX)?;
    std::fs::write(&png_path, png).context("write png")?;
    Ok(Some(png_path))
}

/// Print-resolution sibling for Printify uploads. Writes to `<stem>.print.png`
/// alongside the source SVG so the regular `.png` thumbnail (used for the Etsy
/// listing image) is left untouched. Idempotent.
pub fn rasterize_print_sibling(svg_path: &Path, target_px: u32) -> Result<std::path::PathBuf> {
    let stem = svg_path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow::anyhow!("svg_path has no stem: {:?}", svg_path))?;
    let print_path = svg_path.with_file_name(format!("{stem}.print.png"));
    if print_path.exists() {
        return Ok(print_path);
    }
    let svg_bytes = std::fs::read(svg_path).context("read svg")?;
    let png = svg_to_png(&svg_bytes, target_px)?;
    std::fs::write(&print_path, png).context("write print png")?;
    Ok(print_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47];

    fn red_square_svg() -> Vec<u8> {
        br#"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="100" height="100" fill="red"/>
</svg>"#
            .to_vec()
    }

    fn wide_rect_svg() -> Vec<u8> {
        br#"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect x="0" y="0" width="200" height="100" fill="blue"/>
</svg>"#
            .to_vec()
    }

    #[test]
    fn test_simple_svg_roundtrip() {
        let svg = red_square_svg();
        let png = svg_to_png(&svg, DEFAULT_TARGET_PX).expect("rasterize ok");
        assert!(
            png.starts_with(PNG_MAGIC),
            "output should start with PNG magic bytes"
        );
        // Decode the produced PNG back into a pixmap to assert dimensions.
        let decoded = tiny_skia::Pixmap::decode_png(&png).expect("decode png");
        assert_eq!(decoded.width(), DEFAULT_TARGET_PX);
        assert_eq!(decoded.height(), DEFAULT_TARGET_PX);
    }

    #[test]
    fn test_rectangular_svg_preserves_aspect() {
        let svg = wide_rect_svg();
        let png = svg_to_png(&svg, DEFAULT_TARGET_PX).expect("rasterize ok");
        let decoded = tiny_skia::Pixmap::decode_png(&png).expect("decode png");
        // 200x100 source → longest edge scales to 2048 → 2048 x 1024
        assert_eq!(decoded.width(), 2048);
        assert_eq!(decoded.height(), 1024);
    }

    #[test]
    fn test_rasterize_to_sibling_writes_file_and_skips_existing() {
        let dir = tempdir().expect("tempdir");
        let svg_path = dir.path().join("123.svg");
        std::fs::write(&svg_path, red_square_svg()).expect("write svg");

        let first = rasterize_to_sibling(&svg_path).expect("first rasterize");
        let png_path = first.expect("first call should write a file");
        assert!(png_path.exists(), ".png sibling should exist");
        assert_eq!(png_path, svg_path.with_extension("png"));

        let metadata = std::fs::metadata(&png_path).expect("png metadata");
        assert!(metadata.len() > 0, "png file should be non-empty");

        // Second call should be a no-op (idempotent skip).
        let second = rasterize_to_sibling(&svg_path).expect("second rasterize");
        assert!(second.is_none(), "second call should skip existing png");
    }

    #[test]
    fn test_malformed_svg_returns_error() {
        let result = svg_to_png(b"not svg", DEFAULT_TARGET_PX);
        assert!(result.is_err(), "garbage input should error");
    }

    #[test]
    fn test_rasterize_print_sibling_writes_print_png_and_is_idempotent() {
        let dir = tempdir().expect("tempdir");
        let svg_path = dir.path().join("42.svg");
        std::fs::write(&svg_path, red_square_svg()).expect("write svg");

        let first = rasterize_print_sibling(&svg_path, STICKER_PRINT_TARGET_PX)
            .expect("first print rasterize");
        assert!(first.exists());
        assert_eq!(first.file_name().unwrap().to_str().unwrap(), "42.print.png");
        // Doesn't clobber the regular .png — it lives next to it.
        assert!(!svg_path.with_extension("png").exists());

        let decoded = tiny_skia::Pixmap::decode_png(&std::fs::read(&first).unwrap())
            .expect("decode print png");
        assert_eq!(decoded.width(), STICKER_PRINT_TARGET_PX);

        let written_at = std::fs::metadata(&first).unwrap().modified().unwrap();
        let second = rasterize_print_sibling(&svg_path, STICKER_PRINT_TARGET_PX)
            .expect("second print rasterize");
        assert_eq!(first, second);
        assert_eq!(
            std::fs::metadata(&second).unwrap().modified().unwrap(),
            written_at,
            "second call should not rewrite the file",
        );
    }
}
