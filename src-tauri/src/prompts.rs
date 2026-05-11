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

pub const ROLES: [&str; 4] = ["research", "designer", "listing", "cs"];

pub fn default_prompt(role: &str) -> Option<&'static str> {
    match role {
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
}
