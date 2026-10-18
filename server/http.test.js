import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Store } from './store.js'
import { openSecretStore } from './security.js'
import { FakeRuntime, NoopUnitManager } from './runtime.js'
import { AuthService, InstanceService, DeleteService, QuotaService } from './services.js'
import { Installer, UpgradeService, VersionService } from './release.js'
import { Controller, createHttpServer } from './http.js'
import { instanceView } from './domain.js'
import { BrandingService } from './branding.js'
import { PluginService } from './plugins.js'

test('deployment record deletion requires a session, rejects active records and records audit', async () => {
  const store = new Store(':memory:'); const auth = new AuthService(store); auth.initializeAdmin('test-record-admin')
  const plugins = new PluginService({ store }); const controller = new Controller({ auth, plugins, store, logger: { error() {} } }); const server = createHttpServer(controller)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}/api`
  try {
    store.savePluginJob({ id: 'finished', state: 'completed' }); store.savePluginJob({ id: 'recovering', state: 'blocked' })
    assert.equal((await fetch(`${base}/plugins/jobs/finished`, { method: 'DELETE' })).status, 401)
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-record-admin' }) })
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] }
    assert.equal((await fetch(`${base}/plugins/jobs/finished`, { method: 'DELETE', headers: { ...headers, origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(`${base}/plugins/jobs/recovering`, { method: 'DELETE', headers })).status, 409)
    assert.equal((await fetch(`${base}/plugins/jobs/finished`, { method: 'DELETE', headers })).status, 200)
    assert.equal((await fetch(`${base}/plugins/jobs/finished`, { method: 'DELETE', headers })).status, 404)
    assert.ok(store.listAuditLogs().some(item => item.action === 'plugin.record.delete' && item.resource_id === 'finished' && item.outcome === 'success'))
    assert.deepEqual(store.listPluginJobs().map(item => item.id), ['recovering'])
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); store.close() }
})

test('instance backup API requires login and returns a new stopped instance without credentials', async () => {
  const f = await fixture()
  try {
    const source = await f.instances.create({ name: 'backup-api', port: await freePort(), management_password: 'backup-synthetic-secret' })
    const route = `${f.url}/api/instances/${source.id}/backup`
    assert.equal((await fetch(route, { method: 'POST' })).status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) })
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    const port = await freePort()
    const response = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'backup-api-copy', port }) })
    assert.equal(response.status, 201); const copy = await response.json()
    assert.notEqual(copy.id, source.id); assert.equal(copy.port, port); assert.equal(copy.status.state, 'stopped'); assert.equal(copy.management_secret_ciphertext, undefined); assert.equal(copy.directory, undefined)
    assert.equal(f.instances.decryptManagementSecret(f.store.getInstance(copy.id)), 'backup-synthetic-secret')
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'instance.backup' && item.resource_id === source.id && item.outcome === 'success'))
    await f.instances.setLocked(source.id, true)
    assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'locked-copy', port: await freePort() }) })).status, 409)
  } finally { await closeFixture(f) }
})

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) }) }

test('instance limit settings require authentication, validate changes and audit saves', async () => {
  const f = await fixture()
  try {
    const route = `${f.url}/api/instance-limits`
    assert.equal((await fetch(route)).status, 401)
    assert.equal((await fetch(route, { method: 'PATCH' })).status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) })
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    assert.deepEqual(await (await fetch(route, { headers })).json(), { max_instances: 5, max_backups: 10, instances_used: 0, backups_used: 0 })
    assert.equal((await fetch(route, { method: 'PATCH', headers, body: JSON.stringify({ max_instances: 0, max_backups: 10 }) })).status, 400)
    assert.equal((await fetch(route, { method: 'PATCH', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ max_instances: 8, max_backups: 20 }) })).status, 403)
    const saved = await fetch(route, { method: 'PATCH', headers, body: JSON.stringify({ max_instances: 8, max_backups: 20 }) })
    assert.equal(saved.status, 200); assert.equal((await saved.json()).max_backups, 20)
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'instance-limits.update' && item.outcome === 'success'))
  } finally { await closeFixture(f) }
})
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-http-'))
  // Backend tests run before the web build in CI. Use an isolated shell so
  // route/security checks never depend on ignored or stale build output.
  const staticRoot = path.join(root, 'static')
  fs.mkdirSync(path.join(staticRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><html><head><title>HTTP fixture</title></head><body><div id="root"></div><script type="module" src="/assets/fixture.js"></script></body></html>')
  fs.writeFileSync(path.join(staticRoot, 'assets', 'fixture.js'), 'document.getElementById("root").textContent = "HTTP fixture";')
  const store = new Store(path.join(root, 'control.db'))
  const auth = new AuthService(store); auth.initializeAdmin('controller admin password')
  const runtime = new FakeRuntime(); const secrets = openSecretStore(path.join(root, 'secrets.key'))
  const instances = new InstanceService({ store, runtime, secrets, units: new NoopUnitManager(), root, requireVersion: false })
  const deleteService = new DeleteService({ store, runtime, units: new NoopUnitManager(), instances, auth })
  const quota = new QuotaService({ store, instances, secrets, clients: async () => ({ listAccounts: async () => [], fetchQuota: async () => ({}) }) })
  const upgrade = new UpgradeService({ store, instances, runtime })
  const installer = new Installer({ source: {}, root: path.join(root, 'versions') })
  const versionService = new VersionService({ store, instances, installer }); const branding = new BrandingService({ store })
  const controller = new Controller({ auth, instances, deleteService, quota, upgrade, installer, versionService, branding, store, staticRoot, logger: { error() {} } })
  const server = createHttpServer(controller); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { root, staticRoot, store, instances, branding, quota, controller, server, url: `http://127.0.0.1:${server.address().port}` }
}
async function closeFixture(f) {
  f.server.closeAllConnections?.()
  try { await new Promise((resolve, reject) => f.server.close(error => error ? reject(error) : resolve())) }
  finally { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
}

test('lock API rejects direct mutations and records lock audit events', async () => {
  const f = await fixture()
  try {
    const item = await f.instances.create({ name: 'locked-http', port: await freePort() })
    const base = `${f.url}/api/instances/${item.id}`
    assert.equal((await fetch(`${base}/lock`, { method: 'POST' })).status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) })
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    const locked = await fetch(`${base}/lock`, { method: 'POST', headers })
    assert.equal(locked.status, 200)
    assert.equal((await locked.json()).locked, true)
    for (const action of ['restart', 'stop', 'delete-challenge']) assert.equal((await fetch(`${base}/${action}`, { method: 'POST', headers })).status, 409)
    assert.equal((await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ name: 'changed' }) })).status, 409)
    const missingPassword = await fetch(`${base}/unlock`, { method: 'POST', headers })
    assert.equal(missingPassword.status, 401)
    const wrongPassword = await fetch(`${base}/unlock`, { method: 'POST', headers, body: JSON.stringify({ admin_password: 'wrong password' }) })
    assert.equal(wrongPassword.status, 401)
    const unlocked = await fetch(`${base}/unlock`, { method: 'POST', headers, body: JSON.stringify({ admin_password: 'controller admin password' }) })
    assert.equal((await unlocked.json()).locked, false)
    const logs = await fetch(`${f.url}/api/logs/audit`, { headers })
    const entries = (await logs.json()).items
    assert.ok(entries.some(entry => entry.action === 'instance.lock' && entry.outcome === 'success'))
    assert.ok(entries.some(entry => entry.action === 'instance.unlock' && entry.outcome === 'success'))
  } finally { await closeFixture(f) }
})

