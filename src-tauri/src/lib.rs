use std::path::PathBuf;

/// The Duckware apps: name, program file, and where to download it.
const APPS: [(&str, &str, &str); 3] = [
    ("DuckWriter", "duckwriter.exe", "https://github.com/duckrice/duckwriter/releases/latest"),
    ("Duckument", "duckument.exe", "https://github.com/duckrice/duckument/releases/latest"),
    ("DuckNotes", "ducknotes.exe", "https://github.com/duckrice/ducknotes/releases/latest"),
];

/// Where an app is installed: each installer puts it in %LOCALAPPDATA%\<name>.
/// Tests point DUCKWARE_APPS_DIR somewhere else.
fn program(index: usize) -> Option<PathBuf> {
    let (name, file, _) = APPS.get(index)?;
    let base = std::env::var_os("DUCKWARE_APPS_DIR").or_else(|| std::env::var_os("LOCALAPPDATA"))?;
    Some(PathBuf::from(base).join(name).join(file))
}

fn testing() -> bool {
    std::env::var_os("DUCKWARE_TEST_OFFSCREEN").is_some()
}

/// For each app, whether it is installed.
#[tauri::command]
fn installed() -> Vec<bool> {
    (0..APPS.len()).map(|i| program(i).is_some_and(|p| p.is_file())).collect()
}

/// Starts an app and closes the launcher; its job is done.
#[tauri::command]
fn launch(index: usize, app: tauri::AppHandle) -> Result<(), String> {
    let path = program(index).filter(|p| p.is_file()).ok_or("That app isn't installed.")?;
    if testing() {
        return Ok(());
    }
    std::process::Command::new(&path).current_dir(path.parent().unwrap_or(&path)).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// Opens an app's download page in the browser.
#[tauri::command]
fn download(index: usize) -> Result<(), String> {
    let (_, _, url) = APPS.get(index).ok_or("No such app.")?;
    if testing() {
        return Ok(());
    }
    // Explorer hands the address to the default browser; no shell, so nothing in it is run.
    std::process::Command::new("explorer").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config = &app.config().app.windows[0];
            let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
            // Tests open the window off-screen and in the background.
            if testing() {
                let window = builder.visible(false).focused(false).skip_taskbar(true).build()?;
                window.set_position(tauri::PhysicalPosition::new(-20000, -20000))?;
                window.show()?;
            } else {
                builder.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![installed, launch, download])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
