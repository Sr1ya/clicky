//! What a lesson can do beyond drawing: type into a field, start a job in a
//! terminal, pin a card, and record itself to a video.

use crate::capture;
use crate::state::Shared;
use crate::visual::{self, VisualCommand};
use anyhow::{Context, Result, anyhow};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const CURSOR_REACHED_WITHIN: f64 = 3.0;
const CURSOR_ATTEMPTS: usize = 60;
const CURSOR_GAIN: f64 = 0.7;
const CURSOR_LONGEST_HOP: f64 = 120.0;
const CLICK_TO_TYPE_DELAY: Duration = Duration::from_millis(150);
const LEFT_CLICK: &str = "0xC0";
const VIDEO_WIDTH: u32 = 1920;
const VIDEO_FRAMES_PER_SECOND: u32 = 30;

pub fn notify(message: &str) {
    log::info!("{message}");
    let _ = std::process::Command::new("notify-send").args(["-a", "Clicky", "Clicky", message]).spawn();
}

fn ydotool_socket() -> String {
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/run/user/1000".into());
    format!("{runtime}/.ydotool_socket")
}

fn ydotool() -> Command {
    let mut command = Command::new("ydotool");
    command.env("YDOTOOL_SOCKET", ydotool_socket()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

/// `ydotool type` presses Return for a newline and only knows a US keyboard, so
/// anything but one plain line stays out of it.
fn can_type(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii() && !c.is_ascii_control())
}

fn copy_to_clipboard(text: &str) -> bool {
    std::process::Command::new("wl-copy").arg("--").arg(text).spawn().is_ok()
}

/// Relative moves get accelerated by an unknown amount, so this steers by where
/// KWin says the cursor actually went.
async fn move_cursor_to(shared: &Shared, x: f64, y: f64) -> Result<()> {
    for _ in 0..CURSOR_ATTEMPTS {
        let (cursor_x, cursor_y) = shared.lock().unwrap().cursor_position.ok_or_else(|| anyhow!("cursor position unknown"))?;
        let (dx, dy) = (x - cursor_x, y - cursor_y);
        if dx.abs() <= CURSOR_REACHED_WITHIN && dy.abs() <= CURSOR_REACHED_WITHIN {
            return Ok(());
        }
        // Short, damped hops: the desktop accelerates long moves past the target.
        let hop = |distance: f64| (distance * CURSOR_GAIN).clamp(-CURSOR_LONGEST_HOP, CURSOR_LONGEST_HOP).round() as i64;
        let status = ydotool()
            .args(["mousemove", "-x", &hop(dx).to_string(), "-y", &hop(dy).to_string()])
            .status()
            .await?;
        if !status.success() {
            return Err(anyhow!("ydotool mousemove failed"));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    Err(anyhow!("the cursor didn't reach the field"))
}

async fn click_and_type(shared: &Shared, x: f64, y: f64, text: &str) -> Result<()> {
    move_cursor_to(shared, x, y).await?;
    if !ydotool().args(["click", LEFT_CLICK]).status().await?.success() {
        return Err(anyhow!("ydotool click failed"));
    }
    tokio::time::sleep(CLICK_TO_TYPE_DELAY).await;
    let mut typing = ydotool().args(["type", "--key-delay", "6", "--file", "-"]).stdin(Stdio::piped()).spawn()?;
    typing.stdin.take().context("no stdin")?.write_all(text.as_bytes()).await?;
    if !typing.wait().await?.success() {
        return Err(anyhow!("ydotool type failed"));
    }
    Ok(())
}

/// Never presses Return. Whatever can't be typed goes on the clipboard instead.
pub async fn type_text(shared: &Shared, x: f64, y: f64, text: &str) {
    if can_type(text) {
        match click_and_type(shared, x, y, text).await {
            Ok(()) => return,
            Err(error) => log::warn!("couldn't type: {error:#}"),
        }
    }
    if copy_to_clipboard(text) {
        notify("Copied to your clipboard. Press Ctrl+V to paste");
    }
}

fn slug(words: &str) -> String {
    let cleaned: String = words.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let trimmed = cleaned.split('-').filter(|piece| !piece.is_empty()).take(6).collect::<Vec<_>>().join("-");
    if trimmed.is_empty() { "job".to_string() } else { trimmed }
}

fn seconds_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// Opens Claude Code on the task in a terminal the user can see, in its own
/// folder, with their usual permission prompts.
pub fn hand_off(task: &str, label: &str) {
    let name = if label.trim().is_empty() { task } else { label };
    let Some(folder) = dirs::data_local_dir().map(|data| data.join("clicky/jobs").join(format!("{}-{}", slug(name), seconds_now()))) else {
        return;
    };
    if let Err(error) = std::fs::create_dir_all(&folder) {
        notify(&format!("Couldn't start the job: {error}"));
        return;
    }
    let started = std::process::Command::new("konsole")
        .arg("--workdir")
        .arg(&folder)
        .args(["-e", "claude", "--", task])
        .spawn();
    match started {
        Ok(_) => notify(&format!("Started: {name}")),
        Err(error) => notify(&format!("Couldn't open a terminal for the job: {error}")),
    }
}

pub async fn pin_card(shared: &Shared, x: f64, y: f64, width: f64, height: f64) {
    let (monitors, monitor) = {
        let state = shared.lock().unwrap();
        (state.monitors.clone(), state.lesson_capture.as_ref().map(|capture| capture.monitor))
    };
    let picture = match monitor {
        Some(monitor) => capture::grab_region_png(&monitors, monitor, x, y, width, height).await,
        None => Err(anyhow!("no lesson on screen")),
    };
    let data = picture.unwrap_or_else(|error| {
        log::warn!("couldn't pin the card: {error:#}");
        String::new()
    });
    visual::send(shared, VisualCommand::LessonPinned { data, width, height });
}

/// Records the whole desktop while a lesson plays, using KWin's screenshot API.
pub struct VideoRecorder {
    started: Instant,
    stop: Arc<AtomicBool>,
    frames: JoinHandle<Result<(PathBuf, usize)>>,
}

impl VideoRecorder {
    pub async fn start() -> Result<VideoRecorder> {
        let first = capture::grab_frame().await.context("the first frame")?;
        let path = std::env::temp_dir().join(format!("clicky-lesson-{}.mp4", seconds_now()));
        let encoder = start_encoder(first.width(), first.height(), &path)?;
        let stop = Arc::new(AtomicBool::new(false));
        let frames = tokio::spawn(write_frames(encoder, path, first, stop.clone()));
        Ok(VideoRecorder { started: Instant::now(), stop, frames })
    }

    /// Stops recording, lays the voice over the picture and returns the saved file.
    pub async fn finish(self, clips: Vec<(Instant, Vec<u8>)>) -> Result<PathBuf> {
        let seconds = self.started.elapsed().as_secs_f64();
        self.stop.store(true, Ordering::Relaxed);
        let (silent, frames) = self.frames.await.context("the recording stopped")??;
        log::info!("video: {frames} frames in {seconds:.1} s ({:.1} a second), {} voice clips", frames as f64 / seconds, clips.len());
        let folder = dirs::video_dir().or_else(|| dirs::home_dir().map(|home| home.join("Videos"))).context("no videos folder")?.join("Clicky");
        std::fs::create_dir_all(&folder)?;
        let output = folder.join(format!("lesson-{}.mp4", seconds_now()));
        lay_voice_over(&silent, &clips, self.started, &output).await?;
        let _ = std::fs::remove_file(&silent);
        Ok(output)
    }
}

/// Raw frames stamped by the clock as they arrive, so a slow capture stays in time.
fn start_encoder(width: u32, height: u32, path: &Path) -> Result<Child> {
    Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-use_wallclock_as_timestamps", "1"])
        .args(["-s", &format!("{width}x{height}"), "-i", "-"])
        .args(["-vf", &format!("scale={VIDEO_WIDTH}:-2,fps={VIDEO_FRAMES_PER_SECOND}"), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .context("couldn't start ffmpeg")
}

async fn write_frames(mut encoder: Child, path: PathBuf, first: image::RgbaImage, stop: Arc<AtomicBool>) -> Result<(PathBuf, usize)> {
    let (width, height) = first.dimensions();
    let mut input = encoder.stdin.take().context("ffmpeg has no input")?;
    input.write_all(first.as_raw()).await?;
    let mut frames = 1;
    while !stop.load(Ordering::Relaxed) {
        let frame = capture::grab_frame().await?;
        // The desktop can change size mid-way; a frame of another size would tear the stream.
        if frame.dimensions() != (width, height) {
            continue;
        }
        input.write_all(frame.as_raw()).await?;
        frames += 1;
    }
    drop(input);
    if !encoder.wait().await?.success() {
        return Err(anyhow!("ffmpeg failed"));
    }
    Ok((path, frames))
}

async fn lay_voice_over(silent: &Path, clips: &[(Instant, Vec<u8>)], started: Instant, output: &Path) -> Result<()> {
    if clips.is_empty() {
        std::fs::copy(silent, output)?;
        return Ok(());
    }
    let folder = tempfile_folder()?;
    let mut command = Command::new("ffmpeg");
    command.args(["-y", "-loglevel", "error", "-i"]).arg(silent);
    let mut filter = String::new();
    let mut inputs = String::new();
    for (index, (when, audio)) in clips.iter().enumerate() {
        let clip = folder.join(format!("{index}.mp3"));
        std::fs::write(&clip, audio)?;
        command.arg("-i").arg(&clip);
        let delay = when.saturating_duration_since(started).as_millis();
        filter.push_str(&format!("[{}:a]adelay={delay}:all=1[a{index}];", index + 1));
        inputs.push_str(&format!("[a{index}]"));
    }
    filter.push_str(&format!("{inputs}amix=inputs={}:normalize=0[voice]", clips.len()));
    let status = command
        .args(["-filter_complex", &filter, "-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac"])
        .arg(output)
        .status()
        .await?;
    let _ = std::fs::remove_dir_all(&folder);
    if !status.success() {
        return Err(anyhow!("ffmpeg couldn't add the voice"));
    }
    Ok(())
}

fn tempfile_folder() -> Result<PathBuf> {
    let folder = std::env::temp_dir().join(format!("clicky-voice-{}", seconds_now()));
    std::fs::create_dir_all(&folder)?;
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_never_includes_a_return() {
        assert!(can_type("hello world"));
        assert!(!can_type("two\nlines"));
        assert!(!can_type("carriage\rreturn"));
        assert!(!can_type("tab\there"));
        assert!(!can_type("héllo"));
        assert!(!can_type(""));
    }

    #[test]
    fn job_folders_have_safe_names() {
        assert_eq!(slug("Fix the Login Bug!"), "fix-the-login-bug");
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(slug("???"), "job");
    }
}
