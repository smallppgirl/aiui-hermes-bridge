// Serves the e2e harness, the Ink runtime (@yodaos-pkg/ink) and the agent bundle.
// live = true: the bundle keeps the real AK (local secrets.js) and its bridge URL is
// pointed at /bridge here, which streams to the real bridge (same origin, so no CORS).
import http from 'node:http'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const appRoot = process.env.E2E_APP_ROOT ? join(root, process.env.E2E_APP_ROOT) : root   // another agent, e.g. tools/echo-probe
const ink = dirname(createRequire(import.meta.url).resolve('@yodaos-pkg/ink/package.json'))
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json' }
const skip = /^(\.git|node_modules|test|e2e|docs|tools)(\/|$)/
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const BRIDGE_URL = /^(\s*url:\s*")([^"]+)(")/m

// E2E_BRIDGE_URL overrides the target (e.g. a local slow-streaming stub)
export const bridgeUrl = () => process.env.E2E_BRIDGE_URL || readFileSync(join(root, 'config.js'), 'utf8').match(BRIDGE_URL)[2]

// the agent as the glasses get it
function bundle(live, origin) {
  const files = walk(appRoot).map((f) => relative(appRoot, f)).filter((f) => !skip.test(f) && (live || f !== 'secrets.js'))
    .map((path) => {
      let data = readFileSync(join(appRoot, path))
      if (live && path === 'config.js') data = Buffer.from(data.toString('utf8').replace(BRIDGE_URL, `$1${origin}/bridge$3`))
      return { path, base64: data.toString('base64') }
    })
  if (!live) files.push({ path: 'secrets.js', base64: Buffer.from('export const SECRETS = { ak: "e2e-dummy-ak" }\n').toString('base64') })
  return files
}

// stream one bridge request to the real bridge and the SSE answer back as it arrives
async function proxy(req, res, onRequest, onAnswer) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  onRequest && onRequest(JSON.parse(body.toString('utf8') || '{}'))
  try {
    const upstream = await fetch(bridgeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' },
      body,
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' })
    let raw = ''
    const dec = new TextDecoder()
    for await (const c of upstream.body) { res.write(c); raw += dec.decode(c, { stream: true }) }
    res.end()
    // the answer text, for the test's checks
    const answer = raw.replace(/\r/g, '').split('\n\n').map((b) => { try { return JSON.parse(b.match(/data:\s*(\{.*\})/s)[1]).answer_stream || '' } catch (_) { return '' } }).join('')
    onAnswer && onAnswer(answer, upstream.status)
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('e2e proxy: ' + e.message)
  }
}

export function serve({ live = false, onBridgeRequest, onBridgeAnswer } = {}) {
  if (live && !existsSync(join(root, 'secrets.js'))) throw new Error('--live needs secrets.js with the real AK (see secrets.example.js)')
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    if (url === '/bridge' && live) return proxy(req, res, onBridgeRequest, onBridgeAnswer)
    if (url === '/bundle.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(bundle(live, 'http://' + req.headers.host)))
    }
    const file = url === '/' ? join(here, 'harness.html') : url.startsWith('/ink/') ? join(ink, url.slice(5)) : null
    if (!file || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
