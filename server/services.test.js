import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Store } from './store.js'
import { openSecretStore } from './security.js'
import { FakeRuntime, NoopUnitManager } from './runtime.js'
import { AuthService, InstanceService, DeleteService, QuotaService, DingTalkNotifier } from './services.js'
import { StaticClient } from './cpa.js'
import { instanceBinaryPath } from './instance-binary.js'

// Keep the helper dependency-free and deterministic by reserving an OS port briefly.
import net from 'node:net'
async function port() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) }) }
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-service-')); const store = new Store(path.join(root, 'control.db')); const secrets = openSecretStore(path.join(root, 'secrets.key')); const runtime = new FakeRuntime(); const instances = new InstanceService({ store, runtime, secrets, units: new NoopUnitManager(), root, requireVersion: false }); return { root, store, secrets, runtime, instances } }

test('management readiness clears after a failed probe without mutating runtime state', async () => {
  const f = fixture()
  try {
    const item = await f.instances.create({ name: 'health-transition', port: await port() })
    await f.instances.start(item.id)
    f.instances.healthCheck = async () => {}
    assert.equal((await f.instances.status(item.id)).management_ready, true)
    f.instances.healthCheck = async () => { throw new Error('management unavailable') }
    const failed = await f.instances.status(item.id)
    assert.notEqual(failed.management_ready, true)
    assert.equal(failed.management_message, 'management unavailable')
    assert.equal((await f.runtime.status(item)).management_message, undefined)
    f.instances.healthCheck = async () => {}
    const recovered = await f.instances.status(item.id)
    assert.equal(recovered.management_ready, true)
    assert.equal(recovered.management_message, undefined)
  } finally {
    f.store.close()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('instance service creates independent data, lifecycle and port config', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'demo', port: await port(), management_password: 'child management password' }); assert.equal(created.desired_state, 'stopped'); assert.ok(fs.existsSync(path.join(created.directory, 'auths'))); await f.instances.start(created.id); assert.equal((await f.instances.status(created.id)).state, 'running'); const updated = await f.instances.update(created.id, { port: await port(), expected_revision: created.revision + 1 }); assert.notEqual(updated.port, created.port); await f.instances.stop(created.id); assert.equal((await f.instances.status(created.id)).state, 'stopped'); f.store.close()
})

test('children default to LAN access, enabled plugins, and an empty password update preserves the current secret', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'default-password', port: await port() }); const configFile = path.join(created.directory, 'config.yaml'); const initialConfig = fs.readFileSync(configFile, 'utf8'); assert.equal(f.secrets.decrypt(created.management_secret_ciphertext), 'admin'); assert.match(initialConfig, /^host: 0\.0\.0\.0$/m); assert.match(initialConfig, /^  allow-remote: true$/m); assert.match(initialConfig, /^  disable-control-panel: false$/m); assert.match(initialConfig, /^plugins:\n  enabled: true$/m); assert.match(initialConfig, /secret-key: "admin"/)
  const renamed = await f.instances.update(created.id, { name: 'default-password-renamed', management_password: '', expected_revision: created.revision }); assert.equal(renamed.management_secret_ciphertext, created.management_secret_ciphertext); assert.match(fs.readFileSync(configFile, 'utf8'), /secret-key: "admin"/)
  const changed = await f.instances.update(created.id, { management_password: 'x', expected_revision: renamed.revision }); assert.equal(f.secrets.decrypt(changed.management_secret_ciphertext), 'x'); assert.match(fs.readFileSync(configFile, 'utf8'), /secret-key: "x"/); f.store.close()
})

