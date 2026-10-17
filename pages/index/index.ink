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
    strings: {},            // set in onLoad from the system language
    showTalkButton: false,  // from config
    scrollTop: 0,           // for the answer scroll-view
  },

  // ---- call the Hermes/Claude bridge and render the answer ----
  async ask(text, imageDataUrl) {
    if (!text && !imageDataUrl) return
    this.setData({ status: 'working', answerText: '' })
    let attempts = 0
    while (attempts < 2 && !this._stopped) {
      attempts++
      if (this._abort) this._abort.abort()
      const ctrl = (this._abort = new AbortController())
      const timer = setTimeout(() => ctrl.abort(), 120000)   // 2-minute cap
      try {
        const payload = buildPayload(text || '', imageDataUrl)
        if (this._asrLang) payload.metadata.language = this._asrLang
        const resp = await fetch(BRIDGE_CONFIG.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + BRIDGE_CONFIG.ak,
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
          timeout: 60000,   // try to raise the runtime's short default (ignored if unsupported)
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
        return
      } catch (e) {
        if (attempts < 2 && e && e.name !== 'AbortError' && !this._stopped) {
          // transient network timeout — retry once
          this.setData({ status: 'working' })
          await this._delay(500)
          continue
        }
        const msg = (e && e.name === 'AbortError')
          ? '（已停止）'
          : ('（连接失败：' + (e && e.message || e) + '）')
        this.setData({ status: 'ready', answerText: msg })
        return
      } finally {
        clearTimeout(timer)
        this._abort = null
      }
    }
  },

  // stop the current in-flight request + conversation loop
  stop() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
    this._busy = false
    this.setData({ status: 'ready', inConversation: false })
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
        this.setData({ answerText: cur.length > 4000 ? cur.slice(cur.length - 4000) : cur, scrollTop: 99999 })
      }
      if (obj && obj.is_finish) {
        this.setData({ status: 'done' })
      }
    } catch (e) { /* ignore */ }
  },

  // ---- continuous voice conversation (one tap, mic stays hot, no per-turn tap) ----
  captureAndAsk() {
    this._startListening()
  },

  _startListening() {
    if (this._rec) { this.setData({ status: 'listening' }); return }
    if (typeof SpeechRecognition === 'undefined') { this.setData({ status: 'ready' }); return }
    this._stopped = false
    this.setData({ inConversation: true, status: 'listening', answerText: '' })
    const rec = new SpeechRecognition()
    this._rec = rec
    rec.lang = this._asrLang || BRIDGE_CONFIG.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      const results = e.results
      if (!results) return
      for (let i = e.resultIndex; i < results.length; i++) {
        const r = results[i]
        if (r && r.isFinal && r[0] && r[0].transcript) {
          this._handleUtterance(r[0].transcript)
        }
      }
    }
    rec.onerror = () => {}
    rec.onend = () => { this._rec = null }
    try {
      rec.start()
    } catch (e) {
      this._rec = null
      this.setData({ status: 'ready' })
    }
  },

  _handleUtterance(text) {
    if (this._busy) return
    this._busy = true
    const t = (text || '').trim()
    if (!t) { this._busy = false; return }
    if (this._isExit(t)) { this._endConversation(); this._busy = false; return }
    this.ask(t).then(() => {
      const ans = this.data.answerText
      // mic stays ACTIVE while reading aloud (test whether TTS echo is actually a problem)
      this._busy = false
      if (this._rec) { this.setData({ status: 'listening' }) }
      else { this.setData({ status: 'ready', inConversation: false }) }
      if (BRIDGE_CONFIG.readAloud !== false && ans) {
        setTimeout(() => this._speak(ans), 300)  // read aloud, fire-and-forget
      }
    })
  },

  _speak(text) {
    try {
      if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
        const u = new SpeechSynthesisUtterance(text)
        const zh = this._asrLang && /^zh/i.test(this._asrLang)
        // pick a native voice for the language so it doesn't sound like a foreigner
        u.voice = zh ? 'Chinese (Mandarin)_News_Anchor' : 'English_radiant_girl'
        speechSynthesis.speak(u)
      }
    } catch (e) {}
  },

  _isExit(text) {
    return /^(退出|停止|结束|exit|stop|bye)$/i.test((text || '').trim())
  },

  _endConversation() {
    if (this._rec) { try { this._rec.stop() } catch (_) {} this._rec = null }
    this._busy = false
    this.setData({ status: 'ready', inConversation: false, answerText: (this.data.strings && this.data.strings.ended) || '（会话已结束）' })
  },

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms))
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
    // follow the system / Hi Rokid language for both UI + speech recognition
    this._asrLang = (BRIDGE_CONFIG.lang && BRIDGE_CONFIG.lang !== 'auto')
      ? BRIDGE_CONFIG.lang
      : (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US')
    this.setData({ strings: this._strings(this._asrLang) })
    this.setData({ showTalkButton: BRIDGE_CONFIG.showTalkButton === true })
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

  // UI strings by language; zh for zh-*, otherwise English
  _strings(lang) {
    const zh = /^zh/i.test(lang || '')
    return zh ? {
      chipReady: '就绪', chipListening: '聆听中', chipThinking: '思考中',
      idle: '轻按眼镜腿开始对话', say: '请讲…', working: '正在处理…',
      talk: '说话', hintIdle: '眼镜腿 tap = 开始 · 说「退出」结束',
      hintListening: '正在听 · 说完即可', hintWorking: '请稍候',
      ended: '（会话已结束）',
    } : {
      chipReady: 'READY', chipListening: 'LISTENING', chipThinking: 'THINKING',
      idle: 'Tap the temple to start', say: 'Your turn…', working: 'Working…',
      talk: 'Talk', hintIdle: 'temple tap = start · say "exit" to stop',
      hintListening: 'listening · just speak', hintWorking: 'one moment',
      ended: '(conversation ended)',
    }
  },

  onUnload() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
    this._busy = false
  },
}
</script>

