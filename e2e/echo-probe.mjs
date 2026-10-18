// Runs tools/echo-probe in the AIUI runtime with the fake host, to check the probe itself
// works before it goes on the glasses. The fake mic hears nothing, so the fake recognizer
// is told what a mic without echo cancellation would hear: the probe's own sentence
// (and in test D the user's line too).
//   node e2e/echo-probe.mjs      screenshots in e2e/out-probe/
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.E2E_APP_ROOT = 'tools/echo-probe'
const { serve } = await import('./serve.mjs')
const out = join(dirname(fileURLToPath(import.meta.url)), 'out-probe')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const SENTENCE = '这是一段回声测试语音，请保持安静，不要说话。眼镜正在检查麦克风能不能听到自己播放的声音。测试马上就会结束。'
const SAY = '今天天气很好，我想去公园散步。'
const server = await serve()
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const ctx = await browser.newContext({ viewport: { width: 480, height: 352 }, permissions: ['microphone'] })
const pg = await ctx.newPage()
const errors = []
const lines = []
pg.on('pageerror', (e) => errors.push(e.message))
pg.on('console', (m) => {
  const t = m.text().replace(/%c|color:[^;]*;?|padding:[^;]*;?|background:[^;]*;?|font-weight:[^;]*;?/g, '').trim()
  if (/\bERROR\b|Uncaught/.test(t)) errors.push(t)
  if (t.includes('[probe]')) lines.push(t.replace(/^.*?\[probe\]\s*/, ''))
})
await pg.goto(`http://127.0.0.1:${server.address().port}/?lang=zh-CN&tts=synth&target=_blank`)
await pg.waitForFunction(() => window.__ready)
await pg.waitForTimeout(1200)

for (const [i, id] of ['A', 'B', 'C', 'D'].entries()) {
  await pg.evaluate(() => __key('GlobalHook'))
  const playing = await pg.waitForFunction((n) => window.__tts.length > n, i, { timeout: 15000 }).catch(() => null)
  if (!playing) {
    console.log('✖ test ' + id + ' never started reading\n  ' + lines.concat(errors, await pg.evaluate(() => window.__log)).join('\n  '))
    break
  }
  // what the mic would hear while the sentence plays
  await pg.waitForTimeout(500)
  await pg.evaluate((t) => __say(t, false), SENTENCE.slice(0, 20))
  await pg.evaluate((t) => __say(t), id === 'D' ? SENTENCE.slice(0, 30) + SAY : SENTENCE)
  for (let t = 0; t < 40 && lines.filter((l) => l.startsWith(id + ' ') || l.startsWith(id + ' failed')).length === 0; t++) await pg.waitForTimeout(500)
  await pg.locator('canvas').screenshot({ path: join(out, `${i + 1}-test-${id}.png`) })
}
await browser.close()
server.close()

console.log(lines.map((l) => '  ' + l).join('\n'))
const want = { A: /own voice heard 100%/, B: /EC=.*own voice heard 100%/, C: /EC=.*own voice heard 100%/, D: /your line heard 100%/ }
let failed = errors.length
for (const [id, re] of Object.entries(want)) {
  const line = lines.find((l) => l.startsWith(id + ' '))
  const ok = !!line && re.test(line)
  if (!ok) failed++
  console.log((ok ? '✔ ' : '✖ ') + 'test ' + id + ' ran and scored the simulated echo')
}
if (errors.length) console.log('✖ runtime errors: ' + errors.slice(0, 3).join(' | '))
console.log(failed ? 'probe check failed' : 'probe works in the simulator — screenshots in e2e/out-probe/')
process.exit(failed ? 1 : 0)
