//! Spoken replies: ElevenLabs TTS when a key is configured, otherwise (or on
//! failure) the system's speech-dispatcher via `spd-say`.
//!
//! rodio's output stream isn't `Send`, so playback lives on its own thread.

use crate::state::Shared;
use anyhow::{Result, anyhow};
use std::io::Cursor;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

const ELEVENLABS_MODEL: &str = "eleven_flash_v2_5";

enum PlayerCommand {
    PlayMp3(Vec<u8>),
    Stop,
}

#[derive(Clone)]
pub struct SpeechPlayer {
    command_sender: std_mpsc::Sender<PlayerCommand>,
    shared: Shared,
}

impl SpeechPlayer {
    pub fn spawn(shared: Shared) -> SpeechPlayer {
        let (command_sender, command_receiver) = std_mpsc::channel::<PlayerCommand>();
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("clicky-speaker".into())
            .spawn(move || run_player_thread(command_receiver, thread_shared))
            .expect("spawn speaker thread");
        SpeechPlayer {
            command_sender,
            shared,
        }
    }

    pub fn play_mp3(&self, mp3_bytes: Vec<u8>) {
        if let Ok(mut state) = self.shared.lock()
            && let Some(clips) = &mut state.speech_capture
        {
            clips.push((std::time::Instant::now(), mp3_bytes.clone()));
        }
        set_playing(&self.shared, true);
        let _ = self.command_sender.send(PlayerCommand::PlayMp3(mp3_bytes));
    }

    pub fn stop(&self) {
        let _ = self.command_sender.send(PlayerCommand::Stop);
        let _ = std::process::Command::new("spd-say")
            .arg("--cancel")
            .status();
    }

    pub fn is_playing(&self) -> bool {
        self.shared
            .lock()
            .map(|state| state.is_tts_playing)
            .unwrap_or(false)
    }

    /// Resolves when the current playback finishes (or is stopped).
    pub async fn wait_until_finished(&self) {
        while self.is_playing() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

fn set_playing(shared: &Shared, is_playing: bool) {
    if let Ok(mut state) = shared.lock() {
        state.is_tts_playing = is_playing;
    }
}

fn run_player_thread(command_receiver: std_mpsc::Receiver<PlayerCommand>, shared: Shared) {
    let device_sink = match rodio::DeviceSinkBuilder::open_default_sink() {
        Ok(device_sink) => device_sink,
        Err(error) => {
            log::error!("no audio output device: {error}");
            // Keep draining commands so callers never block.
            while command_receiver.recv().is_ok() {
                set_playing(&shared, false);
            }
            return;
        }
    };
    let mut current_player: Option<rodio::Player> = None;

    loop {
        match command_receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(PlayerCommand::PlayMp3(mp3_bytes)) => {
                if let Some(player) = current_player.take() {
                    player.stop();
                }
                match rodio::Decoder::try_from(Cursor::new(mp3_bytes)) {
                    Ok(decoded_audio) => {
                        let player = rodio::Player::connect_new(device_sink.mixer());
                        player.append(decoded_audio);
                        current_player = Some(player);
                    }
                    Err(error) => {
                        log::error!("couldn't decode TTS audio: {error}");
                        set_playing(&shared, false);
                    }
                }
            }
            Ok(PlayerCommand::Stop) => {
                if let Some(player) = current_player.take() {
                    player.stop();
                }
                set_playing(&shared, false);
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                if current_player.as_ref().is_some_and(|player| player.empty()) {
                    current_player = None;
                    set_playing(&shared, false);
                }
            }
            Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Fish Audio text to speech. Returns MP3 bytes. Send a voice id every time: without
/// one Fish picks a different voice per request, and a lesson would keep changing speaker.
pub async fn synthesize_with_fish(
    http_client: &reqwest::Client,
    api_key: &str,
    model: &str,
    voice_id: &str,
    text: &str,
) -> Result<Vec<u8>> {
    let started = std::time::Instant::now();
    let response = http_client
        .post("https://api.fish.audio/v1/tts")
        .bearer_auth(api_key)
        .header("model", model)
        .json(&serde_json::json!({
            "text": text,
            "reference_id": voice_id,
            "format": "mp3",
            "latency": "normal",
        }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Fish Audio error {status}: {}",
            error_body.chars().take(300).collect::<String>()
        ));
    }
    let audio = response.bytes().await?.to_vec();
    log::info!("Fish Audio: {} chars in {} ms", text.chars().count(), started.elapsed().as_millis());
    Ok(audio)
}

pub async fn synthesize_with_elevenlabs(
    http_client: &reqwest::Client,
    api_key: &str,
    voice_id: &str,
    text: &str,
) -> Result<Vec<u8>> {
    let response = http_client
        .post(format!(
            "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        ))
        .header("xi-api-key", api_key)
        .header("accept", "audio/mpeg")
        .json(&serde_json::json!({
            "text": text,
            "model_id": ELEVENLABS_MODEL,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
        }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "ElevenLabs error {status}: {}",
            error_body.chars().take(300).collect::<String>()
        ));
    }
    Ok(response.bytes().await?.to_vec())
}

/// Speaks through speech-dispatcher and resolves when speech ends.
pub async fn speak_with_system_voice(shared: &Shared, text: &str) {
    set_playing(shared, true);
    let result = tokio::process::Command::new("spd-say")
        .args(["--wait", "--rate", "10", "--"])
        .arg(text)
        .status()
        .await;
    if let Err(error) = result {
        log::error!("spd-say failed: {error}");
    }
    set_playing(shared, false);
}