test('HTTP API protects management routes and completes create/delete flow', async () => {
  const f = await fixture(); try {
    const health = await fetch(`${f.url}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok')
    const denied = await fetch(`${f.url}/api/instances`); assert.equal(denied.status, 401)
    const crossOriginLogin = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); assert.equal(crossOriginLogin.status, 403)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0]
    const create = await fetch(`${f.url}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'http-demo', port: await freePort(), management_password: 'child management password' }) }); assert.equal(create.status, 201); const item = await create.json(); assert.equal(item.name, 'http-demo')
    const crossOrigin = await fetch(`${f.url}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: JSON.stringify({ name: 'blocked', port: await freePort(), management_password: 'child management password' }) }); assert.equal(crossOrigin.status, 403)
    const challenge = await fetch(`${f.url}/api/instances/${item.id}/delete-challenge`, { method: 'POST', headers: { cookie, origin: f.url } }); assert.equal(challenge.status, 200); const challengeBody = await challenge.json(); const deleted = await fetch(`${f.url}/api/instances/${item.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: f.url }, body: JSON.stringify({ challenge_id: challengeBody.challenge_id, admin_password: 'controller admin password' }) }); assert.equal(deleted.status, 200)
  } finally { await closeFixture(f) }
})

test('management.html aliases the embedded frontend shell with browser security headers', async () => {
  const f = await fixture()
  try {
    const shell = fs.readFileSync(path.join(f.staticRoot, 'index.html'), 'utf8')
    for (const alias of ['/', '/index.html', '/management.html']) {
      const response = await fetch(`${f.url}${alias}`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), shell)
      assert.match(shell, /<div id="root"><\/div>/)
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(response.headers.get('cache-control'), 'no-cache')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('x-frame-options'), 'DENY')
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    }
    const asset = await fetch(`${f.url}/assets/fixture.js`)
    assert.equal(asset.status, 200)
    assert.equal(await asset.text(), fs.readFileSync(path.join(f.staticRoot, 'assets', 'fixture.js'), 'utf8'))
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await fetch(`${f.url}/assets/missing.js`)).status, 404)
    fs.unlinkSync(path.join(f.staticRoot, 'index.html'))
    assert.equal((await fetch(`${f.url}/management.html`)).status, 404)
  } finally { await closeFixture(f) }
})

