// Serves the e2e harness, the Ink runtime (@yodaos-pkg/ink) and the agent bundle.
import http from 'node:http'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ink = dirname(createRequire(import.meta.url).resolve('@yodaos-pkg/ink/package.json'))
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json' }
const skip = /^(\.git|node_modules|test|e2e|docs)(\/|$)/
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))

// the agent as the glasses get it, with a dummy AK instead of the gitignored secrets.js
function bundle() {
  const files = walk(root).map((f) => relative(root, f)).filter((f) => !skip.test(f) && f !== 'secrets.js')
    .map((path) => ({ path, base64: readFileSync(join(root, path)).toString('base64') }))
  files.push({ path: 'secrets.js', base64: Buffer.from('export const SECRETS = { ak: "e2e-dummy-ak" }\n').toString('base64') })
  return files
}

export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    if (url === '/bundle.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(bundle()))
    }
    const file = url === '/' ? join(here, 'harness.html') : url.startsWith('/ink/') ? join(ink, url.slice(5)) : null
    if (!file || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
