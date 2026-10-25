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
  assert.deepEqual(b.message[1], { role: 'user', type: 'image', image_url: 'data:image/jpeg;base64,xx' })
})

test('UI strings and status chip follow the system language', () => {
  const zh = makePage({ lang: 'zh-CN' })
  assert.equal(zh.data.chip, '就绪')
  zh._setStatus('speaking')
  assert.equal(zh.data.chip, '播报中')
  assert.equal(zh.data.hint, '直接说话即可打断')
  const en = makePage({ lang: 'en-US' })
  assert.equal(en.data.chip, 'READY')
  en._setStatus('working')
  assert.equal(en.data.chip, 'THINKING')
  en._setStatus('listening')
  assert.equal(en.data.chip, 'LISTENING')
  assert.equal(en.data.strings.thinking, 'Thinking…')
  const forced = makePage({ lang: 'en-US', config: { lang: 'zh-CN' } })   // config overrides system
  assert.equal(forced.data.chip, '就绪')
})

test('scroll-view height from the viewport; small card hides the footer', () => {
  assert.equal(makePage({ innerHeight: 352 }).data.scrollH, 266)
  assert.equal(makePage({ innerHeight: 352 }).data.compact, false)
  assert.equal(makePage({ innerHeight: 352, config: { showTalkButton: true } }).data.scrollH, 220)
  assert.equal(makePage({ innerHeight: 0 }).data.scrollH, 266)    // falls back to the 352px canvas
  const card = makePage({ innerHeight: 150 })                       // 448x150 card in the conversation flow
  assert.equal(card.data.compact, true)
  assert.equal(card.data.scrollH, 90)
  assert.equal(makePage({ innerHeight: 100 }).data.scrollH, 60)   // minimum
})

test('target: card (_current) is compact and skips the audio player; full screen is not', () => {
  const p = makePage({ innerHeight: 0 })   // the runtime reports innerHeight = 0
  p.onTargetChanged('_current', null)
  assert.equal(p.data.compact, true)
  assert.equal(p.data.scrollH, 90)
  assert.equal(p._noPlayer, true)
  p.onTargetChanged('_blank', '_current')  // double tap -> full screen
  assert.equal(p.data.compact, false)
  assert.equal(p.data.scrollH, 266)
  assert.equal(p._noPlayer, false)
})

test('card target: answers are read with speak() without trying synthesize()', async () => {
  setTTS('synth', 10)
  const p = makePage()
  p.onTargetChanged('_current', null)
  await askOnce(p, 'q', '回答')
  assert.deepEqual(tts.log, ['speak:female-yujie'])
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
  assert.equal(p._rec, null)
})

test('debug: the hint shows the timing of the answer when its voice starts', async () => {
  setTTS('synth', 300)
  const p = makePage({ config: { debug: true } })
  net.queue.push({ body: sse('回答。') })
  tap(p)
  await sleep(20)   // after the mic's audiostart, which is shown too
  lastRec().emit('q')
  await until(() => tts.log.includes('play'))
  assert.match(p.data.hint, /^text \d+\.\ds · (answer \d+\.\ds · )?synth \d+\.\ds · (answer \d+\.\ds · )?audio \d+\.\ds · playing \d+\.\ds$/)
  key(p, 'Backspace')
  await until(() => !p._busy)
})

test('long answers are capped to the last 20000 characters', async () => {
  setTTS('synth')
  const p = makePage({ config: { readAloud: false } })
  const long = 'a'.repeat(15000) + 'b'.repeat(10000)
  await askOnce(p, 'q', long)
  assert.equal(botLines(p)[0].length, 20000)
  assert.equal(botLines(p)[0], long.slice(-20000))
})

test('leading blank lines and spaces of an answer are dropped, inner ones kept', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ chunks: [sse('\n\n').trim() + '\n\n', sse(' ', ' 你好').trim() + '\n\n', sse('\n\n世界').trim() + '\n\n'] })
  tap(p)
  lastRec().emit('问题')
  await until(idle(p))
  assert.equal(botLines(p)[0], '你好\n\n世界')
  assert.equal(tts.utterances.map((u) => u.text).join(''), '你好\n\n世界')
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

test('a tap while listening keeps the recognizer and the half-recognized line', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  lastRec().emit('半句', false)
  await sleep(20)
  tap(p)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].calls.join(), 'start')   // never aborted by a tap
  assert.deepEqual(userLines(p), ['半句'])
})

