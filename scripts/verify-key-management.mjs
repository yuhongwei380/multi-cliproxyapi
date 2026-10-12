import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import { createApplication, readConfig } from '../server/index.js'
import { createHttpServer } from '../server/http.js'
import { ProcessRuntime, NoopUnitManager } from '../server/runtime.js'
import { HTTPClient } from '../server/cpa.js'
import { Store } from '../server/store.js'

// Run only against an explicitly supplied real CPA binary, in disposable data.
const binary = path.resolve(process.env.CPA_TEST_BINARY || '')
assert.ok(process.env.CPA_TEST_BINARY && fs.statSync(binary).isFile(), 'CPA_TEST_BINARY must point to a real CPA binary')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-key-acceptance-'))
const version = process.env.CPA_TEST_VERSION || '8.0.23'
assert.match(version, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const versionRoot = path.join(root, 'versions', version)
fs.mkdirSync(versionRoot, { recursive: true })
fs.copyFileSync(binary, path.join(versionRoot, 'cli-proxy-api')); fs.chmodSync(path.join(versionRoot, 'cli-proxy-api'), 0o755)
const password = process.env.CPA_E2E_ADMIN_PASSWORD || crypto.randomBytes(32).toString('hex')
const managementPassword = crypto.randomBytes(32).toString('hex')
const secret = `sk-e2e-${crypto.randomBytes(32).toString('hex')}`
const baseline = `sk-preserved-${crypto.randomBytes(32).toString('hex')}`
const config = { ...readConfig([], {}), dataDir: root, runtimeMode: 'process', version, adminPassword: password, skipVersionInstall: true, staticRoot: path.resolve('web/dist') }
const evidence = { date: '2026-10-12', platform: `${process.platform}/${process.arch}`, node: process.version, cpa_version: version, cpa_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), checks: [], protocols: [] }
let app, server, cookie, base
function makeApp() {
  // The test only uses CPA's management API; no management HTML download is needed.
  return createApplication(config, { runtime: new ProcessRuntime(), units: new NoopUnitManager(), managementAssets: { ensure: async () => {} }, logger: { error() {} } })
}
async function listen(port = 0) {
  server = createHttpServer(app.controller)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.CPA_E2E_BIND || '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
}
async function closeServer() { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null } }
function pass(name) { evidence.checks.push(name); console.log(`PASS ${name}`) }
async function api(route, body, expected = 200) {
  const response = await fetch(`${base}/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const value = await response.json()
  assert.equal(response.status, expected, `${route}: ${response.status} ${JSON.stringify(value)}`)
  if (route === '/auth/login' && response.ok) cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
async function freePort() { return new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) }) }
function client(instance) { return new HTTPClient({ baseUrl: `http://127.0.0.1:${instance.port}`, managementSecret: managementPassword }) }
async function keys(instance) { return (await client(instance).readClientKeys()).keys }
async function rejected(instance, key) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) })
  assert.ok([401, 403].includes(response.status), `revoked/anonymous access unexpectedly returned ${response.status}`)
}

