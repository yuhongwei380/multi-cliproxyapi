import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Store } from '../server/store.js'
import { renderControllerUnit } from '../deploy/render-controller-unit.mjs'

assert.equal(process.getuid(), 0)
const acceptance = path.resolve(process.argv[2] || '')
assert.ok(path.basename(acceptance).startsWith('.functional-test-'))
const root = fs.mkdtempSync('/var/lib/.multi-cpa-deployment-')
const prefix = path.join(root, 'prefix')
const installRoot = path.join(prefix, 'lib', 'multi-cliproxyapi')
const controllerName = 'multi-cpa-acceptance-controller.service'
const controllerPath = `/run/systemd/system/${controllerName}`
const templatePath = '/run/systemd/system/multi-cpa@.service'
const policyPath = '/etc/polkit-1/rules.d/90-multi-cpa-deployment-test.rules'
for (const file of [controllerPath, templatePath, policyPath]) assert.equal(fs.existsSync(file), false, `refusing to overwrite ${file}`)
assert.equal(fs.existsSync('/etc/systemd/system/multi-cpa@.service'), false, 'refusing to shadow a production template')
const sourceRoot = path.resolve(new URL('..', import.meta.url).pathname)
fs.mkdirSync(path.join(installRoot, 'runtime'), { recursive: true })
fs.mkdirSync(path.join(installRoot, 'web'), { recursive: true })
fs.cpSync(path.join(sourceRoot, 'server'), path.join(installRoot, 'server'), { recursive: true })
fs.cpSync(path.join(sourceRoot, 'web', 'dist'), path.join(installRoot, 'web', 'dist'), { recursive: true })
fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(installRoot, 'package.json'))
fs.copyFileSync(process.execPath, path.join(installRoot, 'runtime', 'node'))
fs.chmodSync(path.join(installRoot, 'runtime', 'node'), 0o755)
const versionPath = path.join(root, 'versions', '7.2.159')
fs.mkdirSync(path.dirname(versionPath))
fs.cpSync(path.join(acceptance, 'versions', '7.2.159'), versionPath, { recursive: true })
fs.mkdirSync(path.join(root, 'private'))
const store = new Store(path.join(root, 'control.db'))
store.saveVersion({ tag: '7.2.159', path: versionPath, usable: true, installed_at: new Date().toISOString() })
store.close()
execFileSync('chown', ['-R', 'multi-cpa:multi-cpa', root])
const controllerSource = fs.readFileSync(path.join(sourceRoot, 'deploy/systemd/multi-cliproxyapi.service'), 'utf8')
const controllerUnit = renderControllerUnit(controllerSource, prefix).replaceAll('/opt/mutli-cliproxycpa-data', root).replaceAll('0.0.0.0:8787', '127.0.0.1:18789').replace('[Service]', '[Service]\nEnvironment=MULTI_CPA_SKIP_VERSION_INSTALL=true\nEnvironment=MULTI_CPA_VERSION=7.2.159')
const instanceUnit = fs.readFileSync(path.join(sourceRoot, 'deploy/systemd/multi-cpa@.service'), 'utf8').replaceAll('/opt/mutli-cliproxycpa-data', root).replaceAll('/etc/multi-cliproxyapi', path.join(root, 'private'))
const policy = fs.readFileSync(path.join(sourceRoot, 'deploy/polkit/60-multi-cpa.rules'), 'utf8')
let cookie = '', instance
const evidence = []
const record = name => { evidence.push(name); console.log(`PASS ${name}`) }
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:18789/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  const value = await response.json()
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`)
  if (route === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
async function ready() {
  for (let i = 0; i < 40; i++) { try { const response = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(500) }); if (response.ok) return } catch {}; await new Promise(resolve => setTimeout(resolve, 200)) }
  throw new Error(execFileSync('journalctl', ['-u', controllerName, '-n', '12', '--no-pager'], { encoding: 'utf8' }))
}
try {
  fs.writeFileSync(controllerPath, controllerUnit, { mode: 0o644 })
  fs.writeFileSync(templatePath, instanceUnit, { mode: 0o644 })
  fs.writeFileSync(policyPath, policy, { mode: 0o644 })
  execFileSync('systemctl', ['daemon-reload'])
  execFileSync('systemctl', ['start', controllerName])
  await ready()
  record('controller starts under actual service hardening with copied Node runtime')
  await api('/auth/login', { username: 'admin', password: 'admin' })
  instance = await api('/instances', { name: 'systemd-deployment', port: 18328 })
  await api(`/instances/${instance.id}/start`, {})
  const started = await api(`/instances/${instance.id}`)
  assert.equal(started.status.management_ready, true)
  record('unprivileged controller creates and starts a real CPA via production polkit policy')
  execFileSync('systemctl', ['restart', controllerName])
  await ready()
  const recovered = await api(`/instances/${instance.id}`)
  assert.equal(recovered.status.pid, started.status.pid)
  record('systemd controller restart preserves independently managed CPA PID and session')
  await api(`/instances/${instance.id}/stop`, {})
  execFileSync('systemctl', ['restart', controllerName])
  await ready()
  assert.equal((await api(`/instances/${instance.id}`)).status.state, 'stopped')
  record('manual stopped intent survives systemd controller restart')
  const challenge = await api(`/instances/${instance.id}/delete-challenge`, {})
  await api(`/instances/${instance.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: 'admin' })
  assert.equal(fs.existsSync(path.join(root, 'instances', instance.id)), false)
  record('production runtime deletion clears its isolated instance directory')
} finally {
  if (instance) { try { execFileSync('systemctl', ['stop', `multi-cpa@${instance.id}.service`]) } catch {} }
  try { execFileSync('systemctl', ['stop', controllerName]) } catch {}
  for (const file of [controllerPath, templatePath, policyPath]) { try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  execFileSync('systemctl', ['daemon-reload'])
  const resolved = fs.realpathSync(root)
  assert.ok(resolved.startsWith('/var/lib/.multi-cpa-deployment-'))
  fs.rmSync(resolved, { recursive: true, force: true })
  fs.writeFileSync(path.join(acceptance, 'deployment-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), evidence }, null, 2))
}