test('a tap after the recognizer ended starts a new one and drops the half line', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  lastRec().emit('半句', false)
  await sleep(20)
  recs[0].onend()
  tap(p)
  assert.equal(recs.length, 2)
  assert.equal(p._rec, recs[1])
  assert.deepEqual(recs[0].calls, ['start'])   // the ended one is not aborted
  assert.deepEqual(userLines(p), [])
  assert.equal(p.data.status, 'listening')
})

test('a question while thinking cancels the pending answer and asks the new one', async () => {
  setTTS('synth', 10)
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('first')
  await until(() => p.data.status === 'working')
  net.queue.push({ body: sse('第二个回答') })
  lastRec().emit('second')
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.equal(net.calls.length, 2)
  assert.ok(net.calls[0].opts.signal.aborted, 'the first request was aborted')
  assert.deepEqual(userLines(p), ['first', 'second'])
  assert.deepEqual(botLines(p), ['（已停止）', '第二个回答'])
  assert.equal(p.data.status, 'listening')
})

test('a question while the answer streams: the old request is not retried, even if its abort is not an AbortError', async () => {
  setTTS('synth', 10)
  const p = makePage({ config: { readAloud: false } })
  net.queue.push({ chunks: slow('一', '二', '三', '四', '五', '六').chunks, chunkDelay: 100, abortError: new TypeError('stream closed') })
  tap(p)
  lastRec().emit('写一首长诗')
  await until(() => botLines(p)[0] && botLines(p)[0].length > 0)
  net.queue.push({ body: sse('二。') })
  lastRec().emit('算了，一加一等于几')
  await until(() => botLines(p).length === 2 && !p._busy)
  await sleep(700)                         // a retry would come 0.5 s after the error
  assert.deepEqual(net.calls.map((c) => c.body.message[0].text), ['写一首长诗', '算了，一加一等于几'])
  assert.match(botLines(p)[0], /（已停止）$/)
  assert.equal(botLines(p)[1], '二。')
})

test('a question while the answer streams: nothing more of the old answer is read, the new one is', async () => {
  setTTS('synth', 50)
  const p = makePage()
  net.queue.push({ chunks: slow('第一句诗。', '第二句诗。', '第三句诗。', '第四句诗。').chunks, chunkDelay: 60 })
  tap(p)
  lastRec().emit('写一首长诗')
  await until(() => texts().length > 0)
  const commit = p._commitUserTurn.bind(p)
  p._commitUserTurn = async (t) => { await sleep(200); return commit(t) }   // a slow render: old chunks keep coming
  net.queue.push({ body: sse('二。') })
  const n = texts().length
  lastRec().emit('算了，一加一等于几')
  await until(() => botLines(p).length === 2 && !p._busy, 5000)
  assert.deepEqual(texts().slice(n), ['二。'], 'only the new answer is read')
  assert.match(botLines(p)[0], /（已停止）$/)
  assert.equal(p.data.status, 'listening')
})

test('an exit word while thinking stops the request and ends the conversation', async () => {
  setTTS('synth')
  const p = makePage()
  net.queue.push({ hang: true })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'working')
  lastRec().emit('退出')
  await until(() => p.data.turns.some((t) => t.role === 'note') && !p._busy)
  assert.ok(net.calls[0].opts.signal.aborted)
  assert.equal(net.calls.length, 1)
  assert.equal(p.data.status, 'ready')
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
  assert.equal(p.data.status, 'listening')   // a mic opens after the answer...
  assert.equal(recs.length, 1)
})

test('semantic wake-up: if the mic may not open without a tap, ready for a tap', async () => {
  setTTS('synth')
  net.queue.length = 0
  try {
    const p = makePage({ query: { text: '讲个笑话' } })
    FakeRec.failStart = true
    net.queue.push({ body: sse('哈哈') })
    await until(() => net.calls.length === 1 && !p._busy)
    assert.equal(p.data.status, 'ready')
    assert.equal(p._rec, null)
  } finally { FakeRec.failStart = false }
})

// a fake camera: takePhoto() gives the bytes "hi" (base64 aGk=); fail = getUserMedia rejects
function fakeCamera({ fail } = {}) {
  const cam = { stopped: 0, settings: [] }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', mediaDevices: {
    getUserMedia: async () => {
      if (fail) throw new Error(fail)
      cam.openedAt = Date.now()
      return { getVideoTracks: () => [{}], getTracks: () => [{ stop: () => cam.stopped++ }] }
    } } }, configurable: true, writable: true })
  globalThis.ImageCapture = class { async takePhoto(s) {
    cam.settings.push(s)
    cam.shotAt = Date.now()
    return { type: 'image/jpeg', arrayBuffer: async () => new Uint8Array([104, 105]).buffer }
  } }
  return cam
}
const takePhotoSse = 'data: {"type": "tool_call", "tool_call": {"command": "take_photo"}, "is_finish": false}\n\n' +
  'data: {"type": "tool_call", "is_finish": true}\n\n'

