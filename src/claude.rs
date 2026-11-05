//! Claude Messages API over raw HTTP with SSE streaming (Rust has no official
//! Anthropic SDK). Request shape follows the cURL reference: API version
//! 2026-10-21, adaptive thinking (always on for Opus 5.5) steered with
//! `output_config.effort`, and server-side refusal fallbacks.
//!
//! When `api_base_url` points somewhere other than api.anthropic.com, the
//! request drops the beta header and fallbacks but keeps `effort: low`.
//! Measured on the OmniRoute gateway (2026-11-04): it ignores
//! `thinking: disabled` and thinking budgets, and with the full visual prompt
//! Sonnet 5.5 then thinks ~16k tokens (over two minutes) and hits max_tokens
//! before saying anything. `output_config.effort: "low"` with the current API
//! version is honoured: zero thinking tokens, first text in ~1.5 s.

use crate::config::DEFAULT_API_BASE_URL;
use crate::web_reference;
use anyhow::{Context, Result, anyhow};
use futures_util::StreamExt;
use serde_json::{Value, json};

const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Opts into `fallbacks: "default"`: if a safety classifier declines, the API
/// retries on Anthropic's recommended fallback model inside the same call.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Room for thinking plus a spoken reply; streaming keeps this safe from timeouts.
/// Medium effort thinks before it speaks, so leave plenty of room for both.
const MAX_TOKENS: u32 = 32_000;
/// After this many tool rounds the model must answer.
const MAX_TOOL_ROUNDS: usize = 2;

pub struct LabeledImage {
    pub jpeg_base64: String,
    pub label: String,
}

pub struct ConversationTurn {
    pub user_transcript: String,
    pub assistant_reply: String,
}

pub enum ClaudeReply {
    /// The full text went to `on_text` as it streamed.
    Completed,
    /// The request was declined (stop_reason "refusal") even after fallbacks.
    Refused,
}

/// Streams a reply. `on_text` receives each visible text fragment as it
/// arrives, so speech and drawing can start before the reply is finished.
pub async fn ask_claude_with_screenshots(
    http_client: &reqwest::Client,
    api_base_url: &str,
    api_key: &str,
    model: &str,
    effort: &str,
    system_prompt: &str,
    history: &[ConversationTurn],
    images: &[LabeledImage],
    user_prompt: &str,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<ClaudeReply> {
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() * 2 + 1);
    // Earlier turns are sent as text only — re-sending old screenshots would
    // multiply cost without helping much.
    for turn in history {
        messages.push(json!({"role": "user", "content": turn.user_transcript}));
        messages.push(json!({"role": "assistant", "content": turn.assistant_reply}));
    }

    let mut current_content: Vec<Value> = Vec::with_capacity(images.len() * 2 + 1);
    for image in images {
        current_content.push(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": image.jpeg_base64}
        }));
        current_content.push(json!({"type": "text", "text": image.label}));
    }
    current_content.push(json!({"type": "text", "text": user_prompt}));
    messages.push(json!({"role": "user", "content": current_content}));

    let base_url = api_base_url.trim().trim_end_matches('/');
    let base_url = if base_url.is_empty() { DEFAULT_API_BASE_URL } else { base_url };
    let is_official_api = base_url == DEFAULT_API_BASE_URL;

    // A turn may call the reference tool once or twice; each tool round is a
    // new request that continues the same assistant reply.
    let mut tool_rounds = 0;
    loop {
        let mut request_body = json!({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            // Cached: the prompt is large and identical on every turn.
            "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "tools": [web_reference::tool_definition()],
            "output_config": {"effort": effort},
        });
        if tool_rounds >= MAX_TOOL_ROUNDS {
            request_body["tool_choice"] = json!({"type": "none"});
        }
        let mut request = http_client
            .post(format!("{base_url}/v1/messages"))
            .header("x-api-key", api_key)
            .header("content-type", "application/json")
            .header("anthropic-version", ANTHROPIC_VERSION);
        if is_official_api {
            request_body["fallbacks"] = json!("default");
            request = request.header("anthropic-beta", FALLBACK_BETA);
        }

        let response = request
            .json(&request_body)
            .send()
            .await
            .context("couldn't reach the Claude API")?;

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Claude API error {status}: {}",
                summarize_api_error(&error_body)
            ));
        }

        let (stop_reason, content_blocks) = read_stream(response, on_text).await?;
        if stop_reason.as_deref() == Some("refusal") {
            return Ok(ClaudeReply::Refused);
        }
        let tool_calls: Vec<Value> = content_blocks
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .cloned()
            .collect();
        if stop_reason.as_deref() != Some("tool_use") || tool_calls.is_empty() {
            return Ok(ClaudeReply::Completed);
        }

        // Run the tool(s), then continue the reply with their results.
        let mut results = Vec::with_capacity(tool_calls.len());
        for call in &tool_calls {
            let content = if call["name"] == web_reference::TOOL_NAME {
                log::info!("reference lookup: {}", call["input"]);
                web_reference::run_tool(http_client, &call["input"]).await
            } else {
                vec![json!({"type": "text", "text": "unknown tool"})]
            };
            results.push(json!({"type": "tool_result", "tool_use_id": call["id"], "content": content}));
        }
        messages.push(json!({"role": "assistant", "content": content_blocks}));
        messages.push(json!({"role": "user", "content": results}));
        tool_rounds += 1;
    }
}

