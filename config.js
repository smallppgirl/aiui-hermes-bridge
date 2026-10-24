// AIUI agent config — point these at YOUR bridge
import { SECRETS } from './secrets.js'

export const BRIDGE_CONFIG = {
  // Hermes (B) bridge:
  url: "https://rokid-hermes.snowbig.com/api/sse",
  agentId: "hermes-agent",
  // For Claude Code bridge instead use:
  // url: "https://rokid-claude.snowbig.com/rokid/sse",
  // agentId: "claude-agent",
  // AK lives in secrets.js (gitignored) — copy secrets.example.js to create it
  ak: SECRETS.ak,
  userId: "aiui-rokit",
  // voice recognition language: 'auto' (follow the system / Hi Rokid language),
  // or force e.g. 'zh-CN' / 'en-US'
  lang: "auto",
  // on-screen "Talk" button. false = hidden (use the temple tap / Enter instead),
  // true = show it as a fallback if the temple tap isn't delivered on your device.
  showTalkButton: false,
  // read the answer aloud with TTS after rendering (true) or text-only (false).
  // NOTE: with continuous listening this may capture the glasses' own TTS (echo);
  // if that happens, set this to false (text-only, mic stays clean).
  readAloud: true,
  // TTS voices by language. The voice is picked from the language of each answer
  // (Chinese answer -> zh voice, English answer -> en voice), not the system language.
  // zh = Chinese female (female-yujie / female-tianmei / lovely_girl / male variants
  // male-qn-jingying, male-qn-qingse); en = English (English_radiant_girl /
  // English_expressive_narrator / English_Trustworthy_Man).
  ttsVoices: { zh: 'female-yujie', en: 'English_radiant_girl' },
  // true = show speech-recognition events (start / interim / final / error / end)
  // in the hint line, to diagnose listening problems on the glasses.
  debug: false,
};

// Minimal Rokid/lingzhu-style request. The bridge accepts extra fields.
// A photo is sent as a base64 data URL (taken when the bridge answers with take_photo).
export function buildPayload(text, imageDataUrl) {
  return {
    message_id: "aiui-" + Date.now(),
    agent_id: BRIDGE_CONFIG.agentId,
    user_id: BRIDGE_CONFIG.userId,
    message: [
      { role: "user", type: "text", text },
      // the bridge reads a photo as { type: "image", image_url: "<http URL or data URL>" }
      ...(imageDataUrl ? [{ role: "user", type: "image", image_url: imageDataUrl }] : []),
    ],
    metadata: { context: { language: BRIDGE_CONFIG.lang } },
  };
}