test('askWithPhoto: no camera falls back to text, camera adds the image', async () => {
  setTTS('none')
  const p = makePage({ config: { readAloud: false } })
  fakeCamera({ fail: 'no camera' })
  net.queue.push({ body: sse('看到了') })
  await p.askWithPhoto()
  assert.equal(net.calls[0].body.message.length, 1)
  assert.equal(net.calls[0].body.message[0].text, '看看这个')
  const cam = fakeCamera()
  net.queue.push({ body: sse('一只猫') })
  await p.askWithPhoto('这是什么')
  const msg = net.calls[1].body.message
  assert.equal(msg[0].text, '这是什么')
  assert.deepEqual(msg[1], { role: 'user', type: 'image', image_url: 'data:image/jpeg;base64,aGk=' })
  assert.equal(cam.stopped, 1)
  delete globalThis.ImageCapture
})

test('the bridge asks for a photo: it is taken and the question asked again with it', async () => {
  setTTS('synth')
  const p = makePage()
  const cam = fakeCamera()
  net.queue.push({ body: takePhotoSse }, { body: sse('这是一只猫。') })
  const shown = []
  const patch = p._patchTurn.bind(p)
  p._patchTurn = (id, d) => { shown.push(d.text); return patch(id, d) }
  tap(p)
  lastRec().emit('这是什么')
  await until(() => botLines(p)[0] === '这是一只猫。' && !p._busy)
  assert.equal(net.calls.length, 2)
  assert.equal(net.calls[0].body.message.length, 1)
  assert.equal(net.calls[1].body.message[0].text, '这是什么')
  assert.deepEqual(net.calls[1].body.message[1], { role: 'user', type: 'image', image_url: 'data:image/jpeg;base64,aGk=' })
  assert.deepEqual(cam.settings, [{ quality: 'normal', mode: 'telephoto', enableSystemPreview: false }])
  assert.ok(cam.shotAt - cam.openedAt >= 950, 'waits ~1 s for the exposure: ' + (cam.shotAt - cam.openedAt) + ' ms')
  assert.equal(cam.stopped, 1)
  assert.ok(shown.includes('正在拍照…'))
  assert.ok(tts.utterances.some((u) => u.text === '这是一只猫。'))
  assert.equal(p.data.status, 'listening')
  delete globalThis.ImageCapture
})

test('photoSettleMs: 0 takes the photo at once; debug shows its size', async () => {
  setTTS('synth')
  const p = makePage({ config: { photoSettleMs: 0, debug: true } })
  const cam = fakeCamera()
  await p._takePhoto()
  assert.ok(cam.shotAt - cam.openedAt < 50)
  assert.match(p.data.hint, /photo 0 KB$/)
  delete globalThis.ImageCapture
})

test('the bridge asks for a photo in the card: no camera, a hint to go full screen, no retry', async () => {
  setTTS('synth')
  const p = makePage()
  p.onTargetChanged('_current')
  const cam = fakeCamera()
  net.queue.push({ body: takePhotoSse })
  tap(p)
  lastRec().emit('这是什么')
  await until(() => !p._busy && p.data.status === 'ready')
  assert.equal(net.calls.length, 1)
  assert.equal(cam.settings.length, 0)
  assert.equal(botLines(p)[0], '（拍照需要全屏：双击卡片进入全屏后再问）')
  delete globalThis.ImageCapture
})

test('the bridge asks for a photo and the camera fails: the error is shown, no retry', async () => {
  setTTS('synth')
  const p = makePage()
  fakeCamera({ fail: 'NotAllowedError' })
  net.queue.push({ body: takePhotoSse })
  tap(p)
  lastRec().emit('这是什么')
  await until(() => !p._busy && p.data.status === 'ready')
  assert.equal(net.calls.length, 1)
  assert.equal(botLines(p)[0], '（拍照失败：NotAllowedError）')
  delete globalThis.ImageCapture
})

