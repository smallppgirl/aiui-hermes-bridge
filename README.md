# aiui-hermes-bridge (AIUI agent skeleton)

An AIUI (JSUI) agent for Rokid Glasses that talks to your self-hosted Hermes/Claude
bridge over SSE and renders the streamed answer on the glasses HUD.

## What this IS
- Real, working logic: **POST to your bridge → parse the SSE stream (`data: {...answer_stream...}`) → render the text live** on the glasses page.
- Uses the official AIUI project shape (`app.json` / `app.js` / `pages/index/index.ink` + `config.js`), scaffolded from `@yodaos-pkg/aiui-agent`.
- **Continuous conversation:** tap the temple (`GlobalHook`) or Enter once to begin, then it listens → asks the bridge → reads/render the answer → auto-listens for the next question, looping until you say `退出/停止/exit/stop` or press Backspace/Esc.
- **Reading starts with the first sentence:** in full screen the answer is read sentence by sentence while it is still streaming (each `synthesize()` request is every complete sentence not read yet), so the voice starts right after the first sentence. In the card, `speak()` reads the answer once it is complete.
- **Tap while reading (like the native assistant):** the voice keeps reading and the mic opens; the next question is printed as you speak and stops the reading once it is complete. Each such tap opens a fresh recognizer once the old one has released the mic. On the glasses a recognizer opened while the voice plays hears nothing, so the voice pauses for about a second while the mic opens and then goes on from the start of its sentence. A recognizer times out after ~15 s without speech; the screen then stops showing listening, and after a reading a new one is opened. No echo filtering is needed: the glasses cancel their own voice in the mic (measured with the echo probe agent on branch `echo-probe`: 0% of the read sentence recognized, 100% of the user's line spoken over it).
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

## Tests
- `npm test` (Node 20+) — unit tests of the page logic against fakes of the AIUI runtime
  (speech recognition, TTS, SSE fetch, scroll-view). No glasses, bridge or real AK needed.
- `npm run e2e` — end-to-end run on the **real AIUI runtime** (`@yodaos-pkg/ink`, same version
  as the glasses) in headless Chromium. A fake glasses host feeds speech results and plays TTS,
  a fake bridge answers; it covers full screen (`_blank`) and the card in the conversation flow
  (`_current`), Chinese and English. Screenshots of every step land in `e2e/out/`.
  First time: `npm install && npx playwright install chromium`.
- `npm run e2e -- --live` — the same cases against the **real bridge** in `config.js` with the
  real AK from `secrets.js`: real Hermes answers (a long one that needs scrolling, then a short
  one in the other language — 8 questions in total, so it costs tokens; never run by default).
  Run one case with e.g. `npm run e2e -- --live zh-CN-synth_blank`. Screenshots: `e2e/out-live/`.
  `E2E_BRIDGE_URL=<url>` points the live run at another bridge or a local stub.
- `test/` and `e2e/` are excluded from the `.aix` package via `.aixignore`.

Runtime facts found this way (they differ from a browser):
- `clearTimeout` / `clearInterval` **throw** on `undefined` / `null` — always guard them.
- `window.innerHeight` is `0`; the page sizes itself from `onTargetChanged(target)`
  (`_current` card = 448×150, `_blank` full screen = 480×352).
- `AudioPlayer.play()` is unavailable in the card (`_current`), so answers are read with
  `speechSynthesis.speak()` there (whose end event is not reported — listening resumes after
  the estimated speaking time, or when a new question is asked after a temple tap); full screen uses `synthesize()` + player.
- Set `debug: true` in `config.js` to show the last speech-recognition and voice events in the hint line
  (seconds since the tap, recognizer number: `3.2 #2 speechstart`, `voice 77` / `voice end` per read segment), and the
  timing of each answer when its voice starts, e.g. `text 4.2s · answer 8.5s · synth 8.6s · audio 9.4s · playing 9.4s`
  (seconds from the end of the question; also logged to the console as `[tts] timing`).

## Notes
- The bridges accept the Rokid/lingzhu-style body; extra fields are ignored. `take_photo` tool_calls
  are emitted by the bridge for vision intents, but an AIUI agent drives its own camera (see #3).
- Verify the AIUI runtime can `fetch()` external HTTPS + (ideally) stream SSE before relying on it.
