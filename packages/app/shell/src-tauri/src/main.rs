//! The OpenAssess window.
//!
//! Everything the app does is done by its local server, which is Node running the app's own code. This starts that server,
//! waits for it to say where it is listening, and points the window at it. There is nothing else in here on purpose: the
//! window has no commands for the page to call, and the page it shows is given no access to the machine beyond what the
//! server allows it. When the window closes the server is stopped, and if the window is killed the server notices its
//! input has closed and stops itself.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("the window is made from the configuration");
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