test('version uninstall API removes an old cache and records the audit action', async () => {
  const f = await fixture(); try {
    const versionsRoot = path.join(f.root, 'versions')
    const oldDirectory = path.join(versionsRoot, 'v1')
    fs.mkdirSync(oldDirectory, { recursive: true })
    fs.writeFileSync(path.join(oldDirectory, 'cli-proxy-api'), 'binary-v1')
    f.store.saveVersion({ tag: 'v1', path: oldDirectory, installed_at: new Date().toISOString(), usable: true })
    f.instances.defaultVersion = 'v2'
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const removed = await fetch(`${f.url}/api/versions/uninstall`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ version: 'v1' }) })
    assert.equal(removed.status, 200)
    assert.deepEqual(await removed.json(), { status: 'uninstalled', version: 'v1' })
    assert.equal(fs.existsSync(oldDirectory), false)
    assert.throws(() => f.store.getVersion('v1'), /version not found/)
    assert.equal(f.store.listAuditLogs()[0].action, 'version.uninstall')
  } finally { await closeFixture(f) }
})

test('async request failures return JSON without terminating the controller', async () => {
  const f = await fixture(); try {
    const malformed = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'username:admin' }); assert.equal(malformed.status, 400); assert.match((await malformed.json()).error, /invalid body/)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const internal = await fetch(`${f.url}/api/versions/install`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' }); assert.equal(internal.status, 500); assert.deepEqual(await internal.json(), { error: 'internal server error' })
    const health = await fetch(`${f.url}/health`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' })
  } finally { await closeFixture(f) }
})

test('instance management URLs use the accepted socket address instead of the Host header', () => {
  const view = instanceView({ id: 'cpa-test', port: 8317 }, { state: 'running' }, { headers: { host: 'evil.example' }, socket: { localAddress: '192.168.1.10' } })
  assert.equal(view.management_url, 'http://192.168.1.10:8317/management.html')
})

test('quota settings are protected and can be updated through the API', async () => {
  const f = await fixture(); try {
    const denied = await fetch(`${f.url}/api/quota/settings`); assert.equal(denied.status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const defaults = await fetch(`${f.url}/api/quota/settings`, { headers: { cookie } }); assert.equal(defaults.status, 200); assert.equal((await defaults.json()).refresh_interval_minutes, 360)
    const updated = await fetch(`${f.url}/api/quota/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ refresh_interval_minutes: 30, webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', alert_threshold_percent: 10 }) }); assert.equal(updated.status, 200); const updatedBody = await updated.json(); assert.equal(updatedBody.refresh_interval_minutes, 30); assert.equal(updatedBody.webhook_url, ''); assert.equal(updatedBody.webhook_url_configured, true)
    const signed = await fetch(`${f.url}/api/quota/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ webhook_signing_enabled: true, webhook_secret: 'ding-secret' }) }); assert.equal(signed.status, 200); const signedBody = await signed.json(); assert.equal(signedBody.webhook_signing_enabled, true); assert.equal(signedBody.webhook_secret_configured, true); assert.equal(signedBody.webhook_secret, undefined); assert.equal(signedBody.webhook_url, '')
  } finally { await closeFixture(f) }
})

