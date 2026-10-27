// End-to-end run on the real AIUI (Ink) runtime in headless Chromium, with a fake
// glasses host (ASR/TTS). Checks the conversation flow and saves screenshots of every
// step to e2e/out/<case>/ for visual review.
//   npm run e2e             fake bridge (free, deterministic) — the default
//   npm run e2e -- --live   the REAL bridge from config.js + real AK from secrets.js:
//                           real Hermes answers (costs tokens; ~2 questions per case)
//   add a case filter, e.g. npm run e2e -- --live zh-CN-synth_blank
//   E2E_DEBUG=1 npm run e2e   debug: true in the bundle (event log in the screenshots)
// Full screen with synthesize() runs like the glasses: speech at about the real pace, and a
// mic that stops after 16 s without speech and is deaf if opened while the voice plays.
import { chromium } from 'playwright'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, bridgeUrl } from './serve.mjs'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const only = args.filter((a) => !a.startsWith('--'))
const outRoot = join(dirname(fileURLToPath(import.meta.url)), LIVE ? 'out-live' : 'out')
const CASES = [
  // lang = system (Hi Rokid) language, tts = what the host offers, target = card or full screen
  { lang: 'zh-CN', tts: 'synth', target: '_blank' },
  { lang: 'zh-CN', tts: 'synth', target: '_current' },
  { lang: 'en-US', tts: 'synth', target: '_blank' },
  { lang: 'zh-CN', tts: 'speak', target: '_blank' },
].filter((c) => !only.length || only.includes(`${c.lang}-${c.tts}${c.target}`))

// questions: a long answer (needs scrolling) in the UI language, then a short one in the other
const FAKE = {
  zh: ['给我讲一个关于月亮的长故事', '\n\n 很久以前，在一个宁静的小村庄里，住着一个喜欢看月亮的小女孩。每天晚上，她都会坐在院子里，抬头望着天上那轮明亮的月亮。她相信月亮上住着一位温柔的仙女，会在夜里守护着所有的孩子。有一天晚上，月亮突然变得特别亮，一道银色的光芒从天而降，落在了她的院子里。光芒中走出一只雪白的兔子，它告诉小女孩，月亮上的仙女生病了，需要人间最纯净的笑声才能治好。',
    'What time is it in London?', 'It is about three in the afternoon in London.'],
  en: ['Tell me a long story about the moon', '\n\n Long ago, in a quiet village, there lived a girl who loved to watch the moon. Every night she sat in the garden and looked up at its bright silver face. She believed a gentle fairy lived there, watching over all the children while they slept. One evening the moon grew brighter than ever, and a beam of silver light fell into her garden. Out of the light hopped a snow white rabbit, who told her the moon fairy was ill.',
    '伦敦现在几点？', '伦敦现在大约是下午三点。'],
}
const REAL = {
  zh: ['请用三段话简单介绍一下月球，每段四到五句话，不要用标题和列表。', 'What is two plus two? Answer in one short English sentence.'],
  en: ['Describe the Moon in three short paragraphs of four or five sentences each, no headings or lists.', '一加一等于几？请用一句简短的中文回答。'],
}
const HAN = /[㐀-鿿]/g
const isChinese = (s) => (s.match(HAN) || []).length * 2 >= (s.match(/[A-Za-z]+/g) || []).length

const asked = []
const answered = []
const server = await serve({ live: LIVE, onBridgeRequest: (b) => asked.push(b.message?.[0]?.text), onBridgeAnswer: (a, status) => answered.push({ a, status }) })
const base = `http://127.0.0.1:${server.address().port}/`
// fake mic, and a fake audio output: with the Mac's real output Web Audio stalls when that
// device is busy or stuck, and the runtime then never gets mic audio
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output'] })
rmSync(outRoot, { recursive: true, force: true })
if (LIVE) console.log('LIVE bridge:', bridgeUrl(), '\n')
let failures = 0

