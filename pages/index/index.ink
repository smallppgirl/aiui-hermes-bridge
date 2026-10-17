<script def>
{
  "navigationBarTitleText": "Hermes Bridge"
}
</script>

<script setup>
import { BRIDGE_CONFIG, buildPayload } from '../../config.js'

const MAX_TURNS = 20      // keep the on-screen dialog bounded
const MAX_ANSWER = 4000   // cap a single answer's displayed text

export default {
  data: {
    focused: false,
    status: 'ready',        // ready | listening | working | speaking
    chip: '',
    hint: '',
    turns: [],              // dialog history: { id, role: 'user' | 'bot' | 'note', text, pending }
    drafting: false,        // a live (interim) question line is on screen
    inConversation: false,
    strings: {},            // set in onLoad from the system language
    showTalkButton: false,  // from config
    scrollTop: 0,           // fallback for runtimes without the entity scroll API
  },

  // ---- call the Hermes/Claude bridge and stream the answer into a new dialog line ----
  // returns true if an answer was received and rendered, false otherwise.
  async ask(text, imageDataUrl) {
    if (!text && !imageDataUrl) return false
    const botId = this._nextId()
    this._botId = botId
    this._answer = ''
    this._setStatus('working')
    await this._set({ turns: this.data.turns.concat([{ id: botId, role: 'bot', text: '', pending: true }]) })
    this._follow()
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
        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          throw new Error('HTTP ' + resp.status + ' ' + body.slice(0, 120))
        }
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
        if (!this._answer) throw new Error('未收到回复（桥返回空）')
        await this._flushAnswer()
        this._botId = null
        return true
      } catch (e) {
        if (attempts < 2 && e && e.name !== 'AbortError' && !this._stopped) {
          // transient network timeout — retry once, from a clean answer line
          this._answer = ''
          await this._patchTurn(botId, { text: '', pending: true })
          await this._delay(500)
          continue
        }
        const msg = (e && e.name === 'AbortError')
          ? '（已停止）'
          : ('（' + (e && e.message || e) + '）')
        this._botId = null
        await this._patchTurn(botId, { text: (this._answer ? this._answer + '\n' : '') + msg, pending: false })
        this._setStatus('ready')
        this._follow()
        return false
      } finally {
        clearTimeout(timer)
        this._abort = null
      }
    }
    return false
  },

  // stop the current in-flight request + conversation loop
  stop() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
    this._stopReadScroll()
    this._busy = false
    this._draftId = null
    this._setStatus('ready', { inConversation: false, drafting: false })
  },

  // parse one SSE block:  data:{...answer_stream...}
  _consumeSse(block) {
    if (!block) return
    const m = block.match(/data:\s*(\{.*\})/s)
    if (!m) return
    try {
      const obj = JSON.parse(m[1])
      if (obj && obj.type === 'answer' && obj.answer_stream) {
        const cur = this._answer + obj.answer_stream
        this._answer = cur.length > MAX_ANSWER ? cur.slice(cur.length - MAX_ANSWER) : cur
        this._renderAnswer()
      }
    } catch (e) { /* ignore */ }
  },

  // throttle answer re-renders while chunks stream in
  _renderAnswer() {
    if (this._renderPending) return
    this._renderPending = true
    setTimeout(() => { this._renderPending = false; this._flushAnswer() }, 60)
  },

  // first chunk replaces the "Thinking…" placeholder; later chunks extend the line
  async _flushAnswer() {
    if (!this._botId || !this._answer) return
    await this._patchTurn(this._botId, { text: this._answer, pending: false })
    this._follow()
  },

  // ---- dialog lines ----
  _nextId() {
    this._seq = (this._seq || 0) + 1
    return 't' + this._seq
  },

  // setData as a promise (with a safety timeout in case the callback never fires)
  _set(data) {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      this.setData(data, finish)
      setTimeout(finish, 300)
    })
  },

  _patchTurn(id, patch) {
    const turns = this.data.turns.map((t) => (t.id === id ? Object.assign({}, t, patch) : t))
    return this._set({ turns })
  },

  // start a new question line below the current dialog (draft = live interim text)
  _openUserTurn(text, draft) {
    const id = this._nextId()
    if (draft) this._draftId = id
    const ready = (async () => {
      let turns = this.data.turns
      if (turns.length > MAX_TURNS - 2) {
        turns = turns.slice(turns.length - (MAX_TURNS - 2))
        await this._set({ turns })
      }
      // where this Q&A starts: streaming/reading never scrolls the question off the top
      this._turnStart = turns.length ? this._contentHeight() : 0
      await this._set({ turns: turns.concat([{ id, role: 'user', text }]), drafting: !!draft })
      this._follow()
    })()
    if (draft) this._draftReady = ready
    return ready
  },

  // the final transcript: settle the live draft line, or add the question line now
  async _commitUserTurn(text) {
    if (this._draftId) {
      const id = this._draftId
      await this._draftReady
      this._draftId = null
      this._draftReady = null
      await this._patchTurn(id, { text })
      this.setData({ drafting: false })
    } else {
      await this._openUserTurn(text, false)
    }
  },

  // print the question as it is being recognized
  _onInterim(text) {
    if (this._busy) return
    const t = (text || '').trim()
    if (!t) return
    if (this._draftId) {
      this._patchTurn(this._draftId, { text: t }).then(() => this._follow())
    } else {
      this._openUserTurn(t, true)
    }
  },

  // ---- scrolling ----
  _chat() {
    try { return this.querySelector ? this.querySelector('#chat') : null } catch (_) { return null }
  },

  // height of the dialog content (the #log view, else the scroll-view's content)
  _contentHeight() {
    try {
      const log = this.querySelector && this.querySelector('#log')
      if (log && log.clientHeight > 0) return log.clientHeight
      const el = this._chat()
      return el ? el.scrollHeight : 0
    } catch (_) { return 0 }
  },

  // keep the newest text in view, but never past the start of the current question
  _follow() {
    if (this._reading) return
    const el = this._chat()
    if (el && typeof el.scrollTo === 'function') {
      let top = el.scrollHeight - el.clientHeight
      if (this._turnStart != null) top = Math.min(top, this._turnStart)
      if (top > el.scrollTop + 1) {
        const r = el.scrollTo({ top, behavior: 'smooth' })
        if (r && r.catch) r.catch(() => {})
      }
    } else {
      // older runtimes: scroll-top only reacts when the bound value changes
      this._flip = !this._flip
      this.setData({ scrollTop: this._flip ? 1000000 : 1000001 })
    }
  },

  _scrollToEnd() {
    const el = this._chat()
    if (el && typeof el.scrollTo === 'function') {
      const r = el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      if (r && r.catch) r.catch(() => {})
    }
  },

  // slowly scroll the answer while it is read, keeping the spoken part ~1/3 down the screen
  _startReadScroll(durationMs) {
    this._stopReadScroll()
    const el = this._chat()
    if (!el || this._turnStart == null || durationMs <= 0) return
    const start = this._turnStart
    const end = this._contentHeight()
    if (end - start <= el.clientHeight) return   // fits on one screen
    this._reading = true
    const t0 = Date.now()
    this._readTimer = setInterval(() => {
      try {
        const p = Math.min(1, (Date.now() - t0) / durationMs)
        const spokenY = start + p * (end - start)
        const top = Math.min(el.scrollHeight - el.clientHeight, spokenY - el.clientHeight * 0.35)
        if (top > el.scrollTop + 0.5) el.scrollTop = top
        if (p >= 1) this._stopReadScroll()
      } catch (_) { this._stopReadScroll() }
    }, 80)
  },

  _stopReadScroll() {
    if (this._readTimer) { clearInterval(this._readTimer); this._readTimer = null }
    this._reading = false
  },

  // ---- continuous voice conversation (one tap, mic stays hot, no per-turn tap) ----
  captureAndAsk() {
    this._startListening()
  },

  _startListening() {
    if (this._rec) { if (!this._busy) this._setStatus('listening'); return }
    if (typeof SpeechRecognition === 'undefined') { this._setStatus('ready'); return }
    this._stopped = false
    this._setStatus('listening', { inConversation: true })
    const rec = new SpeechRecognition()
    this._rec = rec
    rec.lang = this._asrLang || BRIDGE_CONFIG.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      const results = e.results
      if (!results) return
      let interim = ''
      for (let i = e.resultIndex; i < results.length; i++) {
        const r = results[i]
        const t = r && r[0] && r[0].transcript
        if (!t) continue
        if (r.isFinal) this._handleUtterance(t)
        else interim += t
      }
      if (interim) this._onInterim(interim)
    }
    rec.onerror = () => {}
    rec.onend = () => { this._rec = null }
    try {
      rec.start()
    } catch (e) {
      this._rec = null
      this._setStatus('ready')
    }
  },

  async _handleUtterance(text) {
    if (this._busy) return
    const t = (text || '').trim()
    if (!t) return
    this._busy = true
    await this._commitUserTurn(t)
    if (this._isExit(t)) { this._endConversation(); this._busy = false; return }
    const ok = await this.ask(t)
    const ans = this._answer
    if (!ok || !ans) {
      // FAILED (error already shown by ask) — stop listening, keep the error visible
      this._busy = false
      if (this._rec) { try { this._rec.stop() } catch (_) {} this._rec = null }
      this._setStatus('ready', { inConversation: false })
      return
    }
    const zh = this._isChinese(ans)
    if (BRIDGE_CONFIG.readAloud !== false) {
      // mic IGNORED while reading aloud (avoid capturing the TTS echo)
      this._setStatus('speaking')
      await this._speak(ans, zh)
      this._stopReadScroll()
      this._scrollToEnd()
    } else {
      this._startReadScroll(this._estimateSpeechMs(ans, zh) * 0.7)
    }
    this._turnStart = null
    // after reading, resume listening (or you can tap the temple anytime)
    this._busy = false
    if (this._rec) { this._setStatus('listening') }
    else { this._setStatus('ready', { inConversation: false }) }
  },

  // the TTS voice follows the language of the answer, not the system language
  // (AIUI ignores utterance.lang today; only the voice id selects the language)
  _speak(text, zh) {
    const est = this._estimateSpeechMs(text, zh)
    this._startReadScroll(est)
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
      const timer = setTimeout(finish, Math.min(300000, est * 1.2 + 1500))  // fallback
      try {
        if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
          const u = new SpeechSynthesisUtterance(text)
          const voices = BRIDGE_CONFIG.ttsVoices || {}
          u.voice = zh ? (voices.zh || 'female-yujie') : (voices.en || 'English_radiant_girl')
          u.lang = zh ? 'zh-CN' : 'en-US'
          u.onend = finish
          u.onerror = finish
          speechSynthesis.speak(u)
        } else { finish() }
      } catch (e) { finish() }
    })
  },

  // Chinese if Han characters make up a meaningful share of the text
  // (one Han char ~ half an English word, so a few English terms don't flip it)
  _isChinese(text) {
    const s = text || ''
    const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length
    const words = (s.match(/[A-Za-z]+/g) || []).length
    return han > 0 && han * 2 >= words
  },

  // rough speaking time: ~4 Han chars/s, ~160 English words/min
  _estimateSpeechMs(text, zh) {
    const s = text || ''
    const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length
    const words = (s.match(/[A-Za-z0-9]+/g) || []).length
    return 800 + han * 240 + words * (zh ? 450 : 380)
  },

  _isExit(text) {
    return /^(退出|停止|结束|exit|stop|bye)$/i.test((text || '').trim())
  },

  _endConversation() {
    if (this._rec) { try { this._rec.stop() } catch (_) {} this._rec = null }
    this._busy = false
    this._turnStart = null
    const ended = (this.data.strings && this.data.strings.ended) || '（会话已结束）'
    this._setStatus('ready', {
      inConversation: false,
      turns: this.data.turns.concat([{ id: this._nextId(), role: 'note', text: ended }]),
    })
    setTimeout(() => this._follow(), 50)
  },

  _setStatus(status, extra) {
    const s = this.data.strings || {}
    const chip = { listening: s.chipListening, working: s.chipThinking, speaking: s.chipSpeaking }[status] || s.chipReady
    const hint = { listening: s.hintListening, working: s.hintWorking, speaking: s.hintSpeaking }[status] || s.hintIdle
    this.setData(Object.assign({ status, chip, hint }, extra || {}))
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
    const q = text || '看看这个'
    await this._commitUserTurn(q)
    await this.ask(q, imageDataUrl || undefined)
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
    // manual scroll through the dialog (pauses the reading auto-scroll)
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      const el = this._chat()
      if (el && typeof el.scrollBy === 'function') {
        if (event.preventDefault) event.preventDefault()
        this._stopReadScroll()
        const dir = event.code === 'ArrowUp' ? -1 : 1
        const r = el.scrollBy({ top: dir * el.clientHeight * 0.6, behavior: 'smooth' })
        if (r && r.catch) r.catch(() => {})
      }
    }
  },

  onLoad(query) {
    this._stopped = false
    // follow the system / Hi Rokid language for the UI + speech recognition
    this._asrLang = (BRIDGE_CONFIG.lang && BRIDGE_CONFIG.lang !== 'auto')
      ? BRIDGE_CONFIG.lang
      : (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US')
    this.setData({ strings: this._strings(this._asrLang) })
    this.setData({ showTalkButton: BRIDGE_CONFIG.showTalkButton === true })
    this._setStatus('ready')
    // semantic wake-up: "Hi Rokid, open the xxx agent" may pass the spoken query.
    // AIUI SpeechRecognition requires a user gesture (interactive), so do NOT
    // auto-start ASR on load; the user taps the temple to talk.
    const q = query && (query.text || query.query || query.q)
    if (q && typeof q === 'string' && q.trim()) {
      this._handleUtterance(q.trim())
    }
  },

  // UI strings by language; zh for zh-*, otherwise English
  _strings(lang) {
    const zh = /^zh/i.test(lang || '')
    return zh ? {
      chipReady: '就绪', chipListening: '聆听中', chipThinking: '思考中', chipSpeaking: '播报中',
      idle: '轻按眼镜腿开始对话', say: '请讲…', thinking: '正在思考…',
      talk: '说话', hintIdle: '眼镜腿 tap = 开始 · 说「退出」结束',
      hintListening: '正在听 · 说完即可', hintWorking: '请稍候', hintSpeaking: '正在朗读',
      ended: '（会话已结束）',
    } : {
      chipReady: 'READY', chipListening: 'LISTENING', chipThinking: 'THINKING', chipSpeaking: 'SPEAKING',
      idle: 'Tap the temple to start', say: 'Your turn…', thinking: 'Thinking…',
      talk: 'Talk', hintIdle: 'temple tap = start · say "exit" to stop',
      hintListening: 'listening · just speak', hintWorking: 'one moment', hintSpeaking: 'reading aloud',
      ended: '(conversation ended)',
    }
  },

  onUnload() {
    this._stopped = true
    if (this._rec) { try { this._rec.abort() } catch (_) {} this._rec = null }
    if (this._abort) this._abort.abort()
    this._stopReadScroll()
    this._busy = false
  },
}
</script>

