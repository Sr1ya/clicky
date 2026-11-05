//! Puter text-to-speech (https://docs.puter.com/AI/txt2speech/).
//!
//! Puter only documents a JavaScript SDK, so this calls the same endpoint that
//! SDK uses: `POST https://api.puter.com/drivers/call` with the `puter-tts`
//! interface. Puter is "user pays": the signed-in Puter account's free monthly
//! allowance covers the speech, so there's no API key, only that account's
//! auth token. `sign_in` gets one with Puter's browser login (the same
//! `?action=authme` redirect flow as puter.js's `getAuthToken`).

use anyhow::{Context, Result, anyhow, bail};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const API_ORIGIN: &str = "https://api.puter.com";
const SIGN_IN_ORIGIN: &str = "https://puter.com";
/// Puter rejects longer input with `input_too_large`.
pub const MAX_INPUT_CHARS: usize = 3000;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

pub struct VoiceSettings<'a> {
    pub provider: &'a str,
    pub voice: &'a str,
    pub model: &'a str,
}

/// Returns encoded audio (MP3 for most providers, WAV for Gemini); rodio
/// decodes either.
pub async fn synthesize(
    http_client: &reqwest::Client,
    auth_token: &str,
    settings: &VoiceSettings<'_>,
    text: &str,
) -> Result<Vec<u8>> {
    let mut args = serde_json::json!({ "text": text });
    for (name, value) in [
        ("provider", settings.provider),
        ("voice", settings.voice),
        ("model", settings.model),
    ] {
        if !value.trim().is_empty() {
            args[name] = value.trim().into();
        }
    }
    let body = serde_json::json!({
        "interface": "puter-tts",
        "driver": "ai-tts",
        "test_mode": false,
        "method": "synthesize",
        "args": args,
        "auth_token": auth_token,
    });
    let response = http_client
        .post(format!("{API_ORIGIN}/drivers/call"))
        // puter.js sends JSON under this content type; keep the wire format identical.
        .header("content-type", "text/plain;actually=json")
        .bearer_auth(auth_token)
        .body(body.to_string())
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("Puter request failed")?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = response.bytes().await?.to_vec();

    if !content_type.contains("json") {
        if !status.is_success() {
            bail!("Puter error {status}: {}", lossy_preview(&bytes));
        }
        return Ok(bytes);
    }

    // JSON is either an error or (rarely) a URL to the finished audio.
    let envelope: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("Puter sent unreadable JSON ({status})"))?;
    if !status.is_success() || envelope["success"] == false {
        let message = envelope["error"]["message"]
            .as_str()
            .or_else(|| envelope["message"].as_str())
            .or_else(|| envelope["error"].as_str())
            .unwrap_or("unknown error");
        let code = envelope["code"]
            .as_str()
            .or_else(|| envelope["error"]["code"].as_str())
            .unwrap_or("");
        if status == reqwest::StatusCode::UNAUTHORIZED || code.starts_with("token_") {
            bail!("Puter sign-in expired or missing ({message}); run `clicky puter-login`");
        }
        bail!("Puter error {status} {code}: {message}");
    }
    let result = envelope.get("result").unwrap_or(&envelope);
    let audio_url = result
        .as_str()
        .or_else(|| result["url"].as_str())
        .ok_or_else(|| anyhow!("Puter sent no audio: {}", lossy_preview(&bytes)))?;
    let audio = http_client.get(audio_url).send().await?.error_for_status()?;
    Ok(audio.bytes().await?.to_vec())
}

fn lossy_preview(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).into_owned()
}

/// Splits long replies into pieces Puter accepts, preferring sentence ends.
pub fn split_for_synthesis(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut remaining = text.trim();
    while remaining.chars().count() > MAX_INPUT_CHARS {
        let limit = remaining
            .char_indices()
            .nth(MAX_INPUT_CHARS)
            .map(|(index, _)| index)
            .unwrap_or(remaining.len());
        let window = &remaining[..limit];
        let cut = window
            .rfind(['.', '!', '?', '\n'])
            .map(|index| index + 1)
            .or_else(|| window.rfind(' '))
            .filter(|&index| index > 0)
            .unwrap_or(limit);
        chunks.push(remaining[..cut].trim().to_string());
        remaining = remaining[cut..].trim_start();
    }
    if !remaining.is_empty() {
        chunks.push(remaining.to_string());
    }
    chunks
}