test('the bridge asks for a photo again although one was sent: no loop, empty answer shown', async () => {
  setTTS('synth')
  const p = makePage()
  const cam = fakeCamera()
  net.queue.push({ body: takePhotoSse }, { body: takePhotoSse }, { body: takePhotoSse })
  tap(p)
  lastRec().emit('这是什么')
  await until(() => !p._busy && p.data.status === 'ready')
  assert.equal(cam.settings.length, 1)
  assert.equal(net.calls.length, 3)   // the photo request, then once more on the "empty" retry
  assert.equal(botLines(p)[0], '（未收到回复（桥返回空））')
  delete globalThis.ImageCapture
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
  assert.deepEqual(tts.log, ['synth:female-yujie', 'play', 'player.destroy'])
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 1)   // same recognizer kept
  assert.equal(p._tts, null)
})

// ---------------- reading while the answer streams ----------------

const texts = () => tts.utterances.map((u) => u.text)
const slow = (...parts) => ({ chunks: parts.map((x) => sse(x).trim() + '\n\n'), chunkDelay: 60 })

test('sentence end: Chinese/English punctuation and line breaks, not decimals or a bare dot', () => {
  const p = makePage()
  assert.equal(p._sentenceEnd('第一句。第二', 0), 4)
  assert.equal(p._sentenceEnd('第一句。第二句！第三', 0), 8)
  assert.equal(p._sentenceEnd('他说：“好。”然后', 0), 7)
  assert.equal(p._sentenceEnd('Pi is 3.14 and', 0), 0)
  assert.equal(p._sentenceEnd('It ends here.', 0), 0)          // could still be "here.5": wait
  assert.equal(p._sentenceEnd('It ends here. Next', 0), 13)
  assert.equal(p._sentenceEnd('Really? Yes', 0), 7)
  assert.equal(p._sentenceEnd('段落一\n段落二', 0), 4)
  assert.equal(p._sentenceEnd('第一句。第二句。', 4), 8)
  assert.equal(p._sentenceEnd('第一句。第二', 4), 4)
})

test('full screen: reading starts at the first sentence, before the answer is complete', async () => {
  setTTS('synth', 30)
  const p = makePage()
  net.queue.push(slow('第一句', '话。第二', '句话。', '第三句话。'))
  tap(p)
  lastRec().emit('q')
  await until(() => tts.log.includes('play'))
  assert.equal(texts()[0], '第一句话。')
  assert.ok(!p._answerDone, 'still streaming')
  await until(idle(p))
  assert.equal(texts().join(''), '第一句话。第二句话。第三句话。')
  assert.ok(texts().length >= 2)
  assert.deepEqual(botLines(p), ['第一句话。第二句话。第三句话。'])
  assert.equal(p.data.status, 'listening')
})

test('a reading that caught up waits for more text, and reads the unfinished end once complete', async () => {
  setTTS('synth', 10)
  const p = makePage()
  net.queue.push({ chunks: slow('第一句。', '第二', '句没有句号').chunks, chunkDelay: 120 })
  tap(p)
  lastRec().emit('q')
  await until(idle(p), 5000)
  assert.deepEqual(texts(), ['第一句。', '第二句没有句号'])
})

test('the first sentences decide the voice for the whole answer', async () => {
  setTTS('synth', 10)
  const p = makePage()
  net.queue.push(slow('Hello there. ', '接下来全是中文的内容。', '还有更多中文。'))
  tap(p)
  lastRec().emit('q')
  await until(idle(p), 5000)
  assert.ok(tts.log.filter((l) => l.startsWith('synth:')).every((l) => l === 'synth:English_radiant_girl'))
})

test('card target: speak() reads the whole answer once it is complete', async () => {
  setTTS('speak', 20)
  const p = makePage()
  p.onTargetChanged('_current')
  net.queue.push(slow('第一句。', '第二句。'))
  tap(p)
  lastRec().emit('q')
  await until(idle(p), 5000)
  assert.deepEqual(texts(), ['第一句。第二句。'])
})

