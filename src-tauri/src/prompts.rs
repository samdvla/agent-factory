//! Prompt override storage for the four LLM-driven roles. Reads/writes
//! `~/.agent-factory/prompts.json` — the same file the Python workers consult
//! at runtime (each agent's `_load_system_override(role)` reads it on every
//! call). The SI loop also appends `_history` entries here; we just READ
//! that history and never mutate SI's writes.
//!
//! Default prompts are mirrored from the Python worker source as Rust string
//! constants. KEEP IN SYNC — if the Python prompt strings change, update the
//! constants below or the UI will show a stale default.
//!
//! Source-of-truth mapping:
//!   research: workers/research/research/agent.py::build_demand_brief_prompt
//!   designer: workers/designer/designer/agent.py::build_designer_prompt
//!   listing:  workers/listing/listing/agent.py::build_listing_prompt
//!   cs:       workers/cs/cs/agent.py::build_reply_prompt

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub const RESEARCH_DEFAULT: &str = "You are a Market Research Analyst at an AI-run digital products Etsy shop. Your job is to identify a profitable niche and return a structured JSON Demand Brief. Be concise and specific. Only return valid JSON, no prose, no markdown.";

pub const DESIGNER_DEFAULT: &str = "You are the Designer at an AI-run digital-products Etsy shop. Given a Demand Brief, produce an asset description that an image generator would render into the actual product. Be specific about style, palette, composition, and dimensions. Return JSON only:\n{\n  \"asset_type\": \"<printable | svg | template | ebook>\",\n  \"style\": \"<descriptive style notes, 1 sentence>\",\n  \"palette\": [\"<hex>\", \"<hex>\", \"<hex>\"],\n  \"dimensions\": \"<e.g. '8.5x11 inch printable, 300dpi'>\",\n  \"mockup_count\": <int 1-4>,\n  \"brief_for_image_gen\": \"<single concise prompt suitable for SDXL>\"\n}";

pub const LISTING_DEFAULT: &str = "You are the Listing Copywriter at an AI-run digital-products Etsy shop. Given a Demand Brief and an Asset Description, produce a complete Etsy listing draft. Title must be \u{2264}140 chars. Exactly 13 tags. Description should be SEO-tuned and policy-compliant (digital download, no shipping, no custom work without explicit policy). Return JSON only:\n{\n  \"title\": \"<\u{2264}140 chars>\",\n  \"tags\": [\"<exactly 13 tags>\"],\n  \"description\": \"<200-400 word listing description>\",\n  \"materials\": [\"digital download\"],\n  \"price_usd\": <number>\n}";

pub const CS_DEFAULT: &str = "You are the Customer Service agent at an AI-run digital-products Etsy shop. All products are digital downloads \u{2014} no shipping, no physical inventory, no custom work. Respond to the buyer's message with a polite, policy-compliant reply. If the buyer requests a refund, asks for custom work, or raises a dispute, do NOT promise anything \u{2014} say you'll escalate to the shop owner. Keep replies under 60 words. Return JSON only:\n{\"reply\": \"<your reply>\", \"escalate\": <true|false>, \"category\": \"<file_format|refund_request|custom_request|policy_question|thank_you|other>\"}";

// Orchestrator is the Strategy Lead — the agent that actually picks the
// niche_seed each cycle. Its full prompt is built dynamically in
// workers/orchestrator/orchestrator/agent.py::build_orchestrator_prompt
// (it varies by SHOP_FOCUS, character pool, recent-drafts context, etc.),
// so we store only a stub here. The UI shows this default as informational
// text; system_override editing on orchestrator is not currently supported
// (only operator_steers), so the UI should hide the Edit Override action
// for this role.
pub const ORCHESTRATOR_DEFAULT: &str = "Strategy Lead — picks the next niche_seed each cycle and hands it to Research. Full prompt is generated dynamically from shop focus, character pool, and recent-drafts context. Use Steer to inject standing instructions (e.g. 'focus on superhero/supervillain archetypes', 'rotate into pet accessories') — those land as the final OPERATOR OVERRIDE block in the orchestrator's system prompt and supersede the built-in category list.";

