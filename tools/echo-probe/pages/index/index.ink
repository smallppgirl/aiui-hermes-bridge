<script def>
{
  "navigationBarTitleText": "Echo Probe"
}
</script>

<script setup>
// Does the glasses mic hear the glasses' own voice? Each temple tap runs one test:
// the mic is opened, a known sentence is read aloud, and the recognized text is
// compared with that sentence. Stay silent, except in test D.
//   A  SpeechRecognition (what the Hermes agent uses)
//   B  SpeechRecognitionSession + getUserMedia({ audio: true })
//   C  SpeechRecognitionSession + getUserMedia({ audio: { echoCancellation: true } })
//   D  like A, and you say the line shown on screen while it reads
const SENTENCE = '这是一段回声测试语音，请保持安静，不要说话。眼镜正在检查麦克风能不能听到自己播放的声音。测试马上就会结束。'
const SAY = '今天天气很好，我想去公园散步。'
const HAN = /[㐀-鿿]/g
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// share of the target's neighbouring Han character pairs found in the heard text, in %
function heardShare(target, heard) {
  const pairs = (s) => {
    const u = s.match(HAN) || []
    const p = new Set()
    for (let i = 1; i < u.length; i++) p.add(u[i - 1] + u[i])
    return p
  }
  const t = pairs(target), h = pairs(heard || '')
  if (!t.size) return 0
  let n = 0
  t.forEach((x) => { if (h.has(x)) n++ })
  return Math.round((100 * n) / t.size)
}

const TESTS = [
  { id: 'A', title: 'SpeechRecognition', mic: null },
  { id: 'B', title: 'Session + audio:true', mic: true },
  { id: 'C', title: 'Session + echoCancellation:true', mic: { echoCancellation: true } },
  { id: 'D', title: 'SpeechRecognition, you speak', mic: null, speak: true },
]

