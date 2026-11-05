//! Everything that talks to the Plasma/Wayland session:
//! - a session D-Bus service (`dev.clicky.Clicky`) that doubles as the
//!   single-instance lock and lets `clicky toggle` / KDE custom shortcuts drive us
//! - a KWin script that reports the global cursor position (Wayland apps can't
//!   read it themselves)
//! - the XDG GlobalShortcuts portal for hold-to-talk
//! - a .desktop file, which the portal uses to identify host (non-Flatpak) apps

use crate::companion::CompanionEvent;
use crate::state::Shared;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use tokio::sync::mpsc::UnboundedSender;

pub const APP_ID: &str = "dev.clicky.Clicky";
pub const BUS_NAME: &str = "dev.clicky.Clicky";
pub const OBJECT_PATH: &str = "/dev/clicky/Clicky";
const KWIN_SCRIPT_NAME: &str = "clicky-cursor";
const PUSH_TO_TALK_SHORTCUT_ID: &str = "push-to-talk";

// ---------------------------------------------------------------- D-Bus service

struct ClickyBusService {
    companion_events: UnboundedSender<CompanionEvent>,
    shared: Shared,
}

#[zbus::interface(name = "dev.clicky.Clicky")]
impl ClickyBusService {
    /// Called by the KWin script with "x,y" in global logical coordinates.
    /// A string avoids int-vs-double signature mismatches from JavaScript.
    fn cursor_moved(&self, position: String) {
        let mut parts = position.split(',').map(|part| part.trim().parse::<f64>());
        if let (Some(Ok(x)), Some(Ok(y))) = (parts.next(), parts.next())
            && let Ok(mut state) = self.shared.lock()
        {
            state.cursor_position = Some((x, y));
        }
    }

    fn press(&self) {
        let _ = self
            .companion_events
            .send(CompanionEvent::PushToTalkPressed);
    }

    fn release(&self) {
        let _ = self
            .companion_events
            .send(CompanionEvent::PushToTalkReleased);
    }

    fn toggle(&self) {
        let _ = self
            .companion_events
            .send(CompanionEvent::PushToTalkToggled);
    }

    fn show_panel(&self) {
        let _ = self.companion_events.send(CompanionEvent::ShowPanel);
    }

    /// Stop talking and clear the drawing (`clicky dismiss`).
    fn dismiss(&self) {
        let _ = self.companion_events.send(CompanionEvent::Dismiss);
    }

    /// `clicky ask QUESTION`: a turn as if the words were spoken.
    fn ask(&self, question: String) {
        let _ = self.companion_events.send(CompanionEvent::Ask(question));
    }

    /// `clicky present FILE --keep`: a canned reply that builds on the drawing on screen.
    fn present_reply_keeping_drawing(&self, reply_text: String) {
        let _ = self
            .companion_events
            .send(CompanionEvent::PresentReplyKeepingDrawing(reply_text));
    }

    /// `clicky puter-login` saved a new token to config.toml.
    fn reload_config(&self) {
        let _ = self.companion_events.send(CompanionEvent::ReloadConfig);
    }

    /// Debug hook (`clicky point X Y`): fly the buddy to a global logical position.
    fn point_at(&self, x: f64, y: f64) {
        log::debug!("debug point request at ({x}, {y})");
        let mut state = self.shared.lock().unwrap();
        let request_id = state.next_point_request_id;
        state.next_point_request_id += 1;
        state.point_target = Some(crate::state::PointTarget {
            request_id,
            global_x: x,
            global_y: y,
            bubble_text: "right here!".into(),
        });
    }

    /// Debug hook (`clicky present FILE`): present a canned Claude reply,
    /// including any `<visual>` block and `[POINT]` tag, without an API call.
    fn present_reply(&self, reply_text: String) {
        let _ = self
            .companion_events
            .send(CompanionEvent::PresentReply(reply_text));
    }
}

/// Claims the bus name and serves the interface. Fails if another Clicky owns it.
pub async fn start_bus_service(
    companion_events: UnboundedSender<CompanionEvent>,
    shared: Shared,
) -> Result<zbus::Connection> {
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(
            OBJECT_PATH,
            ClickyBusService {
                companion_events,
                shared,
            },
        )?
        .build()
        .await
        .context("couldn't claim dev.clicky.Clicky on the session bus")?;
    Ok(connection)
}

/// Sends a command (Press/Release/Toggle/ShowPanel) to an already running instance.
pub async fn call_running_instance(method_name: &str) -> Result<()> {
    call_running_instance_with(method_name, &()).await
}

pub async fn call_running_instance_with<Body>(method_name: &str, body: &Body) -> Result<()>
where
    Body: serde::Serialize + zbus::zvariant::DynamicType,
{
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BUS_NAME),
            OBJECT_PATH,
            Some(BUS_NAME),
            method_name,
            body,
        )
        .await?;
    Ok(())
}

pub async fn is_instance_running() -> bool {
    let Ok(connection) = zbus::Connection::session().await else {
        return false;
    };
    let Ok(proxy) = zbus::fdo::DBusProxy::new(&connection).await else {
        return false;
    };
    let Ok(bus_name) = zbus::names::BusName::try_from(BUS_NAME) else {
        return false;
    };
    proxy.name_has_owner(bus_name).await.unwrap_or(false)
}

// ---------------------------------------------------------------- KWin cursor script

