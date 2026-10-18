<script def>
{
  "navigationBarTitleText": "Hermes Bridge"
}
</script>

<script setup>
import { BRIDGE_CONFIG, buildPayload } from '../../config.js'

const MAX_TURNS = 20      // keep the on-screen dialog bounded
const MAX_ANSWER = 20000  // cap a single answer's displayed text
const HAN = /[㐀-鿿豈-﫿]/g
const count = (s, re) => ((s || '').match(re) || []).length

export default {
  data: {
    status: 'ready',        // ready | listening | working | speaking
    chip: '',
    hint: '',
    turns: [],              // dialog history: { id, role: 'user' | 'bot' | 'note', text, pending }
    strings: {},            // set in onLoad from the system language
    showTalkButton: false,  // from config
    scrollTop: 0,           // scroll-top binding (used when the entity scroll API is missing)
    scrollH: 266,           // scroll-view height in px, computed in onLoad
    compact: false,         // small host (the 448x150 card): footer hidden
  },

  // ---- call the Hermes/Claude bridge and stream the answer into a new dialog line ----
  // returns true if an answer was received and rendered, false otherwise.
  async ask(text, imageDataUrl) {
    if (!text && !imageDataUrl) return false
    const botId = (this._botId = this._nextId())
    this._answer = ''
    this._setStatus('working')
    await this._set({ turns: this.data.turns.concat([{ id: botId, role: 'bot', text: '', pending: true }]) })
    this._follow()
    for (let attempt = 1; attempt <= 2 && !this._stopped; attempt++) {
      if (this._abort) this._abort.abort()
      const ctrl = (this._abort = new AbortController())
      const timer = setTimeout(() => ctrl.abort(), 120000)   // 2-minute cap
      try {
        const payload = buildPayload(text || '', imageDataUrl)
        if (this._asrLang) payload.metadata.language = this._asrLang
        const resp = await fetch(BRIDGE_CONFIG.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BRIDGE_CONFIG.ak },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
          timeout: 60000,   // try to raise the runtime's short default (ignored if unsupported)
        })
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text().catch(() => '')).slice(0, 120))
        const dec = new TextDecoder()
        let buffer = ''
        const feed = (chunk) => {
          buffer += chunk.replace(/\r/g, '')   // before splitting, so \r\n\r\n also ends an event
          for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
            this._consumeSse(buffer.slice(0, i))
          }
        }
        if (resp.body && typeof resp.body.getReader === 'function') {
          const reader = resp.body.getReader()
          for (let r; !(r = await reader.read()).done;) feed(dec.decode(r.value, { stream: true }))
          if (buffer) this._consumeSse(buffer)
        } else {
          feed(await resp.text())   // some mini-app runtimes buffer the whole body instead of streaming
        }
        if (!this._answer) throw new Error('未收到回复（桥返回空）')
        await this._flushAnswer()
        this._botId = null
        return true
      } catch (e) {
        if (attempt < 2 && e && e.name !== 'AbortError' && !this._stopped) {
          // transient network timeout — retry once, from a clean answer line
          this._answer = ''
          await this._patchTurn(botId, { text: '', pending: true })
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const msg = (e && e.name === 'AbortError') ? '（已停止）' : ('（' + (e && e.message || e) + '）')
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

  // stop the in-flight request, recognizer, speech and scrolling
  _teardown() {
    this._stopped = true
    this._dropRec('abort')
    if (this._abort) this._abort.abort()
    this._stopSpeaking(false)
    this._stopReadScroll()
    this._busy = false
  },

  // stop the current in-flight request + conversation loop
  stop() {
    this._teardown()
    this._draftId = null
    this._setStatus('ready')
  },

  onUnload() {
    this._teardown()
  },

  // parse one SSE block:  data:{...answer_stream...}
  _consumeSse(block) {
    const m = block && block.match(/data:\s*(\{.*\})/s)
    if (!m) return
    try {
      const obj = JSON.parse(m[1])
      if (obj && obj.type === 'answer' && obj.answer_stream) {
        if (!this._answer) this._mark('text')
        // Hermes answers often start with blank lines or a space: drop them (no indent, not read aloud)
        this._answer = (this._answer + obj.answer_stream).replace(/^\s+/, '').slice(-MAX_ANSWER)
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
    return 't' + (this._seq = (this._seq || 0) + 1)
  },

  // setData as a promise (with a safety timeout in case the callback never fires)
  _set(data) {
    return new Promise((resolve) => {
      this.setData(data, resolve)
      setTimeout(resolve, 300)
    })
  },

  _patchTurn(id, patch) {
    return this._set({ turns: this.data.turns.map((t) => (t.id === id ? Object.assign({}, t, patch) : t)) })
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
      this._stopReadScroll()   // a new question ends the previous answer's reading scroll
      this._userScrolled = false
      this._turnStart = turns.length ? this._contentHeight() : 0
      await this._set({ turns: turns.concat([{ id, role: 'user', text }]) })
      this._follow()
    })()
    if (draft) this._draftReady = ready
    return ready
  },

  // the final transcript: settle the live draft line, or add the question line now
  async _commitUserTurn(text) {
    if (!this._draftId) return this._openUserTurn(text, false)
    const id = this._draftId
    await this._draftReady
    this._draftId = this._draftReady = null
    await this._patchTurn(id, { text })
  },

  // print the question as it is being recognized
  _onInterim(text) {
    const t = (text || '').trim()
    if ((this._busy && !this._barge) || !t) return
    if (this._draftId) this._patchTurn(this._draftId, { text: t }).then(() => this._follow())
    else this._openUserTurn(t, true)
  },

  // ---- scrolling ----
  // Works on old and new runtimes: the entity scroll API (AIUI >= 0.18) is used when
  // present, otherwise the scroll-top binding, with positions learned from bindscroll.

  // the scroll-view entity, only if this runtime exposes its scroll metrics
  _chat() {
    try {
      const el = this.querySelector ? this.querySelector('#chat') : null
      return el && typeof el.scrollHeight === 'number' ? el : null
    } catch (_) { return null }
  },

  // { top, height, client, live } — live from the entity, else from the last scroll
  // event (then height can be stale: content grows without firing scroll events)
  _metrics() {
    const el = this._chat()
    if (el) return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, live: true }
    const d = this._lastScroll
    return d ? { top: d.scrollTop, height: d.scrollHeight, client: d.clientHeight, live: false } : null
  },

  // furthest position we may scroll to (stale height: overshoot, the runtime clamps)
  _maxTop(m) {
    return m.live ? Math.max(0, m.height - m.client) : m.top + m.client * 2
  },

  onChatScroll(e) {
    const d = e && e.detail
    if (!d) return
    this._lastScroll = d
    this.data.scrollTop = d.scrollTop   // silent sync, so a re-render never jumps back
  },

  _scrollTo(top, smooth) {
    top = Math.max(0, Math.round(top))
    const el = this._chat()
    if (el && typeof el.scrollTo === 'function') {
      this.data.scrollTop = top
      const r = el.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' })
      if (r && r.catch) r.catch(() => {})
      return
    }
    // scroll-top only reacts when the bound value changes
    this.setData({ scrollTop: top === this.data.scrollTop ? top + 1 : top })
  },

  // height of the dialog content (the #log view, else the scroll-view's content)
  _contentHeight() {
    try {
      const log = this.querySelector && this.querySelector('#log')
      if (log && log.clientHeight > 0) return log.clientHeight
    } catch (_) {}
    const m = this._metrics()
    return m ? m.height : 0
  },

  // keep the newest text in view, but never past the start of the current question
  // (a moment later, once the runtime has laid out the new content)
  _follow() {
    if (this._followTimer) return
    this._followTimer = setTimeout(() => { this._followTimer = null; this._followNow() }, 50)
  },

  _followNow() {
    if (this._reading || this._userScrolled) return
    const m = this._metrics()
    if (!m) return this._scrollTo(1)   // size unknown yet: a 1px nudge reports it via bindscroll
    let top = this._maxTop(m)
    if (this._turnStart != null) top = Math.min(top, this._turnStart)
    if (top > m.top + 1) this._scrollTo(top, true)
  },

  _scrollToEnd() {
    if (this._userScrolled) return   // the user swiped back to read: leave the view there
    const m = this._metrics()
    this._scrollTo(m ? m.height : 1000000, true)
  },

  // temple swipe (ArrowUp / ArrowDown): scroll by ~60% of a screen
  _scrollPage(dir) {
    this._stopReadScroll()
    this._userScrolled = true   // until the next question
    const m = this._metrics()
    if (!m) return this._scrollTo((this.data.scrollTop > 100000 ? 0 : this.data.scrollTop) + dir * 150, true)
    const step = m.client > 0 ? m.client * 0.6 : 150
    this._scrollTo(Math.min(m.top + dir * step, this._maxTop(m)), true)
  },

  // slowly scroll the answer while it is read, keeping the spoken part ~1/3 down the screen
  _startReadScroll(durationMs) {
    this._stopReadScroll()
    const m0 = this._metrics()
    const start = this._turnStart
    if (!m0 || start == null || durationMs <= 0) return
    if (m0.live && this._contentHeight() - start <= m0.client) return   // fits on one screen
    if (!m0.live) this._scrollTo(m0.top + 1)   // 1px nudge: the scroll event reports the final size
    this._reading = true
    const t0 = Date.now()
    this._readTimer = setInterval(() => {
      try {
        const m = this._metrics()
        if (!m) return
        // real subtitle position when available, else elapsed time vs estimate
        const p = Math.min(1, this._ttsProgress != null ? this._ttsProgress : (Date.now() - t0) / durationMs)
        const spokenY = start + p * (this._contentHeight() - start)
        const top = Math.min(Math.max(0, m.height - m.client), spokenY - m.client * 0.35)
        if (top > m.top + 0.5) this._scrollTo(top, false)
        if (p >= 1 && this._ttsProgress == null) this._stopReadScroll()
      } catch (_) { this._stopReadScroll() }
    }, 100)
  },

  _stopReadScroll() {
    // guard: the AIUI runtime throws on clearInterval(undefined / null)
    if (this._readTimer) clearInterval(this._readTimer)
    this._readTimer = null
    this._reading = false
  },

  // ---- continuous voice conversation (one tap, mic stays hot, no per-turn tap) ----
  // temple tap: (re)start listening. While reading, the voice keeps going (like the
  // native assistant) and the mic takes the next question, which then ends the reading.
  // A tap is a user gesture, so the mic is always allowed to open here.
  captureAndAsk() {
    this._muteUntil = 0   // a tap means "I'm about to speak": drop the TTS echo guard
    if (this._tts) {
      this._barge = true
      this._startListening()
      return this._setStatus(this._rec ? 'listening' : 'speaking')
    }
    if (!this._busy) this._startListening()   // still thinking: ignore
  },

  // retire the recognizer we own: we stopped it, so ignore anything it still sends
  _dropRec(method) {
    const rec = this._rec
    this._rec = null
    if (rec) { rec._retired = true; try { rec[method]() } catch (_) {} }
  },

  // On the glasses the recognizer can report error/end early and still deliver
  // results, so neither event retires it or changes the screen. A tap only creates
  // a new recognizer once the current one has reported end.
  _startListening() {
    if (this._rec && !this._rec._ended) { if (!this._busy) this._setStatus('listening'); return }
    this._rec = null
    if (typeof SpeechRecognition === 'undefined') return this._setStatus('ready')
    this._stopped = false
    if (this._draftId) {   // a new recognizer drops the half-recognized question line
      const id = this._draftId
      this._draftId = this._draftReady = null
      this.setData({ turns: this.data.turns.filter((t) => t.id !== id) })
    }
    if (!this._busy) this._setStatus('listening')
    const rec = (this._rec = new SpeechRecognition())
    rec.lang = this._asrLang || BRIDGE_CONFIG.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      if (rec._retired) return                         // a recognizer we stopped
      if (Date.now() < (this._muteUntil || 0)) return  // tail of our own TTS
      const results = e.results || []
      let interim = ''
      for (let i = e.resultIndex; i < results.length; i++) {
        const t = results[i] && results[i][0] && results[i][0].transcript
        if (!t) continue
        if (this._tts && !this._isExit(t) && this._isEcho(t)) { this._debug('echo ' + t); continue }
        this._debug((results[i].isFinal ? 'final ' : 'interim ') + t)
        if (results[i].isFinal) this._handleUtterance(t)
        else interim += t
      }
      if (interim) this._onInterim(interim)
    }
    rec.onerror = (e) => this._debug('error ' + (e && (e.error || e.message)))
    rec.onend = () => { rec._ended = true; this._debug('end') }
    try {
      rec.start()
      this._debug('start')
    } catch (e) {
      this._rec = null
      if (!this._busy) this._setStatus('ready')
      this._debug('start failed ' + (e && e.message))
    }
  },

  // config debug: show recognizer events in the hint line (and the console)
  _debug(msg) {
    console.log('[asr]', msg)
    if (BRIDGE_CONFIG.debug) this.setData({ hint: 'asr: ' + msg })
  },

  // timing of one answer, from the question: first text, answer complete, speech
  // requested, audio ready, playing. Logged (and shown with config debug) at each play.
  _mark(name) {
    if (name === 'question') this._marks = { t0: Date.now(), list: [] }
    const m = this._marks
    if (!m || (name === 'text' && m.text)) return
    if (name === 'text') m.text = true
    m.list.push(name + ' ' + ((Date.now() - m.t0) / 1000).toFixed(1) + 's')
    if (name !== 'playing') return
    console.log('[tts] timing', m.list.join(' · '))
    if (BRIDGE_CONFIG.debug) this.setData({ hint: m.list.slice(1).join(' · ') })
  },

  // after an answer: keep listening on the recognizer we own (a tap renews it)
  _resumeListening() {
    this._muteUntil = Date.now() + 700
    this._setStatus(this._rec ? 'listening' : 'ready')
  },

  async _handleUtterance(text) {
    const t = (text || '').trim()
    if ((this._busy && !this._barge) || !t) return
    if (this._barge) this._stopSpeaking()   // a question asked while reading ends the reading
    this._busy = true
    this._mark('question')
    await this._commitUserTurn(t)
    if (this._isExit(t)) { this._endConversation(); return }
    const ok = await this.ask(t)
    const ans = this._answer
    this._mark('answer')
    if (!ok || !ans) {
      // FAILED (error already shown by ask) — stop listening, keep the error visible
      this._busy = false
      this._dropRec('stop')
      return this._setStatus('ready')
    }
    const zh = this._isChinese(ans)
    if (BRIDGE_CONFIG.readAloud !== false) {
      // mic results ignored while reading aloud (TTS echo), unless a tap opened it
      this._setStatus('speaking')
      const interrupted = await this._speak(ans, zh)
      if (interrupted) return   // a new question took over
      this._stopReadScroll()
      if (!this._draftId) this._turnStart = null   // keep it for a question being spoken
      this._scrollToEnd()
    } else {
      this._startReadScroll(this._estimateSpeechMs(ans, zh) * 0.7)
      this._turnStart = null
    }
    this._busy = false
    this._resumeListening()
  },

  // Read the answer aloud. Resolves true if interrupted by a tap, false when done.
  // The voice follows the language of the answer, not the system language
  // (AIUI ignores utterance.lang; only the voice id selects the language).
  // Prefers synthesize() + SpeechAudioPlayer: it can be stopped, reports when
  // playback really ends, and gives subtitle positions to pace the scrolling.
  // speak() has no stop and its end event may never fire, so it is the fallback.
  _speak(text, zh) {
    const est = this._estimateSpeechMs(text, zh)
    const voices = BRIDGE_CONFIG.ttsVoices || {}
    this._ttsProgress = null
    return new Promise((resolve) => {
      let timer = null
      const tts = {
        text,
        finish: (interrupted) => {
          if (this._tts !== tts) return
          this._tts = this._ttsProgress = null
          this._barge = false
          if (timer) clearTimeout(timer)
          resolve(!!interrupted)
        },
      }
      this._tts = tts
      if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return tts.finish(false)
      const arm = (ms) => { if (timer) clearTimeout(timer); timer = setTimeout(() => this._stopSpeaking(false), Math.min(300000, ms)) }
      const u = new SpeechSynthesisUtterance(text)
      u.voice = zh ? (voices.zh || 'female-yujie') : (voices.en || 'English_radiant_girl')
      u.lang = zh ? 'zh-CN' : 'en-US'
      const speakSimple = () => {
        if (this._tts !== tts) return
        arm(est * 1.1 + 1000)
        u.onend = u.onerror = () => tts.finish(false)
        this._startReadScroll(est)
        this._mark('speak')
        try { speechSynthesis.speak(u) } catch (_) { tts.finish(false) }
        this._mark('playing')
      }
      if (this._noPlayer || typeof speechSynthesis.synthesize !== 'function' || typeof SpeechAudioPlayer === 'undefined') return speakSimple()
      arm(est * 1.5 + 8000)   // safety net only; onEnded normally ends it
      this._mark('synth')
      speechSynthesis.synthesize(u, { subtitles: 'sentence' }).then((task) => {
        if (this._tts !== tts) { try { task.abort() } catch (_) {} return }
        const player = (tts.player = new SpeechAudioPlayer(task, { trackMode: 'hidden' }))
        tts.task = task
        // AudioPlayer.play() is unavailable in the card (_current) target: fall back to speak()
        const fallback = () => {
          this._noPlayer = true   // until the target changes
          try { task.abort() } catch (_) {}
          try { player.destroy() } catch (_) {}
          tts.player = tts.task = null
          speakSimple()
        }
        player.audioPlayer.onCanplay(() => {
          if (this._tts !== tts || !tts.player) return
          this._mark('audio')
          try { player.play(); this._mark('playing') } catch (_) { fallback() }
        })
        player.audioPlayer.onEnded(() => tts.finish(false))
        task.onerror = () => tts.finish(false)
        // generation done: the real length is known, so tighten the safety net
        task.onend = (e) => {
          if (this._tts === tts && tts.player && e && e.duration > 0) arm((e.duration - (player.currentTime || 0)) * 1000 + 2000)
        }
        player.textTrack.addEventListener('cuechange', () => {
          const cue = player.textTrack.activeCues.item(0)
          if (cue && Number.isInteger(cue.charIndex)) {
            this._ttsProgress = (cue.charIndex + (cue.charLength || 0) / 2) / Math.max(1, text.length)
          }
        })
        this._startReadScroll(est)
      }).catch(speakSimple)
    })
  },

  // stop reading aloud now (interrupted = true when the user tapped)
  _stopSpeaking(interrupted = true) {
    const tts = this._tts
    if (!tts) return
    try { if (tts.player) tts.player.stop() } catch (_) {}
    try { if (tts.task && tts.task.state === 'running') tts.task.abort() } catch (_) {}
    try { if (tts.player) tts.player.destroy() } catch (_) {}
    try { if (!tts.player && typeof speechSynthesis.cancel === 'function') speechSynthesis.cancel() } catch (_) {}
    this._stopReadScroll()
    console.log('[tts] stop')
    tts.finish(interrupted)
  },

  // while reading with the mic open: is this our own voice coming back? Compares
  // pairs of neighbouring units (Han characters / words) with the text being read.
  _isEcho(text) {
    const units = (s) => (s || '').toLowerCase().match(/[\u3400-\u9fff\uf900-\ufaff]|[a-z0-9]+/g) || []
    const t = units(text), a = units(this._tts && this._tts.text)
    if (!t.length || !a.length) return false
    if (t.length < 3) return (' ' + a.join(' ') + ' ').includes(' ' + t.join(' ') + ' ')
    const pairs = new Set(a.slice(1).map((u, i) => a[i] + ' ' + u))
    let hits = 0
    for (let i = 1; i < t.length; i++) if (pairs.has(t[i - 1] + ' ' + t[i])) hits++
    return hits / (t.length - 1) >= 0.7
  },

  // Chinese if Han characters make up a meaningful share of the text
  // (one Han char ~ half an English word, so a few English terms don't flip it)
  _isChinese(text) {
    const han = count(text, HAN)
    return han > 0 && han * 2 >= count(text, /[A-Za-z]+/g)
  },

  // rough speaking time: ~4 Han chars/s, ~160 English words/min
  _estimateSpeechMs(text, zh) {
    return 800 + count(text, HAN) * 240 + count(text, /[A-Za-z0-9]+/g) * (zh ? 450 : 380)
  },

  _isExit(text) {
    return /^(退出|停止|结束|exit|stop|bye)$/i.test((text || '').trim())
  },

  _endConversation() {
    this._dropRec('stop')
    this._busy = false
    this._turnStart = null
    this._setStatus('ready', {
      turns: this.data.turns.concat([{ id: this._nextId(), role: 'note', text: this.data.strings.ended || '（会话已结束）' }]),
    })
    setTimeout(() => this._follow(), 50)
  },

  _setStatus(status, extra) {
    const s = this.data.strings || {}
    const [chip, hint] = {
      listening: [s.chipListening, s.hintListening],
      working: [s.chipThinking, s.hintWorking],
      speaking: [s.chipSpeaking, s.hintSpeaking],
    }[status] || [s.chipReady, s.hintIdle]
    this.setData(Object.assign({ status, chip, hint }, extra))
  },

  // capture a photo with the AIUI camera API and send it with the query (vision)
  async askWithPhoto(text) {
    let imageDataUrl = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const blob = await new ImageCapture(stream.getVideoTracks()[0]).takePhoto({ mode: 'default' })
      imageDataUrl = await new Promise((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => resolve('')
        fr.readAsDataURL(blob)
      })
      stream.getTracks().forEach(t => t.stop())
    } catch (e) {
      // no camera / permission denied — fall back to text only
    }
    const q = text || '看看这个'
    await this._commitUserTurn(q)
    await this.ask(q, imageDataUrl || undefined)
  },

  onKeyUp(event) {
    const code = event.code
    if (code === 'Backspace' || code === 'Escape') return this.stop()
    // temple tap (GlobalHook) or Enter = start talking (valid user gesture
    // so SpeechRecognition is allowed to open the mic)
    if (code === 'GlobalHook' || code === 'Enter') return this.captureAndAsk()
    // temple swipe: the default only scrolls the (fixed) root view, so take it over
    // and scroll the dialog instead (also pauses the reading auto-scroll)
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      if (event.preventDefault) event.preventDefault()
      this._scrollPage(code === 'ArrowUp' ? -1 : 1)
    }
  },

  onLoad(query) {
    this._stopped = false
    // follow the system / Hi Rokid language for the UI + speech recognition
    this._asrLang = (BRIDGE_CONFIG.lang && BRIDGE_CONFIG.lang !== 'auto')
      ? BRIDGE_CONFIG.lang
      : (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US')
    this.setData({
      strings: this._strings(this._asrLang),
      showTalkButton: BRIDGE_CONFIG.showTalkButton === true,
      ...this._layout(),
    })
    this._setStatus('ready')
    // semantic wake-up: "Hi Rokid, open the xxx agent" may pass the spoken query.
    // AIUI SpeechRecognition requires a user gesture (interactive), so do NOT
    // auto-start ASR on load; the user taps the temple to talk.
    const q = query && (query.text || query.query || query.q)
    if (q && typeof q === 'string' && q.trim()) this._handleUtterance(q.trim())
  },

  // the scroll-view needs a definite pixel height to overflow (a flex/100% height
  // grows with its content and is just clipped, so nothing can scroll).
  // The runtime reports window.innerHeight = 0, so the size comes from the target:
  // the card in the conversation flow (_current) is 448x150 with the footer hidden.
  _layout() {
    let h = 352   // Rokid Glasses full-screen (_blank) canvas height
    try { if (typeof window !== 'undefined' && window.innerHeight > 0) h = window.innerHeight } catch (_) {}
    if (this._target === '_current') h = Math.min(h, 150)
    const compact = h < 250
    // app padding 12+12, head 28, gap 8, foot 8+18 (+46 with the Talk button)
    const chrome = compact ? 60 : 86 + (BRIDGE_CONFIG.showTalkButton === true ? 46 : 0)
    return { scrollH: Math.max(60, Math.floor(h - chrome)), compact }
  },

  // fires at startup and on card (_current) <-> full screen (_blank, double tap).
  // AudioPlayer.play() is unavailable in the card, so read aloud with speak() there.
  onTargetChanged(target) {
    this._target = target
    this._noPlayer = target === '_current'
    this.setData(this._layout())
  },

  // UI strings by language; zh for zh-*, otherwise English
  _strings(lang) {
    return /^zh/i.test(lang || '') ? {
      chipReady: '就绪', chipListening: '聆听中', chipThinking: '思考中', chipSpeaking: '播报中',
      idle: '轻按眼镜腿开始对话', say: '请讲…', thinking: '正在思考…',
      talk: '说话', hintIdle: '眼镜腿 tap = 开始 · 说「退出」结束',
      hintListening: '正在听 · 说完即可', hintWorking: '请稍候', hintSpeaking: '眼镜腿 tap = 提问',
      ended: '（会话已结束）',
    } : {
      chipReady: 'READY', chipListening: 'LISTENING', chipThinking: 'THINKING', chipSpeaking: 'SPEAKING',
      idle: 'Tap the temple to start', say: 'Your turn…', thinking: 'Thinking…',
      talk: 'Talk', hintIdle: 'temple tap = start · say "exit" to stop',
      hintListening: 'listening · just speak', hintWorking: 'one moment', hintSpeaking: 'temple tap = ask',
      ended: '(conversation ended)',
    }
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
      <scroll-view id="chat" class="scroll" style="height: {{ scrollH }}px;" scroll-y="true" show-scrollbar="true" scroll-top="{{ scrollTop }}" bindscroll="onChatScroll">
        <view id="log" class="log">
          <text class="line idle" ink:if="{{ !turns.length }}">{{ status === 'listening' ? strings.say : strings.idle }}</text>
          <view class="turn" ink:for="{{ turns }}" ink:key="id">
            <text class="line {{ item.role }} {{ item.pending ? 'pending' : '' }}">{{ item.pending ? strings.thinking : item.text }}</text>
          </view>
        </view>
      </scroll-view>
    </view>
    <view class="foot {{ compact ? 'hidden' : '' }}">
      <button class="talk {{ showTalkButton ? '' : 'hidden' }} {{ status === 'listening' ? 'listening' : status === 'working' ? 'working' : '' }}" bindtap="captureAndAsk">{{ strings.talk }}</button>
      <text class="hint">{{ hint }}</text>
    </view>
  </view>
</page>

<style>
.app { display: flex; flex-direction: column; height: 100vh; padding: 12px 16px; box-sizing: border-box; overflow: hidden; }
.head { display: flex; flex-direction: row; height: 28px; flex-shrink: 0; align-items: center; justify-content: space-between; width: 100%; }
.brand { color: #40FF5E; font-size: 18px; font-weight: bold; letter-spacing: 1px; }
.state { display: flex; flex-direction: row; align-items: center; }
.chip { color: #123a1d; background-color: #40FF5E; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: bold; letter-spacing: 1px; }
.body { width: 100%; flex-shrink: 0; margin-top: 8px; overflow: hidden; }
.scroll { width: 100%; height: 266px; }
.scroll::-webkit-scrollbar { width: 3px; background-color: transparent; }
.scroll::-webkit-scrollbar-thumb { background-color: rgba(64,255,94,0.48); border-radius: 2px; }
.log { display: flex; flex-direction: column; width: 100%; padding-right: 8px; padding-bottom: 12px; box-sizing: border-box; }
.turn { width: 100%; margin-bottom: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background-color: #40FF5E; margin-right: 8px; flex: 0 0 auto; animation: pulse 1.1s ease-in-out infinite; }
.line { width: 100%; text-align: left; font-size: 20px; line-height: 30px; white-space: pre-wrap; }
.bot { color: #40FF5E; }
.user, .note, .idle, .pending { color: rgba(64,255,94,0.48); }
.foot { display: flex; flex-direction: column; flex-shrink: 0; align-items: center; margin-top: 8px; }
.talk { margin-bottom: 8px; color: #40FF5E; border: 1px solid #40ff5d55; border-radius: 999px; padding: 8px 26px; font-size: 16px; line-height: 20px; text-align: center; transition: all .2s; }
.talk.listening { border: 2px solid #40FF5E; animation: pulse 1.1s ease-in-out infinite; }
.talk.working { border: 1px dashed #40FF5E; opacity: .8; }
.hidden { display: none; }
.hint { color: #2aa046; font-size: 13px; line-height: 18px; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(64,255,94,.5); }
  50% { box-shadow: 0 0 0 8px rgba(64,255,94,0); }
}
</style>
