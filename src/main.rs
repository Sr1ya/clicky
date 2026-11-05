//! Clicky for Linux — a voice companion that sees your screen and points at
//! things. Rust + Tauri port of github.com/farzaa/clicky, targeting KDE Plasma
//! on Wayland.
//!
//! Usage:
//!   clicky                 start (or show the panel of the running instance)
//!   clicky toggle          start/stop talking — bind this in KDE custom shortcuts
//!   clicky press|release   explicit push-to-talk edges
//!   clicky panel           open the settings panel

mod audio_input;
mod capture;
mod claude;
mod web_reference;
mod companion;
mod config;
mod desktop_integration;
mod lesson;
mod overlay;
mod pointing;
mod puter;
mod speech;
mod state;
mod streaming;
mod transcription;
mod visual;

use companion::{Companion, CompanionEvent};
use config::Config;
use gtk::prelude::MonitorExt;
use serde::{Deserialize, Serialize};
use state::Shared;
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tokio::sync::mpsc::UnboundedSender;

struct AppState {
    shared: Shared,
    config: Arc<Mutex<Config>>,
    companion_events: UnboundedSender<CompanionEvent>,
    bus_connection: Arc<Mutex<Option<zbus::Connection>>>,
}

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,zbus=warn,tracing=warn"),
    )
    .init();

    let cli_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let bus_method = match arguments.first().map(String::as_str) {
        None => None,
        Some("toggle") => Some("Toggle"),
        Some("press") => Some("Press"),
        Some("release") => Some("Release"),
        Some("panel") => Some("ShowPanel"),
        Some("dismiss") => Some("Dismiss"),
        Some("point") => {
            let coordinates: Vec<f64> = arguments[1..]
                .iter()
                .filter_map(|value| value.parse().ok())
                .collect();
            let [x, y] = coordinates[..] else {
                eprintln!("usage: clicky point X Y   (global logical coordinates)");
                std::process::exit(2);
            };
            if let Err(error) = cli_runtime.block_on(
                desktop_integration::call_running_instance_with("PointAt", &(x, y)),
            ) {
                eprintln!("Clicky isn't running ({error})");
                std::process::exit(1);
            }
            return;
        }
        Some("ask") => {
            let question = arguments[1..].join(" ");
            if question.trim().is_empty() {
                eprintln!("usage: clicky ask QUESTION   (as if you'd said it)");
                std::process::exit(2);
            }
            if let Err(error) = cli_runtime.block_on(
                desktop_integration::call_running_instance_with("Ask", &question),
            ) {
                eprintln!("Clicky isn't running ({error})");
                std::process::exit(1);
            }
            return;
        }
        Some("present") => {
            let Some(reply_text) = arguments
                .get(1)
                .and_then(|path| std::fs::read_to_string(path).ok())
            else {
                eprintln!("usage: clicky present FILE [--keep]   (a canned Claude reply; --keep builds on the drawing on screen)");
                std::process::exit(2);
            };
            let keep_drawing = arguments.get(2).is_some_and(|flag| flag == "--keep");
            let method = if keep_drawing { "PresentReplyKeepingDrawing" } else { "PresentReply" };
            if let Err(error) = cli_runtime.block_on(
                desktop_integration::call_running_instance_with(method, &reply_text),
            ) {
                eprintln!("Clicky isn't running ({error})");
                std::process::exit(1);
            }
            return;
        }
        Some("puter-login") => {
            std::process::exit(match cli_runtime.block_on(puter_login_from_cli()) {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("Puter sign-in failed: {error:#}");
                    1
                }
            });
        }
        Some("selftest") => {
            std::process::exit(if cli_runtime.block_on(run_self_test()) {
                0
            } else {
                1
            });
        }
        Some(_) => {
            println!("usage: clicky [toggle|press|release|dismiss|panel|point X Y|ask QUESTION|present FILE [--keep]|puter-login|selftest]");
            return;
        }
    };
    if let Some(method_name) = bus_method {
        if let Err(error) =
            cli_runtime.block_on(desktop_integration::call_running_instance(method_name))
        {
            eprintln!("Clicky isn't running ({error})");
            std::process::exit(1);
        }
        return;
    }

    // Single instance: a second launch just opens the existing panel.
    if cli_runtime.block_on(desktop_integration::is_instance_running()) {
        let _ = cli_runtime.block_on(desktop_integration::call_running_instance("ShowPanel"));
        return;
    }
    drop(cli_runtime);

    run_app();
}

