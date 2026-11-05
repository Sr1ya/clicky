//! Reference images from the web for 2D diagrams and 3D models.
//!
//! Claude calls the `find_reference_images` tool with a specific query
//! ("spacex starship booster", "iphone 15 teardown", "four stroke engine
//! cutaway") before it draws a real thing, and gets back real photos, cutaways
//! and diagrams to copy shape, proportions, colours and internal layout from.
//!
//! Sources, all through their official public APIs:
//! - Brave Search image API — the whole web; used when a key is configured
//!   (`brave_search_api_key` in config.toml or `BRAVE_SEARCH_API_KEY`).
//! - Wikipedia — the lead image of the best-matching articles.
//! - Wikimedia Commons — photos, cutaways and labelled diagrams.
//! - Openverse — openly licensed images from Flickr and other collections.

use anyhow::{Context, Result};
use base64::Engine;
use futures_util::future::join_all;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Duration;

pub const TOOL_NAME: &str = "find_reference_images";
/// How many images Claude gets back.
const MAX_IMAGES: usize = 5;
/// Wikimedia asks API clients to identify themselves.
const USER_AGENT: &str = "Clicky/0.1 (desktop tutor app; reference image lookup)";
const TIMEOUT: Duration = Duration::from_secs(6);
/// The Messages API rejects images over 5 MB; stay well under it.
const MAX_IMAGE_BYTES: usize = 3_700_000;
const THUMB_WIDTH: &str = "1024";

/// The tool definition sent with every request.
pub fn tool_definition() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": "Search the web for real reference images (photos, teardowns, cutaways, cross-sections, labelled diagrams) of a specific thing before you draw it, so your 2d diagram or 3d model matches the real object: its silhouette, proportions, colours, materials, and where every part sits, inside and out. Call it before writing the <visual> block whenever you draw or model a specific real-world object, machine, device, vehicle, building, organ, animal or plant, or a diagram whose real layout matters (a circuit board, an engine cycle, a cell). You may call it twice: once for the outside (a photo) and once for the inside (a cutaway or diagram). Don't call it for abstract ideas, code, or small talk.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A specific 2 to 6 word image search naming the exact thing and the view you need: 'spacex starship booster', 'iphone 15 pro teardown', 'four stroke engine cutaway', 'human heart anatomy diagram', 'raspberry pi 5 board'."
                }
            },
            "required": ["query"]
        }
    })
}

#[derive(Clone, Debug)]
struct Candidate {
    title: String,
    /// Where it came from, for Claude ("Wikimedia Commons", a website name).
    source: String,
    /// Preferred image URL, then a smaller fallback.
    urls: Vec<String>,
}

struct Reference {
    title: String,
    source: String,
    media_type: &'static str,
    base64: String,
}

async fn get_json(http_client: &reqwest::Client, url: reqwest::Url, headers: &[(&str, &str)]) -> Result<Value> {
    let mut request = http_client.get(url).header("user-agent", USER_AGENT).timeout(TIMEOUT);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    Ok(request.send().await?.error_for_status()?.json().await?)
}

/// The whole web, through Brave's official image search API (needs a key).
async fn search_brave(http_client: &reqwest::Client, api_key: &str, query: &str) -> Result<Vec<Candidate>> {
    let url = reqwest::Url::parse_with_params(
        "https://api.search.brave.com/res/v1/images/search",
        &[("q", query), ("count", "10"), ("safesearch", "strict")],
    )?;
    let response = get_json(http_client, url, &[("accept", "application/json"), ("x-subscription-token", api_key)])
        .await
        .context("Brave image search failed")?;
    Ok(response["results"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|result| {
            let full = result["properties"]["url"].as_str();
            let thumbnail = result["thumbnail"]["src"].as_str();
            let urls: Vec<String> = [full, thumbnail].into_iter().flatten().map(str::to_string).collect();
            (!urls.is_empty()).then(|| Candidate {
                title: result["title"].as_str().unwrap_or("web image").to_string(),
                source: result["source"].as_str().or(result["meta_url"]["hostname"].as_str()).unwrap_or("the web").to_string(),
                urls,
            })
        })
        .collect())
}

