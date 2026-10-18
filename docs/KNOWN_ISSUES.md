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
                 ├─ fresh-mic-on-tap   ← deploy this one
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
8. **Tap while reading** — with `fresh-mic-on-tap`: tap during a long answer and ask.
   If it still doesn't hear you, note the debug hint (`tap rec=…`, `start`, `interim …`).
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