pub const ROLES: [&str; 5] = ["orchestrator", "research", "designer", "listing", "cs"];

pub fn default_prompt(role: &str) -> Option<&'static str> {
    match role {
        "orchestrator" => Some(ORCHESTRATOR_DEFAULT),
        "research" => Some(RESEARCH_DEFAULT),
        "designer" => Some(DESIGNER_DEFAULT),
        "listing" => Some(LISTING_DEFAULT),
        "cs" => Some(CS_DEFAULT),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptRow {
    pub default: String,
    #[serde(rename = "override")]
    pub override_: Option<String>,
    pub last_tweak_ts: Option<i64>,
    pub last_tweak_source: Option<String>,
    pub last_tweak_rationale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptHistoryEntry {
    pub ts: i64,
    pub role_tweaked: String,
    #[serde(default)]
    pub prior_overrides: serde_json::Value,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

fn prompts_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".agent-factory").join("prompts.json")
}

/// Root directory for steer reference images. Per-role subdirectories live
/// underneath this. Tests monkey-patch HOME to redirect it.
pub fn steer_assets_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".agent-factory").join("steer-assets")
}

/// Save the bytes of an attached steer image under the steer-assets dir for
/// the given role. Returns the absolute path. The filename embeds a
/// timestamp + a short random suffix so two attachments on the same second
/// don't collide.
///
/// Validates `ext` to a small allow-list (png/jpg/jpeg/webp/gif) so a
/// malicious caller can't drop arbitrary executables into the assets tree.
/// Restricted to ROLES so a typo doesn't create unbounded subdirectories.
pub fn save_steer_image(role: &str, bytes: &[u8], ext: &str) -> Result<PathBuf> {
    if !ROLES.contains(&role) {
        return Err(anyhow!("unknown role: {role}"));
    }
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    let allowed = matches!(lower.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif");
    if !allowed {
        return Err(anyhow!("unsupported image extension: {ext}"));
    }
    // Cap at 8 MB per image — Anthropic's multimodal limit is 5 MB
    // base64-encoded which is roughly 3.75 MB raw, but allowing a little
    // headroom for callers that haven't downsampled. Real callers should
    // be sending thumbnails, not full-res renders.
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(anyhow!(
            "steer image too large ({} bytes > 8 MB)",
            bytes.len()
        ));
    }
    let dir = steer_assets_dir().join(role);
    std::fs::create_dir_all(&dir)?;
    let ts = now_ts();
    // Short hex tag from the bytes themselves so two unrelated uploads at
    // the same ts get distinct filenames without a heavy hash dependency.
    let tag: u32 = bytes
        .iter()
        .take(64)
        .fold(0u32, |acc, &b| acc.wrapping_mul(131).wrapping_add(b as u32));
    let filename = format!("{ts}-{tag:08x}.{lower}");
    let path = dir.join(filename);
    let tmp = path.with_extension(format!("{lower}.tmp"));
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

fn read_prompts_file() -> serde_json::Value {
    match std::fs::read_to_string(prompts_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn write_prompts_file(data: &serde_json::Value) -> Result<()> {
    let path = prompts_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(data)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn parse_history(data: &serde_json::Value) -> Vec<PromptHistoryEntry> {
    data.get("_history")
        .and_then(|h| {
            h.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value::<PromptHistoryEntry>(v.clone()).ok())
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default()
}

pub fn list_prompts() -> HashMap<String, PromptRow> {
    let data = read_prompts_file();
    let history = parse_history(&data);
    let mut out = HashMap::new();
    for role in ROLES.iter() {
        let default = default_prompt(role).unwrap_or("").to_string();
        let override_ = data
            .get(*role)
            .and_then(|v| v.get("system_override"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let last = history.iter().rev().find(|h| h.role_tweaked == *role);
        out.insert(
            role.to_string(),
            PromptRow {
                default,
                override_,
                last_tweak_ts: last.map(|h| h.ts),
                last_tweak_source: last.and_then(|h| h.source.clone()),
                last_tweak_rationale: last.and_then(|h| h.rationale.clone()),
            },
        );
    }
    out
}

pub fn history_for(role: &str, limit: usize) -> Vec<PromptHistoryEntry> {
    if !ROLES.contains(&role) {
        return Vec::new();
    }
    let data = read_prompts_file();
    let history = parse_history(&data);
    history
        .into_iter()
        .rev()
        .filter(|h| h.role_tweaked == role)
        .take(limit)
        .collect()
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn set_override(role: &str, system: &str) -> Result<()> {
    if !ROLES.contains(&role) {
        return Err(anyhow!("unknown role: {role}"));
    }
    if system.len() < 40 || system.len() > 4000 {
        return Err(anyhow!("system prompt must be 40..=4000 chars"));
    }
    let mut data = read_prompts_file();
    if !data.is_object() {
        data = serde_json::json!({});
    }
    let prior: serde_json::Value = data.get(role).cloned().unwrap_or(serde_json::json!({}));
    let entry = serde_json::json!({
        "ts": now_ts(),
        "role_tweaked": role,
        "prior_overrides": { role: prior },
        "rationale": "user edit",
        "source": "user"
    });
    {
        let obj = data.as_object_mut().expect("data is object");
        let history = obj
            .entry("_history".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !history.is_array() {
            *history = serde_json::json!([]);
        }
        let arr = history.as_array_mut().unwrap();
        arr.push(entry);
        while arr.len() > 30 {
            arr.remove(0);
        }
    }
    {
        let obj = data.as_object_mut().expect("data is object");
        let role_entry = obj
            .entry(role.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !role_entry.is_object() {
            *role_entry = serde_json::json!({});
        }
        role_entry.as_object_mut().unwrap().insert(
            "system_override".to_string(),
            serde_json::Value::String(system.to_string()),
        );
    }
    write_prompts_file(&data)?;
    Ok(())
}

/// Maximum length of a single operator steering instruction. The PromptsPanel
/// allows up to 4000 chars for a full override; a steer is a single-instruction
/// nudge layered on top, so a tighter cap is appropriate.
pub const STEER_MAX_LEN: usize = 2000;

/// Maximum number of operator steers per role. Beyond this, the oldest steer
/// is dropped (FIFO) — prevents unbounded prompt growth.
pub const STEER_MAX_COUNT: usize = 10;

/// One entry in `operator_steers` — text plus optional image references.
///
/// Two on-disk shapes coexist for backward compatibility: plain JSON strings
/// (the original schema, still emitted by `add_operator_steer` when no images
/// are attached) and `{"text": ..., "image_paths": [...]}` objects (new
/// shape, emitted whenever the user attaches a reference image). Both
/// normalize into this Rust struct via `parse_steer_entry`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SteerEntry {
    pub text: String,
    #[serde(default)]
    pub image_paths: Vec<String>,
}

fn parse_steer_entry(v: &serde_json::Value) -> Option<SteerEntry> {
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(SteerEntry {
            text: trimmed.to_string(),
            image_paths: Vec::new(),
        });
    }
    if let Some(obj) = v.as_object() {
        let text = obj.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
        if text.is_empty() {
            return None;
        }
        let images: Vec<String> = obj
            .get("image_paths")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        return Some(SteerEntry {
            text: text.to_string(),
            image_paths: images,
        });
    }
    None
}

/// Read every operator steer recorded for `role` in insertion order. Returns
/// an empty vec if the role has no steers or the field is malformed.
///
/// Each returned `SteerEntry` carries the text plus any attached image_paths
/// (absolute filesystem paths under `~/.agent-factory/steer-assets/`).
/// Plain-string entries on disk are normalized to entries with empty
/// image_paths so callers don't have to handle two shapes.
///
/// Called both from the UI (to populate the steer badge) and from
/// `effective_system_prompt` (which composes steers into the worker's system
/// prompt at job-time). Unknown roles return an empty vec rather than erroring
/// — the chat panel hides the Steer button for non-LLM agents, but a caller
/// asking about an unknown role just gets nothing back.
pub fn list_operator_steers(role: &str) -> Vec<SteerEntry> {
    let data = read_prompts_file();
    data.get(role)
        .and_then(|v| v.get("operator_steers"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_steer_entry).collect::<Vec<_>>())
        .unwrap_or_default()
}

/// Legacy view: text only, for callers that don't need image refs.
/// Used by the prompt-history surface and by tests that predate the schema
/// expansion.
pub fn list_operator_steer_texts(role: &str) -> Vec<String> {
    list_operator_steers(role)
        .into_iter()
        .map(|e| e.text)
        .collect()
}

/// Append a steer entry to the role's `operator_steers` list. Validates
/// length, drops the oldest entry when the list exceeds STEER_MAX_COUNT,
/// and writes a `_history` audit entry.
///
/// When `image_paths` is empty, the entry is stored as a plain JSON string
/// (backward-compat with the original schema). When images are attached,
/// the entry is stored as `{"text": ..., "image_paths": [...]}` and the
/// Python workers thread those image files into the next job's multimodal
/// user message.
///
/// Restricted to ROLES — other roles don't have a `_load_system_override`
/// call, so their steers would be silently ignored.
pub fn add_operator_steer(role: &str, text: &str, image_paths: Vec<String>) -> Result<()> {
    if !ROLES.contains(&role) {
        return Err(anyhow!("unknown role: {role}"));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("steer text is empty"));
    }
    if trimmed.len() > STEER_MAX_LEN {
        return Err(anyhow!(
            "steer too long ({} > {} chars)",
            trimmed.len(),
            STEER_MAX_LEN
        ));
    }
    // Validate each image path: must be an existing file under the
    // steer-assets dir we own. This stops a malicious caller from getting
    // the worker to read arbitrary files off disk and ship them to the
    // model (would be a credential-exfil path otherwise).
    let assets_root = steer_assets_dir();
    let mut clean_images: Vec<String> = Vec::with_capacity(image_paths.len());
    for raw in image_paths {
        let canonical = std::fs::canonicalize(&raw)
            .map_err(|e| anyhow!("steer image path {raw:?} not readable: {e}"))?;
        if !canonical.starts_with(&assets_root) {
            return Err(anyhow!(
                "steer image must live under steer-assets/, got {}",
                canonical.display()
            ));
        }
        clean_images.push(canonical.to_string_lossy().to_string());
    }

    let mut data = read_prompts_file();
    if !data.is_object() {
        data = serde_json::json!({});
    }

    {
        let obj = data.as_object_mut().expect("data is object");
        let role_entry = obj
            .entry(role.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !role_entry.is_object() {
            *role_entry = serde_json::json!({});
        }
        let role_obj = role_entry.as_object_mut().unwrap();
        let steers = role_obj
            .entry("operator_steers".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !steers.is_array() {
            *steers = serde_json::json!([]);
        }
        let arr = steers.as_array_mut().unwrap();
        // Plain-string shape when no images, object shape otherwise. Keeps
        // older entries readable by code paths that haven't been upgraded.
        let entry_val = if clean_images.is_empty() {
            serde_json::Value::String(trimmed.to_string())
        } else {
            serde_json::json!({
                "text": trimmed,
                "image_paths": clean_images,
            })
        };
        arr.push(entry_val);
        while arr.len() > STEER_MAX_COUNT {
            arr.remove(0);
        }
    }

    let entry = serde_json::json!({
        "ts": now_ts(),
        "role_tweaked": role,
        "rationale": format!("operator steer: {}", trimmed.chars().take(120).collect::<String>()),
        "source": "user_steer"
    });
    {
        let obj = data.as_object_mut().expect("data is object");
        let history = obj
            .entry("_history".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !history.is_array() {
            *history = serde_json::json!([]);
        }
        let arr = history.as_array_mut().unwrap();
        arr.push(entry);
        while arr.len() > 30 {
            arr.remove(0);
        }
    }

    write_prompts_file(&data)?;
    Ok(())
}

/// Wipe every operator steer for `role`. Strategist's `system_override` is
/// untouched — clearing steers only undoes operator-driven nudges.
pub fn clear_operator_steers(role: &str) -> Result<()> {
    if !ROLES.contains(&role) {
        return Err(anyhow!("unknown role: {role}"));
    }
    let mut data = read_prompts_file();
    if !data.is_object() {
        data = serde_json::json!({});
    }
    if let Some(obj) = data.get_mut(role).and_then(|v| v.as_object_mut()) {
        obj.remove("operator_steers");
    }
    let entry = serde_json::json!({
        "ts": now_ts(),
        "role_tweaked": role,
        "rationale": "operator steers cleared",
        "source": "user_steer"
    });
    {
        let obj = data.as_object_mut().expect("data is object");
        let history = obj
            .entry("_history".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !history.is_array() {
            *history = serde_json::json!([]);
        }
        let arr = history.as_array_mut().unwrap();
        arr.push(entry);
        while arr.len() > 30 {
            arr.remove(0);
        }
    }
    write_prompts_file(&data)?;
    Ok(())
}

pub fn clear_override(role: &str) -> Result<()> {
    if !ROLES.contains(&role) {
        return Err(anyhow!("unknown role: {role}"));
    }
    let mut data = read_prompts_file();
    if !data.is_object() {
        data = serde_json::json!({});
    }
    if let Some(obj) = data.get_mut(role).and_then(|v| v.as_object_mut()) {
        obj.remove("system_override");
    }
    let entry = serde_json::json!({
        "ts": now_ts(),
        "role_tweaked": role,
        "rationale": "cleared by user",
        "source": "user"
    });
    {
        let obj = data.as_object_mut().expect("data is object");
        let history = obj
            .entry("_history".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !history.is_array() {
            *history = serde_json::json!([]);
        }
        let arr = history.as_array_mut().unwrap();
        arr.push(entry);
        while arr.len() > 30 {
            arr.remove(0);
        }
    }
    write_prompts_file(&data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Prompts tests mutate the process-wide HOME env var, so they must run
    // serially. A shared mutex guards every test that touches prompts.json.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard {
        _tmp: TempDir,
        prev: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    fn use_tmp_home() -> HomeGuard {
        let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().expect("tempdir");
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", tmp.path());
        HomeGuard { _tmp: tmp, prev, _lock: lock }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn test_set_override_persists_and_round_trips() {
        let _g = use_tmp_home();
        let prompt = "a".repeat(50);
        set_override("designer", &prompt).expect("set");
        let rows = list_prompts();
        let row = rows.get("designer").expect("row");
        assert_eq!(row.override_.as_deref(), Some(prompt.as_str()));
        assert_eq!(row.last_tweak_source.as_deref(), Some("user"));
        assert!(row.last_tweak_ts.is_some());
    }

    #[test]
    fn test_set_override_rejects_unknown_role() {
        let _g = use_tmp_home();
        let prompt = "a".repeat(50);
        let r = set_override("nonsense", &prompt);
        assert!(r.is_err());
    }

    #[test]
    fn test_set_override_validates_length() {
        let _g = use_tmp_home();
        assert!(set_override("research", "short").is_err());
        let too_long = "a".repeat(4500);
        assert!(set_override("research", &too_long).is_err());
        let just_right = "a".repeat(100);
        assert!(set_override("research", &just_right).is_ok());
    }

    #[test]
    fn test_clear_override_removes_field() {
        let _g = use_tmp_home();
        let prompt = "a".repeat(50);
        set_override("listing", &prompt).unwrap();
        let before = list_prompts();
        assert!(before.get("listing").unwrap().override_.is_some());
        clear_override("listing").unwrap();
        let after = list_prompts();
        assert!(after.get("listing").unwrap().override_.is_none());
        // History should reflect the clear.
        assert_eq!(
            after.get("listing").unwrap().last_tweak_rationale.as_deref(),
            Some("cleared by user")
        );
    }

    #[test]
    fn test_history_capped_at_30() {
        let _g = use_tmp_home();
        let prompt = "a".repeat(50);
        for _ in 0..35 {
            set_override("cs", &prompt).unwrap();
        }
        let data = read_prompts_file();
        let arr_len = data
            .get("_history")
            .and_then(|h| h.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        assert!(arr_len <= 30, "history exceeded cap: {arr_len}");
    }

    #[test]
    fn test_defaults_present_for_all_roles() {
        for r in ROLES.iter() {
            let d = default_prompt(r).expect("default present");
            assert!(d.len() > 50, "default too short for {r}");
        }
    }

    #[test]
    fn test_add_operator_steer_appends_and_lists() {
        let _g = use_tmp_home();
        add_operator_steer("designer", "be more aggressive with pricing", vec![]).unwrap();
        add_operator_steer("designer", "favor halloween themes this week", vec![]).unwrap();
        let steers = list_operator_steer_texts("designer");
        assert_eq!(steers.len(), 2);
        assert_eq!(steers[0], "be more aggressive with pricing");
        assert_eq!(steers[1], "favor halloween themes this week");
    }

    #[test]
    fn test_add_operator_steer_rejects_unknown_role() {
        let _g = use_tmp_home();
        // "strategist" is a real role in the codebase but does NOT honor
        // operator_steers (its Python worker doesn't call
        // _load_operator_steers), so it must be rejected here to prevent
        // silently-ignored steers. Same reasoning for "supervisor", "publisher",
        // etc. — any role that wouldn't read the steer at runtime.
        let r = add_operator_steer("strategist", "hello", vec![]);
        assert!(r.is_err(), "roles that don't honor steers must be rejected");
        let r2 = add_operator_steer("publisher", "hello", vec![]);
        assert!(r2.is_err(), "non-LLM roles must be rejected");
    }

    #[test]
    fn test_orchestrator_is_steerable() {
        // Orchestrator picks the niche each cycle — operator_steers on this
        // role land in the system prompt as the final OPERATOR OVERRIDE
        // block (see workers/orchestrator/orchestrator/agent.py).
        let _g = use_tmp_home();
        add_operator_steer("orchestrator", "focus on pet accessories this week", vec![]).unwrap();
        let steers = list_operator_steer_texts("orchestrator");
        assert_eq!(steers, vec!["focus on pet accessories this week"]);
    }

    #[test]
    fn test_add_operator_steer_rejects_empty_and_oversized() {
        let _g = use_tmp_home();
        assert!(add_operator_steer("research", "", vec![]).is_err());
        assert!(add_operator_steer("research", "   ", vec![]).is_err());
        let too_long = "a".repeat(STEER_MAX_LEN + 1);
        assert!(add_operator_steer("research", &too_long, vec![]).is_err());
        let just_right = "a".repeat(STEER_MAX_LEN);
        assert!(add_operator_steer("research", &just_right, vec![]).is_ok());
    }

    #[test]
    fn test_operator_steer_count_capped() {
        let _g = use_tmp_home();
        for i in 0..(STEER_MAX_COUNT + 5) {
            add_operator_steer("listing", &format!("steer-{i}"), vec![]).unwrap();
        }
        let steers = list_operator_steer_texts("listing");
        assert_eq!(steers.len(), STEER_MAX_COUNT);
        // FIFO: oldest (steer-0..steer-4) should be dropped.
        assert_eq!(steers[0], "steer-5");
        assert_eq!(steers[STEER_MAX_COUNT - 1], format!("steer-{}", STEER_MAX_COUNT + 4));
    }

    #[test]
    fn test_clear_operator_steers_wipes_and_leaves_override_alone() {
        let _g = use_tmp_home();
        // Strategist sets an override.
        set_override("cs", &"a".repeat(80)).unwrap();
        // Operator adds a steer.
        add_operator_steer("cs", "be terse", vec![]).unwrap();
        assert_eq!(list_operator_steers("cs").len(), 1);
        clear_operator_steers("cs").unwrap();
        assert_eq!(list_operator_steers("cs").len(), 0);
        // Strategist's override must survive the clear.
        let rows = list_prompts();
        assert!(rows.get("cs").unwrap().override_.is_some());
    }

    #[test]
    fn test_steer_does_not_clobber_override() {
        let _g = use_tmp_home();
        let prompt = "a".repeat(80);
        set_override("listing", &prompt).unwrap();
        add_operator_steer("listing", "operator note", vec![]).unwrap();
        let rows = list_prompts();
        assert_eq!(
            rows.get("listing").unwrap().override_.as_deref(),
            Some(prompt.as_str()),
            "operator steer must not modify strategist's override",
        );
        assert_eq!(list_operator_steer_texts("listing"), vec!["operator note"]);
    }
}
