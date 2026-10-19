# Status and known issues

As of 2026-10-18. `main` and the glasses are at `bd72f17`. The work below is on stacked
branches (each starts from the previous one); `fresh-mic-on-tap` contains all of it except
the test agent. 74 unit tests and the fake e2e pass on it; the live e2e
(`npm run e2e -- --live`) last passed on `tts-timing-and-sentences`.

```
main (bd72f17)
 └─ answer-trim-and-limit
     └─ tap-keeps-reading
         └─ tts-timing-and-sentences
             └─ asr-during-reading
                 ├─ fresh-mic-on-tap
                 │   └─ asr-diagnostics   (debug log for item 8, debug on)
                 │       └─ mic-handover
                 │           └─ pause-to-listen  ← deploy this one (debug on)
                 └─ echo-probe         (test agent only, tools/echo-probe)
```

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
   an exit word is ignored unless you tap first.
4. **Card mode: reading scroll is paced by an estimate**, not by the real speech position.
5. **Card mode: reading starts after the whole answer**, and `speak()` cannot be stopped,
   so a question asked mid-reading may overlap answer 1's voice with answer 2's.
6. **Very long answers** — over 20000 characters the beginning is dropped. Not yet known
   whether a very long answer stays smooth on the glasses.

## To check on the glasses

7. **Timing** — with `debug: true`, ask for a long answer and note the timing line.
   A big gap between `synth` and `audio` is the glasses' speech engine. Are the gaps
   between sentence segments audible?
8. **Tap while reading — still deaf at times (2026-10-20, `fresh-mic-on-tap`).** After a
   tap during a long answer the screen says listening, but for 15–20 s (and sometimes until
   the reading ends, or after it) nothing is heard; a second tap fixes it. The AIUI docs say
   `end` means the recognition session is over, while the agent assumes the glasses report
   `end` early and keep listening (seen once on the device). Suspect: the recognizer is
   really ended, perhaps when the next sentence segment starts playing. Branch
   `asr-diagnostics` logs it: with `debug: true` the hint shows the last 4 events, with
   seconds since the tap, the recognizer number (`#2 start`, `#2 audiostart`,
   `#2 speechstart`, `#2 interim …`, `#2 end`) and the voice segments (`voice 77` = a
   segment of 77 characters starts, `voice end`). Note what it shows when it is deaf.

   **Found (photo, 2026-10-20):** `0.0 #10 start | 0.4 #9 error network | 0.4 #9 audioend |
   0.4 #9 end`, then nothing from `#10`. The aborted recognizer releases the mic only when it
   ends, 0.4 s after the tap; the new one was started before that and heard nothing (the
   same as "请讲… never processes" while the echo probe held the mic). **Fix on
   `mic-handover`:** the new recognizer starts when the old one has ended (at most 1.5 s).
   To check: does `#n start` still work 0.4 s after the tap (`start failed` would mean the
   glasses want it inside the tap itself)? Then `#n audiostart` / `interim …` when you speak.

   **Second photo (2026-10-20, `mic-handover`):** `0.4 #15 start | 16.0 #15 error network |
   16.0 #15 audioend | 16.0 #15 end`. The handover worked, but `#15` heard nothing and
   timed out after ~16 s without speech. In the echo probe (test D) the mic was opened
   *before* the voice and heard the user 100%; here it is opened *while* the voice plays.
   Taps that worked probably fell between two segments. **Fix on `pause-to-listen`:**
   - a tap pauses the voice, opens the new mic, and ~0.3 s later the voice goes on from
     the start of the sentence it was in (debug: `voice pause`, `#n start`, `voice 120`);
   - an `end` more than 5 s after the start is a timeout: the screen leaves 聆听中
     (ready, or speaking while reading), so it no longer claims to listen;
   - after a reading, if the recognizer timed out, a new one is opened without a tap; if
     the glasses refuse (`start failed`), the screen shows ready and a tap is needed.
   To check: tap during several long answers in a row; each time it should hear you.
9. **ASR session lifecycle** — after a tap, stay silent 20–30 s, then speak: still heard?
10. **Card ↔ full screen** — ask in the card, switch to full screen, ask again: right layout,
    and does `synthesize()` (and sentence-by-sentence reading) take over?
11. **Without a tap after reading** — speak right after an answer ends: heard? After a long
    answer the old recognizer may have stopped; a new one can only open on a tap.
12. **Long answer** — ask for a very long answer: does it stream and scroll smoothly?

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
