import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store, ConflictError, NotFoundError } from './store.js'

function tempStore() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-store-')); return { directory, store: new Store(path.join(directory, 'control.db')) } }
function instance(directory, id = 'cpa-test') { const now = new Date().toISOString(); return { id, name: 'demo', port: 19001, directory: path.join(directory, 'instances', id), management_secret_ciphertext: 'v1:test', desired_state: 'stopped', version: 'v1', revision: 1, created_at: now, updated_at: now } }

test('SQLite store persists instances and protects optimistic revisions', () => {
  const fixture = tempStore(); const item = instance(fixture.directory); fixture.store.createInstance(item); assert.equal(fixture.store.getInstance(item.id).name, 'demo'); assert.equal(fixture.store.listInstances().length, 1)
  const updated = { ...item, name: 'updated', revision: 2, updated_at: new Date().toISOString() }; fixture.store.updateInstance(updated, 1); assert.equal(fixture.store.getInstance(item.id).name, 'updated'); assert.throws(() => fixture.store.updateInstance({ ...updated, revision: 3 }, 1), ConflictError); fixture.store.close()
})

test('quota, operation, version and delete challenge records round trip', () => {
  const fixture = tempStore(); const item = instance(fixture.directory); fixture.store.createInstance(item)
  fixture.store.saveQuota({ instance_id: item.id, account_id: 'a', provider: 'p', values: [{ name: '6h', remaining: 3 }], status: 'ok', message: '', collected_at: '2026-01-01T00:00:00.000Z', attempted_at: '2026-01-01T00:00:00.000Z' }); assert.equal(fixture.store.listQuotas(item.id)[0].values[0].remaining, 3)
  fixture.store.saveVersion({ tag: 'v2', asset: 'a.tar.gz', path: '/tmp/v2', sha256: 'abc', installed_at: new Date().toISOString(), usable: true }); assert.equal(fixture.store.getVersion('v2').usable, true)
  const challenge = { id: 'del-1', instance_id: item.id, revision: 1, expires_at: '2099-01-01T00:00:00.000Z' }; fixture.store.createDeleteChallenge(challenge); fixture.store.consumeDeleteChallenge(challenge.id, item.id, 1, '2026-01-01T00:00:00.000Z'); assert.throws(() => fixture.store.consumeDeleteChallenge(challenge.id, item.id, 1, '2026-01-01T00:00:00.000Z'), ConflictError); assert.throws(() => fixture.store.getInstance('missing'), NotFoundError); fixture.store.close()
})

test('runtime and audit logs are structured and ordered newest first', () => {
  const fixture = tempStore()
  fixture.store.appendRuntimeLog({ level: 'info', source: 'controller', message: 'started', context: { port: 8787 }, created_at: '2026-01-01T00:00:00.000Z' })
  fixture.store.appendRuntimeLog({ level: 'error', source: 'instance', instance_id: 'cpa-one', message: 'failed', created_at: '2026-01-01T00:01:00.000Z' })
  const runtime = fixture.store.listRuntimeLogs(); assert.equal(runtime[0].message, 'failed'); assert.equal(runtime[1].context.port, 8787)
  fixture.store.appendAuditLog({ actor: 'admin', action: 'instance.restart', resource_type: 'instance', resource_id: 'cpa-one', outcome: 'success', client_address: '127.0.0.1', created_at: '2026-01-01T00:00:00.000Z' })
  fixture.store.appendAuditLog({ actor: 'admin', action: 'auth.login', resource_type: 'session', outcome: 'failed', detail: 'invalid credentials', created_at: '2026-01-01T00:02:00.000Z' })
  const audit = fixture.store.listAuditLogs(); assert.equal(audit[0].outcome, 'failed'); assert.equal(audit[1].resource_id, 'cpa-one'); fixture.store.close()
})

test('quota settings use defaults and persist webhook configuration', () => {
  const fixture = tempStore(); assert.deepEqual(fixture.store.getQuotaSettings(), { refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false })
  fixture.store.saveQuotaSettings({ refresh_interval_minutes: 120, webhook_enabled: true, webhook_url: '', webhook_url_ciphertext: 'v1:url', alert_threshold_percent: 15, webhook_signing_enabled: true, webhook_signing_secret_ciphertext: 'v1:secret' }); assert.deepEqual(fixture.store.getQuotaSettings(), { refresh_interval_minutes: 120, webhook_enabled: true, webhook_url: '', webhook_url_configured: true, alert_threshold_percent: 15, webhook_signing_enabled: true, webhook_secret_configured: true }); const privateSettings = fixture.store.getQuotaSettings({ includeSecretCiphertext: true }); assert.equal(privateSettings.webhook_signing_secret_ciphertext, 'v1:secret'); assert.equal(privateSettings.webhook_url_ciphertext, 'v1:url'); fixture.store.close()
})

test('quota settings migrate an existing database before reading signing columns', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-store-legacy-')); const file = path.join(directory, 'control.db'); const db = new DatabaseSync(file)
  db.exec("CREATE TABLE quota_settings (id INTEGER PRIMARY KEY CHECK (id = 1), refresh_interval_minutes INTEGER NOT NULL DEFAULT 360, webhook_enabled INTEGER NOT NULL DEFAULT 0, webhook_url TEXT NOT NULL DEFAULT '', alert_threshold_percent REAL NOT NULL DEFAULT 20); INSERT INTO quota_settings VALUES (1, 120, 1, 'https://oapi.dingtalk.com/robot/send?access_token=legacy', 15);")
  db.close()
  const store = new Store(file); assert.deepEqual(store.getQuotaSettings(), { refresh_interval_minutes: 120, webhook_enabled: true, webhook_url: '', webhook_url_configured: true, alert_threshold_percent: 15, webhook_signing_enabled: false, webhook_secret_configured: false }); assert.equal(store.getQuotaSettings({ includeSecretCiphertext: true }).webhook_url_legacy, 'https://oapi.dingtalk.com/robot/send?access_token=legacy'); store.close()
})
