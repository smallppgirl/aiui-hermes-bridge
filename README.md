# aiui-hermes-bridge (AIUI agent skeleton)

An AIUI (JSUI) agent for Rokid Glasses that talks to your self-hosted Hermes/Claude
bridge over SSE and renders the streamed answer on the glasses HUD.

## What this IS
- Real, working logic: **POST to your bridge → parse the SSE stream (`data: {...answer_stream...}`) → render the text live** on the glasses page.
- Uses the official AIUI project shape (`app.json` / `app.js` / `pages/index/index.ink` + `config.js`), scaffolded from `@yodaos-pkg/aiui-agent`.
- **Continuous conversation:** tap the temple (`GlobalHook`) or Enter once to begin, then it listens → asks the bridge → reads/render the answer → auto-listens for the next question, looping until you say `退出/停止/exit/stop` or press Backspace/Esc.
- **Dialog-style HUD (like the native Rokid assistant):** each new question is printed live on a new line below the previous answer (interim ASR), followed by `正在思考…` / `Thinking…`, which is replaced by the streamed answer. The screen is never cleared between turns (last 20 lines are kept).
- **Reading scroll:** while an answer streams, the view follows it but keeps the question at the top; while it is read aloud, the text scrolls slowly with the estimated speech progress. ArrowUp/ArrowDown scroll manually.
- **TTS voice follows the answer language:** a Chinese answer is read with the `zh` voice, an English answer with the `en` voice (`ttsVoices` in `config.js`), whatever the Hi Rokid UI language is. AIUI ignores `utterance.lang`; only the voice id selects the language. AIUI `SpeechRecognition.start()` needs a user gesture, so the first utterance needs a tap OR include the question in the wake phrase ("Hi Rokid, open hermes, <question>").

## What you MUST fill in / verify (unknowns, marked TODO in index.ink)
1. **Bridge URL + AK** — `cp secrets.example.js secrets.js` and put the real AK in `secrets.js` (gitignored, never committed); then edit `config.js`: set `url` (`https://rokid-hermes.snowbig.com/api/sse` for Hermes,
   `https://rokid-claude.snowbig.com/rokid/sse` for Claude), `agentId`, `userId`. The AK = the bridge's
   `ROKID_AK` (Hermes xdc) or `ROKID_AGENT_AK` (Claude).
2. **Voice capture** — `getVoiceInput()` uses the AIUI `SpeechRecognition` API (`start({lang: BRIDGE_CONFIG.lang})` + `onresult → transcript`). Set `lang` in `config.js`: `'zh-CN'` (default) or `'en-US'` (English — supported, TTS has several English voices). On a semantic wake-up the spoken query may instead arrive via `onLoad(query)` (handled); confirm which model the host uses.
3. **Camera (vision)** — `askWithPhoto()` captures via `navigator.mediaDevices.getUserMedia({video})` → `ImageCapture.takePhoto({mode:'default'})` → base64 data URL, and sends it as a second `{role:'user', type:'image_url', image_url:{url}}` message. **NOTE:** the bridge's exact image transport field/shape may differ (Hermes B converts to base64, Claude downloads from an http URL) — confirm/adapt before relying on vision.
4. **Streaming support** — the code uses `resp.body.getReader()` if available, else buffers the full
   body (some mini-app runtimes don't stream). Verify whether the AIUI runtime streams; if not it
   will show the full answer at once (no live progress) — still works.

## How to run
1. On a machine with Node: `cd ~/aiui-hermes-bridge && npm install && npm start` (dev preview).
2. Import the folder into **Craft** (open.rokid.com → Craft → Import project), open **AIUI Code**,
   fill the TODOs, test in **Interactive Inview** simulator.
3. Upload to your Rokid Glasses, set the required permissions (network, mic, camera, display),
   and test on-device.

## Notes
- The bridges accept the Rokid/lingzhu-style body; extra fields are ignored. `take_photo` tool_calls
  are emitted by the bridge for vision intents, but an AIUI agent drives its own camera (see #3).
- Verify the AIUI runtime can `fetch()` external HTTPS + (ideally) stream SSE before relying on it.
