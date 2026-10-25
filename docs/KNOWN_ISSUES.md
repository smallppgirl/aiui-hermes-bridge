# Status and known issues

As of 2026-10-25. This branch, `talk-to-interrupt`, replaces the tap-while-reading
design on `main` with the native assistant's: speaking interrupts, a tap does not.
`voice-gives-way` keeps the tap design (pause, resume, give way) so the two can be
compared on the glasses; only one of them should be merged. The branch names under
"Done" say where each change was made. `echo-probe`, the test agent
(`tools/echo-probe`), is kept apart on purpose. 95 unit tests and the fake e2e pass here,
and the live e2e passed on 2026-10-26. The e2e host now acts like the glasses in full
screen: speech at about the real pace, a mic that stops after 16 s without speech, and a
mic opened while the voice plays is deaf. Question 2 is asked 22 s into a long reading, and
the run checks the mic was renewed, nothing was lost, and an exit word is still heard
after the reading. `E2E_DEBUG=1` shows the debug line in the screenshots.
`debug` is off: set `debug: true` in `config.js` for the event log on the glasses.

## Done

**On `main` (on the glasses)**
- Dialog-style HUD like the native assistant: question streamed on a new line,
  `正在思考…` / `Thinking…`, then the streamed answer; the screen is not cleared.
- Auto-scroll while streaming and slow scroll while reading; temple swipe scrolls.
- TTS voice follows the answer's language, not the Hi Rokid app language.
- Listening reliable after reading; card mode TTS and layout; AK kept in gitignored
  `secrets.js`; unit tests and e2e on the real AIUI runtime.

**`answer-trim-and-limit`**
- A temple swipe during or after reading is no longer pulled back to the end.
- A tap cancels the 0.7 s echo guard after reading (the guard is gone altogether in
  `fresh-mic-on-tap`).
- Leading blank lines / spaces of Hermes answers are trimmed (no indent, not read aloud).
- Answer cap raised from 4000 to 20000 characters.
- Live-bridge e2e set (`npm run e2e -- --live`, never run by default).

**`tap-keeps-reading`**
- Temple tap while reading keeps the voice going (like the native assistant) and
  opens the mic; the next question streams in and ends the reading once complete.

**`tts-timing-and-sentences`**
- Timing log: with `debug: true` the hint shows `text · answer · synth · audio · playing`
  in seconds from the question (also `[tts] timing` in the console).
- Full screen reads sentence by sentence while the answer streams: the voice starts
  after the first sentence instead of after the whole answer (live e2e: ~0.1 s after
  the first text). The bridge streams in small pieces of a few characters.
- A new question while an answer still streams stops that request and keeps its text.

**`asr-during-reading` → `fresh-mic-on-tap`** (the probe is a side branch, `echo-probe`)
- Measured on the glasses with the echo probe agent (branch `echo-probe`, 2026-10-18): with the mic open while
  the glasses read a sentence, 0% of it was recognized; a line spoken over the voice was
  recognized 100%. The hardware cancels its own voice, so the agent does no echo
  filtering and has no echo guard after reading.
- A tap during reading opens a fresh recognizer (the one from the question may have
  stopped hearing during a long answer without reporting it).
- With `debug: true` the hint shows the last 3 recognizer events.

**`talk-to-interrupt`** (to compare with `voice-gives-way`)
- Speaking during a reading stops it at the first interim words for good (no pause and
  resume); the question line opens at the bottom and the view jumps there, even after a
  swipe back. Speaking while thinking cancels the pending answer and asks the new
  question; an exit word then also stops the request.
- A tap during thinking or reading changes nothing; the swipe only scrolls.
- Segments are capped at ~8 s of estimated speech. Before each segment, a mic that would
  pass ~13 s (or has timed out) is replaced; the voice waits until the new one captures
  (0.3 s after `audiostart`, at most 1 s without it; the old one gets 1.5 s to let go).
  After a reading, a mic older than ~3 s is replaced too, so the next question gets a
  full ~16 s.
- Removed: the tap-while-reading path (`_barge`, pause/resume of the voice) and the rule
  that speech during reading is ignored without a tap.
- A mic that is hearing the wearer (`speechstart`, or interim words in the last 1.5 s) is
  not renewed: a renewal then would cut the question off.
- Found by the multi-round e2e (`npm run e2e:rounds`) and fixed, 2026-10-26:
  - A request cancelled by a newer question was retried 0.5 s later (the runtime's abort
    mid-stream is not always an `AbortError`), so Hermes got the cancelled question again.
    Also on `main` and `voice-gives-way`.
  - A piece of the cancelled answer streamed in while the new question was being shown
    started a new reading of the cancelled answer, and the new answer was then not read.
  - The debug line could wrap onto a second line that is cut off; it now keeps to one line.
- Cost of the renewal: while it runs (about every 10 s of reading, since one sentence of a
  Hermes answer is often ~10 s), the mic is deaf for ~0.5–0.9 s and the voice is silent.
  Words started exactly then lose their first syllable or two; the rest is heard.
- After a reading the mic times out after ~16 s of silence (the screen goes to 就绪); then
  a tap is needed.

