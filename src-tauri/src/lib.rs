use std::path::{Path, PathBuf};
use std::process::Command;

/// The Duckware apps: name, program file, where to download it, and the files it opens.
const APPS: [(&str, &str, &str, &[&str]); 4] = [
    ("DuckWriter", "duckwriter.exe", "https://github.com/duckrice/duckwriter/releases/latest", &["docx", "docm", "dotx", "dotm", "doc", "rtf", "odt"]),
    ("Duckument", "duckument.exe", "https://github.com/duckrice/duckument/releases/latest", &["pdf"]),
    ("DuckNotes", "ducknotes.exe", "https://github.com/duckrice/ducknotes/releases/latest", &[]),
    ("DuckSheets", "ducksheets.exe", "https://github.com/duckrice/ducksheets/releases/latest", &["xlsx", "xlsm", "csv"]),
];

/// Where an app is installed: each installer puts it in %LOCALAPPDATA%\<name>.
/// Tests point DUCKWARE_APPS_DIR somewhere else.
fn program(index: usize) -> Option<PathBuf> {
    let (name, file, _, _) = APPS.get(index)?;
    let base = std::env::var_os("DUCKWARE_APPS_DIR").or_else(|| std::env::var_os("LOCALAPPDATA"))?;
    Some(PathBuf::from(base).join(name).join(file))
}

fn testing() -> bool {
    std::env::var_os("DUCKWARE_TEST_OFFSCREEN").is_some()
}

/// Runs a PowerShell command and returns what it printed. No window flashes up.
fn powershell(script: &str) -> Option<String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = command.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// For each app, its installed version ("" if it can't be read), or null if it isn't installed.
#[tauri::command]
async fn apps() -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let paths: Vec<Option<PathBuf>> = (0..APPS.len()).map(|i| program(i).filter(|p| p.is_file())).collect();
        // Every program carries its version; one PowerShell reads them all.
        let list = paths.iter().map(|p| format!("'{}'", p.as_ref().map(|p| p.display().to_string().replace('\'', "''")).unwrap_or_default())).collect::<Vec<_>>().join(",");
        let script = format!("@({list}) | ForEach-Object {{ if ($_ -and (Test-Path -LiteralPath $_)) {{ (Get-Item -LiteralPath $_).VersionInfo.ProductVersion }} else {{ '' }} }}");
        let versions: Vec<String> = powershell(&script).map(|s| s.lines().map(|l| l.trim().to_string()).collect()).unwrap_or_default();
        paths.iter().enumerate().map(|(i, p)| p.as_ref().map(|_| versions.get(i).cloned().unwrap_or_default())).collect()
    })
    .await
    .unwrap_or_default()
}

/// For each app, the version of its latest release (null if it can't be found).
#[tauri::command]
async fn latest() -> Vec<Option<String>> {
    if let Ok(test) = std::env::var("DUCKWARE_TEST_LATEST") {
        return test.split(',').map(|s| (!s.is_empty()).then(|| s.to_string())).collect();
    }
    let lookups: Vec<_> = APPS
        .iter()
        .map(|(_, _, page, _)| {
            let url = format!("{page}/download/latest.json");
            std::thread::spawn(move || {
                let out = Command::new("curl.exe").args(["--fail", "--location", "--silent", "--max-time", "15", &url]).output().ok()?;
                let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
                json.get("version")?.as_str().map(str::to_string)
            })
        })
        .collect();
    tauri::async_runtime::spawn_blocking(move || lookups.into_iter().map(|t| t.join().ok().flatten()).collect()).await.unwrap_or_default()
}

