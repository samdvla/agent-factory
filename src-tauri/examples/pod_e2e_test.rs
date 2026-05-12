//! End-to-end POD pipeline smoke test.
//!
//! Reads the saved Printify PAT + shop_id from the user's local secret
//! store, rasterizes a tiny test SVG, walks the Printify catalog to pick
//! a sticker blueprint + provider + small variants, uploads the PNG,
//! creates a Printify product, and publishes it to Etsy. Each step
//! prints what it did so the user can verify by:
//!   - Looking at the Printify dashboard → Products list (should see the
//!     new "POD pipeline e2e test" sticker)
//!   - Looking at the Etsy seller dashboard → Listings → Drafts (should
//!     see the same product within ~10 seconds of "Published")
//!
//! Run with:
//!   cd src-tauri && cargo run --example pod_e2e_test

use agent_factory_lib::{printify, raster, secrets};
use anyhow::{Context, Result};
use std::path::PathBuf;

const TEST_SVG: &str = r##"<svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="760" height="760" rx="80" fill="#5fd4f0"/>
  <circle cx="400" cy="320" r="170" fill="#0a1620"/>
  <text x="400" y="335" font-family="sans-serif" font-size="80" font-weight="700"
        text-anchor="middle" fill="#5fd4f0">SABI</text>
  <text x="400" y="430" font-family="sans-serif" font-size="60" font-weight="500"
        text-anchor="middle" fill="#0a1620">e2e test sticker</text>
  <text x="400" y="700" font-family="sans-serif" font-size="32"
        text-anchor="middle" fill="#0a1620" opacity="0.7">printify · agent-factory</text>
</svg>"##;

#[tokio::main]
async fn main() -> Result<()> {
    // ── 1. Load credentials ────────────────────────────────────────────
    let api_key = secrets::get("printify_api_key")
        .context("read printify_api_key from secrets")?
        .ok_or_else(|| anyhow::anyhow!("printify_api_key is not set — open Settings and Verify a PAT first"))?;
    let shop_id_str = secrets::get("printify_shop_id")
        .context("read printify_shop_id")?
        .ok_or_else(|| anyhow::anyhow!("printify_shop_id is not set — re-run Verify in Settings"))?;
    let shop_id: i64 = shop_id_str.parse().context("parse shop_id")?;
    println!("✓ Credentials loaded. shop_id={shop_id}");

    // ── 2. Write test SVG to a temp file and rasterize ────────────────
    let temp_dir = std::env::temp_dir().join("agent-factory-pod-e2e");
    std::fs::create_dir_all(&temp_dir).context("mkdir temp")?;
    let svg_path: PathBuf = temp_dir.join("e2e.svg");
    std::fs::write(&svg_path, TEST_SVG).context("write test svg")?;
    println!("✓ Test SVG written: {}", svg_path.display());

    let print_png_path = tokio::task::spawn_blocking({
        let p = svg_path.clone();
        move || raster::rasterize_print_sibling(&p, raster::STICKER_PRINT_TARGET_PX)
    })
    .await
    .context("raster join")??;
    let png_bytes = std::fs::read(&print_png_path).context("read print png")?;
    println!(
        "✓ Rasterized to {} ({} bytes, {}px target)",
        print_png_path.display(),
        png_bytes.len(),
        raster::STICKER_PRINT_TARGET_PX,
    );

    // ── 3. Discover sticker SKU triplet ────────────────────────────────
    let bp = printify::find_sticker_blueprint(&api_key).await?;
    println!("✓ Blueprint: {} ({})", bp.title, bp.id);
    let providers = printify::list_print_providers(&api_key, bp.id).await?;
    let provider = providers
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no providers for blueprint {}", bp.id))?;
    println!("✓ Provider: {} ({})", provider.title, provider.id);
    let variants = printify::list_variants(&api_key, bp.id, provider.id).await?;
    println!("  · {} total variants in catalog", variants.len());
    let variant_ids = printify::pick_small_variants(&variants, 2);
    if variant_ids.is_empty() {
        anyhow::bail!("no usable small-size sticker variants on this provider");
    }
    println!("✓ Picked variants: {variant_ids:?}");

    // ── 4. Upload PNG to Printify ──────────────────────────────────────
    let uploaded =
        printify::upload_image_base64(&api_key, "e2e-test.png", &png_bytes).await?;
    println!("✓ Uploaded image id={}", uploaded.id);

    // ── 5. Create product ──────────────────────────────────────────────
    let title = format!(
        "POD pipeline e2e test — sticker {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M")
    );
    let description = "Automated end-to-end pipeline test from agent-factory. \
        Safe to delete from the Etsy drafts list — this was created by a test \
        binary that walked the full Printify integration: rasterize → upload \
        → create product → publish to Etsy.\n\n— About this design —\nThis \
        artwork was created in our AI-assisted design studio.";
    let tags = vec![
        "test".to_string(),
        "agent-factory".to_string(),
        "pod-pipeline".to_string(),
    ];
    let created = printify::create_product(
        &api_key,
        shop_id,
        &title,
        description,
        &tags,
        500, // $5.00 in cents — safe minimum
        bp.id,
        provider.id,
        &variant_ids,
        &uploaded.id,
    )
    .await?;
    println!("✓ Product created id={}  title={:?}", created.id, created.title);

    // ── 6. Publish to Etsy (Printify creates the Etsy draft on our behalf) ─
    printify::publish_product(&api_key, shop_id, &created.id).await?;
    println!("✓ Publish requested. Etsy draft should appear within ~10s.");

    println!();
    println!("──────────────────────────────────────────────");
    println!("DONE.");
    println!("Verify in:");
    println!("  • Printify → My new store → Products list");
    println!("  • Etsy → Shop manager → Listings → Drafts");
    println!("Product id (Printify): {}", created.id);
    Ok(())
}