try {
  app = makeApp()
  app.store.saveVersion({ tag: version, path: versionRoot, usable: true, sha256: evidence.cpa_sha256, installed_at: new Date().toISOString() })
  await listen(Number(process.env.CPA_E2E_PORT || 0))
  await api('/keys', undefined, 401); await api('/auth/login', { username: 'admin', password })
  pass('administrator authentication required')
  const first = await api('/instances', { name: 'Key Acceptance A', port: await freePort(), management_password: managementPassword }, 201)
  const second = await api('/instances', { name: 'Key Acceptance B', port: await freePort(), management_password: managementPassword }, 201)
  for (const instance of [first, second]) await api(`/instances/${instance.id}/start`, {}, 202)
  for (const instance of [first, second]) {
    let healthy = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await client(instance).health(); healthy = true; break } catch { await new Promise(resolve => setTimeout(resolve, 150)) }
    }
    assert.ok(healthy, 'CPA management API did not become ready')
  }
  for (const requestPath of ['/v8/management/config/access/api-keys', '/v0/management/api-keys']) {
    const probe = await fetch(`http://127.0.0.1:${first.port}${requestPath}`, { headers: { Authorization: `Bearer ${managementPassword}` } })
    const payload = await probe.json()
    console.log(JSON.stringify({ endpoint: requestPath, status: probe.status, shape: Array.isArray(payload) ? 'array' : typeof payload, fields: Array.isArray(payload) ? [] : Object.keys(payload), types: Array.isArray(payload) ? [] : Object.fromEntries(Object.entries(payload).map(([key,value]) => [key, Array.isArray(value) ? 'array' : typeof value])) }))
  }
  const detected = await client(first).readClientKeys(); evidence.protocols.push(detected.path)
  await client(first).writeClientKeys(detected.path, [baseline])
  pass('two independent real CPA processes start and expose Key APIs')
  const generated = await api('/keys', { note: '随机生成验收' }, 201)
  assert.match((await api(`/keys/${generated.id}/reveal`, {})).key, /^sk-[A-Za-z0-9_-]{43}$/)
  assert.equal((await api(`/keys/${generated.id}/delete`, {})).deleted, true)
  const key = await api('/keys', { key: secret, note: '真实 CPA 下发测试' }, 201)
  await api('/keys', { key: secret }, 409)
  assert.ok(!JSON.stringify(await api('/keys')).includes(secret))
  pass('manual creation, secure generation, notes, masking and duplicate rejection')
  await api(`/keys/${key.id}/bind`, { instances: [first.id, second.id] })
  assert.deepEqual(await keys(first), [baseline]); assert.deepEqual(await keys(second), [])
  pass('binding records relationships without deploying')
  const deployed = await api(`/keys/${key.id}/deploy`, {})
  assert.ok(deployed.results.every(result => result.status === 'deployed'))
  assert.deepEqual(await keys(first), [baseline, secret]); assert.deepEqual(await keys(second), [secret])
  const modelResponse = await fetch(`http://127.0.0.1:${second.port}/v1/models`, { headers: { Authorization: `Bearer ${secret}` } })
  assert.equal(modelResponse.status, 200)
  pass('real deployment preserves existing Keys and enables client authentication')
  assert.ok((await api(`/keys/${key.id}/deploy`, {})).results.every(result => result.status === 'exists'))
  assert.equal((await keys(first)).filter(value => value === secret).length, 1)
  pass('repeated deployment is idempotent')
  await api(`/keys/${key.id}/lock`, {})
  await api(`/keys/${key.id}/delete`, {}, 409); await api(`/keys/${key.id}/revoke`, { instance_id: first.id }, 409)
  await api(`/keys/${key.id}/unlock`, { admin_password: 'incorrect' }, 401)
  await api(`/keys/${key.id}/unlock`, { admin_password: password })
  pass('Key locking prevents removal; unlock requires correct administrator password')
  await api(`/instances/${first.id}/lock`, {})
  assert.equal((await api(`/keys/${key.id}/deploy`, {})).results.find(result => result.instance_id === first.id).status, 'failed')
  await api(`/instances/${first.id}/unlock`, { admin_password: password })
  await api(`/keys/${key.id}/revoke`, { instance_id: first.id })
  assert.deepEqual(await keys(first), [baseline]); assert.ok((await keys(second)).includes(secret))
  await rejected(first, secret)
  pass('instance locks are respected; single unbind removes the real Key only from its target')
  await api(`/keys/${key.id}/bind`, { instances: [first.id] }); await api(`/keys/${key.id}/deploy`, {})
  await api(`/instances/${second.id}/stop`, {}, 202)
  const partial = await api(`/keys/${key.id}/delete`, {})
  assert.equal(partial.deleted, false); assert.equal(partial.item.bindings.length, 1); assert.equal(partial.item.bindings[0].instance_id, second.id)
  await api(`/keys/${key.id}/deploy`, {}, 409); await api(`/keys/${key.id}/bind`, { instances: [first.id] }, 409)
  const reopened = new Store(path.join(root, 'control.db'))
  try { assert.equal(reopened.getManagedKey(key.id).deleting, true); assert.equal(reopened.keyBindings(key.id)[0].status, 'revoke-failed') } finally { reopened.close() }
  pass('stopped target prevents deletion; failed binding and delete intent persist')
  await api(`/instances/${second.id}/start`, {}, 202)
  const removed = await api(`/keys/${key.id}/delete`, {})
  assert.equal(removed.deleted, true); assert.equal(removed.results[0].authentication_guard, true)
  assert.deepEqual(await keys(first), [baseline]); assert.match((await keys(second))[0], /^sk-controller-guard-/)
  await rejected(second, secret); await rejected(second); await rejected(second, 'invalid-key')
  pass('retry completes deletion; last-Key guard rejects revoked, anonymous and invalid access')

  const backupKey = await api('/keys', { note: '备份继承与撤销' }, 201)
  const backupSecret = (await api(`/keys/${backupKey.id}/reveal`, {})).key
  await api(`/keys/${backupKey.id}/bind`, { instances: [first.id] }); await api(`/keys/${backupKey.id}/deploy`, {})
  const manual = await api(`/instances/${first.id}/backup`, { name: 'Key Manual Backup', port: await freePort() }, 201)
  const [automatic] = await app.instances.operations.run('global', () => app.instances.automaticBackups([first.id], 'Key acceptance'))
  const inherited = (await api('/keys')).items.find(item => item.id === backupKey.id)
  assert.equal(inherited.bindings.length, 3); assert.equal(inherited.bindings.filter(item => item.status === 'copied').length, 2)
  await api(`/instances/${first.id}/delete-challenge`, {}, 409)
  pass('manual and automatic backups inherit bindings; bound instance deletion is prohibited')
  assert.equal((await api(`/keys/${backupKey.id}/delete`, {})).deleted, false)
  await api(`/instances/${automatic.id}/unlock`, { admin_password: password })
  for (const copy of [manual, automatic]) { await api(`/instances/${copy.id}/start`, {}, 202); assert.ok((await keys(copy)).includes(backupSecret)) }
  assert.equal((await api(`/keys/${backupKey.id}/delete`, {})).deleted, true)
  for (const copy of [first, manual, automatic]) { assert.deepEqual(await keys(copy), [baseline]); await rejected(copy, backupSecret) }
  pass('backup copies really contain the Key and revoke it before global removal')

  const persistent = await api('/keys', { note: '重启后保留的备注' }, 201)
  const persistentSecret = (await api(`/keys/${persistent.id}/reveal`, {})).key
  await api(`/keys/${persistent.id}/bind`, { instances: [first.id] })
  await Promise.all([api(`/keys/${persistent.id}/deploy`, {}), api(`/keys/${persistent.id}/deploy`, {})])
  assert.equal((await keys(first)).filter(value => value === persistentSecret).length, 1)
  await api(`/keys/${persistent.id}/lock`, {})
  await closeServer(); app.store.close(); app = makeApp(); await listen(Number(process.env.CPA_E2E_PORT || 0))
  await app.instances.reconcileDesired(); await api('/auth/login', { username: 'admin', password })
  const retained = (await api('/keys')).items.find(item => item.id === persistent.id)
  assert.equal(retained.locked, true); assert.equal(retained.note, '重启后保留的备注'); assert.equal(retained.bindings.length, 1)
  assert.equal((await api(`/keys/${persistent.id}/reveal`, {})).key, persistentSecret)
  pass('concurrent deployment avoids duplicates; controller restart preserves encrypted Key, note, lock and binding')
  const logs = JSON.stringify(app.store.listAuditLogs(500))
  for (const sensitive of [secret, baseline, managementPassword, password, persistentSecret, backupSecret]) assert.ok(!logs.includes(sensitive))
  pass('audit records omit plaintext Keys and passwords')

  if (Number(process.env.CPA_E2E_HOLD_SECONDS || 0) > 0) {
    console.log(`BROWSER_CHECK_READY ${server.address().port}`)
    await new Promise(resolve => setTimeout(resolve, Math.min(180, Number(process.env.CPA_E2E_HOLD_SECONDS)) * 1000))
  }
  await api(`/keys/${persistent.id}/unlock`, { admin_password: password })
  assert.equal((await api(`/keys/${persistent.id}/delete`, {})).deleted, true)
  for (const instance of app.store.listInstances()) {
    const challenge = await api(`/instances/${instance.id}/delete-challenge`, {})
    await api(`/instances/${instance.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: password })
  }
  assert.equal(app.store.listInstances().length, 0); assert.equal(app.store.listManagedKeys().length, 0)
  pass('all isolated test Keys and CPA processes cleaned up successfully')
  evidence.success = true
} catch (error) {
  evidence.success = false; evidence.error = error.message; process.exitCode = 1
  console.error(`FAIL ${error.message}`)
} finally {
  if (app) {
    for (const instance of app.store.listInstances()) { try { await app.runtime.stop(instance) } catch { console.error(`Unable to stop isolated instance ${instance.id}`) } }
    await closeServer(); app.store.close()
  }
  const target = path.resolve(process.env.CPA_E2E_EVIDENCE || 'test-doc/test-evidence/2026-10-12/key-management-real.json')
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(evidence, null, 2))
  // Only the explicitly created disposable directory can be removed.
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'cpa-key-acceptance-')))
  fs.rmSync(root, { recursive: true, force: true })
  console.log(`Evidence saved; ${evidence.checks.length} checks passed; success=${evidence.success}`)
}
