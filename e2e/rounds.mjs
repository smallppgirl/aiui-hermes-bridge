// Several rounds of conversation in one session, in full screen on a host that acts like
// the glasses (speech at about the real pace, a mic that stops after 16 s without speech
// and is deaf if opened while the voice plays). Screenshots in e2e/out-rounds/.
//   npm run e2e:rounds              fake bridge
//   npm run e2e:rounds -- --live    the REAL bridge (5 Hermes questions)
//   E2E_DEBUG=1 ...                 debug: true in the bundle (event log in the screenshots)
// Rounds: a long answer interrupted mid-reading by the next question; that answer read to
// the end; a follow-up right after the reading (no tap); silence; a question cancelled
// while it is still thinking by the next one; an exit word.
import { chromium } from 'playwright'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, bridgeUrl } from './serve.mjs'

const LIVE = process.argv.includes('--live')
const out = join(dirname(fileURLToPath(import.meta.url)), 'out-rounds')
const Q = LIVE ? [
  '请用三段话介绍一下月球，每段四到五句话，不要用标题和列表。',
  '请用两段话介绍一下火星，每段三句话，不要用标题和列表。',
  '火星离地球大约多远？请用一句话回答。',
  '请写一首关于大海的长诗，至少二十行。',
  '算了，不用写诗了。一加一等于几？请用一句话回答。',
] : ['给我讲一个关于月亮的长故事', '再讲讲火星', '火星离地球多远', '帮我写一首很长的诗', '算了，现在几点']
const FAKE = {
  [Q[0]]: { text: '很久以前，在一个宁静的小村庄里，住着一个喜欢看月亮的小女孩。每天晚上，她都会坐在院子里，抬头望着天上那轮明亮的月亮。她相信月亮上住着一位温柔的仙女，会在夜里守护着所有的孩子。有一天晚上，月亮突然变得特别亮，一道银色的光芒从天而降。', delay: 1200 },
  [Q[1]]: { text: '火星是太阳系的第四颗行星，表面覆盖着红色的氧化铁尘土。它的一天比地球长四十分钟左右。火星上有太阳系最高的火山，奥林帕斯山。科学家认为火星过去可能有液态水。', delay: 1000 },
  [Q[2]]: { text: '火星离地球最近时约五千五百万公里。', delay: 800 },
  [Q[3]]: { text: '大海啊，你是那么辽阔。', delay: 5000 },
  [Q[4]]: { text: '现在是下午三点。', delay: 800 },
}
const EXIT = '退出'

const asked = []      // { q, at }
const answers = {}    // question -> answer text
const server = await serve({ live: LIVE,
  onBridgeRequest: (b) => asked.push({ q: b.message?.[0]?.text, at: Date.now() }),
  onBridgeAnswer: (a, status, b) => { answers[b.message?.[0]?.text] = a } })
const base = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output'] })
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
if (LIVE) console.log('LIVE bridge:', bridgeUrl())
const ctx = await browser.newContext({ viewport: { width: 480, height: 352 }, permissions: ['microphone'] })
const pg = await ctx.newPage()
const errors = []
pg.on('pageerror', (e) => errors.push(e.message))
const trace = []   // { at, text }: recognizer, voice and timing events of the agent
pg.on('console', (m) => {
  const t = m.text().replace(/%c|color:[^;]*;?|padding:[^;]*;?|background:[^;]*;?|font-weight:[^;]*;?/g, '').trim()
  if (/\bERROR\b|Uncaught/.test(t)) errors.push(t)
  const i = t.search(/\[(asr|tts)\]/)
  if (i >= 0) trace.push({ at: Date.now(), text: t.slice(i) })
})
if (!LIVE) {
  await pg.route('https://rokid-hermes.snowbig.com/**', async (route) => {
    const q = JSON.parse(route.request().postData() || '{}').message?.[0]?.text
    asked.push({ q, at: Date.now() })
    const a = FAKE[q] || { text: '（无）' }
    await new Promise((r) => setTimeout(r, a.delay))
    answers[q] = a.text
    const sse = a.text.match(/[\s\S]{1,8}/g).map((p) => `data: ${JSON.stringify({ type: 'answer', answer_stream: p })}\n\n`).join('')
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }).catch(() => {})   // aborted by the agent
  })
}