/// Streams one response: forwards visible text to `on_text` and rebuilds the
/// content blocks (text, thinking with its signature, tool calls) so a tool
/// round can send them back verbatim.
async fn read_stream(
    response: reqwest::Response,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<(Option<String>, Vec<Value>)> {
    let mut stop_reason: Option<String> = None;
    let mut blocks: Vec<Value> = Vec::new();
    let mut tool_input_json: Vec<String> = Vec::new();
    let mut pending_line_bytes: Vec<u8> = Vec::new();
    let mut byte_stream = response.bytes_stream();

    while let Some(chunk) = byte_stream.next().await {
        pending_line_bytes.extend_from_slice(&chunk?);
        while let Some(newline_index) = pending_line_bytes.iter().position(|&byte| byte == b'\n') {
            let line_bytes: Vec<u8> = pending_line_bytes.drain(..=newline_index).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let Some(event_json) = line.trim_end().strip_prefix("data: ") else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<Value>(event_json) else {
                continue;
            };

            match event["type"].as_str() {
                Some("content_block_start") => {
                    blocks.push(event["content_block"].clone());
                    tool_input_json.push(String::new());
                }
                Some("content_block_delta") => {
                    let delta = &event["delta"];
                    let (Some(block), Some(json_buffer)) = (blocks.last_mut(), tool_input_json.last_mut()) else {
                        continue;
                    };
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            if let Some(text_chunk) = delta["text"].as_str() {
                                on_text(text_chunk);
                                let text = block["text"].as_str().unwrap_or_default().to_string() + text_chunk;
                                block["text"] = json!(text);
                            }
                        }
                        Some("input_json_delta") => json_buffer.push_str(delta["partial_json"].as_str().unwrap_or_default()),
                        Some("thinking_delta") => {
                            let thinking = block["thinking"].as_str().unwrap_or_default().to_string()
                                + delta["thinking"].as_str().unwrap_or_default();
                            block["thinking"] = json!(thinking);
                        }
                        Some("signature_delta") => block["signature"] = delta["signature"].clone(),
                        _ => {}
                    }
                }
                Some("content_block_stop") => {
                    if let (Some(block), Some(json_buffer)) = (blocks.last_mut(), tool_input_json.last())
                        && block["type"] == "tool_use"
                    {
                        block["input"] = serde_json::from_str(json_buffer).unwrap_or_else(|_| json!({}));
                    }
                }
                Some("message_delta") => {
                    if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                        stop_reason = Some(reason.to_string());
                    }
                }
                Some("error") => {
                    return Err(anyhow!(
                        "Claude stream error: {}",
                        event["error"]["message"].as_str().unwrap_or("unknown")
                    ));
                }
                _ => {}
            }
        }
    }
    // Empty text blocks can't be sent back.
    blocks.retain(|block| block["type"] != "text" || !block["text"].as_str().unwrap_or_default().is_empty());
    Ok((stop_reason, blocks))
}

fn summarize_api_error(error_body: &str) -> String {
    serde_json::from_str::<Value>(error_body)
        .ok()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| error_body.chars().take(300).collect())
}
