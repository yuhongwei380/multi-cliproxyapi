import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Store } from '../server/store.js'
import { ProcessRuntime } from '../server/runtime.js'

assert.equal(process.platform, 'linux')
const acceptance = path.resolve(process.argv[2] || '')
assert.ok(path.basename(acceptance).startsWith('.functional-test-'))
const root = fs.mkdtempSync(path.join(acceptance, 'package-'))
const version = '7.2.159'
const versionPath = path.join(root, 'versions', version)
fs.mkdirSync(path.dirname(versionPath), { recursive: true })
fs.cpSync(path.join(acceptance, 'versions', version), versionPath, { recursive: true })
const store = new Store(path.join(root, 'control.db'))
store.saveVersion({ tag: version, path: versionPath, usable: true, installed_at: new Date().toISOString() })
store.close()
let child, instance, cookie = '', output = ''
const evidence = []
const record = (name, extra = {}) => { evidence.push({ name, ...extra }); console.log(`PASS ${name}`) }
async function launch() {
  child = spawn(path.resolve('release/multi-cliproxyapi-linux-x64'), ['--data-dir', path.relative(process.cwd(), root), '--listen', '127.0.0.1:18788', '--version', version], { env: { ...process.env, MULTI_CPA_SKIP_VERSION_INSTALL: 'true', MULTI_CPA_RUNTIME: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  await once(child, 'spawn')
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`package exited: ${output}`)
    try { const response = await fetch('http://127.0.0.1:18788/health', { signal: AbortSignal.timeout(500) }); if (response.ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`package did not start: ${output}`)
}
async function api(route, body) {
  // Deleting an instance also removes a copied CPA executable. Allow slower
  // WSL/CI filesystems enough time to finish that bounded cleanup.
  const response = await fetch(`http://127.0.0.1:18788/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const value = await response.json()
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`)
  if (route === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
try {
  await launch()
  for (const script of ['install.sh', 'start.sh', 'stop.sh', 'uninstall.sh']) {
    const scriptPath = path.resolve('release', script)
    assert.equal(fs.existsSync(scriptPath), true, `${script} is included in release`)
    assert.ok(fs.statSync(scriptPath).mode & 0o111, `${script} is executable`)
  }
  const installScript = fs.readFileSync(path.resolve('release', 'install.sh'), 'utf8')
  assert.match(installScript, /multi-cliproxyapi\.service/)
  assert.match(installScript, /multi-cpa@\.service/)
  assert.match(installScript, /polkit\.addRule/)
  assert.match(installScript, /--runtime systemd/)
  assert.match(installScript, /DATA_DIR=\$\{MULTI_CPA_DATA_DIR:-\/opt\/mutli-cliproxycpa-data\}/)
  assert.match(installScript, /ProtectHome=read-only/)
  assert.doesNotMatch(installScript, /WorkingDirectory="/)
  assert.doesNotMatch(installScript, /ReadWritePaths="/)
  assert.match(fs.readFileSync(path.resolve('release', 'start.sh'), 'utf8'), /systemctl start/)
  assert.match(fs.readFileSync(path.resolve('release', 'stop.sh'), 'utf8'), /systemctl stop/)
  assert.match(fs.readFileSync(path.resolve('release', 'uninstall.sh'), 'utf8'), /systemctl disable/)
  record('release includes systemd installation and lifecycle scripts')
  const page = await fetch('http://127.0.0.1:18788/')
  const html = await page.text()
  assert.equal(page.status, 200)
  const asset = html.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await fetch(`http://127.0.0.1:18788${asset}`)).status, 200)
  record('standalone package serves embedded HTML and JavaScript')
  await api('/auth/login', { username: 'admin', password: 'admin' })
  instance = await api('/instances', { name: 'package-test', port: 18326 })
  const instanceConfig = fs.readFileSync(path.join(root, 'instances', instance.id, 'config.yaml'), 'utf8')
  assert.match(instanceConfig, /^plugins:\n  enabled: true$/m)
  record('new instances enable CPA plugins by default')
  await api(`/instances/${instance.id}/start`, {})
  let started
  for (let i = 0; i < 20; i++) { started = await api(`/instances/${instance.id}`); if (started.status.management_ready) break; await new Promise(resolve => setTimeout(resolve, 200)) }
  assert.equal(started.status.management_ready, true)
  record('relative data-dir supports real instance creation and startup', { pid: started.status.pid })
  const crashed = once(child, 'exit')
  child.kill('SIGKILL')
  await crashed
  const alive = await fetch('http://127.0.0.1:18326/management.html')
  assert.equal(alive.status, 200)
  record('controller crash leaves CPA management page available')
  await launch()
  const recovered = await api(`/instances/${instance.id}`)
  assert.equal(recovered.status.pid, started.status.pid)
  assert.equal(recovered.desired_state, 'running')
  record('package recovery preserves child PID and persisted session')
  const challenge = await api(`/instances/${instance.id}/delete-challenge`, {})
  await api(`/instances/${instance.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: 'admin' })
  assert.equal(fs.existsSync(path.join(root, 'instances', instance.id)), false)
  record('package deletes only its test instance')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  if (instance && fs.existsSync(path.join(root, 'instances', instance.id))) await new ProcessRuntime().stop({ ...instance, directory: path.join(root, 'instances', instance.id) })
  fs.writeFileSync(path.join(acceptance, 'package-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), root, evidence, output }, null, 2))
}