const KWIN_CURSOR_SCRIPT: &str = r#"
// Reports the global cursor position to Clicky. Throttled to ~120 Hz.
var lastSentAt = 0;
function sendCursorPosition() {
    var position = workspace.cursorPos;
    callDBus("dev.clicky.Clicky", "/dev/clicky/Clicky", "dev.clicky.Clicky", "CursorMoved",
             Math.round(position.x) + "," + Math.round(position.y));
}
workspace.cursorPosChanged.connect(function () {
    var now = Date.now();
    if (now - lastSentAt >= 8) {
        lastSentAt = now;
        sendCursorPosition();
    }
});
sendCursorPosition();
"#;

pub async fn load_kwin_cursor_script(connection: &zbus::Connection) -> Result<()> {
    let script_path = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("clicky")
        .join("kwin-cursor.js");
    std::fs::create_dir_all(script_path.parent().unwrap())?;
    std::fs::write(&script_path, KWIN_CURSOR_SCRIPT)?;

    // Unload a copy left behind by a previous run (e.g. after a crash).
    unload_kwin_cursor_script(connection).await;

    let reply = connection
        .call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "loadScript",
            &(script_path.to_string_lossy().as_ref(), KWIN_SCRIPT_NAME),
        )
        .await
        .context("KWin scripting is unavailable (not running Plasma?)")?;
    let script_id: i32 = reply.body().deserialize()?;
    if script_id < 0 {
        anyhow::bail!("KWin refused to load the cursor script");
    }
    connection
        .call_method(
            Some("org.kde.KWin"),
            format!("/Scripting/Script{script_id}").as_str(),
            Some("org.kde.kwin.Script"),
            "run",
            &(),
        )
        .await?;
    Ok(())
}

pub async fn unload_kwin_cursor_script(connection: &zbus::Connection) {
    let _ = connection
        .call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "unloadScript",
            &(KWIN_SCRIPT_NAME,),
        )
        .await;
}

// ---------------------------------------------------------------- global shortcut

/// Binds hold-to-talk through the GlobalShortcuts portal and forwards
/// Activated/Deactivated as press/release. Runs until the session ends.
pub async fn run_push_to_talk_shortcut(
    preferred_trigger: String,
    companion_events: UnboundedSender<CompanionEvent>,
    shared: Shared,
) -> Result<()> {
    use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};

    if let Ok(app_id) = ashpd::AppID::try_from(APP_ID)
        && let Err(error) = ashpd::register_host_app(app_id).await
    {
        log::warn!("portal host-app registration failed: {error}");
    }

    let global_shortcuts = GlobalShortcuts::new()
        .await
        .context("GlobalShortcuts portal unavailable")?;
    let session = global_shortcuts.create_session(Default::default()).await?;
    let shortcut = NewShortcut::new(PUSH_TO_TALK_SHORTCUT_ID, "Hold to talk to Clicky")
        .preferred_trigger(Some(preferred_trigger.as_str()));
    let bound = global_shortcuts
        .bind_shortcuts(&session, &[shortcut], None, Default::default())
        .await?
        .response()
        .context("shortcut binding was cancelled")?;

    let trigger_description = bound
        .shortcuts()
        .iter()
        .find(|shortcut| shortcut.id() == PUSH_TO_TALK_SHORTCUT_ID)
        .map(|shortcut| shortcut.trigger_description().to_string())
        .filter(|description| !description.is_empty())
        .unwrap_or(preferred_trigger);
    log::info!("push-to-talk bound to {trigger_description}");
    if let Ok(mut state) = shared.lock() {
        state.hotkey_status = format!("hold {trigger_description} to talk");
    }

    let mut activated_stream = global_shortcuts.receive_activated().await?;
    let mut deactivated_stream = global_shortcuts.receive_deactivated().await?;
    loop {
        tokio::select! {
            Some(activated) = activated_stream.next() => {
                if activated.shortcut_id() == PUSH_TO_TALK_SHORTCUT_ID {
                    let _ = companion_events.send(CompanionEvent::PushToTalkPressed);
                }
            }
            Some(deactivated) = deactivated_stream.next() => {
                if deactivated.shortcut_id() == PUSH_TO_TALK_SHORTCUT_ID {
                    let _ = companion_events.send(CompanionEvent::PushToTalkReleased);
                }
            }
            else => break,
        }
    }
    drop(session);
    Ok(())
}

// ---------------------------------------------------------------- .desktop file

/// Installs ~/.local/share/applications/dev.clicky.Clicky.desktop pointing at
/// the current binary. The portal maps our app id to this file, and it gives
/// Clicky a launcher entry.
pub fn install_desktop_entry() -> Result<()> {
    let executable_path = std::env::current_exe()?;
    let applications_directory = dirs::data_dir()
        .context("no XDG data dir")?
        .join("applications");
    std::fs::create_dir_all(&applications_directory)?;
    let desktop_file_path = applications_directory.join(format!("{APP_ID}.desktop"));
    let contents = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Clicky\n\
         Comment=Voice companion that can see your screen and point at things\n\
         Exec=\"{}\"\n\
         Icon=input-mouse\n\
         Terminal=false\n\
         Categories=Utility;\n\
         StartupNotify=false\n\
         X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n",
        executable_path.display()
    );
    let is_up_to_date = std::fs::read_to_string(&desktop_file_path)
        .map(|existing| existing == contents)
        .unwrap_or(false);
    if !is_up_to_date {
        std::fs::write(&desktop_file_path, contents)?;
        // Let KDE's service cache (which KWin consults for screenshot
        // permission) pick up the new entry right away.
        let _ = std::process::Command::new("kbuildsycoca6")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}
