#!/usr/bin/env node
// Runs the API server and the Vite dev server together, and prints the LAN URL
// you can open on your phone. Ctrl-C kills both.
import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_PORT = 3211

function lanAddress() {
  const found = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    // Same exclusions the server uses: a docker bridge address is useless to a phone.
    if (/^(lo|docker|br-|veth|virbr|tun|tap|utun|awdl|llw)/i.test(name)) continue
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) found.push(a.address)
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return found.sort((a, b) => rank(a) - rank(b))[0] || 'localhost'
}

const children = []
function run(name, cmd, args, cwd, env) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const tag = `\x1b[2m[${name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) out.write(tag + l + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`${tag}exited with code ${code}\n`)
      shutdown(code ?? 1)
    }
  })
  children.push(child)
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) c.kill('SIGTERM')
  // Not unref'd: an unref'd timer lets the loop drain first and the process exits 0,
  // swallowing a child's failure exit code.
  setTimeout(() => process.exit(code), 200)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('api', process.execPath, ['--watch', 'src/index.js'], resolve(root, 'server'), {
  NETCLIP_DATA_DIR: resolve(root, 'data'),
  NETCLIP_DEV: '1',
})
run('web', process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT)], resolve(root, 'web'))

setTimeout(() => {
  const ip = lanAddress()
  console.log('')
  console.log('  \x1b[1mnetclip dev\x1b[0m')
  console.log(`  local   \x1b[36mhttp://localhost:${WEB_PORT}\x1b[0m`)
  console.log(`  phone   \x1b[36mhttp://${ip}:${WEB_PORT}\x1b[0m`)
  console.log('')
}, 1200).unref()
