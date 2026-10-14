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
};

// Minimal Rokid/lingzhu-style request. The bridge accepts extra fields.
export function buildPayload(text, extra = {}) {
  return {
    message_id: "aiui-" + Date.now(),
    agent_id: BRIDGE_CONFIG.agentId,
    user_id: BRIDGE_CONFIG.userId,
    message: [{ role: "user", type: "text", text }],
    metadata: { context: { language: "zh-CN" } },
    ...extra,
  };
}
