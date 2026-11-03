use std::path::{Path, PathBuf};
use std::process::Command;

/// The Duckware apps: name, program file, where to download it, and the files it opens.
const APPS: [(&str, &str, &str, &[&str]); 4] = [
    ("DuckWriter", "duckwriter.exe", "https://github.com/duckrice/duckwriter/releases/latest", &["docx", "docm", "dotx", "dotm", "doc", "rtf", "odt"]),
    ("Duckument", "duckument.exe", "https://github.com/duckrice/duckument/releases/latest", &["pdf"]),
    ("DuckNotes", "ducknotes.exe", "https://github.com/duckrice/ducknotes/releases/latest", &[]),
    ("DuckSheets", "ducksheets.exe", "https://github.com/duckrice/ducksheets/releases/latest", &["xlsx", "xlsm", "csv"]),
];

/// Where an app is installed: each Windows installer puts it in %LOCALAPPDATA%\<name>.
/// Tests point DUCKWARE_APPS_DIR somewhere else.
#[cfg(windows)]
fn program(index: usize) -> Option<PathBuf> {
    let (name, file, _, _) = APPS.get(index)?;
    let base = std::env::var_os("DUCKWARE_APPS_DIR").or_else(|| std::env::var_os("LOCALAPPDATA"))?;
    Some(PathBuf::from(base).join(name).join(file))
}

/// On Linux: the AppImage in ~/Applications (where the launcher installs it, as most AppImage
/// tools do), else the program on the PATH (from a package, such as the .deb).
#[cfg(not(windows))]
fn program(index: usize) -> Option<PathBuf> {
    let (name, file, _, _) = APPS.get(index)?;
    let image = appimage(name)?;
    if image.is_file() {
        return Some(image);
    }
    let bin = file.trim_end_matches(".exe");
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(bin)).find(|p| p.is_file()).or(Some(image))
}

#[cfg(not(windows))]
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(not(windows))]
fn appimage(name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("DUCKWARE_APPS_DIR").map(PathBuf::from).or_else(|| Some(home()?.join("Applications")))?;
    Some(dir.join(format!("{name}-x86_64.AppImage")))
}

/// Windows' own curl, or the system's.
const CURL: &str = if cfg!(windows) { "curl.exe" } else { "curl" };

fn testing() -> bool {
    std::env::var_os("DUCKWARE_TEST_OFFSCREEN").is_some()
}

/// A command that runs without a console window flashing up.
fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Runs a PowerShell command and returns what it printed.
fn powershell(script: &str) -> Option<String> {
    let mut command = hidden("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let out = command.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// For each app, its installed version ("" if it can't be read), or null if it isn't installed.
#[tauri::command]
async fn apps() -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let paths: Vec<Option<PathBuf>> = (0..APPS.len()).map(|i| program(i).filter(|p| p.is_file())).collect();
        // shortcut: on Linux the version isn't read (an AppImage doesn't show it without running it), so the
        // launcher offers no updates there; each app updates itself. Read it if that's ever needed.
        if cfg!(not(windows)) {
            return paths.iter().map(|p| p.as_ref().map(|_| String::new())).collect();
        }
        // Every program carries its version; one PowerShell reads them all.
        let list = paths.iter().map(|p| format!("'{}'", p.as_ref().map(|p| p.display().to_string().replace('\'', "''")).unwrap_or_default())).collect::<Vec<_>>().join(",");
        let script = format!("@({list}) | ForEach-Object {{ if ($_ -and (Test-Path -LiteralPath $_)) {{ (Get-Item -LiteralPath $_).VersionInfo.ProductVersion }} else {{ '' }} }}");
        let versions: Vec<String> = powershell(&script).map(|s| s.lines().map(|l| l.trim().to_string()).collect()).unwrap_or_default();
        paths.iter().enumerate().map(|(i, p)| p.as_ref().map(|_| versions.get(i).cloned().unwrap_or_default())).collect()
    })
    .await
    .unwrap_or_default()
}