<page>
  <view class="app">
    <view class="head">
      <text class="brand">◈ HERMES</text>
      <text class="chip">{{ status === 'listening' ? strings.chipListening : status === 'working' ? strings.chipThinking : strings.chipReady }}</text>
    </view>
    <view class="body">
      <scroll-view class="scroll" scroll-y scroll-top="{{ scrollTop }}">
        <view class="{{ status === 'listening' ? 'dot' : 'hidden' }}"></view>
        <text class="answer">{{ answerText || (status === 'listening' ? strings.say : status === 'working' ? strings.working : strings.idle) }}</text>
      </scroll-view>
    </view>
    <view class="foot">
      <button class="talk {{ showTalkButton ? '' : 'hidden' }} {{ status === 'listening' ? 'listening' : status === 'working' ? 'working' : '' }}" bindtap="captureAndAsk">{{ strings.talk }}</button>
      <text class="hint">{{ status === 'listening' ? strings.hintListening : status === 'working' ? strings.hintWorking : strings.hintIdle }}</text>
    </view>
  </view>
</page>

<style>
.app {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100vh;
  padding: 14px 16px 20px;
  box-sizing: border-box;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.brand {
  color: #40FF5E;
  font-size: 18px;
  font-weight: bold;
  letter-spacing: 1px;
}
.chip {
  color: #123a1d;
  background: #40FF5E;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: bold;
  letter-spacing: 1px;
}
.body {
  flex: 1;
  display: flex;
  align-items: stretch;
  overflow: hidden;
}
.scroll {
  flex: 1;
  height: 100%;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #40FF5E;
  margin-right: 12px;
  flex: 0 0 auto;
  animation: pulse 1.1s ease-in-out infinite;
}
.answer {
  color: #40FF5E;
  width: 100%;
  text-align: left;
  font-size: 20px;
  line-height: 30px;
  white-space: pre-wrap;
}
.foot {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.talk {
  color: #40FF5E;
  border: 1px solid #40ff5d55;
  border-radius: 999px;
  padding: 8px 26px;
  font-size: 16px;
  line-height: 20px;
  text-align: center;
  transition: all .2s;
}
.talk.listening {
  border: 2px solid #40FF5E;
  animation: pulse 1.1s ease-in-out infinite;
}
.talk.working {
  border: 1px dashed #40FF5E;
  opacity: .8;
}
.hidden { display: none; }
.hint {
  color: #2aa046;
  font-size: 13px;
  margin-top: 10px;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(64,255,94,.5); }
  50% { box-shadow: 0 0 0 8px rgba(64,255,94,0); }
}
</style>
