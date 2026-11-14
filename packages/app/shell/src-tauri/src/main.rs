//! The OpenAssess window.
//!
//! Everything the app does is done by its local server, which is Node running the app's own code. This starts that server,
//! waits for it to say where it is listening, and points the window at it. There is nothing else in here on purpose: the
//! window has no commands for the page to call, and the page it shows is given no access to the machine beyond what the
//! server allows it. When the window closes the server is stopped, and if the window is killed the server notices its
//! input has closed and stops itself. The one other thing it does is show the system's Save dialog when the window is asked to
//! download one of the app's own files (see `on_download`), because the page cannot.
//!
//! The window goes only to its own start page and to its server's pages (see `may_show`). The one page outside them it will open is
//! a page of OpenAssess's releases, which Check for updates offers, and that opens in the person's own browser.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use tauri::webview::DownloadEvent;

/// The server, kept so that it can be stopped when the window goes.
struct Server(Mutex<Option<Child>>);

/// The release this window is, as the installer's build recorded it (`tools/release/build_installer.py` sets it), for Check for
/// updates to compare with the published ones. A window built any other way has none, and Check for updates then says which
/// release is the newest.
const RELEASE: Option<&str> = option_env!("OPENASSESS_RELEASE");

/// The folder that holds `packages/app/src/main.ts`. A release build uses only the copy the installer put beside the window, so
/// that nothing in the environment or in a folder above the program can choose the code it runs (the security review of
/// 2026-11-13). A debug build, run from the repository, may also be pointed at one with `OPENASSESS_APP_ROOT`, or find the
/// repository above itself.
fn app_root(resources: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        if let Ok(root) = std::env::var("OPENASSESS_APP_ROOT") {
            candidates.push(PathBuf::from(root));
        }
    }
    candidates.push(resources.join("resources").join("app"));
    candidates.push(resources.join("app"));
    if cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            for up in 1..=8 {
                if let Some(dir) = exe.ancestors().nth(up) {
                    candidates.push(dir.to_path_buf());
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|c| c.join("packages").join("app").join("src").join("main.ts").exists())
}

/// The Node that runs the server: the one carried with the window. A debug build falls back to the one on the path; a release
/// build never does, so a `node.exe` found first on the path cannot run in its place.
fn node_path(resources: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in [resources.join("resources").join("node"), resources.join("node")] {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    cfg!(debug_assertions).then(|| PathBuf::from(name))
}

/// Whether Check for updates is turned off on this computer: `OPENSTAGE_UPDATE_CHECK=off`, or a file `update-check.txt` beside the
/// program that says `off` (the way an IT department turns it off for the copies it installs). The server is then told so.
fn update_check_off() -> bool {
    let off = |text: &str| text.trim().eq_ignore_ascii_case("off");
    if std::env::var("OPENSTAGE_UPDATE_CHECK").is_ok_and(|v| off(&v)) {
        return true;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("update-check.txt")))
        .and_then(|file| std::fs::read_to_string(file).ok())
        .is_some_and(|text| off(&text))
}

/// Whether the window may show an address: the page it starts on (the app's own, `tauri.localhost` on Windows) and, once the server
/// has said where it is, that server's pages, on that port. Anything else is refused (the security review of 2026-11-13), so that
/// a link in a question, or an address the server never gave, cannot take the window anywhere.
fn may_show(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") && url.port().is_none() => true,
        "http" => port != 0 && url.host_str() == Some("127.0.0.1") && url.port() == Some(port),
        _ => false,
    }
}

/// Whether an address is a page of OpenAssess's releases on GitHub (the list, or one release by its tag): the one page outside
/// the app that the window opens, and it opens it in the person's own browser. Nothing else is opened, whatever the page asks.
fn is_release_page(url: &Url) -> bool {
    const RELEASES: &str = "/jasonswrench-beep/openstage-assess/releases";
    if url.scheme() != "https" || url.host_str() != Some("github.com") || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let path = url.path();
    path == RELEASES
        || path.strip_prefix(RELEASES).and_then(|rest| rest.strip_prefix("/tag/v")).is_some_and(|tag| {
            (1..=40).contains(&tag.len()) && tag.starts_with(|c: char| c.is_ascii_digit()) && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        })
}

