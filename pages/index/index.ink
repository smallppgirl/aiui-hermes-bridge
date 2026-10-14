<script def>
{
  "navigationBarTitleText": "Hermes Bridge"
}
</script>

<script setup>
import { BRIDGE_CONFIG, buildPayload } from '../../config.js'

export default {
  data: {
    focused: false,
    status: 'ready',        // ready | listening | working | done
    answerText: '',
    inConversation: false,
  },

  // ---- call the Hermes/Claude bridge and render the answer ----
  async ask(text, imageDataUrl) {
    if (!text && !imageDataUrl) return
    this.setData({ status: 'working', answerText: '' })
    if (this._abort) this._abort.abort()
    const ctrl = (this._abort = new AbortController())
    const timer = setTimeout(() => ctrl.abort(), 120000)   // 2-minute cap
    try {
      const resp = await fetch(BRIDGE_CONFIG.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + BRIDGE_CONFIG.ak,
        },
        body: JSON.stringify(buildPayload(text || '', imageDataUrl)),
        signal: ctrl.signal,
      })
      const reader = resp.body && typeof resp.body.getReader === 'function'
        ? resp.body.getReader()
        : null
      const dec = new TextDecoder()
      let buffer = ''
      const feed = (chunk) => {
        buffer += chunk
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          this._consumeSse(buffer.slice(0, i).replace(/\r/g, ''))
          buffer = buffer.slice(i + 2)
        }
      }
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          feed(dec.decode(value, { stream: true }))
        }
        if (buffer) this._consumeSse(buffer.replace(/\r/g, ''))
      } else {
        // some mini-app runtimes buffer the whole body instead of streaming
        feed(await resp.text())
      }
      this.setData({ status: 'done' })
    } catch (e) {
      const msg = (e && e.name === 'AbortError')
        ? '（已停止）'
        : ('（连接失败：' + (e && e.message || e) + '）')
      this.setData({ status: 'ready', answerText: msg })
    } finally {
      clearTimeout(timer)
      this._abort = null
    }
  },

  // stop the current in-flight request + conversation loop
  stop() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
  },

  // parse one SSE block:  data:{...answer_stream...}
  _consumeSse(block) {
    if (!block) return
    const m = block.match(/data:\s*(\{.*\})/s)
    if (!m) return
    try {
      const obj = JSON.parse(m[1])
      if (obj && obj.type === 'answer' && obj.answer_stream) {
        const cur = this.data.answerText + obj.answer_stream
        // cap displayed text to avoid unbounded growth on very long answers
        this.setData({ answerText: cur.length > 4000 ? cur.slice(cur.length - 4000) : cur })
      }
      if (obj && obj.is_finish) {
        this.setData({ status: 'done' })
      }
    } catch (e) { /* ignore */ }
  },

  // ---- enter continuous conversation: tap once, then keep asking ----
  async captureAndAsk() {
    this.setData({ inConversation: true, status: 'listening', answerText: '' })
    let guard = 0
    while (!this._stopped && this.data.inConversation && guard < 30) {
      guard++
      this.setData({ status: 'listening' })
      let text = ''
      try {
        text = await this.getVoiceInput()
      } catch (e) {
        this.setData({ status: 'ready', answerText: '（取不了语音：' + (e && e.message || e) + '）' })
        break
      }
      if (this._stopped) break
      if (!text) {
        // nothing recognised — stop the loop, wait for another gesture (tap)
        this.setData({ status: 'ready', answerText: '', inConversation: false })
        break
      }
      if (this._isExit(text)) {
        this._endConversation()
        break
      }
      await this.ask(text)
      if (this._stopped) break
      // small pause so the user hears the answer, then listen again
      await this._delay(600)
    }
    if (this._stopped) this.setData({ status: 'ready', inConversation: false })
  },

  _isExit(text) {
    return /^(退出|停止|结束|exit|stop|bye)$/i.test((text || '').trim())
  },

  _endConversation() {
    this.setData({ status: 'ready', inConversation: false, answerText: '（会话已结束）' })
  },

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms))
  },

  // implement voice capture with the AIUI speech API
  async getVoiceInput() {
    // AIUI SpeechRecognition: new SpeechRecognition(), set lang, onresult -> transcript.
    // start() requires an interactive (user-gesture) context; onLoad is non-interactive.
    if (typeof SpeechRecognition === 'undefined') return ''
    return await new Promise((resolve) => {
      const rec = new SpeechRecognition()
      this._rec = rec
      rec.lang = BRIDGE_CONFIG.lang
      rec.interimResults = false
      let final = ''
      rec.onresult = (e) => {
        const r = e.results && e.results[e.resultIndex] && e.results[e.resultIndex][0]
        if (r && r.transcript) final = r.transcript
      }
      rec.onerror = () => { try { rec.abort() } catch (_) {}; this._rec = null; resolve(final) }
      rec.onend = () => { this._rec = null; resolve(final) }
      try {
        rec.start()
      } catch (e) {
        // non-interactive / not supported here
        resolve(final)
      }
    })
  },

  // capture a photo with the AIUI camera API and send it with the query (vision)
  async askWithPhoto(text) {
    let imageDataUrl = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const track = stream.getVideoTracks()[0]
      const capture = new ImageCapture(track)
      const blob = await capture.takePhoto({ mode: 'default' })
      imageDataUrl = await this._blobToDataUrl(blob)
      stream.getTracks().forEach(t => t.stop())
    } catch (e) {
      // no camera / permission denied — fall back to text only
    }
    await this.ask(text || '看看这个', imageDataUrl || undefined)
  },

  _blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = () => resolve('')
      fr.readAsDataURL(blob)
    })
  },

  onKeyUp(event) {
    if (event.code === 'Backspace' || event.code === 'Escape') {
      this.stop()
      return
    }
    // temple tap (GlobalHook) or Enter = start talking (valid user gesture
    // so SpeechRecognition is allowed to open the mic)
    if (event.code === 'GlobalHook' || event.code === 'Enter') {
      this.captureAndAsk()
      return
    }
  },

  onLoad(query) {
    this._stopped = false
    // semantic wake-up: "Hi Rokid, open the xxx agent" may pass the spoken query.
    const q = query && (query.text || query.query || query.q)
    if (q && typeof q === 'string' && q.trim()) {
      this.ask(q.trim())
    } else {
      // AIUI SpeechRecognition requires a user gesture (interactive), so do NOT
      // auto-start ASR on load. Show the speak button; the user presses to talk.
      this.setData({ status: 'ready', answerText: '' })
    }
  },

  onUnload() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
  },
}
</script>

<page>
  <view class="container">
    <text class="title">Hermes · {{ status }}</text>
    <text class="answer">{{ answerText || (status === 'listening' ? '请讲…' : '轻按眼镜腿或点「说话」开始；说「退出」结束') }}</text>
    <button class="{{ focused ? 'focused' : '' }}" bindtap="captureAndAsk">说话</button>
  </view>
</page>

<style>
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
}
.title {
  color: #40FF5E;
  width: 100%;
  text-align: center;
  font-size: 22px;
  margin-bottom: 16px;
}
.answer {
  color: #40FF5E;
  width: 88%;
  text-align: left;
  font-size: 18px;
  line-height: 24px;
  margin-bottom: 20px;
  white-space: pre-wrap;
}
button {
  color: #40FF5E;
  border: 1px solid #40ff5d42;
  border-radius: 12px;
  padding: 5px;
  width: 100px;
  line-height: 24px;
  text-align: center;
}
button.focused { border: 2px solid #40FF5E; }
</style>