test('each instance gets an independent CPA binary copy', async () => {
  const f = fixture(); const version = 'v1'; const source = path.join(f.root, 'versions', version, 'cli-proxy-api'); fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'shared-release-binary'); fs.chmodSync(source, 0o755)
  const instances = new InstanceService({ store: f.store, runtime: f.runtime, secrets: f.secrets, units: new NoopUnitManager(), root: f.root, binaryByVersion: () => source, defaultVersion: version, requireVersion: false })
  const first = await instances.create({ name: 'first', port: await port() }); const second = await instances.create({ name: 'second', port: await port() }); const firstBinary = instanceBinaryPath(first); const secondBinary = instanceBinaryPath(second)
  assert.notEqual(firstBinary, secondBinary); assert.equal(fs.readFileSync(firstBinary, 'utf8'), 'shared-release-binary'); assert.equal(fs.readFileSync(secondBinary, 'utf8'), 'shared-release-binary'); assert.equal(fs.lstatSync(firstBinary).isSymbolicLink(), false); assert.equal(fs.lstatSync(secondBinary).isSymbolicLink(), false)
  fs.writeFileSync(firstBinary, 'first-instance-binary'); assert.equal(fs.readFileSync(secondBinary, 'utf8'), 'shared-release-binary'); f.store.close()
})

test('starting a legacy instance enables LAN management and repairs missing or empty management settings', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'legacy-default', port: await port() }); const configFile = path.join(created.directory, 'config.yaml')
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('host: 0.0.0.0', 'host: 127.0.0.1').replace('  allow-remote: true', '  allow-remote: false').replace('  disable-control-panel: false', '  disable-control-panel: true').replace(/^plugins:\n  enabled: true\n/m, 'plugins:\n  enabled: false\n').replace(/  secret-key: "admin"\n/, ''))
  await f.instances.start(created.id); const repaired = fs.readFileSync(configFile, 'utf8'); assert.match(repaired, /^host: 0\.0\.0\.0$/m); assert.match(repaired, /^  allow-remote: true$/m); assert.match(repaired, /^  disable-control-panel: false$/m); assert.match(repaired, /^plugins:\n  enabled: true$/m); assert.match(repaired, /secret-key: "admin"/)
  await f.instances.stop(created.id)
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/  secret-key: "admin"/, '  secret-key: ""'))
  await f.instances.start(created.id); assert.match(fs.readFileSync(configFile, 'utf8'), /secret-key: "admin"/)
  f.store.close()
})

test('controller recovery preserves live legacy configuration and PID', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'running-legacy', port: await port() }); const configFile = path.join(created.directory, 'config.yaml')
  await f.instances.start(created.id); const originalPid = (await f.runtime.status(created)).pid
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('host: 0.0.0.0', 'host: 127.0.0.1').replace('  allow-remote: true', '  allow-remote: false'))
  const before = fs.readFileSync(configFile, 'utf8')
  f.instances.prepareBinary = async () => { throw new Error('must not touch live binary') }
  await f.instances.reconcileDesired()
  assert.equal(fs.readFileSync(configFile, 'utf8'), before)
  assert.equal((await f.runtime.status(created)).pid, originalPid)
  f.store.close()
})

test('controller recovery preserves stopped children and externally running children', async () => {
  const f = fixture()
  try {
    const stopped = await f.instances.create({ name: 'stopped', port: await port() })
    const external = await f.instances.create({ name: 'external', port: await port() })
    await f.runtime.start(external)
    const pid = (await f.runtime.status(external)).pid
    f.instances.prepareBinary = async () => { throw new Error('must not prepare existing children') }
    await f.instances.reconcileDesired()
    assert.equal((await f.runtime.status(stopped)).state, 'stopped')
    assert.equal((await f.runtime.status(external)).pid, pid)
  } finally { f.store.close() }
})

test('instance start exposes a safe actionable failure instead of an internal server error', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'start-failure', port: await port() }); f.runtime.failure('start', new Error('CPA binary is not executable'))
  await assert.rejects(() => f.instances.start(created.id), /start failed: CPA binary is not executable/)
  const operation = f.store.listOperations(1)[0]; assert.equal(operation.state, 'failed'); assert.match(operation.message, /CPA binary is not executable/)
  f.store.close()
})