/// Signs in to Puter in the browser, saves the token, and tells a running
/// Clicky to pick it up.
async fn puter_login_from_cli() -> anyhow::Result<()> {
    println!("Opening Puter sign-in in your browser…");
    let token = puter::sign_in().await?;
    let mut config = Config::load_file();
    config.puter_auth_token = token;
    config.save()?;
    println!("Signed in. Token saved to {}", config::config_file_path().display());
    if desktop_integration::is_instance_running().await {
        desktop_integration::call_running_instance("ReloadConfig").await?;
        println!("Running Clicky now speaks with Puter ({} / {}).", config.puter_tts_provider, config.puter_tts_voice);
    }
    Ok(())
}

/// Checks the local pieces that don't need API keys: monitor detection,
/// screenshots, and the microphone → 16 kHz PCM pipeline.
async fn run_self_test() -> bool {
    let mut all_passed = true;
    // KWin's screenshot permission is granted through the .desktop entry.
    if let Err(error) = desktop_integration::install_desktop_entry() {
        println!("✗ couldn't install .desktop entry: {error:#}");
    }

    let monitors = match gtk::init() {
        Ok(()) => {
            let display = gtk::gdk::Display::default().expect("display");
            (0..display.n_monitors())
                .filter_map(|index| display.monitor(index))
                .map(|monitor| {
                    let rectangle = monitor.geometry();
                    state::MonitorGeometry {
                        x: rectangle.x(),
                        y: rectangle.y(),
                        width: rectangle.width(),
                        height: rectangle.height(),
                    }
                })
                .collect::<Vec<_>>()
        }
        Err(error) => {
            println!("✗ GTK init failed: {error}");
            return false;
        }
    };
    println!("✓ monitors: {monitors:?}");

    let started_at = std::time::Instant::now();
    match capture::capture_all_screens(&monitors, None).await {
        Ok(captures) => {
            for (screen_index, capture) in captures.iter().enumerate() {
                use base64::Engine;
                let saved_path = std::env::temp_dir()
                    .join(format!("clicky-selftest-screen{}.jpg", screen_index + 1));
                if let Ok(jpeg_bytes) =
                    base64::engine::general_purpose::STANDARD.decode(&capture.jpeg_base64)
                {
                    let _ = std::fs::write(&saved_path, jpeg_bytes);
                    println!("  saved {}", saved_path.display());
                }
                println!(
                    "✓ screenshot {}x{} ({} KB jpeg) in {:.1}s — {}",
                    capture.screenshot_width,
                    capture.screenshot_height,
                    capture.jpeg_base64.len() * 3 / 4 / 1024,
                    started_at.elapsed().as_secs_f64(),
                    capture.label
                );
            }
        }
        Err(error) => {
            println!("✗ screenshot failed: {error:#}");
            all_passed = false;
        }
    }

    let shared = state::new_shared(true);
    let recorder = audio_input::MicrophoneRecorder::spawn(shared.clone());
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    match recorder.start(sender).await {
        Ok(()) => {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            recorder.stop();
            let mut sample_count = 0usize;
            let mut peak = 0i16;
            while let Some(chunk) = receiver.recv().await {
                sample_count += chunk.len();
                peak = peak.max(
                    chunk
                        .iter()
                        .map(|sample| sample.saturating_abs())
                        .max()
                        .unwrap_or(0),
                );
            }
            let seconds = sample_count as f64 / audio_input::TARGET_SAMPLE_RATE as f64;
            let rate_ok = (1.6..=2.4).contains(&seconds);
            all_passed &= rate_ok;
            println!(
                "{} microphone: {sample_count} samples ≈ {seconds:.2}s of 16 kHz audio over 2s, peak {peak}",
                if rate_ok { "✓" } else { "✗" }
            );
        }
        Err(error) => {
            println!("✗ microphone: {error}");
            all_passed = false;
        }
    }
    all_passed
}