/// Opens Puter's sign-in page in the browser and waits for it to redirect back
/// to a one-shot local listener with the account's auth token.
pub async fn sign_in() -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let state = random_state()?;

    let mut callback = url::Url::parse(&format!("http://127.0.0.1:{port}/"))?;
    callback.query_pairs_mut().append_pair("state", &state);
    let mut sign_in_url = url::Url::parse(SIGN_IN_ORIGIN)?;
    sign_in_url
        .query_pairs_mut()
        .append_pair("action", "authme")
        .append_pair("redirectURL", callback.as_str());

    log::info!("opening Puter sign-in: {sign_in_url}");
    let opened = tokio::process::Command::new("xdg-open")
        .arg(sign_in_url.as_str())
        .status()
        .await;
    if !opened.is_ok_and(|status| status.success()) {
        eprintln!("Open this link to sign in to Puter:\n{sign_in_url}");
    }

    tokio::time::timeout(SIGN_IN_TIMEOUT, async {
        loop {
            let (mut stream, _) = listener.accept().await?;
            let mut buffer = vec![0u8; 16 * 1024];
            let length = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..length]);
            match token_from_request(&request, &state) {
                Some(token) => {
                    respond(&mut stream, "200 OK", "Signed in to Puter. You can close this tab and go back to Clicky.").await;
                    return Ok(token);
                }
                // Browsers also ask for /favicon.ico and the like; ignore those.
                None => respond(&mut stream, "400 Bad Request", "Invalid sign-in callback.").await,
            }
        }
    })
    .await
    .map_err(|_| anyhow!("Puter sign-in timed out after 5 minutes"))?
}

fn token_from_request(request: &str, expected_state: &str) -> Option<String> {
    let request_line = request.lines().next()?;
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = url::Url::parse(&format!("http://127.0.0.1{}", parts.next()?)).ok()?;
    if target.path() != "/" {
        return None;
    }
    let mut state = None;
    let mut token = None;
    for (name, value) in target.query_pairs() {
        match name.as_ref() {
            "state" if state.is_none() => state = Some(value.into_owned()),
            "token" if token.is_none() => token = Some(value.into_owned()),
            "state" | "token" => return None, // duplicates: reject, like puter.js
            _ => {}
        }
    }
    (state.as_deref() == Some(expected_state))
        .then_some(token)
        .flatten()
        .filter(|token| !token.is_empty())
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Clicky</title>\
         <body style=\"font:16px system-ui;margin:3em\">{message}</body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn random_state() -> Result<String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
        .context("reading /dev/urandom")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_needs_matching_state_and_one_token() {
        let ok = "GET /?state=abc&token=t0k HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(token_from_request(ok, "abc").as_deref(), Some("t0k"));
        assert_eq!(token_from_request(ok, "nope"), None);
        let favicon = "GET /favicon.ico HTTP/1.1\r\n\r\n";
        assert_eq!(token_from_request(favicon, "abc"), None);
        let duplicate = "GET /?state=abc&token=a&token=b HTTP/1.1\r\n\r\n";
        assert_eq!(token_from_request(duplicate, "abc"), None);
    }

    #[test]
    fn long_text_splits_at_sentences_under_the_limit() {
        let sentence = "This is a sentence that goes on for a while. ";
        let text = sentence.repeat(200);
        let chunks = split_for_synthesis(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= MAX_INPUT_CHARS));
        assert!(chunks.iter().all(|chunk| chunk.ends_with('.')));
        assert_eq!(split_for_synthesis("short"), vec!["short".to_string()]);
    }
}
