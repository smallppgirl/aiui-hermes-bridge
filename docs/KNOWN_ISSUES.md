# Known issues

Open items as of 2026-10-18. `main` / the glasses are at `bd72f17`; 63 unit tests, the fake e2e
and the live e2e (`npm run e2e -- --live`) all pass.

## Not fixed yet

1. **English words split mid-word, lines can start with "。"** — seen in the simulator
   (`aix preview` / e2e screenshots). It is the runtime's line breaker; CSS can't change it.
   Check on the glasses: if English lines look fine there, close this.
2. ~~Leading blank lines / spaces in answers~~ — fixed on branch `answer-trim-and-limit`:
   the start of the answer is trimmed while streaming (inner blank lines are kept).

## Optional

3. **Markdown shown and spoken raw** — not seen on the glasses so far. If Hermes ever
   sends `**bold**`, `#`, `- ` or code fences, they would appear as-is on screen and be
   read aloud. Fix then: strip Markdown for display and TTS (formatting only, not words).

## Trade-offs from the runtime (not bugs, could be improved)

4. **Card mode: end of reading is guessed.** In the card (`_current`) target
   `AudioPlayer.play()` is unavailable, so the answer is read with `speechSynthesis.speak()`,
   which never reports its end. Listening resumes after an estimate of the speech length;
   until then a spoken exit word is ignored (a temple tap still works).
5. **speak() reading scroll is paced by an estimate**, not by the real speech position,
   so the scroll can run ahead of or behind the voice (card mode, or when
   `synthesize()` is missing).
6. **Very long answers lose their beginning** — `MAX_ANSWER` raised from 4000 to 20000 on
   branch `answer-trim-and-limit`. To check on the glasses: does a very long answer still
   stream and scroll smoothly? If not, split it into paragraphs (see below).

## Only the real glasses can confirm

7. **ASR session lifecycle** — after a tap, stay silent 20–30 s, then speak: is it
   still heard? (The recognizer may end early on the device.)
8. **Card ↔ full screen** — ask in the card, double-tap to full screen, ask again:
   is `onTargetChanged` fired, is the layout/height right, does `synthesize()` take over?
9. **Echo guard (0.7 s after reading ends)** — start speaking right after an answer
   ends, without a tap: does it hear its own voice, or drop your first words?

10a. **Tap while reading keeps the voice going** (branch `tap-keeps-reading`) — the mic
   is open while the speaker plays. Check: does it pick up its own voice? Text that
   matches the answer being read is ignored, but a garbled echo could still get through.
   In card mode `speak()` cannot be stopped, so a question asked mid-reading may overlap
   answer 1's voice with answer 2's.

## Reading starts late

11. ~~The voice starts only after the whole answer has arrived~~ — on branch
    `tts-timing-and-sentences`, full screen reads sentence by sentence while the answer
    streams (live e2e: voice ~0.1 s after the first text instead of after the whole answer).
    Card mode still reads with `speak()` once the answer is complete.
    Check on the glasses with `debug: true`: the hint shows e.g.
    `text 1.4s · synth 1.5s · audio 1.6s · playing 1.6s`. A big gap between `synth` and
    `audio` is the glasses' speech engine; gaps between segments may be audible.

## Not on the glasses yet

10. On branch `answer-trim-and-limit`, not on `main` yet: a temple swipe during/after reading is no longer pulled back to the
    end; a tap cancels the 0.7 s echo guard.

## Improvement ideas for 4–6

**4 — card mode end of reading**
- Check whether `speechSynthesis.speak()` returns a Promise on the device (the host
  capability `speak` is async). If it resolves when playback ends, await it and drop
  the estimate.
- Keep the mic open while reading and drop results that match the answer text (fuzzy
  match against the spoken sentence = echo). Then an exit word or a new question by
  voice works mid-reading, in both targets, and the 0.7 s guard is no longer needed.
- Make the estimate tunable: `ttsRate: { zh: 240, en: 380 }` (ms per character / word)
  in `config.js`, calibrated once by timing a long answer on the glasses.

**5 — scroll paced by an estimate**
- Same calibration as above (the biggest win for little code).
- Scroll by sentence, not linearly: split the answer at `。！？.!?`, give each sentence
  its share of the estimate, and scroll to the start of that sentence. Drift then looks
  like a short pause instead of text sliding past the voice.
- Keep the line being read in the upper third of the screen, so being a bit early or
  late still shows the current text.

**6 — 4000-character cap**
- Decision: show Hermes' answer as it comes; no "keep it short" hint, no config flag.
- First raise `MAX_ANSWER` (e.g. 20000) and stream a long answer on the glasses: the 4000
  limit is a guess, not a measured device limit. If it stays smooth, that is the fix.
- If it stutters, render long answers as paragraphs (one node per paragraph in
  `ink:for`), so a re-render only touches the last paragraph.