/// Lead images of the best-matching Wikipedia articles.
async fn search_wikipedia(http_client: &reqwest::Client, query: &str) -> Result<Vec<Candidate>> {
    let url = reqwest::Url::parse_with_params(
        "https://en.wikipedia.org/w/api.php",
        &[
            ("action", "query"),
            ("format", "json"),
            ("generator", "search"),
            ("gsrsearch", query),
            ("gsrlimit", "3"),
            ("prop", "pageimages"),
            ("piprop", "thumbnail"),
            ("pithumbsize", THUMB_WIDTH),
        ],
    )?;
    let response = get_json(http_client, url, &[]).await.context("Wikipedia search failed")?;
    let mut pages: Vec<&Value> = response["query"]["pages"].as_object().map(|pages| pages.values().collect()).unwrap_or_default();
    pages.sort_by_key(|page| page["index"].as_u64().unwrap_or(u64::MAX));
    Ok(pages
        .into_iter()
        .filter_map(|page| {
            Some(Candidate {
                title: format!("{} (Wikipedia)", page["title"].as_str()?),
                source: "Wikipedia".into(),
                urls: vec![page["thumbnail"]["source"].as_str()?.to_string()],
            })
        })
        .collect())
}

/// Photos, cutaways and diagrams on Wikimedia Commons (bitmaps and drawings only, no PDFs).
async fn search_commons(http_client: &reqwest::Client, query: &str) -> Result<Vec<Candidate>> {
    let search = format!("{query} filetype:bitmap|drawing");
    let url = reqwest::Url::parse_with_params(
        "https://commons.wikimedia.org/w/api.php",
        &[
            ("action", "query"),
            ("format", "json"),
            ("generator", "search"),
            ("gsrsearch", search.as_str()),
            ("gsrnamespace", "6"),
            ("gsrlimit", "6"),
            ("prop", "imageinfo"),
            ("iiprop", "url"),
            ("iiurlwidth", THUMB_WIDTH),
        ],
    )?;
    let response = get_json(http_client, url, &[]).await.context("Wikimedia Commons search failed")?;
    let mut pages: Vec<&Value> = response["query"]["pages"].as_object().map(|pages| pages.values().collect()).unwrap_or_default();
    pages.sort_by_key(|page| page["index"].as_u64().unwrap_or(u64::MAX));
    Ok(pages
        .into_iter()
        .filter_map(|page| {
            let info = &page["imageinfo"][0];
            let title = page["title"].as_str()?.trim_start_matches("File:");
            Some(Candidate {
                title: title.rsplit_once('.').map_or(title, |(stem, _)| stem).to_string(),
                source: "Wikimedia Commons".into(),
                urls: vec![info["thumburl"].as_str().or(info["url"].as_str())?.to_string()],
            })
        })
        .collect())
}

/// Openly licensed images from Flickr and other collections.
async fn search_openverse(http_client: &reqwest::Client, query: &str) -> Result<Vec<Candidate>> {
    let url = reqwest::Url::parse_with_params(
        "https://api.openverse.org/v1/images/",
        &[("q", query), ("page_size", "6"), ("mature", "false")],
    )?;
    let response = get_json(http_client, url, &[]).await.context("Openverse search failed")?;
    Ok(response["results"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|result| {
            let urls: Vec<String> = [result["url"].as_str(), result["thumbnail"].as_str()].into_iter().flatten().map(str::to_string).collect();
            (!urls.is_empty()).then(|| Candidate {
                title: result["title"].as_str().unwrap_or("image").to_string(),
                source: result["provider"].as_str().unwrap_or("Openverse").to_string(),
                urls,
            })
        })
        .collect())
}

/// Interleaves the sources so no single one crowds out the rest: the web
/// first (most relevant), then Wikipedia's lead image, Commons, Openverse.
fn interleave(lists: Vec<Vec<Candidate>>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    for index in 0..longest {
        for list in &lists {
            if let Some(candidate) = list.get(index)
                && seen.insert(candidate.urls[0].clone())
            {
                merged.push(candidate.clone());
            }
        }
    }
    merged
}