test('per-instance quota notification settings are protected and independently configurable', async () => {
  const f = await fixture(); try {
    const instance = await f.instances.create({ name: 'notification-http', port: await freePort() }); const route = `${f.url}/api/quota/notifications/${instance.id}`
    assert.equal((await fetch(`${f.url}/api/quota/notifications`)).status, 401); assert.equal((await fetch(route, { method: 'PATCH' })).status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    const defaults = await fetch(`${f.url}/api/quota/notifications`, { headers }); assert.equal(defaults.status, 200); const defaultItem = (await defaults.json()).items.find(item => item.instance_id === instance.id); assert.equal(defaultItem.configured, false); assert.equal(defaultItem.timezone, 'UTC+8'); assert.deepEqual(defaultItem.work_windows, [{ start: '09:00', end: '12:00' }, { start: '13:30', end: '18:00' }])
    const saved = await fetch(route, { method: 'PATCH', headers, body: JSON.stringify({ refresh_interval_minutes: 45, webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=instance', alert_threshold_percent: 12 }) }); assert.equal(saved.status, 200); const savedBody = await saved.json(); assert.equal(savedBody.configured, true); assert.equal(savedBody.refresh_interval_minutes, 45); assert.equal(savedBody.webhook_url, undefined); assert.ok(f.store.listAuditLogs().some(item => item.action === 'quota.notification.update' && item.resource_id === instance.id && item.outcome === 'success'))
  } finally { await closeFixture(f) }
})

test('quota test notification endpoints are authenticated and audited', async () => {
  const f = await fixture(); try {
    const instance = await f.instances.create({ name: 'test-message-http', port: await freePort() })
    await f.instances.start(instance.id)
    f.quota.clients = async () => ({ listAccounts: async () => [{ id: 'oauth-http', provider: 'codex' }], fetchQuota: async () => ({ values: [{ name: '周限额', remaining: 75, total: 100, reset_at: '2026-10-21T08:00:00Z' }] }) })
    const sent = []; f.quota.notifier = { notify: async (settings, message) => { sent.push({ settings, message }); return true } }
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    assert.equal((await fetch(`${f.url}/api/quota/settings/test`, { method: 'POST' })).status, 401)
    assert.equal((await fetch(`${f.url}/api/quota/notifications/${instance.id}/test`, { method: 'POST' })).status, 401)
    const disabled = await fetch(`${f.url}/api/quota/settings/test`, { method: 'POST', headers }); assert.equal(disabled.status, 400); assert.match((await disabled.json()).error, /未启用/)
    const configured = await fetch(`${f.url}/api/quota/settings`, { method: 'PATCH', headers, body: JSON.stringify({ instance_ids: [instance.id], webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=global-token' }) }); assert.equal(configured.status, 200)
    const globalTest = await fetch(`${f.url}/api/quota/settings/test`, { method: 'POST', headers }); assert.equal(globalTest.status, 200); assert.deepEqual(await globalTest.json(), { status: 'sent', instance_id: '' })
    const instanceTest = await fetch(`${f.url}/api/quota/notifications/${instance.id}/test`, { method: 'POST', headers }); assert.equal(instanceTest.status, 200); assert.deepEqual(await instanceTest.json(), { status: 'sent', instance_id: instance.id })
    assert.equal(sent.length, 2); assert.equal(sent[0].message, sent[1].message); assert.match(sent[0].message, /^【测试消息】CLIProxyAPI 配额告警\ntest-message-http \/ codex oauth-http \/ 周限额：剩余 75\.0%，额度刷新时间 2026-10-21 16:00（UTC\+8）$/)
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'quota.settings.test' && item.outcome === 'success'))
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'quota.notification.test' && item.resource_id === instance.id && item.outcome === 'success'))
  } finally { await closeFixture(f) }
})

test('administrator password endpoint requires the current password and keeps the session active', async () => {
  const f = await fixture(); try {
    const denied = await fetch(`${f.url}/api/auth/password`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current_password: 'controller admin password', new_password: 'new-password' }) }); assert.equal(denied.status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const changed = await fetch(`${f.url}/api/auth/password`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ current_password: 'controller admin password', new_password: 'new-password' }) }); assert.equal(changed.status, 200); assert.deepEqual(await changed.json(), { status: 'updated' })
    const stillAuthenticated = await fetch(`${f.url}/api/auth/status`, { headers: { cookie } }); assert.deepEqual(await stillAuthenticated.json(), { authenticated: true, username: 'admin', branding: f.branding.get() })
    const oldLogin = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); assert.equal(oldLogin.status, 401)
    const newLogin = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'new-password' }) }); assert.equal(newLogin.status, 200)
  } finally { await closeFixture(f) }
})

