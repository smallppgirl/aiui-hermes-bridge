import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_CONFIG, buildPayload, makePage, setTTS, tts, net, sse, recs, FakeRec, lastRec,
  tap, key, sleep, until, userLines, botLines,
} from './harness.mjs'

const idle = (p) => () => !p._busy && (p.data.status === 'listening' || p.data.status === 'ready')
async function askOnce(p, q, answer = '好的。') {
  net.queue.push({ body: sse(answer) })
  if (!p._rec) tap(p)
  p._muteUntil = 0   // skip the post-reading echo guard (tested separately)
  lastRec().emit(q)
  await until(idle(p))
}

// ---------------- pure helpers ----------------

test('language detection picks the dominant language of the answer', () => {
  const p = makePage()
  assert.equal(p._isChinese('你好世界'), true)
  assert.equal(p._isChinese('hello world'), false)
  assert.equal(p._isChinese('这是 React 和 Vue 的对比'), true)          // Chinese with English terms
  assert.equal(p._isChinese('I visited 北京 last year, it was great'), false)  // English with a Chinese name
  assert.equal(p._isChinese(''), false)
  assert.equal(p._isChinese('12345'), false)
  assert.equal(p._isChinese(null), false)
})

test('speech time estimate', () => {
  const p = makePage()
  assert.equal(p._estimateSpeechMs('你好', true), 800 + 2 * 240)
  assert.equal(p._estimateSpeechMs('hello world', false), 800 + 2 * 380)
  assert.equal(p._estimateSpeechMs('用 React', true), 800 + 240 + 450)
  assert.equal(p._estimateSpeechMs('', false), 800)
})

test('exit words', () => {
  const p = makePage()
  for (const w of ['退出', '停止', '结束', 'exit', 'Stop', ' BYE ']) assert.equal(p._isExit(w), true, w)
  for (const w of ['退出吧', 'stop it', 'hello', '']) assert.equal(p._isExit(w), false, w)
})

test('buildPayload: text only and with a photo', () => {
  const a = buildPayload('hi')
  assert.deepEqual(a.message, [{ role: 'user', type: 'text', text: 'hi' }])
  assert.equal(a.agent_id, BRIDGE_CONFIG.agentId)
  assert.equal(a.user_id, BRIDGE_CONFIG.userId)
  assert.match(a.message_id, /^aiui-\d+$/)
  const b = buildPayload('look', 'data:image/jpeg;base64,xx')
  assert.equal(b.message.length, 2)
  assert.deepEqual(b.message[1], { role: 'user', type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } })
})

test('UI strings and status chip follow the system language', () => {
  const zh = makePage({ lang: 'zh-CN' })
  assert.equal(zh.data.chip, '就绪')
  zh._setStatus('speaking')
  assert.equal(zh.data.chip, '播报中')
  assert.equal(zh.data.hint, '眼镜腿 tap = 打断并提问')
  const en = makePage({ lang: 'en-US' })
  assert.equal(en.data.chip, 'READY')
  en._setStatus('working')
  assert.equal(en.data.chip, 'THINKING')
  en._setStatus('listening', { inConversation: true })
  assert.equal(en.data.chip, 'LISTENING')
  assert.equal(en.data.inConversation, true)
  assert.equal(en.data.strings.thinking, 'Thinking…')
  const forced = makePage({ lang: 'en-US', config: { lang: 'zh-CN' } })   // config overrides system
  assert.equal(forced.data.chip, '就绪')
})

test('scroll-view height from the viewport', () => {
  assert.equal(makePage({ innerHeight: 352 }).data.scrollH, 266)
  assert.equal(makePage({ innerHeight: 352, config: { showTalkButton: true } }).data.scrollH, 220)
  assert.equal(makePage({ innerHeight: 0 }).data.scrollH, 266)   // falls back to the 352px canvas
  assert.equal(makePage({ innerHeight: 100 }).data.scrollH, 120) // minimum
})

// ---------------- bridge request / SSE ----------------

