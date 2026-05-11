use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.agentfactory.app";

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set(key: &str, value: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key)?;
    entry.set_password(value)?;
    cache().lock().unwrap().insert(key.to_string(), Some(value.to_string()));
    Ok(())
}

pub fn get(key: &str) -> anyhow::Result<Option<String>> {
    if let Some(cached) = cache().lock().unwrap().get(key) {
        return Ok(cached.clone());
    }
    let entry = Entry::new(SERVICE, key)?;
    let value = match entry.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(e.into()),
    };
    cache().lock().unwrap().insert(key.to_string(), value.clone());
    Ok(value)
}

pub fn delete(key: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key)?;
    match entry.delete_credential() {
        Ok(()) => {}
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.into()),
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
        cache().lock().unwrap().insert(k.to_string(), Some("hello".to_string()));
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
        cache().lock().unwrap().insert(k.to_string(), Some("v".to_string()));
        invalidate(k);
        assert!(cache().lock().unwrap().get(k).is_none());
    }
}