test('talking while the answer still streams: the old request stops, the new one is read', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ chunks: slow('第一句话。', '还在', '继续', '流式', '输出', '中。').chunks, chunkDelay: 150 })
  tap(p)
  lastRec().emit('q1')
  await until(() => tts.log.includes('play'))
  assert.ok(!p._answerDone)
  net.queue.push({ body: sse('新的回答。') })
  lastRec().emit('q2')
  await until(() => botLines(p).length === 2 && texts().includes('新的回答。'))
  await sleep(400)                                  // the old stream would have gone on
  assert.deepEqual(userLines(p), ['q1', 'q2'])
  assert.match(botLines(p)[0], /^第一句话。.*（已停止）$/s)
  assert.equal(botLines(p)[1], '新的回答。')
  assert.equal(p.data.status, 'speaking')
  assert.ok(p._busy)
  key(p, 'Backspace')
  await until(() => !p._busy)
})
test('the request fails after reading started: the reading stops, the error is shown', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ chunks: [sse('第一句话。').trim() + '\n\n', 'data: {"type":"error"'], chunkDelay: 50 })
  // the fake stream ends without an error, so make the read fail instead
  tap(p)
  lastRec().emit('q')
  await until(() => tts.log.includes('play'))
  p._abort.abort()
  await until(() => !p._busy)
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p.data.status, 'ready')
  assert.match(botLines(p)[0], /第一句话。\n（已停止）/)
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
  await until(idle(p), 4000)                // ...the safety net finishes it
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p.data.status, 'listening')
})

test('card target (play() unavailable): falls back to speak()', async () => {
  setTTS('synth-card', 20)
  const p = makePage()
  await askOnce(p, 'q', '回答')
  assert.deepEqual(tts.log, ['synth:female-yujie', 'task.abort', 'player.destroy', 'speak:female-yujie'])
  assert.equal(p.data.status, 'listening')
  assert.equal(p._tts, null)
})

test('card target: after one play() failure, later answers use speak() directly', async () => {
  setTTS('synth-card', 10)
  const p = makePage()
  await askOnce(p, 'q1', '回答一')
  tts.log.length = 0
  await askOnce(p, 'q2', '回答二')
  assert.deepEqual(tts.log, ['speak:female-yujie'])   // no wasted synthesize()
})

test('synthesize: once generation ends, the safety net shrinks to the real length', async () => {
  setTTS('synth-hang')   // plays but never reports ended; generation ends with duration 0.1s
  const p = makePage()
  const t0 = Date.now()
  await askOnce(p, 'q', '这是一个比较长的回答，正常估计要读很久很久。')
  assert.ok(Date.now() - t0 < 4000, 'finished ~2s after the real audio length, not the long estimate')
  assert.ok(tts.log.includes('player.stop'))
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

// ---------------- talking over the reading / recognizer lifecycle ----------------

const plays = () => tts.log.filter((l) => l === 'play').length
const reading = (p) => () => p.data.status === 'speaking' && tts.log.includes('play')
const SENT = '这是第一句话。'   // ~2.2 s of speech (estimated): five fit in one segment

test('talking over the reading stops it at the first words; the question is asked', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ body: sse('很长的回答。') })
  tap(p)
  const rec = lastRec()
  rec.emit('q')
  await until(reading(p))
  net.queue.push({ body: sse('第二个回答。') })
  rec.emit('nex', false)                  // the first words: the voice stops for good
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p._tts, null)
  await sleep(10)
  assert.deepEqual(userLines(p), ['q', 'nex'])
  rec.emit('next')                        // final: asks
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q', 'next'])
  assert.deepEqual(botLines(p), ['很长的回答。', '第二个回答。'])
  assert.equal(plays(), 2, 'answer 1 is not read on')
  assert.equal(recs.length, 1, 'the same recognizer')
})

test('a few words over the reading, then nothing: the reading stays stopped, back to listening', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ body: sse('很长的回答。') })
  tap(p)
  lastRec().emit('q')
  await until(reading(p))
  lastRec().emit('嗯', false)
  await until(idle(p))
  assert.equal(p.data.status, 'listening')
  assert.equal(p._tts, null)
  assert.equal(net.calls.length, 1)
  assert.equal(plays(), 1)
})

test('a tap while reading changes nothing', async () => {
  setTTS('synth', 300)
  const p = makePage()
  net.queue.push({ body: sse('回答。') })
  tap(p)
  lastRec().emit('q')
  await until(reading(p))
  tap(p)
  tap(p)
  assert.equal(p.data.status, 'speaking')
  assert.equal(recs.length, 1)
  assert.ok(!tts.log.includes('player.stop'))
  await until(idle(p))
  assert.equal(plays(), 1)
  assert.equal(p.data.status, 'listening')
})

test('segments: whole sentences, as many as fit in ~8 s of speech', () => {
  const p = makePage()
  const t = SENT.repeat(6)
  assert.equal(p._segmentEnd(t, 0, t.length, true), 35)        // five sentences
  assert.equal(p._segmentEnd(t, 35, t.length, true), 42)       // the last one
  assert.equal(p._segmentEnd(t, 0, 14, true), 14)              // only what is complete
  const long = '这一句话非常非常长'.repeat(5) + '。后面'
  assert.equal(p._segmentEnd(long, 0, long.length - 2, true), long.length - 2)   // one long sentence
  assert.equal(p._segmentEnd('第一句。没有句号', 0, 8, true), 8)   // the unfinished end, once complete
  assert.equal(p._segmentEnd('第一句', 0, 0, true), 0)          // nothing complete yet
})

