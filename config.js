// AIUI agent config — point these at YOUR bridge
export const BRIDGE_CONFIG = {
  // Hermes (B) bridge:
  url: "https://rokid-hermes.snowbig.com/api/sse",
  agentId: "hermes-agent",
  // For Claude Code bridge instead use:
  // url: "https://rokid-claude.snowbig.com/rokid/sse",
  // agentId: "claude-agent",
  // AK = the ROKID_AK / ROKID_AGENT_AK from the bridge .env
  ak: "REPLACE_WITH_BRIDGE_AK",
  userId: "aiui-rokit",
  // voice recognition language: 'zh-CN' (default) or 'en-US' (English)
  lang: "zh-CN",
};

// Minimal Rokid/lingzhu-style request. The bridge accepts extra fields.
export function buildPayload(text, imageDataUrl) {
  const message = [{ role: "user", type: "text", text }]
  if (imageDataUrl) {
    // AIUI captures photos as a base64 data URL. Bridge image transport may
    // expect its own field/shape (see README) — adjust for your bridge.
    message.push({ role: "user", type: "image_url", image_url: { url: imageDataUrl } })
  }
  return {
    message_id: "aiui-" + Date.now(),
    agent_id: BRIDGE_CONFIG.agentId,
    user_id: BRIDGE_CONFIG.userId,
    message,
    metadata: { context: { language: BRIDGE_CONFIG.lang } },
  };
}
