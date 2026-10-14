# aiui-hermes-bridge (AIUI agent skeleton)

An AIUI (JSUI) agent for Rokid Glasses that talks to your self-hosted Hermes/Claude
bridge over SSE and renders the streamed answer on the glasses HUD.

## What this IS
- Real, working logic: **POST to your bridge → parse the SSE stream (`data: {...answer_stream...}`) → render the text live** on the glasses page.
- Uses the official AIUI project shape (`app.json` / `app.js` / `pages/index/index.ink` + `config.js`), scaffolded from `@yodaos-pkg/aiui-agent`.

## What you MUST fill in / verify (unknowns, marked TODO in index.ink)
1. **Bridge URL + AK** — edit `config.js`: set `url` (`https://rokid-hermes.snowbig.com/api/sse` for Hermes,
   `https://rokid-claude.snowbig.com/rokid/sse` for Claude), `agentId`, and `ak` (= the bridge's
   `ROKID_AK` (Hermes xdc) or `ROKID_AGENT_AK` (Claude)), `userId`.
2. **Voice capture** — `getVoiceInput()` now uses the AIUI `SpeechRecognition` API (`start({lang})` + `onresult → transcript`).
   On a semantic wake-up ("Hi Rokid, open the xxx agent") the spoken query may instead arrive via `onLoad(query)`;
   confirm which model the host uses, and adjust (AIUI CODING with the aiui-dev skill can wire it). See `apis/ai.md`
   for `SpeechRecognition` / `SpeechRecognitionSession` / `LanguageModel`.
3. **Camera (vision)** — `askWithPhoto()` is a placeholder; to send a photo, capture with the AIUI camera API
   (see `apis/media.md` / `apis/wx.md` camera) and add a second `{role:'user', type:'image', image_url}` message
   to the payload (both bridges accept `image` messages; the HTTP body can also carry the same `LanguageModel`
   `image_url` part shape). The AIUI runtime supports `fetch`/`Response`/streams (see `apis/web.md`).
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