test('a long answer is read in segments of at most ~8 s', async () => {
  setTTS('synth', 10)
  const p = makePage()
  await askOnce(p, 'q', SENT.repeat(12))
  assert.deepEqual(texts(), [SENT.repeat(5), SENT.repeat(5), SENT.repeat(2)])
})

test('an old mic is renewed before the next segment, and the voice waits until it captures', async () => {
  setTTS('synth', 50)
  const p = makePage()
  net.queue.push({ body: sse(SENT.repeat(8)) })
  tap(p)
  const rec = lastRec()
  rec._startAt -= 9000                    // 9 s old + the next segment: past ~13 s
  rec.emit('q')
  await until(() => tts.log.includes('play'))
  assert.deepEqual(rec.calls, ['start', 'abort'])
  assert.equal(recs.length, 2)
  assert.ok(Date.now() - recs[1]._startAt >= 300, 'played 0.3 s after the new mic captured')
  rec.emit('stale')                       // the old one is ignored
  await until(idle(p))
  assert.equal(recs.length, 2, 'the fresh one lasts the rest of the reading')
  assert.equal(plays(), 2)
  assert.deepEqual(userLines(p), ['q'])
  assert.equal(p.data.status, 'listening')
})

test('the recognizer times out during reading: a new one opens before the next segment', async () => {
  setTTS('synth', 200)
  const p = makePage()
  net.queue.push({ body: sse(SENT.repeat(6)) })
  tap(p)
  const rec = lastRec()
  rec.emit('q')
  await until(reading(p))
  rec._startAt -= 6000
  rec.onend()                             // timed out
  assert.equal(p._rec, null)
  assert.equal(p.data.status, 'speaking')
  await until(() => plays() === 2)
  assert.equal(recs.length, 2)
  net.queue.push({ body: sse('答。') })
  recs[1].emit('还在听吗')                // heard during the second segment
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q', '还在听吗'])
})

test('a mic that is hearing the wearer is not renewed, even when it is old', async () => {
  setTTS('synth', 50)
  const p = makePage()
  net.queue.push({ body: sse('回答。') })
  tap(p)
  const rec = lastRec()
  rec.emit('q')
  rec._startAt -= 12000                   // old enough to renew...
  rec.onspeechstart()                     // ...but the wearer just started talking again
  await until(() => tts.log.includes('play'))
  assert.equal(recs.length, 1)
  assert.deepEqual(rec.calls, ['start'])
  net.queue.push({ body: sse('第二个。') })
  rec.emit('next')                        // heard on the same mic
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q', 'next'])
})

test('mic renewal: an old recognizer that never ends is given up after 1.5 s', async () => {
  setTTS('synth', 50)
  const p = makePage()
  net.queue.push({ body: sse('回答。') })
  tap(p)
  const rec = lastRec()
  rec.abort = () => rec.calls.push('abort')   // no end event
  rec._startAt -= 12000
  const t0 = Date.now()
  rec.emit('q')
  await until(() => recs.length === 2, 3000)
  assert.ok(Date.now() - t0 >= 1400)
  assert.equal(plays(), 0, 'the voice waits for the new mic')
  await until(idle(p))
  assert.equal(plays(), 1)
})

test('Backspace while the mic is renewed: no new one opens', async () => {
  setTTS('synth', 50)
  const p = makePage()
  net.queue.push({ body: sse('回答。') })
  tap(p)
  const rec = lastRec()
  rec.abort = () => rec.calls.push('abort')   // no end event
  rec._startAt -= 12000
  rec.emit('q')
  await until(() => p._waitRec)
  key(p, 'Backspace')
  await sleep(1700)
  assert.equal(recs.length, 1)
  assert.equal(p._rec, null)
  assert.equal(p.data.status, 'ready')
})

test('after a reading, an old mic is renewed for the next question', async () => {
  setTTS('synth', 30)
  const p = makePage()
  net.queue.push({ body: sse('回答。') })
  tap(p)
  const rec = lastRec()
  rec._startAt -= 5000                    // fine for the reading, too old to wait for a question
  rec.emit('q')
  await until(() => idle(p)() && recs.length === 2)
  assert.deepEqual(rec.calls, ['start', 'abort'])
  assert.equal(plays(), 1)
  assert.equal(p.data.status, 'listening')
})

