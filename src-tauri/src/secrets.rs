use keyring::Entry;

const SERVICE: &str = "com.agentfactory.app";

pub fn set(key: &str, value: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key)?;
    entry.set_password(value)?;
    Ok(())
}

pub fn get(key: &str) -> anyhow::Result<Option<String>> {
    let entry = Entry::new(SERVICE, key)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(key: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