test('log APIs are protected and mutations create audit and runtime entries', async () => {
  const f = await fixture(); try {
    assert.equal((await fetch(`${f.url}/api/logs/runtime`)).status, 401)
    const failedLogin = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) }); assert.equal(failedLogin.status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const created = await fetch(`${f.url}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'logged-instance', port: await freePort() }) }); assert.equal(created.status, 201); const instance = await created.json()
    const started = await fetch(`${f.url}/api/instances/${instance.id}/start`, { method: 'POST', headers: { cookie } }); assert.equal(started.status, 202)
    const runtime = await (await fetch(`${f.url}/api/logs/runtime?limit=20`, { headers: { cookie } })).json(); assert.ok(runtime.items.some(item => item.instance_id === instance.id && item.message === 'instance start succeeded'))
    f.store.appendRuntimeLog({ source: 'upgrade', level: 'error', message: 'upgrade failed' })
    f.store.appendRuntimeLog({ source: 'plugin', level: 'info', message: 'plugin completed' })
    const filtered = await (await fetch(`${f.url}/api/logs/runtime?source=upgrade&level=error&limit=1`, { headers: { cookie } })).json()
    assert.deepEqual(filtered.items.map(item => item.message), ['upgrade failed'])
    for (const query of ['source=invalid', 'level=invalid', 'limit=501']) assert.equal((await fetch(`${f.url}/api/logs/runtime?${query}`, { headers: { cookie } })).status, 400)
    assert.equal((await fetch(`${f.url}/api/logs/runtime?source=key`)).status, 401)
    const audit = await (await fetch(`${f.url}/api/logs/audit?limit=20`, { headers: { cookie } })).json(); assert.ok(audit.items.some(item => item.action === 'auth.login' && item.outcome === 'failed')); assert.ok(audit.items.some(item => item.action === 'instance.create' && item.outcome === 'success')); assert.ok(audit.items.some(item => item.action === 'instance.start' && item.resource_id === instance.id))
  } finally { await closeFixture(f) }
})

test('failed quota test requests never copy signed webhook URLs into runtime or audit logs', async () => {
  const f = await fixture()
  try {
    const instance = await f.instances.create({ name: 'safe-notification-log', port: await freePort() }); await f.instances.start(instance.id)
    f.quota.updateNotificationSettings(instance.id, { webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=private-http-log-token' })
    f.quota.notifier = { notify: async () => { throw new Error('https://oapi.dingtalk.com/robot/send?access_token=private-http-log-token&sign=private-sign') } }
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const result = await fetch(`${f.url}/api/quota/notifications/${instance.id}/test`, { method: 'POST', headers: { cookie } })
    assert.equal(result.status, 500)
    assert.ok(f.store.listRuntimeLogs(500, { source: 'quota' }).some(item => item.context.event === 'quota.test.failed'))
    assert.equal(JSON.stringify(f.store.listRuntimeLogs(500)).includes('private-'), false)
    assert.equal(JSON.stringify(f.store.listAuditLogs(500)).includes('private-'), false)
  } finally { await closeFixture(f) }
})

test('branding API exposes defaults and persists a partial update', async () => {
  const f = await fixture(); try {
    const publicStatus = await fetch(`${f.url}/api/auth/status`); const publicBody = await publicStatus.json(); assert.equal(publicStatus.status, 200); assert.equal(publicBody.branding.brand_name, 'CPA')
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const updated = await fetch(`${f.url}/api/branding`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ brand_name: 'Northstar CPA', page_description: '内部控制平面' }) }); assert.equal(updated.status, 200); const body = await updated.json(); assert.equal(body.brand_name, 'Northstar CPA'); assert.equal(body.page_description, '内部控制平面'); assert.equal(body.banner_title, '静候流量。')
    const status = await fetch(`${f.url}/api/auth/status`, { headers: { cookie } }); assert.equal((await status.json()).branding.brand_name, 'Northstar CPA')
    assert.equal(f.store.listAuditLogs()[0].action, 'branding.update')
  } finally { await closeFixture(f) }
})
