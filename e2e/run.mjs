// End-to-end run on the real AIUI (Ink) runtime in headless Chromium, with a fake
// glasses host (ASR/TTS) and a fake bridge. Checks the conversation flow and saves
// screenshots of every step to e2e/out/<case>/ for visual review.
//   npm run e2e            (needs: npm install && npx playwright install chromium)
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const outRoot = join(dirname(fileURLToPath(import.meta.url)), 'out')
const CASES = [
  // lang = system (Hi Rokid) language, tts = what the host offers, target = card or full screen
  { lang: 'zh-CN', tts: 'synth', target: '_blank' },
  { lang: 'zh-CN', tts: 'synth', target: '_current' },
  { lang: 'en-US', tts: 'synth', target: '_blank' },
  { lang: 'zh-CN', tts: 'speak', target: '_blank' },
]
const ZH_STORY = '很久以前，在一个宁静的小村庄里，住着一个喜欢看月亮的小女孩。每天晚上，她都会坐在院子里，抬头望着天上那轮明亮的月亮。她相信月亮上住着一位温柔的仙女，会在夜里守护着所有的孩子。有一天晚上，月亮突然变得特别亮，一道银色的光芒从天而降，落在了她的院子里。光芒中走出一只雪白的兔子，它告诉小女孩，月亮上的仙女生病了，需要人间最纯净的笑声才能治好。'
const EN_STORY = 'Long ago, in a quiet village, there lived a girl who loved to watch the moon. Every night she sat in the garden and looked up at its bright silver face. She believed a gentle fairy lived there, watching over all the children while they slept. One evening the moon grew brighter than ever, and a beam of silver light fell into her garden. Out of the light hopped a snow white rabbit, who told her the moon fairy was ill.'

const server = await serve()
const base = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
rmSync(outRoot, { recursive: true, force: true })
let failures = 0

for (const c of CASES) {
  const name = `${c.lang}-${c.tts}${c.target}`
  const out = join(outRoot, name)
  mkdirSync(out, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 480, height: 352 }, permissions: ['microphone'] })
  const pg = await ctx.newPage()
  const errors = []
  pg.on('pageerror', (e) => errors.push(e.message))
  pg.on('console', (m) => { const t = m.text(); if (/\bERROR\b|Uncaught/.test(t)) errors.push(t.replace(/%c|color:[^;]*;?|padding:[^;]*;?|background:[^;]*;?|font-weight:[^;]*;?/g, '').trim()) })

  // fake bridge: one queued answer per request, SSE in small chunks
  const answers = []
  const asked = []
  await pg.route('https://rokid-hermes.snowbig.com/**', async (route) => {
    asked.push(JSON.parse(route.request().postData() || '{}').message?.[0]?.text)
    const a = answers.shift() || { text: '（无）' }
    await new Promise((r) => setTimeout(r, a.delay || 0))
    const sse = a.text.match(/[\s\S]{1,8}/g).map((p) => `data: ${JSON.stringify({ type: 'answer', answer_stream: p })}\n\n`).join('')
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse })
  })

  const wait = (ms) => pg.waitForTimeout(ms)
  let n = 0
  const shot = async (step) => { await wait(150); await pg.locator('canvas').screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${step}.png`) }) }
  const say = (text, isFinal = true) => pg.evaluate(([t, f]) => __say(t, f), [text, isFinal])
  const key = (code) => pg.evaluate((k) => __key(k), code)
  const hostLog = () => pg.evaluate(() => window.__log.slice())

  const zh = c.lang.startsWith('zh')
  const [q1, a1] = zh ? ['给我讲一个关于月亮的长故事', ZH_STORY] : ['Tell me a long story about the moon', EN_STORY]
  const [q2, a2] = zh ? ['What time is it in London?', 'It is about three in the afternoon in London.'] : ['伦敦现在几点？', '伦敦现在大约是下午三点。']
  const checks = []
  const check = (ok, what) => { checks.push((ok ? '  ✔ ' : '  ✖ ') + what); if (!ok) failures++ }

  await pg.goto(`${base}?lang=${c.lang}&tts=${c.tts}&target=${c.target}`)
  await pg.waitForFunction(() => window.__ready)
  await wait(1200)
  await shot('initial')
  await key('GlobalHook')
  await pg.waitForFunction(() => __asr.sessions.length > 0, null, { timeout: 10000 }).catch(() => {})
  check((await hostLog()).some((l) => l.startsWith('asr.open ' + c.lang)), 'temple tap opens the mic (ASR stream, ' + c.lang + ')')
  await wait(1200)
  await shot('listening')

  answers.push({ text: a1, delay: 1200 })
  await say(q1.slice(0, 6), false)
  await shot('question-live')
  await say(q1)
  await wait(400)
  await shot('question-thinking')
  await wait(1500)
  await shot('answer-reading')
  await wait(4000)
  await shot('reading-4s')
  const firstVoice = (await hostLog()).find((l) => l.startsWith('tts.'))
  const voice1 = zh ? 'female-yujie' : 'English_radiant_girl'
  const method = c.tts === 'synth' && c.target === '_blank' ? 'tts.synth' : 'tts.speak'
  check(firstVoice?.startsWith(method) && firstVoice.includes('voice=' + voice1), `answer 1 read with ${method.slice(4)}() in ${voice1}: ${firstVoice}`)

  await key('GlobalHook')   // interrupt the reading
  await wait(300)
  await shot('tap-interrupt')
  answers.push({ text: a2, delay: 500 })
  await say(q2)             // only accepted if the tap really switched to listening
  await wait(300)
  await shot('question-2-thinking')
  await wait(1500)
  await shot('answer-2')
  const voices = (await hostLog()).filter((l) => / voice=/.test(l))
  const voice2 = zh ? 'English_radiant_girl' : 'female-yujie'
  check(voices.at(-1)?.includes('voice=' + voice2), `answer 2 voice follows its language (${voice2}): ${voices.at(-1)}`)
  check(JSON.stringify(asked) === JSON.stringify([q1, q2]), 'bridge got both questions (tap interrupted the reading): ' + JSON.stringify(asked))

  await key('ArrowUp'); await wait(600); await shot('swipe-up')
  await key('ArrowDown'); await wait(600); await shot('swipe-down')
  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''))
  console.log(name + '\n' + checks.join('\n'))
  await ctx.close()
}

await browser.close()
server.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed', '— screenshots in e2e/out/')
process.exit(failures ? 1 : 0)