/// Opens a page of OpenAssess's releases in the person's own browser, as opening a link from the Start menu does.
#[cfg(windows)]
fn open_in_browser(url: &Url) {
    if !is_release_page(url) {
        return;
    }
    let address = url.to_string();
    std::thread::spawn(move || {
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(address.as_str()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        // ShellExecuteW says it worked with a number above 32.
        if result.0 as isize > 32 {
            note("a release page was opened in the browser");
        } else {
            note("Windows could not open the release page in the browser");
        }
    });
}

#[cfg(not(windows))]
fn open_in_browser(_url: &Url) {}

/// What the window does when it is asked to go somewhere: its own pages are let through, a release page is opened in the browser
/// instead, and anything else is refused. Only the scheme and the host are logged, so no key in an address is written down.
fn navigate_to(url: &Url, port: u16) -> bool {
    if may_show(url, port) {
        return true;
    }
    if is_release_page(url) {
        open_in_browser(url);
    } else {
        note(&format!("the window was kept from going to {}://{}", url.scheme(), url.host_str().unwrap_or("")));
    }
    false
}

/// Says in the window what went wrong, in words, for a failure to start.
fn say(window: &tauri::WebviewWindow, message: &str) {
    let safe: String = message.chars().filter(|c| !matches!(c, '\'' | '"' | '\\' | '<' | '>' | '`' | '\n' | '\r')).collect();
    let _ = window.eval(&format!(
        "document.getElementById('note').textContent = '{}';",
        safe
    ));
}

/// The place a person chose for a file, kept for the moment between the Save dialog and the download that follows it: the
/// address that was asked for, and where it is to go.
#[cfg(windows)]
type Chosen = Arc<Mutex<Option<(String, PathBuf)>>>;

/// What to do when the window is asked to download something.
///
/// Left to itself the window saves a download into the Downloads folder at once, with no dialog and no word that anything had
/// happened, so the button looked as if it did nothing. (The page's own save dialog, `showSaveFilePicker`, is no way round it:
/// in this window it is offered and then never opens.) The system's Save dialog has to be shown from outside the download
/// event: shown from inside, it is owned by a window whose thread is waiting for it, and it never appears. So the first request
/// for a file is declined, the dialog is shown from a thread of its own with the file's name filled in, and when a place has been
/// chosen the same address is asked for again; that second request is let through, to the place that was chosen. Closing the
/// dialog drops the download. Only this app's own files are offered a dialog; anything else the window is asked to download is
/// declined.
#[cfg(windows)]
fn on_download(webview: tauri::Webview, event: DownloadEvent<'_>, chosen: &Chosen) -> bool {
    let DownloadEvent::Requested { url, destination } = event else {
        return true;
    };
    let wanted = url.to_string();

    // The second request, made after the person chose.
    if let Ok(mut slot) = chosen.lock() {
        if let Some((address, path)) = slot.take() {
            if address == wanted {
                note(&format!("saving to {}", path.display()));
                *destination = path;
                return true;
            }
        }
    }

    if url.host_str() != Some("127.0.0.1") || !url.path().starts_with("/files/") {
        note(&format!("a download that is not one of this app's own files was declined: {}", url.path()));
        return false;
    }

    let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = destination.extension().map(|e| e.to_string_lossy().into_owned());
    note(&format!("download requested: {name}"));
    let window = webview.window();
    let again = webview.clone();
    let chosen = chosen.clone();
    std::thread::spawn(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Save a copy").set_file_name(name).set_parent(&window);
        if let Some(extension) = &extension {
            dialog = dialog.add_filter(format!("{} file", extension.to_uppercase()), &[extension.as_str()]);
        }
        match dialog.save_file() {
            Some(path) => {
                note(&format!("chosen: {}", path.display()));
                if let Ok(mut slot) = chosen.lock() {
                    *slot = Some((wanted, path));
                }
                let _ = again.navigate(url);
            }
            None => note("the Save dialog was closed without saving"),
        }
    });
    false
}