fn run_app() {
    let config = Config::load();
    let shared = state::new_shared(config.show_cursor_always);
    let config = Arc::new(Mutex::new(config));
    let (companion_events, companion_event_receiver) = tokio::sync::mpsc::unbounded_channel();
    let bus_connection: Arc<Mutex<Option<zbus::Connection>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        .manage(AppState {
            shared: shared.clone(),
            config: config.clone(),
            companion_events: companion_events.clone(),
            bus_connection: bus_connection.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            save_config,
            puter_sign_in,
            push_to_talk,
            quit_app
        ])
        .setup(move |app| {
            if let Err(error) = desktop_integration::install_desktop_entry() {
                log::warn!("couldn't install .desktop entry: {error:#}");
            }

            // Graphics first so the buddy's surface stacks above the cards.
            visual::start(shared.clone(), companion_events.clone());
            overlay::start(shared.clone());
            build_tray(
                app,
                shared.clone(),
                config.clone(),
                companion_events.clone(),
            )?;

            let companion = Companion {
                shared: shared.clone(),
                config: config.clone(),
                http_client: reqwest::Client::new(),
                recorder: audio_input::MicrophoneRecorder::spawn(shared.clone()),
                speaker: speech::SpeechPlayer::spawn(shared.clone()),
                history: Default::default(),
                app: app.handle().clone(),
            };
            tauri::async_runtime::spawn(companion.run(companion_event_receiver));

            spawn_session_integration(
                shared.clone(),
                companion_events.clone(),
                bus_connection.clone(),
            );
            spawn_push_to_talk_shortcut(shared.clone(), config.clone(), companion_events.clone());

            if !config.lock().unwrap().missing_keys().is_empty() {
                companion::show_panel(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the panel only hides it; Clicky keeps running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Clicky");

    app.run(move |app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            let state = app_handle.state::<AppState>();
            let connection = state.bus_connection.lock().unwrap().clone();
            if let Some(connection) = connection {
                tauri::async_runtime::block_on(desktop_integration::unload_kwin_cursor_script(
                    &connection,
                ));
            }
        }
        _ => {}
    });
}

fn spawn_session_integration(
    shared: Shared,
    companion_events: UnboundedSender<CompanionEvent>,
    bus_connection: Arc<Mutex<Option<zbus::Connection>>>,
) {
    tauri::async_runtime::spawn(async move {
        let connection =
            match desktop_integration::start_bus_service(companion_events, shared.clone()).await {
                Ok(connection) => connection,
                Err(error) => {
                    log::error!("{error:#}");
                    shared.lock().unwrap().cursor_tracking_status =
                        format!("D-Bus unavailable: {error}");
                    return;
                }
            };
        let tracking_status = match desktop_integration::load_kwin_cursor_script(&connection).await
        {
            Ok(()) => "following your cursor (KWin script)".to_string(),
            Err(error) => {
                log::warn!("cursor tracking unavailable: {error:#}");
                format!("cursor tracking unavailable: {error}")
            }
        };
        shared.lock().unwrap().cursor_tracking_status = tracking_status;
        *bus_connection.lock().unwrap() = Some(connection);
    });
}

fn spawn_push_to_talk_shortcut(
    shared: Shared,
    config: Arc<Mutex<Config>>,
    companion_events: UnboundedSender<CompanionEvent>,
) {
    let preferred_trigger = config.lock().unwrap().push_to_talk_trigger.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = desktop_integration::run_push_to_talk_shortcut(
            preferred_trigger,
            companion_events,
            shared.clone(),
        )
        .await
        {
            log::warn!("global shortcut unavailable: {error:#}");
            shared.lock().unwrap().hotkey_status = format!(
                "portal shortcut unavailable ({error}). Bind `clicky toggle` in System Settings → Shortcuts instead."
            );
        }
    });
}