test('delete requires a fresh challenge and administrator password', async () => {
  const f = fixture(); const auth = new AuthService(f.store); auth.initializeAdmin('controller admin password'); const created = await f.instances.create({ name: 'delete-me', port: await port(), management_password: 'child management password' }); const service = new DeleteService({ store: f.store, runtime: f.runtime, units: new NoopUnitManager(), instances: f.instances, auth }); const challenge = service.preview(created.id); await service.confirm(created.id, challenge.id, 'controller admin password'); assert.equal(f.store.listInstances().length, 0); assert.equal(fs.existsSync(created.directory), false); f.store.close()
})

test('login throttling is scoped by client and collapses unknown usernames', () => {
  const f = fixture(); const auth = new AuthService(f.store); auth.initializeAdmin('controller admin password')
  for (let index = 0; index < 5; index += 1) assert.throws(() => auth.login(`unknown-${index}`, 'wrong', '192.0.2.10'), /invalid credentials/)
  assert.throws(() => auth.login('another-unknown', 'wrong', '192.0.2.10'), /too many authentication attempts/)
  assert.equal(auth.failures.size, 1); assert.equal(auth.login('admin', 'controller admin password', '192.0.2.11').token.length, 64); f.store.close()
})

test('administrator password can be changed without a default password policy', () => {
  const f = fixture(); const auth = new AuthService(f.store); auth.initializeAdmin('admin'); auth.changeAdminPassword('admin', 'new-password')
  assert.throws(() => auth.login('admin', 'admin'), /invalid credentials/)
  assert.equal(auth.login('admin', 'new-password').token.length, 64); f.store.close()
})

test('quota refresh preserves old values on child API failure', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'quota', port: await port(), management_password: 'child management password' }); await f.instances.start(created.id); const client = new StaticClient({ accounts: [{ id: 'a', provider: 'demo' }], quotas: { a: { values: [{ name: '6h', remaining: 7 }] } } }); const quota = new QuotaService({ store: f.store, instances: f.instances, clients: async () => client }); await quota.refreshInstance(created.id); assert.equal((await quota.list(created.id))[0].values[0].remaining, 7); client.error = new Error('child unavailable'); await assert.rejects(() => quota.refreshInstance(created.id), /list OAuth accounts/); assert.equal((await quota.list(created.id))[0].status, 'failed'); f.store.close()
})

test('quota scheduler retries a previously failed OAuth discovery', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'quota-retry', port: await port() }); await f.instances.start(created.id); let unavailable = true
  const quota = new QuotaService({ store: f.store, instances: f.instances, clients: async () => ({ listAccounts: async () => { if (unavailable) throw new Error('child unavailable'); return [] } }) })
  await assert.rejects(() => quota.refreshInstance(created.id), /list OAuth accounts/); unavailable = false; await quota.refreshDue(); const snapshot = (await quota.list(created.id))[0]
  assert.equal(snapshot.status, 'empty'); assert.equal(snapshot.message, 'no OAuth accounts configured'); f.store.close()
})

