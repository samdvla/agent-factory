pub mod budget;
pub mod db;
pub mod events;
pub mod heartbeat;
pub mod llm;
pub mod queue;
pub mod secrets;
pub mod supervisor;
pub mod worker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
