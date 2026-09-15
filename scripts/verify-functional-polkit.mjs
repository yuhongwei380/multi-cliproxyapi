import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { SystemdRuntime } from '../server/runtime.js'

assert.equal(process.getuid(), 0)
const acceptance = path.resolve(process.argv[2] || '')
assert.ok(path.basename(acceptance).startsWith('.functional-test-'))
const root = fs.mkdtempSync('/var/lib/.multi-cpa-acceptance-')
const unitName = 'multi-cpa@acceptance-polkit.service'
const deniedName = 'multi-cpa-denied@acceptance-polkit.service'
const unitPath = `/run/systemd/system/${unitName}`
const deniedPath = `/run/systemd/system/${deniedName}`
const rulePath = '/etc/polkit-1/rules.d/90-multi-cpa-acceptance.rules'
for (const file of [unitPath, deniedPath, rulePath]) assert.equal(fs.existsSync(file), false, `refusing to overwrite ${file}`)
const directory = path.join(root, 'instances', 'acceptance-polkit')
for (const name of ['bin', 'static', 'auths', 'logs']) fs.mkdirSync(path.join(directory, name), { recursive: true })
fs.mkdirSync(path.join(root, 'private'))
for (const name of ['control.db', 'secrets.key']) fs.writeFileSync(path.join(root, name), '')
const versionPath = path.join(acceptance, 'versions', '7.2.159')
fs.copyFileSync(path.join(versionPath, 'cli-proxy-api'), path.join(directory, 'bin', 'cli-proxy-api'))
fs.chmodSync(path.join(directory, 'bin', 'cli-proxy-api'), 0o755)
fs.copyFileSync(path.join(versionPath, 'static', 'management.html'), path.join(directory, 'static', 'management.html'))
fs.writeFileSync(path.join(directory, 'config.yaml'), `host: 127.0.0.1\nport: 18327\nauth-dir: ${JSON.stringify(path.join(directory, 'auths'))}\nremote-management:\n  allow-remote: false\n  secret-key: "admin"\nlogging-to-file: true\n`)
execFileSync('chown', ['-R', 'multi-cpa:multi-cpa', root])
const template = fs.readFileSync(new URL('../deploy/systemd/multi-cpa@.service', import.meta.url), 'utf8')
const unit = template.replaceAll('/opt/mutli-cliproxycpa-data', root).replaceAll('/etc/multi-cliproxyapi', path.join(root, 'private')).replaceAll('%i', 'acceptance-polkit')
const policy = fs.readFileSync(new URL('../deploy/polkit/60-multi-cpa.rules', import.meta.url), 'utf8')
// Restrict the temporary copy to this one test unit, while retaining every
// production user/action/unit/verb predicate underneath it.
const narrowedPolicy = policy.replace('polkit.addRule(function (action, subject) {', `polkit.addRule(function (action, subject) {\n  if (action.lookup("unit") !== "${unitName}") return polkit.Result.NOT_HANDLED;`)
const runtime = new SystemdRuntime({ unitPrefix: 'multi-cpa', runner: async args => ({ stdout: execFileSync('runuser', ['-u', 'multi-cpa', '--', 'systemctl', ...args], { encoding: 'utf8' }) }) })
const instance = { id: 'acceptance-polkit', directory, version: '7.2.159' }
const evidence = []
try {
  fs.writeFileSync(unitPath, unit, { mode: 0o644 })
  fs.writeFileSync(deniedPath, unit, { mode: 0o644 })
  fs.writeFileSync(rulePath, narrowedPolicy, { mode: 0o644 })
  execFileSync('systemctl', ['daemon-reload'])
  await runtime.start(instance)
  let healthy = false
  for (let i = 0; i < 30; i++) { try { const response = await fetch('http://127.0.0.1:18327/v0/management/config', { headers: { Authorization: 'Bearer admin' }, signal: AbortSignal.timeout(500) }); if (response.ok) { healthy = true; break } } catch {}; await new Promise(resolve => setTimeout(resolve, 200)) }
  assert.ok(healthy, 'CPA must run under the actual multi-cpa principal')
  const pid = (await runtime.status(instance)).pid
  await runtime.restart(instance)
  assert.notEqual((await runtime.status(instance)).pid, pid)
  await runtime.stop(instance)
  assert.equal((await runtime.status(instance)).state, 'stopped')
  evidence.push('multi-cpa principal may start, restart and stop the allowlisted test unit')
  assert.throws(() => execFileSync('runuser', ['-u', 'multi-cpa', '--', 'systemctl', '--no-ask-password', 'start', deniedName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => /Access denied|Interactive authentication required/i.test(error.stderr))
  evidence.push('unrelated unit start is denied without an interactive prompt')
  console.log(evidence.map(value => `PASS ${value}`).join('\n'))
} finally {
  for (const name of [unitName, deniedName]) { try { execFileSync('systemctl', ['stop', name]) } catch {} }
  for (const file of [unitPath, deniedPath, rulePath]) { try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  execFileSync('systemctl', ['daemon-reload'])
  const resolved = fs.realpathSync(root)
  assert.ok(resolved.startsWith('/var/lib/.multi-cpa-acceptance-'))
  fs.rmSync(resolved, { recursive: true, force: true })
  fs.writeFileSync(path.join(acceptance, 'polkit-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), evidence }, null, 2))
}