test('quota settings configure the refresh period and notify on low remaining quota', async () => {
  const f = fixture(); const created = await f.instances.create({ name: 'quota-alert', port: await port() }); await f.instances.start(created.id); const client = new StaticClient({ accounts: [{ id: 'a', provider: 'demo' }], quotas: { a: { values: [{ name: '6h', remaining: 1, total: 10 }] } } }); const notifications = []; const quota = new QuotaService({ store: f.store, instances: f.instances, clients: async () => client, secrets: f.secrets, notifier: { notify: async (settings, message) => { notifications.push({ settings, message }) } } }); assert.equal(quota.getSettings().refresh_interval_minutes, 360); const saved = quota.updateSettings({ refresh_interval_minutes: 90, webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', alert_threshold_percent: 20 }); assert.equal(saved.refresh_interval_minutes, 90); assert.equal(saved.webhook_url, ''); assert.equal(saved.webhook_url_configured, true); await quota.refreshInstance(created.id); assert.equal(notifications.length, 1); assert.match(notifications[0].message, /10\.0%/); assert.equal(notifications[0].settings.webhook_url, 'https://oapi.dingtalk.com/robot/send?access_token=test'); assert.throws(() => quota.updateSettings({ webhook_enabled: true, webhook_url: '' }), /webhook_url is required/); assert.throws(() => quota.updateSettings({ webhook_url: 'http://127.0.0.1/internal' }), /DingTalk HTTPS robot URL/); assert.throws(() => quota.updateSettings({ webhook_url: 'https://example.com/robot/send?access_token=test' }), /DingTalk HTTPS robot URL/); f.store.close()
})

test('quota webhook signing secrets are encrypted and never returned by settings', () => {
  const f = fixture(); const quota = new QuotaService({ store: f.store, instances: f.instances, secrets: f.secrets, clients: async () => ({ listAccounts: async () => [] }) })
  assert.throws(() => quota.updateSettings({ webhook_signing_enabled: true }), /webhook_secret is required/)
  const saved = quota.updateSettings({ webhook_signing_enabled: true, webhook_secret: 'ding-secret' })
  assert.equal(saved.webhook_signing_enabled, true); assert.equal(saved.webhook_secret_configured, true); assert.equal(saved.webhook_secret, undefined)
  const stored = f.store.getQuotaSettings({ includeSecretCiphertext: true }); assert.notEqual(stored.webhook_signing_secret_ciphertext, ''); assert.equal(f.secrets.decrypt(stored.webhook_signing_secret_ciphertext), 'ding-secret'); f.store.close()
})

test('legacy DingTalk access tokens migrate from plaintext to encrypted storage', () => {
  const f = fixture(); const legacyUrl = 'https://oapi.dingtalk.com/robot/send?access_token=legacy'; f.store.db.prepare('UPDATE quota_settings SET webhook_enabled=1, webhook_url=? WHERE id=1').run(legacyUrl)
  const quota = new QuotaService({ store: f.store, instances: f.instances, secrets: f.secrets, clients: async () => ({ listAccounts: async () => [] }) }); const row = f.store.db.prepare('SELECT webhook_url, webhook_url_ciphertext FROM quota_settings WHERE id=1').get()
  assert.equal(row.webhook_url, ''); assert.notEqual(row.webhook_url_ciphertext, ''); assert.equal(f.secrets.decrypt(row.webhook_url_ciphertext), legacyUrl); assert.equal(quota.getSettings().webhook_url, ''); assert.equal(quota.getSettings().webhook_url_configured, true); f.store.close()
})

test('DingTalk notifier signs requests with timestamp and HMAC-SHA256', async () => {
  let request
  const notifier = new DingTalkNotifier({ clock: () => 1700000000123, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ errcode: 0 }) } } })
  await notifier.notify({ webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', webhook_signing_enabled: true, webhook_secret: 'ding-secret' }, 'quota alert')
  const parsed = new URL(request.url); const timestamp = '1700000000123'; const expected = crypto.createHmac('sha256', 'ding-secret').update(`${timestamp}\nding-secret`).digest('base64')
  assert.equal(parsed.searchParams.get('timestamp'), timestamp); assert.equal(parsed.searchParams.get('sign'), expected); assert.match(String(request.options.body), /quota alert/)
})