<page>
  <view class="app">
    <view class="head">
      <text class="brand">◈ HERMES</text>
      <view class="state">
        <view class="dot" ink:if="{{ status === 'listening' }}"></view>
        <text class="chip">{{ chip }}</text>
      </view>
    </view>
    <view class="body">
      <scroll-view id="chat" class="scroll" scroll-y="true" scroll-top="{{ scrollTop }}">
        <view id="log" class="log">
          <text class="line idle" ink:if="{{ !turns.length }}">{{ status === 'listening' ? strings.say : strings.idle }}</text>
          <view class="turn" ink:for="{{ turns }}" ink:key="id">
            <text class="line {{ item.role }} {{ item.pending ? 'pending' : '' }}">{{ item.pending ? strings.thinking : item.text }}</text>
          </view>
        </view>
      </scroll-view>
    </view>
    <view class="foot">
      <button class="talk {{ showTalkButton ? '' : 'hidden' }} {{ status === 'listening' ? 'listening' : status === 'working' ? 'working' : '' }}" bindtap="captureAndAsk">{{ strings.talk }}</button>
      <text class="hint">{{ hint }}</text>
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
.state {
  display: flex;
  flex-direction: row;
  align-items: center;
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
  margin-top: 10px;
}
.scroll {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.log {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding-bottom: 12px;
}
.turn {
  width: 100%;
  margin-bottom: 8px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #40FF5E;
  margin-right: 8px;
  flex: 0 0 auto;
  animation: pulse 1.1s ease-in-out infinite;
}
.line {
  width: 100%;
  text-align: left;
  font-size: 20px;
  line-height: 30px;
  white-space: pre-wrap;
}
.bot {
  color: #40FF5E;
}
.user,
.note,
.idle,
.pending {
  color: rgba(64,255,94,0.48);
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