test('streams SSE chunks split across reads, ignores other events and junk', async () => {
  setTTS('synth')
  const p = makePage()
  const full = sse('你好，', '我是 ', 'Hermes。')
  const junk = 'data: {"type":"tool_call","x":1}\r\n\r\ndata: not json\n\n: comment\n\n'
  const body = (junk + full).replace(/\n\n/g, '\r\n\r\n')
  net.queue.push({ chunks: [body.slice(0, 7), body.slice(7, 40), body.slice(40, 41), body.slice(41)] })
  tap(p)
  lastRec().emit('你是谁')
  await until(idle(p))
  assert.deepEqual(userLines(p), ['你是谁'])
  assert.deepEqual(botLines(p), ['你好，我是 Hermes。'])
  const req = net.calls[0]
  assert.equal(req.url, BRIDGE_CONFIG.url)
  assert.equal(req.opts.headers.Authorization, 'Bearer test-ak')
  assert.equal(req.body.message[0].text, '你是谁')
  assert.equal(req.body.metadata.language, 'zh-CN')
})

test('a final SSE block without the trailing blank line is still used', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ chunks: [sse('part one, ').trim(), '\n\n' + sse('part two').trim()] })
  tap(p)
  lastRec().emit('q')
  await until(idle(p))
  assert.deepEqual(botLines(p), ['part one, part two'])
})

test('non-streaming body (runtime buffers the response)', async () => {
  setTTS('synth')
  const p = makePage()
  await askOnce(p, '问题', '整段回答')
  assert.deepEqual(botLines(p), ['整段回答'])
})

test('HTTP error: retried once, then shows the error and stops listening', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ status: 500, body: 'boom' }, { status: 500, body: 'boom' })
  tap(p)
  const rec = lastRec()
  rec.emit('q')
  await until(() => !p._busy)
  assert.equal(net.calls.length, 2)
  assert.equal(botLines(p)[0], '（HTTP 500 boom）')
  assert.equal(p.data.status, 'ready')
  assert.equal(p.data.inConversation, false)
  assert.equal(p._rec, null)
  assert.ok(rec.calls.includes('stop'))
  assert.equal(tts.log.length, 0)
})

test('empty answer: retried once, then the error is shown', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ body: '' }, { body: '' })
  tap(p)
  lastRec().emit('q')
  await until(() => !p._busy)
  assert.equal(net.calls.length, 2)
  assert.equal(botLines(p)[0], '（未收到回复（桥返回空））')
})

test('network error then success: retry starts from a clean answer line', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ networkError: true }, { body: sse('ok') })
  tap(p)
  lastRec().emit('q')
  await until(idle(p))
  assert.equal(net.calls.length, 2)
  assert.deepEqual(botLines(p), ['ok'])
  assert.equal(p.data.turns.find((t) => t.role === 'bot').pending, false)
})

test('Backspace while thinking aborts the request without retry', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'working' && net.calls.length === 1)
  assert.equal(p.data.turns[1].pending, true)
  key(p, 'Backspace')
  await until(() => !p._busy && botLines(p)[0] === '（已停止）')
  assert.equal(net.calls.length, 1)
  assert.equal(p.data.status, 'ready')
  assert.equal(p.data.inConversation, false)
  assert.equal(p._rec, null)
})

test('long answers are capped to the last 4000 characters', async () => {
  setTTS('synth')
  const p = makePage({ config: { readAloud: false } })
  const long = 'a'.repeat(3000) + 'b'.repeat(2000)
  await askOnce(p, 'q', long)
  assert.equal(botLines(p)[0].length, 4000)
  assert.equal(botLines(p)[0], long.slice(-4000))
})

test('dialog keeps at most 20 lines, newest last', async () => {
  setTTS('synth', 5)
  const p = makePage({ config: { readAloud: false } })
  for (let i = 1; i <= 12; i++) {
    await askOnce(p, 'q' + i, 'a' + i)
  }
  assert.ok(p.data.turns.length <= 20, String(p.data.turns.length))
  assert.deepEqual(p.data.turns.slice(-2).map((t) => t.text), ['q12', 'a12'])
  assert.equal(new Set(p.data.turns.map((t) => t.id)).size, p.data.turns.length)
})

