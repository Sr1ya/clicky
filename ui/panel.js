const { invoke } = window.__TAURI__.core;

const element = (id) => document.getElementById(id);

const STATE_DESCRIPTIONS = {
  idle: "ready",
  listening: "listening…",
  processing: "thinking…",
  responding: "talking",
};

async function refreshStatus() {
  try {
    const status = await invoke("get_status");
    element("state-line").textContent = STATE_DESCRIPTIONS[status.voice_state] ?? status.voice_state;
    element("hotkey-line").textContent = status.hotkey_status;
    element("cursor-line").textContent = status.cursor_tracking_status;

    const hasConversation = Boolean(status.last_transcript);
    element("conversation").classList.toggle("hidden", !hasConversation);
    element("last-transcript").textContent = status.last_transcript ?? "";
    element("last-response").textContent = status.last_response ?? "…";

    element("error-line").classList.toggle("hidden", !status.last_error);
    element("error-line").textContent = status.last_error ?? "";
  } catch (error) {
    element("state-line").textContent = `error: ${error}`;
  }
}

function placeholderFor(isSet) {
  return isSet ? "saved — leave empty to keep" : "not set";
}

async function loadConfig() {
  const config = await invoke("get_config");
  const modelSelect = element("model");
  // Gateway ids (for example "cc/claude-sonnet-5-5") aren't in the list; keep them selectable.
  if (config.model && ![...modelSelect.options].some((option) => option.value === config.model)) {
    modelSelect.add(new Option(`${config.model} (gateway)`, config.model));
  }
  modelSelect.value = config.model;
  element("voice-id").value = config.elevenlabs_voice_id;
  element("show-cursor").checked = config.show_cursor_always;
  element("anthropic-key").placeholder = placeholderFor(config.has_anthropic_api_key);
  element("assemblyai-key").placeholder = placeholderFor(config.has_assemblyai_api_key);
  element("elevenlabs-key").placeholder = placeholderFor(config.has_elevenlabs_api_key);
  element("fish-key").placeholder = placeholderFor(config.has_fish_api_key);
  element("fish-voice-id").value = config.fish_voice_id;
  element("puter-status").textContent = config.has_puter_auth_token
    ? `signed in · ${config.puter_voice}`
    : "not signed in";
  element("puter-button").textContent = config.has_puter_auth_token ? "Sign in again" : "Sign in with Puter";
  element("config-path").textContent = `stored in ${config.config_path}`;

  const missingLine = element("missing-line");
  missingLine.classList.toggle("hidden", config.missing_keys.length === 0);
  missingLine.textContent = `Add your ${config.missing_keys.join(" and ")} key${config.missing_keys.length > 1 ? "s" : ""} to start.`;
}

async function saveConfig() {
  const saveStatus = element("save-status");
  try {
    await invoke("save_config", {
      update: {
        anthropic_api_key: element("anthropic-key").value,
        assemblyai_api_key: element("assemblyai-key").value,
        elevenlabs_api_key: element("elevenlabs-key").value,
        elevenlabs_voice_id: element("voice-id").value,
        fish_api_key: element("fish-key").value,
        fish_voice_id: element("fish-voice-id").value,
        model: element("model").value,
        show_cursor_always: element("show-cursor").checked,
      },
    });
    for (const id of ["anthropic-key", "assemblyai-key", "elevenlabs-key", "fish-key"]) element(id).value = "";
    saveStatus.textContent = "saved";
    await loadConfig();
  } catch (error) {
    saveStatus.textContent = `couldn't save: ${error}`;
  }
  setTimeout(() => (saveStatus.textContent = ""), 2500);
}

async function signInWithPuter() {
  const status = element("puter-status");
  status.textContent = "finish signing in in your browser…";
  try {
    await invoke("puter_sign_in");
    await loadConfig();
  } catch (error) {
    status.textContent = `sign-in failed: ${error}`;
  }
}

// The panel button works like the hotkey: hold to talk, release to send.
const talkButton = element("talk-button");
let isHoldingTalkButton = false;
function setTalkButtonHeld(isHeld) {
  if (isHeld === isHoldingTalkButton) return;
  isHoldingTalkButton = isHeld;
  talkButton.classList.toggle("active", isHeld);
  talkButton.textContent = isHeld ? "Release to send" : "Hold to talk";
  invoke("push_to_talk", { pressed: isHeld });
}
talkButton.addEventListener("pointerdown", (event) => {
  talkButton.setPointerCapture(event.pointerId);
  setTalkButtonHeld(true);
});
talkButton.addEventListener("pointerup", () => setTalkButtonHeld(false));
talkButton.addEventListener("pointercancel", () => setTalkButtonHeld(false));

element("save-button").addEventListener("click", saveConfig);
element("puter-button").addEventListener("click", signInWithPuter);
element("quit-button").addEventListener("click", () => invoke("quit_app"));

loadConfig();
refreshStatus();
setInterval(refreshStatus, 400);