export default {
  data: {
    lines: [],
    hint: '',
  },

  onLoad() {
    this._step = 0
    let ec = '?'
    try {
      const c = navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints()
      ec = c ? String(!!c.echoCancellation) : 'n/a'
    } catch (e) { ec = 'error ' + (e && e.message) }
    this._log('echoCancellation supported: ' + ec)
    this._log('synthesize: ' + (typeof speechSynthesis !== 'undefined' && typeof speechSynthesis.synthesize === 'function') +
      ', SpeechRecognitionSession: ' + (typeof SpeechRecognitionSession !== 'undefined'))
    this.setData({ hint: 'full screen, stay silent · tap = test A' })
  },

  onKeyUp(e) {
    if (e.code === 'GlobalHook' || e.code === 'Enter') this.next()
  },

  _log(line) {
    console.log('[probe]', line)
    this._n = (this._n || 0) + 1
    this.setData({ lines: this.data.lines.concat([{ id: 'l' + this._n, text: line }]).slice(-12) })
  },

  async next() {
    if (this._running || this._step >= TESTS.length) return
    const test = TESTS[this._step++]
    this._running = true
    this.setData({ hint: test.speak ? 'while it reads, say: ' + SAY : 'test ' + test.id + ' · stay silent' })
    try {
      const mic = test.mic === null ? this._listenClassic() : await this._listenSession(test.mic)
      await sleep(1000)
      const before = mic.text()   // should be empty: nothing played yet
      const how = await this._play(SENTENCE)
      await sleep(2000)            // let the recognizer finish the last words
      const heard = await mic.stop()
      let line = test.id + ' ' + test.title + (mic.settings ? ' [EC=' + (mic.settings.echoCancellation === undefined ? 'not reported' : mic.settings.echoCancellation) + ']' : '') +
        ' · ' + how + ' · own voice heard ' + heardShare(SENTENCE, heard) + '%'
      if (test.speak) line += ' · your line heard ' + heardShare(SAY, heard) + '%'
      if (before) line += ' · before playback: ' + before.slice(0, 12)
      this._log(line)
      this._log('  text: ' + (heard ? heard.slice(0, 24) : '(nothing)') + (mic.errors.length ? ' · ' + mic.errors.join(',') : ''))
    } catch (e) {
      this._log(test.id + ' failed: ' + (e && (e.message || e)))
    }
    this._running = false
    const n = TESTS[this._step]
    this.setData({ hint: n ? 'tap = test ' + n.id + (n.speak ? ' (you will speak)' : ' · stay silent') : 'done · photo this screen' })
  },

  // collect everything a recognizer reports: finals plus the latest interim
  _collector() {
    const c = { finals: [], interim: '', errors: [] }
    c.onresult = (e) => {
      const results = e.results || []
      let interim = ''
      for (let i = e.resultIndex; i < results.length; i++) {
        const t = results[i] && results[i][0] && results[i][0].transcript
        if (!t) continue
        if (results[i].isFinal) c.finals.push(t)
        else interim += t
      }
      c.interim = interim
    }
    c.text = () => c.finals.join(' ') + (c.interim ? ' ' + c.interim : '')
    return c
  },

  // A / D: the SpeechRecognition API, as the Hermes agent uses it
  _listenClassic() {
    const c = this._collector()
    const rec = new SpeechRecognition()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = c.onresult
    rec.onerror = (e) => c.errors.push('error:' + (e && (e.error || e.message)))
    rec.onend = () => c.errors.push('end')
    rec.start()
    return {
      errors: c.errors,
      text: c.text,
      stop: async () => {
        try { rec.stop() } catch (_) {}
        await sleep(800)
        return c.text()
      },
    }
  },

  // B / C: open the mic ourselves and stream it into a recognition session
  async _listenSession(constraints) {
    const c = this._collector()
    let step = 'getCapabilities'
    try {
      const caps = await SpeechRecognitionSession.getCapabilities()
      step = 'isTypeSupported'
      const mimeType = ['audio/ogg;codecs=opus', 'audio/wav'].find((m) =>
        (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(m)) &&
        caps.audioFormats.some((f) => f.mimeType.toLowerCase() === m))
      if (!mimeType) throw new Error('no shared audio format')
      step = 'new session'
      const session = new SpeechRecognitionSession({ lang: 'zh-CN', interimResults: caps.interimResults, audio: { mimeType } })
      session.onresult = c.onresult
      session.onerror = (e) => c.errors.push('error:' + (e && (e.error || e.message)))
      step = 'getUserMedia'
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      step = 'getSettings'
      const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : stream.getTracks()
      const track = tracks && tracks[0]
      const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {}
      step = 'getWriter'
      const writer = session.audio.getWriter()
      let queue = Promise.resolve()
      step = 'MediaRecorder'
      const recorder = new MediaRecorder(stream, { mimeType })
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) queue = queue.then(() => writer.write(e.data))
      }
      const stopped = new Promise((r) => { recorder.onstop = r })
      recorder.start(250)
      return {
        settings,
        errors: c.errors,
        text: c.text,
        stop: async () => {
          try { recorder.stop() } catch (_) {}
          await Promise.race([stopped, sleep(1500)])
          try { await queue; await writer.close() } catch (_) {}
          await sleep(1500)   // final result after close
          stream.getTracks().forEach((t) => { try { t.stop() } catch (_) {} })
          return c.text()
        },
      }
    } catch (e) {
      throw new Error(step + ': ' + (e && (e.message || e)))
    }
  },

  // read the text aloud; resolves when it ends (or after a generous timeout)
  _play(text) {
    const u = new SpeechSynthesisUtterance(text)
    u.voice = 'female-yujie'
    u.lang = 'zh-CN'
    const maxMs = 1500 + text.length * 300
    return new Promise((resolve) => {
      let done = false
      const end = (how) => { if (!done) { done = true; resolve(how) } }
      setTimeout(() => end('timeout'), maxMs)
      const simple = () => {
        u.onend = () => end('speak')
        try { speechSynthesis.speak(u) } catch (e) { end('speak failed') }
        setTimeout(() => end('speak (no end)'), text.length * 240 + 800)
      }
      if (typeof speechSynthesis.synthesize !== 'function' || typeof SpeechAudioPlayer === 'undefined') return simple()
      speechSynthesis.synthesize(u, { subtitles: 'sentence' }).then((task) => {
        const player = new SpeechAudioPlayer(task, { trackMode: 'hidden' })
        player.audioPlayer.onEnded(() => { try { player.destroy() } catch (_) {} end('synth') })
        player.audioPlayer.onCanplay(() => {
          try { player.play() } catch (_) { try { player.destroy() } catch (e) {} simple() }
        })
      }).catch(simple)
    })
  },
}
</script>

<page>
  <view class="app">
    <text class="brand">◈ ECHO PROBE</text>
    <view class="log">
      <text class="line" ink:for="{{ lines }}" ink:key="id">{{ item.text }}</text>
    </view>
    <text class="hint">{{ hint }}</text>
  </view>
</page>

<style>
.app { display: flex; flex-direction: column; height: 100vh; padding: 10px 14px; box-sizing: border-box; overflow: hidden; }
.brand { color: #40FF5E; font-size: 16px; font-weight: bold; letter-spacing: 1px; flex-shrink: 0; }
.log { display: flex; flex-direction: column; height: 280px; flex-shrink: 0; margin-top: 6px; overflow: hidden; }
.line { color: #40FF5E; font-size: 14px; line-height: 19px; white-space: pre-wrap; }
.hint { color: #2aa046; font-size: 13px; line-height: 18px; flex-shrink: 0; }
</style>
