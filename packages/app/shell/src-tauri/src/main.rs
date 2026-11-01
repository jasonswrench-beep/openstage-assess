//! The OpenAssess window.
//!
//! Everything the app does is done by its local server, which is Node running the app's own code. This starts that server,
//! waits for it to say where it is listening, and points the window at it. There is nothing else in here on purpose: the
//! window has no commands for the page to call, and the page it shows is given no access to the machine beyond what the
//! server allows it. When the window closes the server is stopped, and if the window is killed the server notices its
//! input has closed and stops itself. The one other thing it does is show the system's Save dialog when the window is asked to
//! download one of the app's own files (see `on_download`), because the page cannot.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use tauri::webview::DownloadEvent;

/// The server, kept so that it can be stopped when the window goes.
struct Server(Mutex<Option<Child>>);

/// The folder that holds `packages/app/src/main.ts`: the one the installer put beside the window, one named by the person
/// running it, or, when it is run from a build in the repository, the repository.
fn app_root(resources: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(root) = std::env::var("OPENASSESS_APP_ROOT") {
        candidates.push(PathBuf::from(root));
    }
    candidates.push(resources.join("resources").join("app"));
    candidates.push(resources.join("app"));
    if let Ok(exe) = std::env::current_exe() {
        for up in 1..=8 {
            if let Some(dir) = exe.ancestors().nth(up) {
                candidates.push(dir.to_path_buf());
            }
        }
    }
    candidates
        .into_iter()
        .find(|c| c.join("packages").join("app").join("src").join("main.ts").exists())
}

/// The Node that runs the server: the one carried with the window, or the one on the path.
fn node_path(resources: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in [resources.join("resources").join("node"), resources.join("node")] {
        let candidate = dir.join(name);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(name)
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
            let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
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

            let mut command = Command::new(node_path(&resources));
            command
                .arg("--experimental-strip-types")
                .arg("--no-warnings")
                .arg(&script)
                .arg("--exit-when-stdin-closes");
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
                        if url.starts_with("http://127.0.0.1:") && plain {
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