/// A line in the log file, when one was asked for with `OPENASSESS_SHELL_LOG`, for finding out what the window did.
fn note(message: &str) {
    if let Some(mut file) = std::env::var("OPENASSESS_SHELL_LOG").ok().and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok()) {
        let _ = writeln!(file, "{message}");
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // The window is made here, and not from the configuration alone, so that its downloads can be given a Save dialog.
            let config = app.config().app.windows.first().cloned().expect("the configuration names the window");
            // The server's port, once it has said where it is: the only port of 127.0.0.1 the window may go to (`may_show`).
            let server_port = Arc::new(AtomicU16::new(0));
            let watched = server_port.clone();
            let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(move |url| navigate_to(url, watched.load(Ordering::SeqCst)))
                // A link that asks for a new window (Check for updates' link to the release page) never gets one: a release page opens
                // in the browser, and anything else is refused.
                .on_new_window(|url, _features| {
                    navigate_to(&url, 0);
                    NewWindowResponse::Deny
                });
            #[cfg(windows)]
            let builder = {
                let chosen: Chosen = Arc::new(Mutex::new(None));
                builder.on_download(move |webview, event| on_download(webview, event, &chosen))
            };
            let window = builder.build()?;
            let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));

            let Some(root) = app_root(&resources) else {
                say(&window, "OpenAssess could not find its own files. Reinstall it.");
                return Ok(());
            };
            let script = root.join("packages").join("app").join("src").join("main.ts");

            // A file to write what the server says to, for finding out why a start went wrong. Off unless it is asked for.
            let log_path = std::env::var("OPENASSESS_SHELL_LOG").ok();

            let Some(node) = node_path(&resources) else {
                say(&window, "OpenAssess could not find the Node it carries. Reinstall it.");
                return Ok(());
            };
            let mut command = Command::new(node);
            command
                .arg("--experimental-strip-types")
                .arg("--no-warnings")
                .arg(&script)
                .arg("--exit-when-stdin-closes");
            if let Some(release) = RELEASE {
                command.arg("--release").arg(release);
            }
            if update_check_off() {
                command.arg("--no-update-check");
            }
            if log_path.is_some() {
                command.arg("--log-requests");
            }
            command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            // No console window of its own beside the app's window.
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    say(&window, &format!("OpenAssess could not start its server: {error}"));
                    return Ok(());
                }
            };
            let Some(stdout) = child.stdout.take() else {
                say(&window, "OpenAssess could not read from its server.");
                return Ok(());
            };
            app.manage(Server(Mutex::new(Some(child))));

            std::thread::spawn(move || {
                let mut log = log_path.and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());
                let mut shown = false;
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(file) = log.as_mut() {
                        // The start-up line carries the key in its address, and a log is a file that stays on the disk.
                        if line.starts_with("OPENASSESS_READY ") {
                            let _ = writeln!(file, "{}?k=(left out)", line.split('?').next().unwrap_or(""));
                        } else {
                            let _ = writeln!(file, "{line}");
                        }
                    }
                    if shown {
                        continue;
                    }
                    if let Some(url) = line.strip_prefix("OPENASSESS_READY ") {
                        // Only the address the server gave, and only if it is this machine's own: nothing else is ever opened.
                        let plain = url.chars().all(|c| c.is_ascii_alphanumeric() || ":/.?=-_".contains(c));
                        let port = url.strip_prefix("http://127.0.0.1:").and_then(|rest| rest.split(['/', '?']).next()).and_then(|p| p.parse::<u16>().ok());
                        if let (Some(port), true) = (port, plain) {
                            // The port is let through before the window is sent there.
                            server_port.store(port, Ordering::SeqCst);
                            let _ = window.eval(&format!("window.location.replace('{url}');"));
                            shown = true;
                        } else {
                            say(&window, "OpenAssess's server gave an address it will not open.");
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the window could not be built");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(server) = handle.try_state::<Server>() {
                if let Ok(mut guard) = server.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{is_release_page, may_show};
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("an address")
    }

    #[test]
    fn the_window_goes_only_to_its_start_page_and_its_servers_port() {
        assert!(may_show(&url("http://tauri.localhost/index.html"), 0));
        assert!(may_show(&url("tauri://localhost/index.html"), 0));
        assert!(!may_show(&url("http://127.0.0.1:47321/"), 0), "no port of the server is let through before it says where it is");
        assert!(may_show(&url("http://127.0.0.1:47321/?k=abc"), 47321));
        assert!(may_show(&url("http://127.0.0.1:47321/files/x.csv"), 47321));
        for other in [
            "http://127.0.0.1:47322/",
            "http://localhost:47321/",
            "https://127.0.0.1:47321/",
            "http://127.0.0.1/",
            "http://tauri.localhost:8080/",
            "https://github.com/jasonswrench-beep/openstage-assess/releases",
            "https://example.invalid/",
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
        ] {
            assert!(!may_show(&url(other), 47321), "{other}");
        }
    }

    #[test]
    fn the_one_page_outside_is_a_page_of_openassesss_releases() {
        for yes in [
            "https://github.com/jasonswrench-beep/openstage-assess/releases",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/v0.1.0-alpha.26",
            "https://GitHub.com/jasonswrench-beep/openstage-assess/releases/tag/v1.0.0",
        ] {
            assert!(is_release_page(&url(yes)), "{yes}");
        }
        for no in [
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/latest",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/v",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/v0.1.0?x=1",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/v0.1.0#a",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/download/v0.1.0/setup.exe",
            "https://github.com/jasonswrench-beep/openstage-assess/releases/tag/v0.1.0/../../../x",
            "https://github.com/someone/openstage-assess/releases",
            "http://github.com/jasonswrench-beep/openstage-assess/releases",
            "https://github.com:8443/jasonswrench-beep/openstage-assess/releases",
            "https://user@github.com/jasonswrench-beep/openstage-assess/releases",
            "https://github.com.example/jasonswrench-beep/openstage-assess/releases",
            "https://example.invalid/jasonswrench-beep/openstage-assess/releases",
        ] {
            assert!(!is_release_page(&url(no)), "{no}");
        }
    }
}