test('notification failure is logged without losing successful quota data or leaking credentials', async () => {
  const f = fixture()
  try {
    const item = await f.instances.create({ name: 'notify-failure', port: await port() })
    await f.instances.start(item.id)
    const client = new StaticClient({ accounts: [{ id: 'a' }], quotas: { a: { values: [{ remaining: 0, total: 10 }] } } })
    const quota = new QuotaService({ store: f.store, instances: f.instances, clients: async () => client, secrets: f.secrets, notifier: { notify: async () => { throw new Error('https://oapi.dingtalk.com/robot/send?access_token=private-token') } } })
    quota.updateSettings({ webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=private-token' })
    await quota.refreshInstance(item.id)
    assert.equal((await quota.list(item.id))[0].status, 'ok')
    const logs = f.store.listRuntimeLogs(100)
    assert.ok(logs.some(value => value.source === 'quota' && value.level === 'error'))
    assert.equal(JSON.stringify(logs).includes('private-token'), false)
  } finally { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('DingTalk notifier rejects malformed success responses', async () => {
  for (const payload of [null, {}, { errcode: 'invalid' }]) {
    const notifier = new DingTalkNotifier({ fetchImpl: async () => ({ ok: true, json: async () => payload }) })
    await assert.rejects(notifier.notify({ webhook_enabled: true, webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test' }, 'test'))
  }
})

test('changing the quota interval reschedules an already sleeping scheduler', async t => {
  const f = fixture()
  const abort = new AbortController()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const quota = new QuotaService({ store: f.store, instances: f.instances, secrets: f.secrets })
  let refreshes = 0
  quota.refreshDue = async () => { refreshes++ }
  const task = quota.run(abort.signal)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(refreshes, 1)
    quota.updateSettings({ refresh_interval_minutes: 1 })
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(60000)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(refreshes >= 2, 'new interval must take effect before the original six-hour delay')
  } finally { abort.abort(); await task; t.mock.timers.reset(); f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('failed live configuration startup restores the previous config and running instance', async () => {
  const f = fixture()
  try {
    const item = await f.instances.create({ name: 'config-rollback', port: await port() })
    await f.instances.start(item.id)
    const before = f.store.getInstance(item.id)
    const config = fs.readFileSync(path.join(item.directory, 'config.yaml'), 'utf8')
    const newPort = await port()
    const start = f.runtime.start.bind(f.runtime)
    f.runtime.start = async value => { if (value.port === newPort) throw new Error('new config rejected'); return start(value) }
    await assert.rejects(f.instances.update(item.id, { port: newPort, expected_revision: before.revision }), /new config rejected/)
    const restored = f.store.getInstance(item.id)
    assert.equal(restored.port, before.port)
    assert.ok(restored.revision > before.revision)
    assert.equal(fs.readFileSync(path.join(item.directory, 'config.yaml'), 'utf8'), config)
    assert.equal((await f.runtime.status(restored)).state, 'running')
  } finally { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('stopped instances fail quota discovery without contacting the child', async () => {
  const f = fixture()
  try {
    const item = await f.instances.create({ name: 'stopped-quota', port: await port() })
    let calls = 0
    const quota = new QuotaService({ store: f.store, instances: f.instances, clients: async () => { calls++; throw new Error('must not contact stopped child') } })
    await assert.rejects(quota.refreshInstance(item.id), error => error.status === 409)
    assert.equal(calls, 0)
    assert.equal((await quota.list(item.id))[0].status, 'failed')
  } finally { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('expired sessions and delete challenges are rejected without deleting data', async () => {
  const f = fixture()
  let now = new Date('2026-01-01T00:00:00Z')
  const auth = new AuthService(f.store, { now: () => now, sessionTtlMs: 1000 })
  auth.initializeAdmin('admin')
  try {
    const login = auth.login('admin', 'admin')
    const item = await f.instances.create({ name: 'expiry-test', port: await port() })
    const deletion = new DeleteService({ store: f.store, runtime: f.runtime, instances: f.instances, auth, clock: () => now, challengeTtlMs: 1000 })
    const challenge = deletion.preview(item.id)
    now = new Date(now.getTime() + 1001)
    assert.throws(() => auth.authenticate(login.token), /invalid credentials/)
    await assert.rejects(deletion.confirm(item.id, challenge.id, 'admin'))
    assert.ok(fs.existsSync(item.directory))
    assert.equal(f.store.getInstance(item.id).name, 'expiry-test')
  } finally { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }) }
})