// ---------------- dialog lines ----------------

test('continuous dialog: nothing is cleared, each Q/A is appended', async () => {
  setTTS('synth', 20)
  const p = makePage()
  await askOnce(p, '第一个问题', '第一个回答')
  await askOnce(p, 'second question', 'second answer')
  assert.deepEqual(p.data.turns.map((t) => [t.role, t.text]), [
    ['user', '第一个问题'], ['bot', '第一个回答'], ['user', 'second question'], ['bot', 'second answer'],
  ])
})

test('"Thinking…" placeholder until the first chunk, then replaced by the answer', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.turns.length === 2)
  const bot = p.data.turns[1]
  assert.equal(bot.pending, true)
  assert.equal(bot.text, '')
  assert.equal(p.data.status, 'working')
  key(p, 'Backspace')
  await until(() => !p._busy)
})

test('interim results print the question live in one line, final settles it', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ body: sse('答') })
  tap(p)
  const rec = lastRec()
  rec.emit('今天', false)
  await sleep(20)
  rec.emit('今天天气', false)
  await sleep(20)
  assert.deepEqual(userLines(p), ['今天天气'])
  rec.emit('今天天气怎么样？')
  await until(idle(p))
  assert.deepEqual(userLines(p), ['今天天气怎么样？'])
  assert.equal(net.calls[0].body.message[0].text, '今天天气怎么样？')
})

test('a tap while a question is half recognized drops the half line', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  lastRec().emit('半句', false)
  await sleep(20)
  assert.deepEqual(userLines(p), ['半句'])
  tap(p)
  assert.deepEqual(userLines(p), [])
  assert.equal(p._draftId, null)
})

test('results while thinking are ignored (one request only)', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('first')
  await until(() => p.data.status === 'working')
  lastRec().emit('second')
  lastRec().emit('interim', false)
  await sleep(30)
  assert.equal(net.calls.length, 1)
  assert.deepEqual(userLines(p), ['first'])
  key(p, 'Backspace')
  await until(() => !p._busy)
})

test('exit word ends the conversation without calling the bridge', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  const rec = lastRec()
  rec.emit('退出')
  await until(() => p.data.turns.some((t) => t.role === 'note'))
  assert.equal(net.calls.length, 0)
  assert.equal(p.data.turns.at(-1).text, '（会话已结束）')
  assert.equal(p.data.status, 'ready')
  assert.equal(p.data.inConversation, false)
  assert.equal(p._rec, null)
  assert.equal(p._busy, false)
  assert.ok(rec.calls.includes('stop'))
})

test('semantic wake-up query is asked on load without a tap', async () => {
  setTTS('synth')
  net.queue.length = 0
  const p = makePage({ query: { text: '  打开 hermes 讲个笑话  ' } })
  net.queue.push({ body: sse('哈哈') })
  await until(() => net.calls.length === 1 && !p._busy)
  assert.equal(net.calls[0].body.message[0].text, '打开 hermes 讲个笑话')
  assert.deepEqual(botLines(p), ['哈哈'])
  assert.equal(p.data.status, 'ready')   // no recognizer yet: ready for a tap
})

test('askWithPhoto: no camera falls back to text, camera adds the image', async () => {
  setTTS('none')
  const p = makePage({ config: { readAloud: false } })
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
  net.queue.push({ body: sse('看到了') })
  await p.askWithPhoto()
  assert.equal(net.calls[0].body.message.length, 1)
  assert.equal(net.calls[0].body.message[0].text, '看看这个')
  // with a fake camera
  const stopped = []
  globalThis.navigator.mediaDevices = { getUserMedia: async () => ({
    getVideoTracks: () => [{}], getTracks: () => [{ stop: () => stopped.push(1) }] }) }
  globalThis.ImageCapture = class { async takePhoto() { return 'blob' } }
  globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/jpeg;base64,AA'; this.onload() } }
  net.queue.push({ body: sse('一只猫') })
  await p.askWithPhoto('这是什么')
  const msg = net.calls[1].body.message
  assert.equal(msg[0].text, '这是什么')
  assert.equal(msg[1].image_url.url, 'data:image/jpeg;base64,AA')
  assert.equal(stopped.length, 1)
  delete globalThis.ImageCapture
  delete globalThis.FileReader
})