test('a recognizer that ends long after its start timed out: no more "listening"', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  const rec = lastRec()
  rec.onend()                               // early end: the glasses keep going
  assert.equal(p.data.status, 'listening')
  assert.equal(p._rec, rec)
  rec._startAt -= 6000
  rec.onend()                               // the session timed out
  assert.equal(p.data.status, 'ready')
  assert.equal(p._rec, null)
  tap(p)                                    // a tap opens a new one
  assert.equal(recs.length, 2)
  assert.equal(p.data.status, 'listening')
})

test('a question right after the voice ends is used (the glasses cancel their own voice)', async () => {
  setTTS('synth', 150)
  const p = makePage()
  net.queue.push({ body: sse('月球是地球唯一的天然卫星。') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking' && tts.log.includes('play'))
  await until(() => !p._busy)                    // read to the end
  net.queue.push({ body: sse('答。') })
  lastRec().emit('月球有多大')                   // right away, no tap
  await until(() => botLines(p).length === 2 && !p._busy)
  assert.deepEqual(userLines(p), ['q', '月球有多大'])
})

test('debug: the hint shows the last four recognizer and voice events, numbered by recognizer', async () => {
  setTTS('synth', 2000)
  const p = makePage({ config: { debug: true } })
  net.queue.push({ body: sse('月球是地球唯一的天然卫星。') })
  tap(p)
  await sleep(20)
  lastRec().emit('q')
  await until(reading(p))
  assert.ok(p._dbg.some((d) => / voice 13$/.test(d)), p._dbg.join(' | '))
  lastRec().emit('月球有多', false)
  const parts = p.data.hint.split(' | ')
  assert.equal(parts.length, 4)
  assert.match(parts[0], /^0\.0 #1 audiostart$/)
  assert.match(parts[1], /^0\.0 #1 final q$/)
  assert.match(parts[2], /^0\.0 voice 13$/)
  assert.match(parts[3], /^0\.0 #1 interim 月球有多$/)
  assert.deepEqual(userLines(p), ['q', '月球有多'])
  key(p, 'Backspace')
  await until(() => !p._busy)
})
test('an exit word over the reading ends the conversation', async () => {
  setTTS('synth', 2000)
  const p = makePage()
  net.queue.push({ body: sse('回答里也有停止两个字') })
  tap(p)
  lastRec().emit('q')
  await until(reading(p))
  lastRec().emit('停止')
  await until(() => p.data.status === 'ready')
  assert.ok(tts.log.includes('player.stop'))
  assert.equal(p._rec, null)
  assert.equal(net.calls.length, 1)
})
test('card speak() (no stop API): a question over the reading still works', async () => {
  setTTS('speak-noend')
  const p = makePage()
  net.queue.push({ body: sse('回答') })
  tap(p)
  lastRec().emit('q')
  await until(() => p.data.status === 'speaking')
  net.queue.push({ body: sse('第二个') })
  lastRec().emit('next')
  await until(() => botLines(p).length === 2)
  assert.deepEqual(userLines(p), ['q', 'next'])
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

test('error event (e.g. no-speech) does not stop listening or drop results', async () => {
  setTTS('synth', 20)
  const p = makePage()
  tap(p)
  const rec = lastRec()
  rec.onerror({ error: 'no-speech' })
  assert.equal(p.data.status, 'listening')
  assert.equal(p._rec, rec)
  await askOnce(p, '还在听吗', '在')
  assert.deepEqual(botLines(p), ['在'])
  assert.equal(p.data.status, 'listening')
})

test('end event 1s after start (as on the glasses): screen stays LISTENING, speech still works', async () => {
  setTTS('synth', 20)
  const p = makePage()
  tap(p)
  const rec = lastRec()
  rec.onend()
  assert.equal(p.data.status, 'listening')
  await askOnce(p, '第一个', '一')
  assert.equal(p.data.status, 'listening')   // after reading: still listening on the same recognizer
  await askOnce(p, '第二个', '二')
  assert.deepEqual(botLines(p), ['一', '二'])
  assert.equal(recs.length, 1)
})

test('start() throws: READY, a later tap works', () => {
  setTTS('synth')
  const p = makePage()
  FakeRec.failStart = true
  tap(p)
  assert.equal(p.data.status, 'ready')
  assert.equal(p._rec, null)
  FakeRec.failStart = false
  tap(p)
  assert.equal(p.data.status, 'listening')
  assert.equal(recs.length, 2)
})

test('results from a recognizer we stopped are ignored', async () => {
  setTTS('synth')
  const p = makePage()
  tap(p)
  const rec = lastRec()
  key(p, 'Backspace')
  assert.ok(rec.calls.includes('abort'))
  rec.emit('迟到的结果')
  rec.emit('迟到', false)
  await sleep(20)
  assert.equal(net.calls.length, 0)
  assert.deepEqual(p.data.turns, [])
})

test('debug: recognizer events shown in the hint line', async () => {
  setTTS('synth')
  const p = makePage({ config: { debug: true } })
  tap(p)
  assert.match(p.data.hint, /^0\.0 tap none \| 0\.0 #1 start$/)
  lastRec().onspeechstart()
  lastRec().onerror({ error: 'network' })
  assert.match(p.data.hint, /tap none \| .* #1 start \| .* #1 speechstart \| .* #1 error network$/)
  lastRec().onend()
  assert.match(p.data.hint, / #1 start \| .* #1 speechstart \| .* #1 error network \| .* #1 end$/)
  const off = makePage({ config: { debug: false } })
  tap(off)
  assert.equal(off.data.hint, '正在听 · 说完即可')
})

test('debug: the hint stays on one line, dropping the oldest events', () => {
  setTTS('synth')
  const p = makePage({ config: { debug: true } })
  p._tapAt = Date.now() - 101300                 // long times, as late in a conversation
  for (const m of ['#12 error network', '#12 audioend', '#12 end', '#13 start', '#13 speechstart']) p._debug(m)
  assert.ok(p.data.hint.length <= 72, p.data.hint)
  assert.match(p.data.hint, /#13 speechstart$/)
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
    setTTS('synth', 250)   // per segment (~5 s of speech each)
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
    await sleep(100)   // follow-scroll runs ~50ms after a render
    p._muteUntil = 0
    const before = p.sv.scrollHeight
    net.queue.push({ hang: true })
    lastRec().emit('q2')
    await until(() => p.data.status === 'working')
    await sleep(100)
    assert.ok(Math.abs(p._turnStart - before) <= 1, `turnStart ${p._turnStart} vs ${before}`)
    assert.ok(p.sv.scrollTop <= p._turnStart, 'question start not scrolled past')
    assert.ok(p.sv.scrollTop >= p._turnStart - p.sv.clientHeight, 'question visible')
    key(p, 'Backspace')
    await until(() => !p._busy)
  })

  test(`[${mode}] talking over the reading jumps to the bottom, where the question appears`, async () => {
    setTTS('synth', 3000)
    const p = makePage({ scroll: mode })
    net.queue.push({ body: sse('这是一个很长的回答。'.repeat(40)) })
    tap(p)
    lastRec().emit('q')
    await until(() => p.data.status === 'speaking' && tts.log.includes('play'))
    await sleep(100)
    key(p, 'ArrowUp')                       // swiped back to read: the view stays there...
    await sleep(20)
    lastRec().emit('新的问题', false)       // ...until the wearer talks
    await sleep(150)
    const max = p.sv.scrollHeight - p.sv.clientHeight
    assert.ok(max > 0)
    assert.ok(p.sv.scrollTop >= max - 1, `at the bottom: ${p.sv.scrollTop} of ${max}`)
    assert.equal(p.data.turns.at(-1).text, '新的问题')
    assert.equal(p._tts, null)
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

test('a temple swipe is respected: reading end / streaming do not yank the view back', async () => {
  setTTS('synth', 300)
  const p = makePage({ scroll: 'entity' })
  net.queue.push({ body: sse('长'.repeat(400)) })
  tap(p)
  lastRec().emit('q1')
  await until(() => p.data.status === 'speaking')
  p._stopReadScroll()
  p._scrollTo(p.sv.scrollHeight, false)
  await sleep(10)
  key(p, 'ArrowUp')
  await sleep(10)
  const pos = p.sv.scrollTop
  assert.ok(pos < p.sv.scrollHeight - p.sv.clientHeight)
  await until(idle(p))                   // reading ends
  await sleep(100)
  assert.equal(p.sv.scrollTop, pos, 'stays where the user swiped')
  p._muteUntil = 0
  net.queue.push({ hang: true })
  lastRec().emit('q2')                   // a new question follows again
  await until(() => p.data.status === 'working')
  await sleep(100)
  assert.ok(p.sv.scrollTop > pos, 'new question scrolls into view')
  key(p, 'Backspace')
  await until(() => !p._busy)
})

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
