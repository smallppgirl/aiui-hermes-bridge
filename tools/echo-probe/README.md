# Echo probe

A tiny AIUI agent that measures whether the glasses' mic hears the glasses' own voice
while it reads aloud. That decides whether the Hermes agent needs its own echo
filtering when the mic stays open during reading.

## Run on the glasses

1. Pack and deploy this folder as its own agent (`aix pack` in `tools/echo-probe/`,
   or upload it in the AIUI web IDE). It is not part of the Hermes agent package.
2. Open it in full screen, in a quiet room.
3. Tap the temple four times, one test per tap; wait for each line to appear.
   - **A** `SpeechRecognition`, the API the Hermes agent uses. Stay silent.
   - **B** `SpeechRecognitionSession` + `getUserMedia({ audio: true })`. Stay silent.
   - **C** the same with `echoCancellation: true`. Stay silent.
   - **D** like A, and while it reads, say the line shown at the bottom.
4. Photograph the screen.

## Reading the result

- `own voice heard N%`: share of the read sentence the recognizer picked up.
  Around 0% means the mic does not hear the speaker (echo cancelled, or the mic is
  muted while audio plays). Well above 0% means the agent must deal with the echo.
- `[EC=…]` in B and C: the echo cancellation the device actually applied.
- D `your line heard N%`: whether your voice still gets through while it reads.
  If A is ~0% and D is ~0% too, the mic is muted during playback (no barge-in possible).
  If A is ~0% and D is high, the hardware cancels the echo and no app filtering is needed.

Check the probe itself in the simulator: `node e2e/echo-probe.mjs` (screenshots in
`e2e/out-probe/`).
