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
import { UpgradeService } from './release.js'
import { Controller, createHttpServer } from './http.js'
import { instanceView } from './domain.js'

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) }) }
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-http-')); const store = new Store(path.join(root, 'control.db')); const auth = new AuthService(store); auth.initializeAdmin('controller admin password'); const runtime = new FakeRuntime(); const secrets = openSecretStore(path.join(root, 'secrets.key')); const instances = new InstanceService({ store, runtime, secrets, units: new NoopUnitManager(), root, requireVersion: false }); const deleteService = new DeleteService({ store, runtime, units: new NoopUnitManager(), instances, auth }); const quota = new QuotaService({ store, instances, secrets, clients: async () => ({ listAccounts: async () => [], fetchQuota: async () => ({}) }) }); const upgrade = new UpgradeService({ store, instances, runtime }); const controller = new Controller({ auth, instances, deleteService, quota, upgrade, store, staticRoot: path.resolve('web/dist'), logger: { error() {} } }); const server = createHttpServer(controller); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { root, store, server, url: `http://127.0.0.1:${server.address().port}` }
}
async function closeFixture(f) { f.server.closeAllConnections?.(); f.server.close(); f.store.close() }

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

test('management.html aliases the embedded frontend shell with browser security headers', async () => { const f = await fixture(); try { const response = await fetch(`${f.url}/management.html`); assert.equal(response.status, 200); assert.match(await response.text(), /<div id="root"><\/div>/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/) } finally { await closeFixture(f) } })

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

test('administrator password endpoint requires the current password and keeps the session active', async () => {
  const f = await fixture(); try {
    const denied = await fetch(`${f.url}/api/auth/password`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current_password: 'controller admin password', new_password: 'new-password' }) }); assert.equal(denied.status, 401)
    const login = await fetch(`${f.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'controller admin password' }) }); const cookie = login.headers.get('set-cookie').split(';')[0]
    const changed = await fetch(`${f.url}/api/auth/password`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ current_password: 'controller admin password', new_password: 'new-password' }) }); assert.equal(changed.status, 200); assert.deepEqual(await changed.json(), { status: 'updated' })
    const stillAuthenticated = await fetch(`${f.url}/api/auth/status`, { headers: { cookie } }); assert.deepEqual(await stillAuthenticated.json(), { authenticated: true, username: 'admin' })
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
    const audit = await (await fetch(`${f.url}/api/logs/audit?limit=20`, { headers: { cookie } })).json(); assert.ok(audit.items.some(item => item.action === 'auth.login' && item.outcome === 'failed')); assert.ok(audit.items.some(item => item.action === 'instance.create' && item.outcome === 'success')); assert.ok(audit.items.some(item => item.action === 'instance.start' && item.resource_id === instance.id))
  } finally { await closeFixture(f) }
})
