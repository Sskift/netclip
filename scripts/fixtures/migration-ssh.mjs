#!/usr/bin/env node
// Local SSH transport with fault injection, used only by test-migrate.mjs.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let command = process.argv.at(-1)
const mode = process.env.MIGRATION_TEST_FAULT
if (mode === 'commit' && command.includes('"action":"commit"')) {
  command = command.replace('for (const name of incoming) { await ownership',
    'throw new Error("injected commit failure"); for (const name of incoming) { await ownership')
}
if (mode === 'late-write' && command.includes('"action":"commit"')) {
  writeFileSync(process.env.MIGRATION_TEST_TARGET + '/drive/late', 'new target upload')
}
const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] })
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
if (command.includes('"action":"export"') && ['truncate', 'corrupt', 'interrupt'].includes(mode)) {
  const chunks = []
  child.stdout.on('data', chunk => chunks.push(chunk))
  child.stdout.on('end', () => {
    const data = Buffer.concat(chunks)
    if (mode === 'interrupt') {
      writeFileSync(process.env.MIGRATION_TEST_MARKER, 'ready')
      setTimeout(() => process.stdout.write(data), 30000)
    } else if (mode === 'truncate') process.stdout.write(data.subarray(0, data.length - 20))
    else {
      const at = data.indexOf('binary fixture payload')
      if (at < 0) process.exit(2)
      data[at] ^= 1
      process.stdout.write(data)
    }
  })
} else child.stdout.pipe(process.stdout)
child.on('exit', code => { process.exitCode = code ?? 1 })