/// For each app, the version of its latest release and what's new in it (null if it can't be found).
#[tauri::command]
async fn latest() -> Vec<Option<(String, String)>> {
    if let Ok(test) = std::env::var("DUCKWARE_TEST_LATEST") {
        // "version|what's new" for each app, comma-separated.
        return test
            .split(',')
            .map(|s| (!s.is_empty()).then(|| {
                let (version, notes) = s.split_once('|').unwrap_or((s, ""));
                (version.to_string(), notes.to_string())
            }))
            .collect();
    }
    let lookups: Vec<_> = APPS
        .iter()
        .map(|(_, _, page, _)| {
            let url = format!("{page}/download/latest.json");
            std::thread::spawn(move || {
                let out = hidden(CURL).args(["--fail", "--location", "--silent", "--max-time", "15", &url]).output().ok()?;
                let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
                let notes = json.get("notes").and_then(|n| n.as_str()).unwrap_or_default().to_string();
                json.get("version")?.as_str().map(|v| (v.to_string(), notes))
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
        } else if cfg!(not(windows)) {
            // The desktop's own list (GNOME, KDE and most others keep it).
            let list = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/recently-used.xbel"));
            xbel(&list.and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default())
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

/// The files in a recently-used.xbel, as "milliseconds|path" lines, newest first.
fn xbel(xml: &str) -> String {
    let attr = |tag: &str, name: &str| -> Option<String> {
        let start = format!(" {tag}").find(&format!(" {name}=\""))? + name.len() + 2;
        Some(tag[start..].split('"').next()?.to_string())
    };
    let mut found: Vec<(i64, String)> = xml
        .split("<bookmark ")
        .skip(1)
        .filter_map(|tag| {
            let tag = tag.split('>').next()?;
            let path = unescape(&decode(attr(tag, "href")?.strip_prefix("file://")?));
            let time = attr(tag, "visited").or_else(|| attr(tag, "modified")).map(|t| millis(&t)).unwrap_or(0);
            Some((time, path))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.iter().take(80).map(|(t, p)| format!("{t}|{p}")).collect::<Vec<_>>().join("\n")
}

/// %20 and the like back to the bytes they stand for.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => (out.push(byte), i += 3),
            (c, _) => (out.push(c), i += 1),
        };
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// "2026-11-03T10:15:00.123456Z" in milliseconds since 1970 (0 if it can't be read).
fn millis(t: &str) -> i64 {
    let n = |r: std::ops::Range<usize>| t.get(r).and_then(|s| s.parse::<i64>().ok());
    let (Some(y), Some(m), Some(d), Some(hh), Some(mm), Some(ss)) = (n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19)) else { return 0 };
    // Days since 1970 of a calendar date (Howard Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    ((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_linux_recent_list() {
        let xml = r#"<?xml version="1.0"?><xbel version="1.0">
  <bookmark href="file:///home/kim/Dokumenter/Rapport%20%C3%B8ving.docx" added="2026-11-01T08:00:00Z" modified="2026-11-01T08:00:00Z" visited="2026-11-02T09:30:00.5Z"><info/></bookmark>
  <bookmark href="file:///home/kim/a&amp;b.pdf" modified="2026-11-03T10:00:00Z"></bookmark>
  <bookmark href="https://example.com/x.pdf" modified="2026-11-04T10:00:00Z"></bookmark>
</xbel>"#;
        assert_eq!(xbel(xml), "1793700000000|/home/kim/a&b.pdf\n1793611800000|/home/kim/Dokumenter/Rapport øving.docx");
        assert_eq!(millis("1970-01-02T00:00:01Z"), 86_401_000);
    }
}

/// The Run key that starts programs when you sign in to Windows (a test key for tests).
#[cfg(windows)]
fn run_key() -> &'static str {
    if testing() {
        r"HKCU\Software\Duckware\TestRun"
    } else {
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
    }
}

/// Whether the launcher starts when you sign in (Linux: a file in ~/.config/autostart); with `on`, turns that on or off first.
#[cfg(not(windows))]
#[tauri::command]
fn autostart(on: Option<bool>) -> Result<bool, String> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| Some(home()?.join(".config"))).ok_or("No home folder.")?;
    let file = config.join("autostart").join(if testing() { "duckware-test.desktop" } else { "duckware.desktop" });
    match on {
        Some(true) => {
            // Inside an AppImage the program runs from a temporary mount; $APPIMAGE is the file itself.
            let exe = std::env::var_os("APPIMAGE").map(PathBuf::from).map_or_else(std::env::current_exe, Ok).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&file, format!("[Desktop Entry]\nType=Application\nName=Duckware\nExec=\"{}\"\n", exe.display())).map_err(|e| e.to_string())?;
        }
        Some(false) => {
            let _ = std::fs::remove_file(&file);
        }
        None => {}
    }
    Ok(file.is_file())
}