**`take-photo`**
- When the bridge answers a question with `take_photo` (a question about the scene, like
  这是什么), the agent shows 正在拍照…, takes a photo (`telephoto`, `normal` quality, no
  system preview) and asks again with it. Before, this showed 未收到回复（桥返回空）.
- Photos go to the bridge as `{type: "image", image_url: "data:…"}`, the shape it reads
  (checked on the real bridge: 这是什么 + a screenshot was described correctly in 3.6 s).
- In the card the camera is unavailable: the answer line says to go full screen. A camera
  error is shown as 拍照失败：…, without a retry.
- Bridge side (`smallppgirl/rokid-hermes-bridge` PR #2, merged): questions like 看看美股 /
  分析一下美股 no longer trigger `take_photo`. **Not live until the bridge server is
  pulled and restarted** (2026-10-24 it still answered 美股看看美股 with `take_photo`).
- e2e: Chromium now uses a fake audio output; with the Mac's real output stalled, Web Audio
  stopped and the runtime never got mic audio.

## Not fixed

1. **English words split mid-word, lines can start with "。"** — seen in the simulator
   only. It is the runtime's line breaker; CSS can't change it. If English lines look
   fine on the glasses, close this.

## Optional

2. **Markdown shown and spoken raw** — not seen on the glasses so far. If Hermes ever
   sends `**bold**`, `#`, `- ` or code fences, strip them for display and TTS
   (formatting only, not words).

## Trade-offs from the runtime (could be improved)

3. **Card mode: end of reading is guessed.** In the card (`_current`) `AudioPlayer.play()`
   is unavailable, so answers are read with `speechSynthesis.speak()`, which never
   reports its end. Listening resumes after an estimate of the speech length; until then
   a question or exit word spoken over it is still taken, but the voice goes on.
4. **Card mode: reading scroll is paced by an estimate**, not by the real speech position.
5. **Card mode: reading starts after the whole answer**, and `speak()` cannot be stopped,
   so a question asked mid-reading may overlap answer 1's voice with answer 2's.
6. **Very long answers** — over 20000 characters the beginning is dropped. Not yet known
   whether a very long answer stays smooth on the glasses.

## To check on the glasses

7. **Timing** — with `debug: true`, ask for a long answer and note the timing line.
   A big gap between `synth` and `audio` is the glasses' speech engine. Are the gaps
   between sentence segments audible?
8. **Talk over a long answer (`talk-to-interrupt`).** With `debug: true`, ask for a long
   answer and speak over it several times, early, in the middle (after 20–30 s) and near
   the end. Expected: the voice stops at your first words, the view jumps to the bottom
   and shows them, and the question is asked as soon as you stop. During the reading the
   hint should show `#n start`, `#n audiostart` every ~10–15 s between segments (the mic
   being renewed). Things to note:
   - Deaf after a renewal (`#n start` with no `audiostart`, or no `interim` when you speak):
     the renewed mic may need a tap on the glasses (`start failed` in the hint).
   - Audible gaps between sentences when the mic is renewed (up to ~1 s).
   - Nearby talk or noise stopping the reading (expected; it is how the native assistant
     works).
   The earlier tap design and its history are in this file on `voice-gives-way` (item 8).
9. **ASR session lifecycle** — after a tap, stay silent 20–30 s, then speak: still heard?
10. **Card ↔ full screen** — ask in the card, switch to full screen, ask again: right layout,
    and does `synthesize()` (and sentence-by-sentence reading) take over?
11. **Without a tap after reading** — speak right after an answer ends, and again ~10 s
    later: heard both times? The mic is renewed after the reading without a tap.
12. **Long answer** — ask for a very long answer: does it stream and scroll smoothly?
13. **Photo** — in full screen ask 这是什么 while looking at something: 正在拍照…, then an
    answer about it? Note the time. On 2026-10-25 the photo reached Hermes but Hermes said
    画面全黑 (all black): the photo was taken the moment the camera opened. Branch
    `photo-exposure` waits `photoSettleMs` (1000) first; with `debug: true` the hint shows
    `photo N KB` (black ≈ a few dozen KB, a real photo hundreds). The bridge logs the size
    too and keeps the latest photo in `~/rokid-hermes-xdc/logs/last_photo.jpg` on macvm
    (bridge PR #5). If 1 s is not enough, raise `photoSettleMs`.

## Ideas

**Card mode (3–5)**
- Check whether `speechSynthesis.speak()` returns a Promise on the device (the host
  capability `speak` is async). If it resolves when playback ends, await it and drop the
  estimate; then sentences could also be chained in the card.
- Make the speech-rate estimate tunable in `config.js` (`ttsRate: { zh: 240, en: 380 }`,
  ms per character / word), calibrated once by timing a long answer on the glasses.
- Scroll by sentence instead of linearly, so drift looks like a short pause.

**Long answers (6)** — decision: show Hermes' answer as it comes (no "keep it short" hint).
- If a long answer stutters, render it as paragraphs (one node per paragraph in
  `ink:for`), so a re-render only touches the last paragraph.

**Gaps between segments (7)** — if audible, synthesize the next segment while the current
one plays (prefetch), if the runtime buffers a task before its player is created.