async fn download(http_client: &reqwest::Client, candidate: Candidate) -> Option<Reference> {
    for url in &candidate.urls {
        let Ok(response) = http_client.get(url).header("user-agent", USER_AGENT).timeout(TIMEOUT).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response.bytes().await else { continue };
        if bytes.len() > MAX_IMAGE_BYTES || bytes.len() < 2_000 {
            continue; // too big for the API, or a tracking pixel / error stub
        }
        let Some(media_type) = media_type_of(&bytes) else { continue };
        return Some(Reference {
            title: candidate.title.clone(),
            source: candidate.source.clone(),
            media_type,
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }
    None
}

async fn find_references(http_client: &reqwest::Client, query: &str) -> Vec<Reference> {
    let brave_key = crate::config::Config::load().brave_search_api_key;
    let brave = async {
        if brave_key.is_empty() {
            return Vec::new();
        }
        search_brave(http_client, &brave_key, query).await.unwrap_or_else(|error| {
            log::warn!("{error:#}");
            Vec::new()
        })
    };
    let log_failure = |result: Result<Vec<Candidate>>| {
        result.unwrap_or_else(|error| {
            log::warn!("{error:#}");
            Vec::new()
        })
    };
    let (web, wikipedia, commons, openverse) = futures_util::join!(
        brave,
        search_wikipedia(http_client, query),
        search_commons(http_client, query),
        search_openverse(http_client, query),
    );
    let (wikipedia, commons, openverse) = (log_failure(wikipedia), log_failure(commons), log_failure(openverse));
    // The web search is the most relevant, so it gets two slots per round.
    let (web_first, web_rest): (Vec<_>, Vec<_>) = web.into_iter().enumerate().partition(|(index, _)| index % 2 == 0);
    let candidates = interleave(vec![
        web_first.into_iter().map(|(_, candidate)| candidate).collect(),
        web_rest.into_iter().map(|(_, candidate)| candidate).collect(),
        wikipedia.into_iter().take(1).collect(),
        commons,
        openverse,
    ]);
    // Download a few more than needed in parallel; some hosts refuse or time out.
    let downloads = candidates.into_iter().take(MAX_IMAGES + 4).map(|candidate| download(http_client, candidate));
    join_all(downloads).await.into_iter().flatten().take(MAX_IMAGES).collect()
}

fn media_type_of(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        _ => None,
    }
}

/// A real photo of `query` for a lesson's `photo()`, as a data URL.
pub async fn find_photo(http_client: &reqwest::Client, query: &str) -> Option<String> {
    let photo = find_references(http_client, query).await.into_iter().next()?;
    log::info!("photo for {query:?}: {} [{}]", photo.title, photo.source);
    Some(format!("data:{};base64,{}", photo.media_type, photo.base64))
}

/// Runs the tool and returns `tool_result` content blocks for Claude.
pub async fn run_tool(http_client: &reqwest::Client, input: &Value) -> Vec<Value> {
    let query = input["query"].as_str().unwrap_or_default().trim();
    if query.is_empty() {
        return vec![json!({"type": "text", "text": "no query given; draw it from memory."})];
    }
    let references = find_references(http_client, query).await;
    if references.is_empty() {
        log::warn!("no reference images for {query:?}");
        return vec![json!({"type": "text", "text": format!("no reference images found for '{query}'; draw it from memory.")})];
    }
    log::info!(
        "reference images for {query:?}: {}",
        references.iter().map(|r| format!("{} [{}]", r.title, r.source)).collect::<Vec<_>>().join(", ")
    );
    let mut blocks = vec![json!({
        "type": "text",
        "text": format!(
            "{} reference images from the web for '{query}'. ignore any that show a different thing. use photos for the outside (silhouette, proportions, colours, materials, surface details) and teardowns, cutaways and diagrams for the inside (which parts exist, their shapes, and exactly where each one sits). replicate the real thing as faithfully as you can: every visible part in its place, with its real shape, colour and material, down to the small details.",
            references.len()
        )
    })];
    for (index, reference) in references.into_iter().enumerate() {
        blocks.push(json!({"type": "text", "text": format!("image {}: {} — {}", index + 1, reference.title, reference.source)}));
        blocks.push(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": reference.media_type, "data": reference.base64}
        }));
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_image_types() {
        assert_eq!(media_type_of(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(media_type_of(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(media_type_of(b"GIF89a"), Some("image/gif"));
        assert_eq!(media_type_of(b"<html>"), None);
    }

    fn candidate(url: &str) -> Candidate {
        Candidate { title: url.into(), source: "test".into(), urls: vec![url.into()] }
    }

    #[test]
    fn interleaves_sources_and_drops_duplicates() {
        let merged = interleave(vec![
            vec![candidate("a1"), candidate("a2")],
            vec![candidate("b1"), candidate("a1")],
            vec![candidate("c1")],
        ]);
        let urls: Vec<&str> = merged.iter().map(|c| c.urls[0].as_str()).collect();
        assert_eq!(urls, ["a1", "b1", "c1", "a2"]);
    }
}

#[cfg(test)]
mod network_tests {
    /// Hits the real APIs: `cargo test --release live_lookup -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_lookup() {
        let client = reqwest::Client::new();
        for query in ["iphone teardown", "four stroke engine cutaway", "human heart anatomy diagram"] {
            let started = std::time::Instant::now();
            let references = super::find_references(&client, query).await;
            println!("{query:?}: {} images in {:.1}s", references.len(), started.elapsed().as_secs_f32());
            for reference in &references {
                println!("   {} [{}] {} KB {}", reference.title, reference.source, reference.base64.len() * 3 / 4 / 1024, reference.media_type);
            }
            assert!(!references.is_empty());
        }
    }
}