const checks = []
let failures = 0
const check = (ok, what) => { checks.push((ok ? '  ✔ ' : '  ✖ ') + what); if (!ok) failures++; console.log(checks.at(-1)) }
const wait = (ms) => pg.waitForTimeout(ms)
const until = async (cond, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(100)) if (await cond()) return true; return false }
let n = 0
const shot = async (step) => { await wait(150); await pg.locator('canvas').screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${step}.png`) }) }
const say = (text, isFinal = true) => pg.evaluate(([t, f]) => __say(t, f), [text, isFinal])
const key = (code) => pg.evaluate((k) => __key(k), code)
const spoken = () => pg.evaluate(() => window.__tts.map((r) => r.text))
const playing = () => pg.evaluate(() => window.__playing)
const stops = () => trace.filter((l) => l.text.startsWith('[tts] stop')).length
const trim = (s) => (s || '').replace(/^\s+/, '')
const LONG = LIVE ? 240000 : 60000
// ask: say it (first a few characters live, as the glasses show it), then the bridge must get it
// (not in the ~0.6 s while the mic is renewed: those windows are measured on their own)
const micLive = () => pg.evaluate(() => { const s = __asr.sessions.at(-1); return s && !s.ended && Date.now() - s.openedAt > 300 })
async function ask(i, step) {
  await until(micLive, 3000)
  await say(Q[i].slice(0, 4), false)
  await shot(step + '-live')
  const t = Date.now()
  await say(Q[i])
  const sent = await until(() => asked.length > i, 3000)
  check(sent && asked[i].q === Q[i], `round ${i + 1}: the bridge gets the question` + (sent ? ` ${asked[i].at - t} ms after it was said` : ''))
  return [await pg.evaluate(() => window.__tts.length), voiceEnds()]   // voice requests / ends before this answer
}
// answer i read to the end: every voice request after `from` together is the whole answer
const squash = (s) => (s || '').replace(/\s+/g, '')
const voiceEnds = () => trace.filter((l) => / voice end$/.test(l.text)).length
async function readToEnd(i, from, ends0) {
  // all of it sent to the voice, and the last segment played to its end
  const done = await until(async () => {
    const segs = (await spoken()).slice(from)
    return answers[Q[i]] && squash(segs.join('')) === squash(answers[Q[i]]) && voiceEnds() - ends0 >= segs.length && !(await playing())
  }, LONG)
  check(done, `round ${i + 1}: the answer is read to the end (${trim(answers[Q[i]] || '').length} chars, ${(await spoken()).length - from} segment(s))`)
}
const sessions = () => pg.evaluate(() => __asr.sessions.map((s) => ({ openedAt: s.openedAt, deaf: s.deaf })))

await pg.goto(`${base}?lang=zh-CN&tts=synth&target=_blank&pace=200&asrTimeout=16000`)
await pg.waitForFunction(() => window.__ready)
await wait(1200)
await key('GlobalHook')
await until(() => pg.evaluate(() => __asr.sessions.length > 0), 5000)
await wait(600)
await shot('listening')

// ---- round 1: a long answer, interrupted mid-reading ----
const [from1] = await ask(0, 'r1')
check(await until(async () => (await spoken()).length > from1 && (await playing()), LONG), 'round 1: the answer starts being read')
const read1At = Date.now()
await wait(3000)
await shot('r1-reading')
await wait(5000)
await shot('r1-reading-later')
await until(async () => (await playing()) && (await micLive()), 15000)   // talking over the voice
const stops1 = stops()
const tInt = Date.now()
await say(Q[1].slice(0, 2), false)
const stopped = await until(() => stops() > stops1, 2000)
check(stopped, `round 2: the first words stop the reading of answer 1` + (stopped ? ` (${trace.find((l) => l.text.startsWith('[tts] stop') && l.at >= tInt).at - tInt} ms, ${Math.round((tInt - read1At) / 1000)} s into it)` : ''))
await shot('r2-interrupt')
const said1 = (await spoken()).slice(from1).join('')
check(said1.length > 0 && trim(answers[Q[0]] || '').startsWith(said1) && said1.length < trim(answers[Q[0]]).length, `round 1: only the start of answer 1 was read (${said1.length} of ${trim(answers[Q[0]] || '').length} chars)`)

// ---- round 2: asked over the reading, read to the end (the mic renewed meanwhile) ----
const [from2, ends2] = await ask(1, 'r2')
const read2At = Date.now()
await until(async () => (await spoken()).length > from2, LONG)
await wait(4000)
await shot('r2-reading')
await readToEnd(1, from2, ends2)
const read2s = Math.round((Date.now() - read2At) / 1000)
const renewed2 = (await sessions()).filter((s) => s.openedAt > read2At).length
check(read2s < 15 || renewed2 > 0, `round 2: the mic is renewed during the reading (${renewed2} new session(s) in ${read2s} s)`)
await shot('r2-read')

// ---- round 3: a follow-up right after the reading, no tap ----
await wait(1000)
const [from3, ends3] = await ask(2, 'r3')
await readToEnd(2, from3, ends3)
await shot('r3-read')

// ---- silence: the mic must still hear afterwards ----
await wait(12000)
await shot('after-silence')

// ---- rounds 4 and 5: a question still thinking is cancelled by the next one ----
const [from4] = await ask(3, 'r4')
await wait(1500)
const voiced4 = (await spoken()).length - from4
await shot('r4-thinking')
const [from5, ends5] = await ask(4, 'r5')
check(true, `round 5 asked ${voiced4 ? 'while answer 4 was already being read' : 'while round 4 was still thinking'}`)
await readToEnd(4, from5, ends5)
// played = a "[tts] timing … playing" line; between round 4's question and round 5's, none
const iq4 = trace.findIndex((l) => l.text.endsWith(' final ' + Q[3]))
const iq5 = trace.findIndex((l) => l.text.endsWith(' final ' + Q[4]))
const played4 = trace.slice(iq4, iq5).filter((l) => l.text.startsWith('[tts] timing')).length
const after5 = trace.slice(iq5).filter((l) => l.text.startsWith('[tts] timing') && (l.text.match(/playing/g) || []).length === 1).length
check(iq4 >= 0 && iq5 > iq4 && played4 === 0 && after5 === 1, `round 4: the cancelled answer is never played (${played4} play(s) before round 5; ${(await spoken()).length - from5} voice request(s) after it, all round 5)`)
await shot('r5-read')

// ---- exit ----
await wait(2000)
await say(EXIT)
await wait(800)
await shot('ended')
check(trace.some((l) => / #\d+ final 退出$/.test(l.text)) && asked.length === 5, 'the exit word is heard and ends the conversation (no 6th request)')

// ---- the whole session ----
const order = asked.map((a) => a.q)
check(JSON.stringify(order) === JSON.stringify(Q), 'the bridge got the 5 questions in order')
const timings = trace.filter((l) => l.text.startsWith('[tts] timing') && (l.text.match(/playing/g) || []).length === 1).map((l) => l.text)
const gaps = timings.map((t) => { const m = t.match(/text ([\d.]+)s.*playing ([\d.]+)s/); return m ? +(m[2] - m[1]).toFixed(1) : null })
check(timings.length === 4 && gaps.every((g) => g !== null && g < 2.5), `the voice starts soon after the first text of each answer read (${gaps.join(' / ')} s, ${timings.length} answers)`)
const dropped = (await pg.evaluate(() => window.__log.slice())).filter((l) => l.startsWith('asr.dropped'))
const all = await sessions()
check(!dropped.length && !all.some((s) => s.deaf), `no speech lost to a timed-out or deaf mic (${all.length} sessions)` + (dropped.length ? ': ' + dropped.join(' | ') : ''))
// renewals: from the old mic's end to the new one capturing, nothing is heard (the voice waits)
const evs = trace.map((l) => ({ at: l.at, m: l.text.match(/ #(\d+) (end|audiostart)$/) })).filter((e) => e.m)
const windows = []
for (const e of evs) if (e.m[2] === 'audiostart') {
  const end = evs.filter((x) => x.m[2] === 'end' && +x.m[1] === +e.m[1] - 1 && x.at <= e.at).at(-1)
  if (end) windows.push(e.at - end.at)
}
check(windows.length > 0 && Math.max(...windows) < 1500, `mic renewals: ${windows.length}, deaf for ${Math.min(...windows)}–${Math.max(...windows)} ms each (avg ${Math.round(windows.reduce((a, b) => a + b, 0) / windows.length)} ms)`)
check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''))
for (const t of timings) console.log('    ' + t)
if (failures) console.log('  trace:\n' + trace.map((l) => '    ' + l.text.slice(0, 140)).join('\n'))
await browser.close()
server.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall round checks passed', '— screenshots in e2e/out-rounds/')
process.exit(failures ? 1 : 0)
