//! AssemblyAI v3 real-time transcription (same protocol as the macOS app).
//!
//! Audio arrives on an unbounded channel while the key is held — chunks are
//! buffered there while the websocket is still connecting, so no speech is lost.
//! When the channel closes (key released) we send `ForceEndpoint`, wait briefly
//! for the final formatted turn, then `Terminate`.

use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const WEBSOCKET_BASE_URL: &str = "wss://streaming.assemblyai.com/v3/ws";
/// How long to wait for the final turn after ForceEndpoint before using the
/// best transcript we have (matches the original app's grace period).
const FINAL_TRANSCRIPT_GRACE_PERIOD: Duration = Duration::from_millis(1400);
/// AssemblyAI wants 50–1000 ms of audio per message; 100 ms at 16 kHz.
const SAMPLES_PER_WEBSOCKET_MESSAGE: usize = 1600;

/// Words the recognizer should spell the way developers expect.
const BASE_KEYTERMS: &[&str] = &[
    "Clicky",
    "Claude",
    "Anthropic",
    "Rust",
    "Tauri",
    "KDE",
    "Plasma",
    "Wayland",
    "VS Code",
    "GitHub",
    "localhost",
    "Next.js",
    "TypeScript",
];

#[derive(Deserialize)]
struct IncomingMessage {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    turn_order: Option<i64>,
    #[serde(default)]
    end_of_turn: Option<bool>,
    #[serde(default)]
    turn_is_formatted: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

struct StoredTurn {
    text: String,
    is_formatted: bool,
}

#[derive(Default)]
struct TurnAccumulator {
    finished_turns_by_order: BTreeMap<i64, StoredTurn>,
    active_turn_text: String,
}

impl TurnAccumulator {
    fn store_finished_turn(&mut self, turn_order: i64, text: String, is_formatted: bool) {
        if text.is_empty() {
            return;
        }
        // A formatted turn (punctuation, casing) beats the raw version of the same turn.
        if let Some(existing) = self.finished_turns_by_order.get(&turn_order)
            && existing.is_formatted
            && !is_formatted
        {
            return;
        }
        self.finished_turns_by_order
            .insert(turn_order, StoredTurn { text, is_formatted });
    }

    fn full_transcript(&self) -> String {
        let mut segments: Vec<&str> = self
            .finished_turns_by_order
            .values()
            .map(|turn| turn.text.as_str())
            .collect();
        if !self.active_turn_text.is_empty() {
            segments.push(&self.active_turn_text);
        }
        segments.join(" ").trim().to_string()
    }
}

pub async fn transcribe_push_to_talk(
    api_key: String,
    mut pcm16_chunk_receiver: UnboundedReceiver<Vec<i16>>,
) -> Result<String> {
    let keyterms_json = serde_json::to_string(BASE_KEYTERMS)?;
    let mut websocket_url = url::Url::parse(WEBSOCKET_BASE_URL)?;
    websocket_url
        .query_pairs_mut()
        .append_pair("sample_rate", "16000")
        .append_pair("encoding", "pcm_s16le")
        .append_pair("format_turns", "true")
        .append_pair("speech_model", "u3-rt-pro")
        .append_pair("keyterms_prompt", &keyterms_json);

    let mut request = websocket_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        api_key.parse().context("invalid AssemblyAI key")?,
    );

    let (websocket, _) = tokio_tungstenite::connect_async(request)
        .await
        .context("couldn't connect to AssemblyAI")?;
    let (mut websocket_writer, mut websocket_reader) = websocket.split();

    let mut accumulator = TurnAccumulator::default();
    let mut pending_samples: Vec<i16> = Vec::with_capacity(SAMPLES_PER_WEBSOCKET_MESSAGE * 2);
    let mut is_recording = true;
    let final_deadline = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(final_deadline);

    loop {
        tokio::select! {
            chunk = pcm16_chunk_receiver.recv(), if is_recording => {
                match chunk {
                    Some(samples) => {
                        pending_samples.extend_from_slice(&samples);
                        while pending_samples.len() >= SAMPLES_PER_WEBSOCKET_MESSAGE {
                            let message_samples: Vec<i16> =
                                pending_samples.drain(..SAMPLES_PER_WEBSOCKET_MESSAGE).collect();
                            websocket_writer.send(Message::Binary(pcm16_to_bytes(&message_samples).into())).await?;
                        }
                    }
                    None => {
                        // Key released: flush the tail (padded to the 50 ms minimum) and ask
                        // AssemblyAI to end the current turn right away.
                        is_recording = false;
                        if !pending_samples.is_empty() {
                            pending_samples.resize(pending_samples.len().max(800), 0);
                            websocket_writer.send(Message::Binary(pcm16_to_bytes(&pending_samples).into())).await?;
                            pending_samples.clear();
                        }
                        websocket_writer.send(Message::Text(r#"{"type":"ForceEndpoint"}"#.into())).await?;
                        final_deadline.as_mut().reset(tokio::time::Instant::now() + FINAL_TRANSCRIPT_GRACE_PERIOD);
                    }
                }
            }
            incoming = websocket_reader.next() => {
                let Some(incoming) = incoming else { break };
                let Message::Text(text) = incoming? else { continue };
                let Ok(message) = serde_json::from_str::<IncomingMessage>(&text) else { continue };
                match message.message_type.to_ascii_lowercase().as_str() {
                    "turn" => {
                        let turn_text = message.transcript.unwrap_or_default().trim().to_string();
                        let is_formatted = message.turn_is_formatted == Some(true);
                        let is_turn_finished = message.end_of_turn == Some(true) || is_formatted;
                        if is_turn_finished {
                            let turn_order = message.turn_order.unwrap_or_else(|| {
                                accumulator.finished_turns_by_order.keys().max().map_or(0, |max| max + 1)
                            });
                            accumulator.active_turn_text.clear();
                            accumulator.store_finished_turn(turn_order, turn_text, is_formatted);
                            // After release, the first finished turn is the answer to our ForceEndpoint.
                            if !is_recording {
                                break;
                            }
                        } else {
                            accumulator.active_turn_text = turn_text;
                        }
                    }
                    "termination" => break,
                    "error" => return Err(anyhow!("AssemblyAI error: {}", message.error.unwrap_or(text.to_string()))),
                    _ => {}
                }
            }
            _ = &mut final_deadline, if !is_recording => {
                log::info!("assemblyai: final turn didn't arrive in time, using best transcript");
                break;
            }
        }
    }

    let _ = websocket_writer
        .send(Message::Text(r#"{"type":"Terminate"}"#.into()))
        .await;
    let _ = websocket_writer.close().await;
    Ok(accumulator.full_transcript())
}

fn pcm16_to_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}