// ---------------- TTS voice + reading ----------------

test('voice follows the answer language, not the system language', async () => {
  setTTS('synth', 10)
  const p = makePage({ lang: 'en-US' })
  await askOnce(p, '你好', '你好，很高兴见到你。')
  await askOnce(p, 'hello', 'Nice to meet you.')
  assert.deepEqual(tts.log.filter((l) => l.startsWith('synth')), ['synth:female-yujie', 'synth:English_radiant_girl'])
  assert.deepEqual(tts.utterances.map((u) => u.lang), ['zh-CN', 'en-US'])
})

test('custom voices from config', async () => {
  setTTS('speak', 10)
  const p = makePage({ config: { ttsVoices: { zh: 'lovely_girl', en: 'English_Trustworthy_Man' } } })
  await askOnce(p, 'q', 'An English answer.')
  assert.deepEqual(tts.log, ['speak:English_Trustworthy_Man'])
})

test('synthesize path: plays after canplay, back to listening on end', async () => {
  setTTS('synth', 80)
  const p = makePage()
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking')
  assert.equal(p.data.chip, '播报中')
  await until(idle(p))
  assert.deepEqual(tts.log, ['synth:female-yujie', 'play'])
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 1)   // same recognizer kept
  assert.equal(p._tts, null)
})

test('synthesize fails: falls back to speak()', async () => {
  setTTS('synth-fail', 20)
  const p = makePage()
  await askOnce(p, 'q', '回答')
  assert.deepEqual(tts.log, ['synth:female-yujie', 'speak:female-yujie'])
  assert.equal(p.data.status, 'listening')
})

test('synthesize never ends: safety-net timer finishes reading', async () => {
  setTTS('synth-hang')
  const p = makePage()
  p._estimateSpeechMs = () => -5200   // safety net = est * 1.5 + 8000 = 200ms
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => tts.log.includes('play'))
  assert.equal(p.data.status, 'speaking')   // playback started but never ends...
  await until(idle(p), 2000)                // ...the safety net finishes it
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p.data.status, 'listening')
})

test('speak() whose end event never fires: fallback timer finishes reading', async () => {
  setTTS('speak-noend')
  const p = makePage()
  p._estimateSpeechMs = () => -800   // fallback = est * 1.1 + 1000 = 120ms
  const t0 = Date.now()
  await askOnce(p, 'q', '回答')
  assert.ok(Date.now() - t0 >= 100, 'waited for the fallback timer')
  assert.equal(p.data.status, 'listening')
  assert.equal(p._tts, null)
})

test('no TTS available: answer shown, listening resumes', async () => {
  setTTS('none')
  const p = makePage()
  await askOnce(p, 'q', '回答')
  assert.deepEqual(botLines(p), ['回答'])
  assert.equal(p.data.status, 'listening')
})

test('readAloud=false: no speech, listening resumes', async () => {
  setTTS('synth')
  const p = makePage({ config: { readAloud: false } })
  await askOnce(p, 'q', '回答')
  assert.equal(tts.log.length, 0)
  assert.equal(p.data.status, 'listening')
})

// ---------------- temple tap / recognizer lifecycle ----------------

test('tap while reading stops the voice and listens immediately', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ body: sse('很长的回答') })
  tap(p)
  const first = lastRec()
  first.emit('q')
  await until(() => p.data.status === 'speaking' && tts.log.includes('play'))
  tap(p)
  assert.equal(p.data.status, 'listening')
  assert.equal(p._busy, false)
  assert.ok(tts.log.includes('player.stop') && tts.log.includes('player.destroy'))
  assert.equal(recs.length, 2)
  assert.notEqual(p._rec, first)
  await sleep(20)                     // old recognizer's late onend must not clear the new one
  assert.equal(p._rec, recs[1])
  assert.equal(p.data.status, 'listening')
  net.queue.push({ body: sse('第二个回答') })
  recs[1].emit('next')                // a new question works right away (no mute after a tap)
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q', 'next'])
})

