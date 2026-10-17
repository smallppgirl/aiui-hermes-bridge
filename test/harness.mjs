// Test harness: loads the <script setup> of pages/index/index.ink as a module and
// fakes the AIUI runtime (setData, speech recognition, TTS, fetch/SSE, scroll-view).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hermes-test-'))

// config.js without the gitignored secrets.js
writeFileSync(join(dir, 'config.mjs'), readFileSync(join(root, 'config.js'), 'utf8')
  .replace(/import \{ SECRETS \} from '\.\/secrets\.js'/, "const SECRETS = { ak: 'test-ak' }"))
const ink = readFileSync(join(root, 'pages/index/index.ink'), 'utf8')
const script = ink.slice(ink.indexOf('<script setup>') + 14, ink.indexOf('</script>', ink.indexOf('<script setup>')))
writeFileSync(join(dir, 'page.mjs'), script.replace("'../../config.js'", "'./config.mjs'"))

export const { BRIDGE_CONFIG, buildPayload } = await import(pathToFileURL(join(dir, 'config.mjs')))
const page = (await import(pathToFileURL(join(dir, 'page.mjs')))).default
const CONFIG0 = JSON.parse(JSON.stringify(BRIDGE_CONFIG))

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(cond, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await sleep(5)
  }
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })

// like the AIUI (QuickJS) runtime: clearing an undefined/null timer throws
for (const name of ['clearTimeout', 'clearInterval']) {
  const real = globalThis[name]
  setGlobal(name, (id) => {
    if (id == null) throw new TypeError(`Error converting from js '${id}' into type 'i32' (${name})`)
    return real(id)
  })
}

// ---- speech recognition ----
export const recs = []
export class FakeRec {
  constructor() { recs.push(this); this.alive = false; this.calls = [] }
  start() { if (FakeRec.failStart) throw new Error('not-allowed'); this.alive = true; this.calls.push('start') }
  stop() { this.alive = false; this.calls.push('stop'); setTimeout(() => this.onend && this.onend(), 5) }
  abort() { this.alive = false; this.calls.push('abort'); setTimeout(() => this.onend && this.onend(), 5) }
  emit(t, isFinal = true) { this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal })] }) }
}

// ---- TTS: mode = synth | synth-fail | synth-hang | synth-card | speak | speak-noend | none ----
export const tts = { log: [], utterances: [], cues: [] }
export function setTTS(mode, durationMs = 60) {
  tts.log.length = 0
  tts.utterances.length = 0
  tts.cues = []
  delete globalThis.SpeechAudioPlayer
  delete globalThis.speechSynthesis
  setGlobal('SpeechSynthesisUtterance', class { constructor(t) { this.text = t; tts.utterances.push(this) } })
  if (mode === 'none') { delete globalThis.SpeechSynthesisUtterance; return }
  const speak = (u) => {
    tts.log.push('speak:' + u.voice)
    if (mode !== 'speak-noend') setTimeout(() => u.onend && u.onend(), durationMs)
  }
  if (mode === 'speak' || mode === 'speak-noend') return setGlobal('speechSynthesis', { speak })
  setGlobal('speechSynthesis', {
    speak,
    synthesize: async (u) => {
      tts.log.push('synth:' + u.voice)
      if (mode === 'synth-fail') throw new Error('synth unavailable')
      return { state: 'running', abort() { this.state = 'aborted'; tts.log.push('task.abort') } }
    },
  })
  setGlobal('SpeechAudioPlayer', class {
    constructor(task) {
      const self = this
      this.task = task
      this._cueListeners = []
      this._active = null
      this.textTrack = {
        activeCues: { item: () => self._active },
        addEventListener: (_, f) => self._cueListeners.push(f),
      }
      this.audioPlayer = {
        onCanplay: (f) => setTimeout(f, 5),
        onEnded: (f) => { self._ended = f },
      }
      tts.player = this
    }
    play() {
      if (mode === 'synth-card') throw new Error('AudioPlayer.play() is unavailable while InkView target is _current')
      tts.log.push('play')
      if (mode === 'synth-hang') { setTimeout(() => this.task.onend && this.task.onend({ duration: 0.1 }), 20); return }
      // emit the configured cues spread over the duration, then end
      tts.cues.forEach((c, i) => setTimeout(() => { this._active = c; this._cueListeners.forEach((f) => f()) },
        (durationMs * (i + 1)) / (tts.cues.length + 1)))
      this._t = setTimeout(() => this._ended && this._ended(), durationMs)
    }
    stop() { tts.log.push('player.stop'); clearTimeout(this._t) }
    destroy() { tts.log.push('player.destroy') }
  })
}