fn build_tray(
    app: &mut tauri::App,
    shared: Shared,
    config: Arc<Mutex<Config>>,
    companion_events: UnboundedSender<CompanionEvent>,
) -> tauri::Result<()> {
    let show_cursor_always = config.lock().unwrap().show_cursor_always;
    let open_item = MenuItem::with_id(app, "open", "Open Clicky", true, None::<&str>)?;
    let talk_item = MenuItem::with_id(app, "talk", "Start / stop talking", true, None::<&str>)?;
    let cursor_item = CheckMenuItem::with_id(
        app,
        "cursor",
        "Always show buddy",
        true,
        show_cursor_always,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Clicky", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &talk_item, &cursor_item, &quit_item])?;

    let cursor_item_for_handler = cursor_item.clone();
    TrayIconBuilder::with_id("clicky")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("Clicky")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => companion::show_panel(app),
            "talk" => {
                let _ = companion_events.send(CompanionEvent::PushToTalkToggled);
            }
            "cursor" => {
                let is_checked = cursor_item_for_handler.is_checked().unwrap_or(true);
                set_show_cursor_always(&shared, &config, is_checked);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn set_show_cursor_always(shared: &Shared, config: &Arc<Mutex<Config>>, show_cursor_always: bool) {
    shared.lock().unwrap().show_cursor_always = show_cursor_always;
    let mut config = config.lock().unwrap();
    config.show_cursor_always = show_cursor_always;
    if let Err(error) = config.save() {
        log::error!("couldn't save config: {error:#}");
    }
}

// ---------------------------------------------------------------- panel commands

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> state::StatusSnapshot {
    state.shared.lock().unwrap().snapshot()
}

/// Config as the panel sees it: keys are never sent back, only whether they're set.
#[derive(Serialize)]
struct PanelConfig {
    model: String,
    elevenlabs_voice_id: String,
    push_to_talk_trigger: String,
    show_cursor_always: bool,
    has_anthropic_api_key: bool,
    has_assemblyai_api_key: bool,
    has_elevenlabs_api_key: bool,
    has_puter_auth_token: bool,
    puter_voice: String,
    missing_keys: Vec<&'static str>,
    config_path: String,
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> PanelConfig {
    let config = state.config.lock().unwrap();
    PanelConfig {
        model: config.model.clone(),
        elevenlabs_voice_id: config.elevenlabs_voice_id.clone(),
        push_to_talk_trigger: config.push_to_talk_trigger.clone(),
        show_cursor_always: config.show_cursor_always,
        has_anthropic_api_key: !config.anthropic_api_key.is_empty(),
        has_assemblyai_api_key: !config.assemblyai_api_key.is_empty(),
        has_elevenlabs_api_key: !config.elevenlabs_api_key.is_empty(),
        has_puter_auth_token: !config.puter_auth_token.is_empty(),
        puter_voice: format!("{} / {}", config.puter_tts_provider, config.puter_tts_voice),
        missing_keys: config.missing_keys(),
        config_path: config::config_file_path().display().to_string(),
    }
}

/// Empty key fields mean "keep the saved key".
#[derive(Deserialize)]
struct ConfigUpdate {
    anthropic_api_key: String,
    assemblyai_api_key: String,
    elevenlabs_api_key: String,
    elevenlabs_voice_id: String,
    model: String,
    show_cursor_always: bool,
}

#[tauri::command]
fn save_config(state: tauri::State<AppState>, update: ConfigUpdate) -> Result<(), String> {
    {
        let mut config_guard = state.config.lock().unwrap();
        let config: &mut Config = &mut config_guard;
        for (new_value, field) in [
            (update.anthropic_api_key, &mut config.anthropic_api_key),
            (update.assemblyai_api_key, &mut config.assemblyai_api_key),
            (update.elevenlabs_api_key, &mut config.elevenlabs_api_key),
            (update.elevenlabs_voice_id, &mut config.elevenlabs_voice_id),
            (update.model, &mut config.model),
        ] {
            if !new_value.trim().is_empty() {
                *field = new_value.trim().to_string();
            }
        }
        config.show_cursor_always = update.show_cursor_always;
        config.save().map_err(|error| format!("{error:#}"))?;
    }
    state.shared.lock().unwrap().show_cursor_always = update.show_cursor_always;
    Ok(())
}

/// Panel button: Puter browser sign-in; the token is saved like a key.
#[tauri::command]
async fn puter_sign_in(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let token = puter::sign_in().await.map_err(|error| format!("{error:#}"))?;
    let mut config = state.config.lock().unwrap();
    config.puter_auth_token = token;
    let mut saved = Config::load_file();
    saved.puter_auth_token = config.puter_auth_token.clone();
    saved.save().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn push_to_talk(state: tauri::State<AppState>, pressed: bool) {
    let event = if pressed {
        CompanionEvent::PushToTalkPressed
    } else {
        CompanionEvent::PushToTalkReleased
    };
    let _ = state.companion_events.send(event);
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