test('tap while reading with speak() (no stop API) still switches to listening', async () => {
  setTTS('speak-noend')
  const p = makePage()
  await (async () => { net.queue.push({ body: sse('回答') }); tap(p); lastRec().emit('q') })()
  await until(() => p.data.status === 'speaking')
  tap(p)
  assert.equal(p.data.status, 'listening')
  assert.equal(p._tts, null)
  assert.equal(p._busy, false)
})

test('tap while thinking is ignored', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'working')
  tap(p)
  assert.equal(recs.length, 1)
  assert.equal(p.data.status, 'working')
  key(p, 'Backspace')
  await until(() => !p._busy)
})

test('echo guard: speech right after reading is ignored, later speech is used', async () => {
  setTTS('synth', 20)
  const p = makePage()
  await askOnce(p, 'q1', '回答一')
  lastRec().emit('TTS echo tail')
  await sleep(20)
  assert.deepEqual(userLines(p), ['q1'])
  await sleep(720)
  net.queue.push({ body: sse('回答二') })
  lastRec().emit('q2')
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q1', 'q2'])
})

test('recognizer dies while idle: shows READY, tap reopens it', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  assert.equal(p.data.status, 'listening')
  lastRec().onerror({ error: 'no-speech' })
  assert.equal(p.data.status, 'ready')
  assert.equal(p._rec, null)
  tap(p)
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 2)
  assert.ok(recs[1].alive)
})

test('recognizer dies during reading: reopened after reading ends', async () => {
  setTTS('synth', 150)
  const p = makePage()
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking')
  recs[0].onend()
  assert.equal(p.data.status, 'speaking')   // no READY flash while busy
  await until(idle(p))
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 2)
  assert.ok(recs[1].alive)
})

test('reopen refused without a gesture: READY, a tap then works', async () => {
  setTTS('synth', 100)
  const p = makePage()
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking')
  recs[0].onend()
  FakeRec.failStart = true
  await until(idle(p))
  assert.equal(p.data.status, 'ready')
  assert.equal(p._rec, null)
  FakeRec.failStart = false
  tap(p)
  assert.equal(p.data.status, 'listening')
})

test('no SpeechRecognition API: tap leaves the page ready', () => {
  setTTS('synth')
  const p = makePage()
  delete globalThis.SpeechRecognition
  tap(p)
  assert.equal(p.data.status, 'ready')
  assert.equal(p._rec, null)
})

test('Enter works like a temple tap', () => {
  setTTS('synth')
  const p = makePage()
  key(p, 'Enter')
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 1)
})

test('Backspace while reading stops the voice and the conversation', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking' && tts.log.includes('play'))
  key(p, 'Backspace')
  await until(() => !p._busy)
  await sleep(10)
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p.data.status, 'ready')
  assert.equal(p.data.inConversation, false)
  assert.equal(p._rec, null)
})

test('onUnload cleans up recognizer, request, speech and timers', async () => {
  setTTS('synth', 2000)
  const p = makePage({ scroll: 'entity' })
  net.queue.push({ body: sse('长'.repeat(400)) })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking' && tts.log.includes('play'))
  p.onUnload()
  assert.equal(p._rec, null)
  assert.equal(p._tts, null)
  assert.equal(p._readTimer, null)
  assert.equal(p._stopped, true)
  assert.ok(tts.log.includes('player.stop'))
})

// ---------------- scrolling ----------------