for (const c of CASES) {
  const name = `${c.lang}-${c.tts}${c.target}`
  const out = join(outRoot, name)
  mkdirSync(out, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 480, height: 352 }, permissions: ['microphone'] })
  const pg = await ctx.newPage()
  const errors = []
  pg.on('pageerror', (e) => errors.push(e.message))
  const trace = []   // recognizer events + bridge traffic, printed when a check fails
  const t0 = Date.now()
  pg.on('console', (m) => {
    const t = m.text().replace(/%c|color:[^;]*;?|padding:[^;]*;?|background:[^;]*;?|font-weight:[^;]*;?/g, '').trim()
    if (/\bERROR\b|Uncaught/.test(t)) errors.push(t)
    if (/\[(asr|dbg|tts)\]/.test(t)) trace.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + t.replace(/^.*?(\[(asr|dbg|tts)\])/, '$1').slice(0, 120))
  })

  // fake bridge: one queued answer per request, SSE in small chunks
  const answers = []
  if (!LIVE) {
    await pg.route('https://rokid-hermes.snowbig.com/**', async (route) => {
      asked.push(JSON.parse(route.request().postData() || '{}').message?.[0]?.text)
      const a = answers.shift() || { text: '（无）' }
      await new Promise((r) => setTimeout(r, a.delay || 0))
      answered.push({ a: a.text, status: 200 })
      const sse = a.text.match(/[\s\S]{1,8}/g).map((p) => `data: ${JSON.stringify({ type: 'answer', answer_stream: p })}\n\n`).join('')
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse })
    })
  }
  asked.length = 0
  answered.length = 0

  const wait = (ms) => pg.waitForTimeout(ms)
  let n = 0
  const shot = async (step) => {
    await wait(150)
    const file = join(out, `${String(++n).padStart(2, '0')}-${step}.png`)
    await pg.locator('canvas').screenshot({ path: file })
    return readFileSync(file)
  }
  const say = (text, isFinal = true) => pg.evaluate(([t, f]) => __say(t, f), [text, isFinal])
  const key = (code) => pg.evaluate((k) => __key(k), code)
  const hostLog = () => pg.evaluate(() => window.__log.slice())
  const ttsCount = async () => (await hostLog()).filter((l) => / voice=/.test(l)).length
  // wait until a speech request after the first `from` ones (live answers can take a while)
  const untilReading = async (from, step) => {
    const t0 = Date.now()
    for (let i = 0; (await ttsCount()) <= from; i++) {
      if (Date.now() - t0 > (LIVE ? 180000 : 15000)) return false
      if (LIVE && i % 6 === 5) await shot(`${step}-${Math.round((Date.now() - t0) / 1000)}s`)   // streaming progress
      await wait(500)
    }
    return true
  }

  const zh = c.lang.startsWith('zh')
  // E2E_Q1 / E2E_Q2 replace the live questions, e.g. E2E_Q1='美股今天股票如何？'
  const real = REAL[zh ? 'zh' : 'en']
  const [q1, a1, q2, a2] = LIVE ? [process.env.E2E_Q1 || real[0], '', process.env.E2E_Q2 || real[1], ''] : FAKE[zh ? 'zh' : 'en']
  const checks = []
  let caseFailed = false
  const check = (ok, what) => { checks.push((ok ? '  ✔ ' : '  ✖ ') + what); if (!ok) { failures++; caseFailed = true } }

  // like the glasses: the full-screen voice can be renewed around, the card's speak() cannot
  const glasses = c.tts === 'synth' && c.target === '_blank'
  const pace = glasses ? (zh ? 200 : 65) : 40
  await pg.goto(`${base}?lang=${c.lang}&tts=${c.tts}&target=${c.target}&pace=${pace}` + (glasses ? '&asrTimeout=16000' : ''))
  await pg.waitForFunction(() => window.__ready)
  await wait(1200)
  await shot('initial')
  await key('GlobalHook')
  await pg.waitForFunction(() => __asr.sessions.length > 0, null, { timeout: 10000 }).catch(() => {})
  check((await hostLog()).some((l) => l.startsWith('asr.open ' + c.lang)), 'temple tap opens the mic (ASR stream, ' + c.lang + ')')
  await wait(1200)
  await shot('listening')

  // ---- question 1: long answer, read aloud while the text scrolls ----
  answers.push({ text: a1, delay: 1200 })
  await say(q1.slice(0, 6), false)
  await shot('question-live')
  await say(q1)
  await wait(400)
  await shot('question-thinking')
  const read1 = await untilReading(0, 'answer-streaming')
  const tRead = Date.now()
  const reading0 = await shot('answer-reading')
  // reading scroll follows the speech; speak() is paced by the estimate, so allow time
  let reading1 = reading0
  for (let t = 0; reading1.equals(reading0) && t < (LIVE ? 40 : 6); t += 2) { await wait(2000); reading1 = await shot(`reading-${t + 2}s`) }
  const ans1 = (answered[0] && answered[0].a) || ''
  check(read1 && ans1.length > 0, `answer 1 received (${answered[0] ? 'HTTP ' + answered[0].status + ', ' : ''}${ans1.length} chars)` + (LIVE ? ': ' + JSON.stringify(ans1.slice(0, 60)) + '…' : ''))
  const firstVoice = (await hostLog()).find((l) => / voice=/.test(l))
  const voice1 = isChinese(ans1) ? 'male-qn-jingying' : 'English_radiant_girl'
  const method = c.tts === 'synth' && c.target === '_blank' ? 'tts.synth' : 'tts.speak'
  check(firstVoice?.startsWith(method) && firstVoice.includes('voice=' + voice1), `answer 1 read with ${method.slice(4)}() in ${voice1}: ${firstVoice}`)
  const needsScroll = ans1.length > (isChinese(ans1) ? 200 : 450)
  if (LIVE) check(needsScroll, `answer 1 is long enough to need scrolling (${ans1.length} chars)`)
  if (needsScroll) check(!reading0.equals(reading1), 'text scrolls while the answer is read')

  // like the glasses: speak late in a long reading, when the mic from the question would long
  // have timed out (only a mic renewed between segments still hears)
  const sessions = () => pg.evaluate(() => __asr.sessions.map((s) => ({ openedAt: s.openedAt, deaf: s.deaf })))
  // still reading: playing, or between two segments with more of the answer to come
  const reading = async () => (await pg.evaluate(() => window.__playing)) ||
    !answered[0] || (await pg.evaluate(() => window.__tts.map((r) => r.text).join(''))) !== answered[0].a.replace(/^\s+/, '')
  if (glasses) for (; Date.now() - tRead < 22000 && (await reading()); ) await wait(500)
  const readFor = Math.round((Date.now() - tRead) / 1000)
  if (glasses) {
    const renewed = (await sessions()).filter((s) => s.openedAt > tRead).length
    check(readFor < 15 || renewed > 0, `the mic is renewed during a long reading (${renewed} new session(s) in ${readFor} s of reading)`)
  }

  // ---- talk over the reading (no tap needed): the first words stop it; question 2 (other language) ----
  const stops = () => trace.filter((l) => l.includes('[tts] stop')).length
  const stops0 = stops()
  await key('GlobalHook')    // a tap while reading changes nothing
  await wait(500)
  await shot('tap-while-reading')
  check(stops() === stops0, 'temple tap keeps the voice reading')
  answers.push({ text: a2, delay: 500 })
  await say(q2.slice(0, 5), false)
  await wait(150)
  check(stops() > stops0, `the first words of question 2 stop the reading of answer 1 (${readFor} s into the reading)`)
  const tts1 = await ttsCount()   // speech requests of answer 1 (one per segment)
  await shot('question-2-live')
  await say(q2)
  await wait(300)
  await shot('question-2-thinking')
  const read2 = await untilReading(tts1, 'answer-2-streaming')
  await wait(1200)
  await shot('answer-2')
  // a long answer 2 is read in several segments: wait until all of it was sent to the voice
  for (const t0 = Date.now(); Date.now() - t0 < (LIVE ? 120000 : 10000); await wait(500)) {
    const said = (await pg.evaluate(() => window.__tts.map((r) => r.text))).slice(tts1).join('')
    if (answered[1] && said === answered[1].a.replace(/^\s+/, '')) break
  }
  const ans2 = (answered[1] && answered[1].a) || ''
  check(read2 && ans2.length > 0, `answer 2 received (${ans2.length} chars)` + (LIVE ? ': ' + JSON.stringify(ans2.slice(0, 60)) : ''))
  const voices = (await hostLog()).filter((l) => / voice=/.test(l))
  const voice2 = isChinese(ans2) ? 'male-qn-jingying' : 'English_radiant_girl'
  check(voices.length >= 2 && voices.at(-1).includes('voice=' + voice2), `answer 2 voice follows its language (${voice2}): ${voices.at(-1)}`)
  // read = the answer without its leading blank lines/spaces, in segments while it streams;
  // answer 1 up to where question 2 stopped it, answer 2 in full
  const spoken = await pg.evaluate(() => window.__tts.map((r) => r.text))
  const [s1, s2] = [spoken.slice(0, tts1), spoken.slice(tts1).join('')]
  const [t1, t2] = answered.slice(0, 2).map((x) => x.a.replace(/^\s+/, ''))
  const lead = answered.slice(0, 2).map((x) => (x.a.match(/^\s*/)[0].length))
  check(s1.length > 0 && t1.startsWith(s1[0]) && s1.every((x) => x && t1.includes(x)) && s2 === t2,
    `answers read from the start, leading whitespace trimmed (raw answers started with ${lead.join(' / ')} whitespace chars)`)
  if (c.tts === 'synth' && c.target === '_blank') {
    const first = spoken[0] || ''
    check(first.length < t1.length || t1.length < 40, `full screen starts reading answer 1 before it is complete (first segment ${first.length} of ${t1.length} chars, ${tts1} segment(s) read)`)
  }
  check(JSON.stringify(asked) === JSON.stringify([q1, q2]), 'bridge got both questions (asked during the reading): ' + JSON.stringify(asked))

  const before = await shot('before-swipe')
  await key('ArrowUp'); await wait(800); const up = await shot('swipe-up')
  await key('ArrowDown'); await wait(800); const down = await shot('swipe-down')
  check(!before.equals(up) && !up.equals(down), 'temple swipe scrolls the dialog up and back down')

  // ---- after the readings the mic still hears: an exit word ends the conversation ----
  await wait(3000)
  await say(zh ? '退出' : 'exit')
  await wait(800)
  await shot('ended')
  const exitWord = zh ? '退出' : 'exit'
  check(trace.some((l) => / #\d+ final /.test(l) && l.endsWith(' final ' + exitWord)) && asked.length === 2, 'the mic still hears after the reading: the exit word ends the conversation')
  const dropped = (await hostLog()).filter((l) => l.startsWith('asr.dropped'))
  const deaf = (await sessions()).filter((s) => s.deaf).length
  check(!dropped.length && !deaf, `no speech lost to a timed-out or deaf mic (${(await sessions()).length} sessions, ${deaf} deaf)` + (dropped.length ? ': ' + dropped.join(' | ') : ''))
  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''))
  console.log(name + '\n' + checks.join('\n'))
  if (LIVE) console.log(trace.filter((l) => l.includes('timing')).map((l) => '    ' + l.replace(/^\S+ /, '')).join('\n'))
  if (caseFailed) console.log('  trace:\n    ' + trace.concat((await hostLog()).map((l) => 'host ' + l)).join('\n    '))
  await ctx.close()
}

await browser.close()
server.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed', `— screenshots in e2e/${LIVE ? 'out-live' : 'out'}/`)
process.exit(failures ? 1 : 0)