/// Starts an app (with a file, if given) and closes the launcher; its job is done.
#[tauri::command]
fn launch(index: usize, file: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    let path = program(index).filter(|p| p.is_file()).ok_or("That app isn't installed.")?;
    let mut command = Command::new(&path);
    command.current_dir(path.parent().unwrap_or(&path));
    if let Some(file) = &file {
        // Only a file the app opens, that is there.
        let (_, _, _, kinds) = APPS[index];
        let ext = Path::new(file).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !kinds.contains(&ext.as_str()) || !Path::new(file).is_file() {
            return Err("That file can't be opened.".into());
        }
        command.arg(file);
    }
    if testing() {
        return Ok(());
    }
    command.spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[derive(serde::Serialize)]
struct Recent {
    path: String,
    app: usize,
    /// When it was last opened, in milliseconds.
    time: i64,
}

/// Documents opened lately (from Windows' list of recent files), for the app that opens each.
#[tauri::command]
async fn recent() -> Vec<Recent> {
    tauri::async_runtime::spawn_blocking(|| {
        let raw = if let Ok(test) = std::env::var("DUCKWARE_TEST_RECENT") {
            test
        } else {
            let script = r#"$shell = New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Recent\*.lnk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 80 | ForEach-Object {
  $target = $shell.CreateShortcut($_.FullName).TargetPath
  if ($target) { '{0}|{1}' -f ([DateTimeOffset]$_.LastWriteTime).ToUnixTimeMilliseconds(), $target }
}"#;
            powershell(script).unwrap_or_default()
        };
        let mut seen = std::collections::HashSet::new();
        raw.lines()
            .filter_map(|line| {
                let (time, path) = line.split_once('|')?;
                let ext = Path::new(path).extension()?.to_str()?.to_lowercase();
                let app = APPS.iter().position(|(_, _, _, kinds)| kinds.contains(&ext.as_str()))?;
                if !Path::new(path).is_file() || !seen.insert(path.to_lowercase()) {
                    return None;
                }
                Some(Recent { path: path.to_string(), app, time: time.parse().unwrap_or(0) })
            })
            .take(12)
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// The Run key that starts programs when you sign in to Windows (a test key for tests).
fn run_key() -> &'static str {
    if testing() {
        r"HKCU\Software\Duckware\TestRun"
    } else {
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
    }
}

/// Whether the launcher starts with Windows; with `on`, turns that on or off first.
#[tauri::command]
fn autostart(on: Option<bool>) -> Result<bool, String> {
    if let Some(on) = on {
        let mut command = Command::new("reg");
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            command.args(["add", run_key(), "/v", "Duckware", "/t", "REG_SZ", "/f", "/d"]).arg(format!("\"{}\"", exe.display()));
        } else {
            command.args(["delete", run_key(), "/v", "Duckware", "/f"]);
        }
        let status = command.output().map_err(|e| e.to_string())?.status;
        if on && !status.success() {
            return Err("Windows didn't allow it.".into());
        }
    }
    Ok(Command::new("reg").args(["query", run_key(), "/v", "Duckware"]).output().map(|o| o.status.success()).unwrap_or(false))
}

/// Downloads an app's installer from its latest release and runs it (passive:
/// a progress bar, no questions). Installs, or updates an installed app. Resolves when done.
#[tauri::command]
async fn install(index: usize) -> Result<(), String> {
    let (name, _, page, _) = *APPS.get(index).ok_or("No such app.")?;
    if testing() {
        return Ok(());
    }
    let url = format!("{page}/download/{name}-Setup.exe");
    tauri::async_runtime::spawn_blocking(move || {
        let setup = std::env::temp_dir().join(format!("{name}-Setup.exe"));
        // Windows' own curl: follows GitHub's redirect, and fails rather than saving an error page.
        let got = Command::new("curl.exe")
            .args(["--fail", "--location", "--silent", "--show-error", "--output"])
            .arg(&setup)
            .arg(&url)
            .output()
            .map_err(|e| format!("Couldn't start the download: {e}"))?;
        if !got.status.success() {
            let why = String::from_utf8_lossy(&got.stderr);
            return Err(if why.contains("404") { format!("{name} hasn't been released yet.") } else { format!("The download failed: {}", why.trim()) });
        }
        let done = Command::new(&setup).arg("/P").status().map_err(|e| format!("Couldn't run the installer: {e}"));
        let _ = std::fs::remove_file(&setup);
        match done? {
            s if s.success() => Ok(()),
            _ => Err(format!("{name}'s installer stopped before it finished.")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens an app's download page in the browser.
#[tauri::command]
fn download(index: usize) -> Result<(), String> {
    let (_, _, url, _) = APPS.get(index).ok_or("No such app.")?;
    if testing() {
        return Ok(());
    }
    // Explorer hands the address to the default browser; no shell, so nothing in it is run.
    Command::new("explorer").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![apps, latest, launch, recent, autostart, install, download])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
