//! Third-party IP / trademark scrubbing for listing copy.
//!
//! The design pipeline keyword-stuffs listing titles, descriptions and tags
//! with trademarked franchise names ("Warhammer 40K", "D&D", "Pathfinder",
//! …) as SEO bait. Marketplaces act on rights-holder complaints — Cults3D
//! takes listings down on a Games Workshop notice — so every publish must
//! go out with neutral wording instead.
//!
//! This runs once on the publisher result, before the listing fans out to
//! any marketplace, so Etsy / Cults3D / Gumroad / MMF / Sketchfab all get
//! the cleaned copy (and the persisted audit record is clean too).

use serde_json::Value;

/// Trademarked phrases → neutral replacements, applied longest-first so a
/// multi-word phrase is rewritten before its bare brand word. Matching is
/// ASCII-case-insensitive plain substring.
const REPLACEMENTS: &[(&str, &str)] = &[
    ("warhammer 40,000", "tabletop wargaming"),
    ("warhammer 40000", "tabletop wargaming"),
    ("warhammer 40k", "tabletop wargaming"),
    ("warhammer40k", "tabletop wargaming"),
    ("warhammer", "tabletop wargaming"),
    ("age of sigmar", "fantasy battle gaming"),
    ("adeptus astartes", "sci-fi power-armor troopers"),
    ("space marines", "sci-fi power-armor troopers"),
    ("space marine", "sci-fi power-armor trooper"),
    ("games workshop", "tabletop gaming"),
    ("game workshop", "tabletop gaming"),
    ("kill team", "skirmish gaming"),
    ("dungeons & dragons", "tabletop RPG"),
    ("dungeons and dragons", "tabletop RPG"),
    ("d & d", "tabletop RPG"),
    ("d&d", "tabletop RPG"),
    ("dnd", "tabletop RPG"),
    ("pathfinder", "fantasy RPG"),
];

/// Substrings that, if present in a tag, cause the whole tag to be dropped.
const TAG_BLOCK: &[&str] = &[
    "warhammer", "40k", "games workshop", "game workshop", "space marine",
    "adeptus", "sigmar", "kill team", "d&d", "dnd", "dungeon", "pathfinder",
];

/// Case-insensitive plain substring replace. `needle` must be ASCII
/// lowercase. Uses `to_ascii_lowercase` so the lowered copy stays
/// byte-aligned with the original (non-ASCII chars keep their bytes).
fn replace_ci(text: &str, needle: &str, repl: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if lower[i..].starts_with(needle) {
            out.push_str(repl);
            i += needle.len();
        } else {
            // Advance one full UTF-8 char from the original text.
            let ch_len = match bytes[i] {
                b if b < 0x80 => 1,
                b if b >> 5 == 0b110 => 2,
                b if b >> 4 == 0b1110 => 3,
                _ => 4,
            };
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
        }
    }
    out
}

/// Collapse whitespace / punctuation artifacts left by removed phrases.
fn tidy(text: &str) -> String {
    let mut s = text.to_string();
    for _ in 0..3 {
        s = s.replace("  ", " ");
    }
    s = s.replace(" ,", ",").replace(" .", ".").replace(" ;", ";");
    s = s.replace(",,", ",").replace(", ,", ",").replace(",.", ".");
    s = s.replace("( )", "").replace("()", "");
    s.trim().to_string()
}

/// Rewrite a string with all trademark phrases neutralised.
pub fn sanitize_text(text: &str) -> String {
    let mut s = text.to_string();
    for (needle, repl) in REPLACEMENTS {
        if s.to_ascii_lowercase().contains(needle) {
            s = replace_ci(&s, needle, repl);
        }
    }
    tidy(&s)
}

/// Drop any tag containing a blocked trademark substring.
pub fn sanitize_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .filter(|t| {
            let lower = t.to_ascii_lowercase();
            !TAG_BLOCK.iter().any(|b| lower.contains(b))
        })
        .cloned()
        .collect()
}

/// True if `text` still carries a recognised trademark term — used to
/// assert copy is clean before it leaves the building.
pub fn contains_ip_term(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    REPLACEMENTS.iter().any(|(needle, _)| lower.contains(needle))
}

/// Scrub the title, description and tags of a publisher result in place.
/// No-op for non-object values or results without those fields.
pub fn sanitize_publisher_result(result: &mut Value) {
    let Some(obj) = result.as_object_mut() else {
        return;
    };
    for field in ["title", "description"] {
        if let Some(clean) = obj.get(field).and_then(|v| v.as_str()).map(sanitize_text) {
            obj.insert(field.to_string(), Value::String(clean));
        }
    }
    if let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) {
        let strs: Vec<String> = arr
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect();
        let clean = sanitize_tags(&strs);
        obj.insert(
            "tags".to_string(),
            Value::Array(clean.into_iter().map(Value::String).collect()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_warhammer_family() {
        let out = sanitize_text("Perfect for Warhammer 40K and Warhammer armies");
        assert!(!contains_ip_term(&out), "still dirty: {out}");
        assert!(!out.to_lowercase().contains("warhammer"));
    }

    #[test]
    fn strips_dnd_and_pathfinder_keeping_prose() {
        let out = sanitize_text("Great for D&D campaigns, DnD one-shots and Pathfinder games");
        assert!(!contains_ip_term(&out), "still dirty: {out}");
        assert!(out.to_lowercase().contains("tabletop rpg"));
        assert!(out.to_lowercase().contains("fantasy rpg"));
    }

    #[test]
    fn preserves_clean_copy() {
        let clean = "A dark fantasy reaper figurine for tabletop display.";
        assert_eq!(sanitize_text(clean), clean);
    }

    #[test]
    fn drops_only_offending_tags() {
        let tags = vec![
            "warhammer 40k stl".to_string(),
            "reaper figurine".to_string(),
            "dnd mini".to_string(),
            "dark fantasy".to_string(),
        ];
        let out = sanitize_tags(&tags);
        assert_eq!(out, vec!["reaper figurine", "dark fantasy"]);
    }

    #[test]
    fn sanitizes_publisher_result_in_place() {
        let mut r = json!({
            "title": "Lich Lord STL | DnD Boss Mini",
            "description": "Built for Warhammer 40K and D&D tables.",
            "tags": ["warhammer stl", "lich mini", "pathfinder boss"],
            "asset_path": "/tmp/x.stl",
        });
        sanitize_publisher_result(&mut r);
        assert!(!contains_ip_term(r["title"].as_str().unwrap()));
        assert!(!contains_ip_term(r["description"].as_str().unwrap()));
        let tags: Vec<&str> = r["tags"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(tags, vec!["lich mini"]);
        // untouched fields survive
        assert_eq!(r["asset_path"], "/tmp/x.stl");
    }
}
