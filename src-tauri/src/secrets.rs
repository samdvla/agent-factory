use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.agentfactory.app";

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// File-backed secret storage. Used in two cases:
///   1. Debug builds (always) — so dev runs don't pollute the user's Keychain.
///   2. Release builds where AGENT_FACTORY_FILE_SECRETS is set — required for
///      the Mac mini headless server, where the user's login keychain locks
///      on inactivity and the locked-state prompts have nowhere to display.
fn use_file_store() -> bool {
    cfg!(debug_assertions) || std::env::var("AGENT_FACTORY_FILE_SECRETS").is_ok()
}

fn file_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let name = if cfg!(debug_assertions) {
        "secrets.dev.json"
    } else {
        "secrets.json"
    };
    std::path::PathBuf::from(home)
        .join(".agent-factory")
        .join(name)
}

fn load_file() -> HashMap<String, String> {
    let path = file_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<HashMap<String, String>>(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_file(data: &HashMap<String, String>) -> anyhow::Result<()> {
    let path = file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(data)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp, perms)?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn set(key: &str, value: &str) -> anyhow::Result<()> {
    if use_file_store() {
        let mut data = load_file();
        data.insert(key.to_string(), value.to_string());
        save_file(&data)?;
    } else {
        let entry = Entry::new(SERVICE, key)?;
        entry.set_password(value)?;
    }
    cache().lock().unwrap().insert(key.to_string(), Some(value.to_string()));
    Ok(())
}

pub fn get(key: &str) -> anyhow::Result<Option<String>> {
    if let Some(cached) = cache().lock().unwrap().get(key) {
        return Ok(cached.clone());
    }
    let value: Option<String> = if use_file_store() {
        let data = load_file();
        let from_file = data.get(key).cloned();
        from_file.or_else(|| std::env::var(key.to_uppercase()).ok())
    } else {
        let entry = Entry::new(SERVICE, key)?;
        match entry.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(e.into()),
        }
    };
    cache().lock().unwrap().insert(key.to_string(), value.clone());
    Ok(value)
}

pub fn delete(key: &str) -> anyhow::Result<()> {
    if use_file_store() {
        let mut data = load_file();
        data.remove(key);
        save_file(&data)?;
    } else {
        let entry = Entry::new(SERVICE, key)?;
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.into()),
        }
    }
    cache().lock().unwrap().insert(key.to_string(), None);
    Ok(())
}

pub fn invalidate(key: &str) {
    cache().lock().unwrap().remove(key);
}

/// Test-only helper: seed the in-memory cache without touching the keychain or
/// the on-disk debug secrets file. Used by integration tests that need to
/// simulate "this secret is set" without polluting the user's real store.
#[cfg(test)]
pub fn set_cache_for_test(key: &str, value: Option<&str>) {
    cache()
        .lock()
        .unwrap()
        .insert(key.to_string(), value.map(String::from));
}

/// Test-only helper: a process-global lock serializing tests that mutate the
/// shared secrets cache. The cache is a single process-wide map, so tests in
/// different modules race under cargo's parallel runner unless they all
/// serialize on this one lock.
#[cfg(test)]
pub fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_returns_stored_value() {
        let k = "test_cache_hit_key";
        cache()
            .lock()
            .unwrap()
            .insert(k.to_string(), Some("hello".to_string()));
        assert_eq!(get(k).unwrap(), Some("hello".to_string()));
        cache().lock().unwrap().remove(k);
    }

    #[test]
    fn cache_remembers_absent_keys() {
        let k = "test_cache_absent_key";
        cache().lock().unwrap().insert(k.to_string(), None);
        assert_eq!(get(k).unwrap(), None);
        cache().lock().unwrap().remove(k);
    }

    #[test]
    fn invalidate_drops_cached_entry() {
        let k = "test_invalidate_key";
        cache()
            .lock()
            .unwrap()
            .insert(k.to_string(), Some("v".to_string()));
        invalidate(k);
        assert!(cache().lock().unwrap().get(k).is_none());
    }
}