for (const mode of ['entity', 'binding']) {
  test(`[${mode}] streaming keeps the question at the top; reading scrolls to the end`, async () => {
    setTTS('synth', 1500)
    const p = makePage({ scroll: mode })
    const long = '这是一个很长的回答。'.repeat(60)   // ~600 chars, several screens
    tts.cues = Array.from({ length: 10 }, (_, i) => ({ charIndex: i * 60, charLength: 60 }))
    net.queue.push({ body: sse(...long.match(/.{1,20}/g)) })
    tap(p)
    lastRec().emit('讲个长故事')
    await until(() => p.data.status === 'speaking')
    const atStart = p.sv.scrollTop
    assert.ok(atStart <= 2, 'question stays on top while streaming: ' + atStart)
    const seen = []
    while (p.data.status === 'speaking') { seen.push(p.sv.scrollTop); await sleep(50) }
    const max = p.sv.scrollHeight - p.sv.clientHeight
    assert.ok(seen.some((v) => v > 0 && v < max), 'scrolled gradually while reading')
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'never scrolls back while reading')
    await sleep(20)
    assert.equal(p.sv.scrollTop, max, 'ends at the bottom')
  })

  test(`[${mode}] second question scrolls so it starts at the top`, async () => {
    setTTS('synth', 10)
    const p = makePage({ scroll: mode, config: { readAloud: false } })
    await askOnce(p, 'q1', '长'.repeat(400))
    p._muteUntil = 0
    const before = p.sv.scrollHeight
    net.queue.push({ hang: true })
    lastRec().emit('q2')
    await until(() => p.data.status === 'working')
    await sleep(30)
    assert.ok(Math.abs(p._turnStart - before) <= 1, `turnStart ${p._turnStart} vs ${before}`)
    assert.ok(p.sv.scrollTop <= p._turnStart, 'question start not scrolled past')
    assert.ok(p.sv.scrollTop >= p._turnStart - p.sv.clientHeight, 'question visible')
    key(p, 'Backspace')
    await until(() => !p._busy)
  })

  test(`[${mode}] temple swipe scrolls ~60% of a screen and pauses reading scroll`, async () => {
    setTTS('synth', 10)
    const p = makePage({ scroll: mode, config: { readAloud: false } })
    await askOnce(p, 'q', '长'.repeat(400))
    await sleep(50)
    p._stopReadScroll()
    p._scrollToEnd()
    await sleep(10)
    const max = p.sv.scrollHeight - p.sv.clientHeight
    assert.equal(p.sv.scrollTop, max)
    assert.equal(key(p, 'ArrowUp'), true, 'default root-view scroll prevented')
    await sleep(10)
    assert.equal(p.sv.scrollTop, max - Math.round(p.sv.clientHeight * 0.6))
    key(p, 'ArrowDown')
    await sleep(10)
    assert.equal(p.sv.scrollTop, max)
    key(p, 'ArrowDown')   // at the bottom: stays
    await sleep(10)
    assert.equal(p.sv.scrollTop, max)
    p._startReadScroll(5000)
    key(p, 'ArrowUp')
    assert.equal(p._reading, false, 'swipe pauses the reading auto-scroll')
  })
}

test('[binding] scroll-top always changes so the runtime re-applies it', () => {
  const p = makePage()
  p._scrollTo(100)
  assert.equal(p.data.scrollTop, 100)
  p._scrollTo(100)
  assert.equal(p.data.scrollTop, 101)
  p._scrollTo(-5)
  assert.equal(p.data.scrollTop, 0)
})

test('[binding] swipe before any scroll metrics moves by 150px', () => {
  const p = makePage()
  key(p, 'ArrowDown')
  assert.equal(p.data.scrollTop, 150)
})

test('scroll events sync scrollTop silently (no re-render)', () => {
  const p = makePage()
  const r = p.renders
  p.onChatScroll({ detail: { scrollTop: 42, scrollHeight: 900, clientHeight: 266 } })
  assert.equal(p.data.scrollTop, 42)
  assert.equal(p.renders, r)
  p.onChatScroll({})   // no detail: ignored
  assert.equal(p.data.scrollTop, 42)
})

test('short answer that fits on screen: no reading scroll', async () => {
  setTTS('synth', 100)
  const p = makePage({ scroll: 'entity' })
  net.queue.push({ body: sse('短') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking')
  assert.equal(p._reading, false)
  assert.equal(p.sv.scrollTop, 0)
  await until(idle(p))
})
