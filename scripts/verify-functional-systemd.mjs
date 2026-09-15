import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { SystemdRuntime } from '../server/runtime.js'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid(), 0, 'run only this isolated systemd test as root')
const acceptance = path.resolve(process.argv[2] || '')
assert.ok(path.basename(acceptance).startsWith('.functional-test-'))
const root = path.join(acceptance, 'systemd')
const unitFile = '/run/systemd/system/multi-cpa-acceptance@.service'
assert.equal(fs.existsSync(unitFile), false, 'refusing to overwrite an existing test unit')
const item = { id: 'cpa-systemd', directory: path.join(root, 'instances', 'cpa-systemd'), version: '7.2.159' }
fs.mkdirSync(path.join(item.directory, 'bin'), { recursive: true })
fs.mkdirSync(path.join(item.directory, 'static'), { recursive: true })
fs.mkdirSync(path.join(item.directory, 'auths'), { recursive: true })
fs.mkdirSync(path.join(item.directory, 'logs'), { recursive: true })
fs.mkdirSync(path.join(root, 'private'), { recursive: true })
fs.writeFileSync(path.join(root, 'control.db'), '')
fs.writeFileSync(path.join(root, 'secrets.key'), '')
fs.copyFileSync(path.join(acceptance, 'versions', item.version, 'cli-proxy-api'), path.join(item.directory, 'bin', 'cli-proxy-api'))
fs.chmodSync(path.join(item.directory, 'bin', 'cli-proxy-api'), 0o755)
fs.copyFileSync(path.join(acceptance, 'versions', item.version, 'static', 'management.html'), path.join(item.directory, 'static', 'management.html'))
fs.writeFileSync(path.join(item.directory, 'config.yaml'), `host: 127.0.0.1\nport: 18325\nauth-dir: ${JSON.stringify(path.join(item.directory, 'auths'))}\nremote-management:\n  allow-remote: false\n  secret-key: "admin"\n  disable-control-panel: false\nlogging-to-file: true\n`)
execFileSync('chown', ['-R', 'yhw:yhw', root])
const template = fs.readFileSync(new URL('../deploy/systemd/multi-cpa@.service', import.meta.url), 'utf8')
const unit = template.replaceAll('/opt/mutli-cliproxycpa-data', root).replaceAll('/etc/multi-cliproxyapi', path.join(root, 'private')).replace('User=multi-cpa', 'User=yhw').replace('Group=multi-cpa', 'Group=yhw')
const runtime = new SystemdRuntime({ unitPrefix: 'multi-cpa-acceptance' })
const evidence = []
const record = (name, detail = {}) => { evidence.push({ name, ...detail }); console.log(`PASS ${name}`) }
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { const response = await fetch('http://127.0.0.1:18325/v0/management/config', { headers: { Authorization: 'Bearer admin' }, signal: AbortSignal.timeout(1000) }); if (response.ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('systemd CPA did not become ready')
}
try {
  fs.writeFileSync(unitFile, unit, { mode: 0o644 })
  execFileSync('systemctl', ['daemon-reload'])
  await runtime.start(item)
  await ready()
  const started = await runtime.status(item)
  assert.equal(started.state, 'running')
  record('real systemd start under production sandbox directives', { pid: started.pid })
  await runtime.restart(item)
  await ready()
  const restarted = await runtime.status(item)
  assert.notEqual(restarted.pid, started.pid)
  record('real systemd restart changes PID', { pid: restarted.pid })
  const page = await fetch('http://127.0.0.1:18325/management.html')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/i)
  record('systemd CPA management page and authenticated API')
  await runtime.stop(item)
  assert.equal((await runtime.status(item)).state, 'stopped')
  record('real systemd stop confirms exit')
} finally {
  try { await runtime.stop(item) } finally {
    fs.unlinkSync(unitFile)
    execFileSync('systemctl', ['daemon-reload'])
    fs.writeFileSync(path.join(acceptance, 'systemd-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), evidence }, null, 2))
  }
}
