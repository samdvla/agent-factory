#[cfg(not(debug_assertions))]
use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[cfg_attr(debug_assertions, allow(dead_code))]
const SERVICE: &str = "com.agentfactory.app";

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(debug_assertions)]
fn debug_file_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".agent-factory")
        .join("secrets.dev.json")
}

#[cfg(debug_assertions)]
fn load_debug_file() -> HashMap<String, String> {
    let path = debug_file_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<HashMap<String, String>>(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

#[cfg(debug_assertions)]
fn save_debug_file(data: &HashMap<String, String>) -> anyhow::Result<()> {
    let path = debug_file_path();
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
    #[cfg(debug_assertions)]
    {
        let mut data = load_debug_file();
        data.insert(key.to_string(), value.to_string());
        save_debug_file(&data)?;
    }
    #[cfg(not(debug_assertions))]
    {
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
    #[cfg(debug_assertions)]
    let value: Option<String> = {
        let data = load_debug_file();
        let from_file = data.get(key).cloned();
        from_file.or_else(|| std::env::var(key.to_uppercase()).ok())
    };
    #[cfg(not(debug_assertions))]
    let value: Option<String> = {
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
    #[cfg(debug_assertions)]
    {
        let mut data = load_debug_file();
        data.remove(key);
        save_debug_file(&data)?;
    }
    #[cfg(not(debug_assertions))]
    {
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