// ---- fetch / SSE: queue of responses ----
export const net = { queue: [], calls: [] }
export const sse = (...parts) => parts.map((p) => `data: ${JSON.stringify({ type: 'answer', answer_stream: p })}\n\n`).join('')
setGlobal('fetch', async (url, opts) => {
  net.calls.push({ url, opts, body: JSON.parse(opts.body) })
  const r = net.queue.shift() || { body: '' }
  if (r.networkError) throw new TypeError('network timeout')
  if (r.hang) {
    return new Promise((_, reject) => opts.signal.addEventListener('abort',
      () => reject(new DOMException('aborted', 'AbortError'))))
  }
  const text = r.body
  const resp = { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => text, body: null }
  if (r.chunks) {
    const enc = new TextEncoder()
    const chunks = r.chunks.slice()
    resp.body = { getReader: () => ({ read: async () => (chunks.length
      ? { done: false, value: enc.encode(chunks.shift()) } : { done: true }) }) }
  }
  return resp
})

// ---- page instance + optional fake scroll-view ----
// scroll: 'entity' (AIUI >= 0.18 API), 'binding' (scroll-top + bindscroll only), or null
export function makePage({ lang = 'zh-CN', scroll = null, query, innerHeight = 352, config = {} } = {}) {
  Object.keys(BRIDGE_CONFIG).forEach((k) => delete BRIDGE_CONFIG[k])
  Object.assign(BRIDGE_CONFIG, JSON.parse(JSON.stringify(CONFIG0)), { lang: 'auto' }, config)
  setGlobal('navigator', { language: lang })
  setGlobal('window', { innerHeight })
  setGlobal('SpeechRecognition', FakeRec)
  FakeRec.failStart = false
  recs.length = 0
  net.queue.length = 0
  net.calls.length = 0
  const p = Object.assign({}, page)
  p.data = JSON.parse(JSON.stringify(page.data))
  p.renders = 0
  p.setData = function (d, cb) {
    Object.assign(this.data, d)
    this.renders++
    if (scroll === 'binding' && 'scrollTop' in d) sv.setPos(d.scrollTop)
    if (cb) setTimeout(cb, 1)
  }
  // content height: 30px per 20 chars of each line + 8px gap
  const sv = {
    scrollTop: 0,
    get clientHeight() { return p.data.scrollH },
    get scrollHeight() {
      const h = p.data.turns.reduce((a, t) => a + 8 + 30 * Math.max(1, Math.ceil((t.text || 'x').length / 20)), 0)
      return Math.max(this.clientHeight, h)
    },
    setPos(v) {
      const n = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))
      if (n === this.scrollTop) return
      this.scrollTop = n
      p.onChatScroll({ detail: { scrollTop: n, scrollHeight: this.scrollHeight, clientHeight: this.clientHeight } })
    },
  }
  if (scroll === 'entity') {
    sv.scrollTo = async ({ top }) => sv.setPos(top)
    p.querySelector = (s) => (s === '#chat' ? sv : null)
  }
  p.sv = sv
  p.onLoad(query || {})
  return p
}

export const tap = (p) => p.onKeyUp({ code: 'GlobalHook' })
export const key = (p, code) => { let prevented = false; p.onKeyUp({ code, preventDefault: () => { prevented = true } }); return prevented }
export const lastRec = () => recs[recs.length - 1]
export const userLines = (p) => p.data.turns.filter((t) => t.role === 'user').map((t) => t.text)
export const botLines = (p) => p.data.turns.filter((t) => t.role === 'bot').map((t) => t.text)
