//! User configuration persisted at ~/.config/clicky/config.toml (mode 0600,
//! because it holds API keys). Environment variables override file values so
//! keys can also come from the shell.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_API_BASE_URL: &str = "https://api.anthropic.com";
/// ElevenLabs "Rachel" premade voice — available on every account.
/// Low effort starts speaking in 2-3 s. Medium plans richer 3D models but can take a minute to say anything.
pub const DEFAULT_EFFORT: &str = "low";
pub const DEFAULT_ELEVENLABS_VOICE_ID: &str = "21m00Tcm4TlvDq8ikWAM";
/// Puter voice used when signed in to Puter and no ElevenLabs key is set.
pub const DEFAULT_PUTER_TTS_PROVIDER: &str = "openai";
pub const DEFAULT_PUTER_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_PUTER_TTS_VOICE: &str = "coral";
/// XDG shortcuts-spec trigger offered to the GlobalShortcuts portal. The user
/// can rebind it in System Settings → Shortcuts.
pub const DEFAULT_PUSH_TO_TALK_TRIGGER: &str = "CTRL+ALT+space";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub anthropic_api_key: String,
    /// Messages API host, without `/v1`. Anything other than the default is
    /// treated as an Anthropic-compatible proxy (see `claude.rs`).
    pub api_base_url: String,
    pub assemblyai_api_key: String,
    pub elevenlabs_api_key: String,
    pub elevenlabs_voice_id: String,
    /// Puter account token (from `clicky puter-login` or the panel). Puter's
    /// free monthly allowance on that account pays for the speech.
    pub puter_auth_token: String,
    /// Puter TTS provider: openai, aws-polly, elevenlabs, gemini, xai, speechify.
    pub puter_tts_provider: String,
    /// Provider model; empty uses the provider's default.
    pub puter_tts_model: String,
    /// Provider voice; empty uses the provider's default.
    pub puter_tts_voice: String,
    /// Optional: Brave Search API key, so reference images come from the whole web.
    pub brave_search_api_key: String,
    pub model: String,
    /// Reasoning effort sent as output_config.effort: low, medium, high or max.
    /// Lower starts speaking sooner; higher plans richer drawings.
    pub effort: String,
    pub show_cursor_always: bool,
    pub push_to_talk_trigger: String,
    /// The small sounds a lesson makes as it's drawn (paper landing, a part clicking in).
    pub drawing_sounds: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            anthropic_api_key: String::new(),
            api_base_url: DEFAULT_API_BASE_URL.into(),
            assemblyai_api_key: String::new(),
            elevenlabs_api_key: String::new(),
            elevenlabs_voice_id: DEFAULT_ELEVENLABS_VOICE_ID.into(),
            puter_auth_token: String::new(),
            puter_tts_provider: DEFAULT_PUTER_TTS_PROVIDER.into(),
            puter_tts_model: DEFAULT_PUTER_TTS_MODEL.into(),
            puter_tts_voice: DEFAULT_PUTER_TTS_VOICE.into(),
            brave_search_api_key: String::new(),
            model: DEFAULT_MODEL.into(),
            effort: DEFAULT_EFFORT.into(),
            show_cursor_always: true,
            push_to_talk_trigger: DEFAULT_PUSH_TO_TALK_TRIGGER.into(),
            drawing_sounds: true,
        }
    }
}

pub fn config_file_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("clicky")
        .join("config.toml")
}

impl Config {
    pub fn load() -> Config {
        let mut config = Config::load_file();
        config.apply_environment_overrides();
        config
    }

    /// The saved file only, without environment overrides (so saving it back
    /// never writes keys that came from the shell).
    pub fn load_file() -> Config {
        let path = config_file_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).unwrap_or_else(|error| {
                log::warn!("ignoring unreadable config {}: {error}", path.display());
                Config::default()
            }),
            Err(_) => Config::default(),
        }
    }

    fn apply_environment_overrides(&mut self) {
        let overrides = [
            ("ANTHROPIC_API_KEY", &mut self.anthropic_api_key),
            ("ANTHROPIC_BASE_URL", &mut self.api_base_url),
            ("ASSEMBLYAI_API_KEY", &mut self.assemblyai_api_key),
            ("ELEVENLABS_API_KEY", &mut self.elevenlabs_api_key),
            ("ELEVENLABS_VOICE_ID", &mut self.elevenlabs_voice_id),
            ("PUTER_AUTH_TOKEN", &mut self.puter_auth_token),
            ("BRAVE_SEARCH_API_KEY", &mut self.brave_search_api_key),
            ("CLICKY_EFFORT", &mut self.effort),
        ];
        for (variable_name, field) in overrides {
            if let Ok(value) = std::env::var(variable_name)
                && !value.trim().is_empty()
            {
                *field = value.trim().to_string();
            }
        }
    }

    pub fn save(&self) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let path = config_file_path();
        if let Some(parent_directory) = path.parent() {
            std::fs::create_dir_all(parent_directory)?;
        }
        let serialized = toml::to_string_pretty(self)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        file.write_all(serialized.as_bytes())?;
        Ok(())
    }

    /// Names of required keys that are still empty, for the panel to show.
    pub fn missing_keys(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.anthropic_api_key.is_empty() {
            missing.push("Anthropic");
        }
        if self.assemblyai_api_key.is_empty() {
            missing.push("AssemblyAI");
        }
        missing
    }
}