/// Whether the launcher starts with Windows; with `on`, turns that on or off first.
#[cfg(windows)]
#[tauri::command]
fn autostart(on: Option<bool>) -> Result<bool, String> {
    if let Some(on) = on {
        let mut command = hidden("reg");
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
    Ok(hidden("reg").args(["query", run_key(), "/v", "Duckware"]).output().map(|o| o.status.success()).unwrap_or(false))
}

/// Downloads an app's installer from its latest release and runs it silently, so
/// nothing but the launcher's own progress shows. Installs, or updates an installed app. Resolves when done.
#[tauri::command]
async fn install(index: usize) -> Result<(), String> {
    let (name, _, page, _) = *APPS.get(index).ok_or("No such app.")?;
    if testing() {
        return Ok(());
    }
    #[cfg(not(windows))]
    return tauri::async_runtime::spawn_blocking(move || install_appimage(name, page)).await.map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let url = format!("{page}/download/{name}-Setup.exe");
    #[cfg(windows)]
    tauri::async_runtime::spawn_blocking(move || {
        let setup = std::env::temp_dir().join(format!("{name}-Setup.exe"));
        // Windows' own curl: follows GitHub's redirect, and fails rather than saving an error page.
        let got = hidden(CURL)
            .args(["--fail", "--location", "--silent", "--show-error", "--output"])
            .arg(&setup)
            .arg(&url)
            .output()
            .map_err(|e| format!("Couldn't start the download: {e}"))?;
        if !got.status.success() {
            let why = String::from_utf8_lossy(&got.stderr);
            return Err(if why.contains("404") { format!("{name} hasn't been released yet.") } else { format!("The download failed: {}", why.trim()) });
        }
        let done = hidden(&setup).arg("/S").status().map_err(|e| format!("Couldn't run the installer: {e}"));
        let _ = std::fs::remove_file(&setup);
        match done? {
            s if s.success() => Ok(()),
            _ => Err(format!("{name}'s installer stopped before it finished.")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Linux: the AppImage into ~/Applications (it updates itself from then on), and an entry in the app menu.
#[cfg(not(windows))]
fn install_appimage(name: &str, page: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let image = appimage(name).ok_or("No home folder.")?;
    std::fs::create_dir_all(image.parent().unwrap()).map_err(|e| e.to_string())?;
    // Downloaded beside it first, so a broken download never replaces a working app.
    let part = image.with_extension("part");
    let got = hidden(CURL)
        .args(["--fail", "--location", "--silent", "--show-error", "--output"])
        .arg(&part)
        .arg(format!("{page}/download/{name}-x86_64.AppImage"))
        .output()
        .map_err(|e| format!("Couldn't start the download (is curl installed?): {e}"))?;
    if !got.status.success() {
        let _ = std::fs::remove_file(&part);
        let why = String::from_utf8_lossy(&got.stderr);
        return Err(if why.contains("404") { format!("{name} hasn't been released for Linux yet.") } else { format!("The download failed: {}", why.trim()) });
    }
    std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &image).map_err(|e| e.to_string())?;
    if let Some(menu) = home().map(|h| h.join(".local/share/applications")) {
        let _ = std::fs::create_dir_all(&menu);
        let entry = format!("[Desktop Entry]\nType=Application\nName={name}\nExec=\"{}\" %f\nCategories=Office;\n", image.display());
        let _ = std::fs::write(menu.join(format!("{}.desktop", name.to_lowercase())), entry);
    }
    Ok(())
}

/// Opens an app's download page in the browser.
#[tauri::command]
fn download(index: usize) -> Result<(), String> {
    let (_, _, url, _) = APPS.get(index).ok_or("No such app.")?;
    if testing() {
        return Ok(());
    }
    // Explorer (xdg-open on Linux) hands the address to the default browser; no shell, so nothing in it is run.
    Command::new(if cfg!(windows) { "explorer" } else { "xdg-open" }).arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
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
