import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { Store } from './store.js'
import { InstanceService } from './services.js'
import { FakeRuntime, NoopUnitManager } from './runtime.js'
import { openSecretStore } from './security.js'
import { relocateBackupConfig, backupMetadata } from './instance-backup.js'
import { KeyService } from './keys.js'

test('manual and automatic backups inherit managed Key bindings for later revocation', async () => {
  const f = fixture()
  try {
    const source = await f.instances.create({ name: 'key-source', port: await port() })
    const keys = new KeyService({ store: f.store, instances: f.instances, secrets: f.instances.secrets })
    const key = await keys.create({ key: 'sk-backup-test12345' })
    await keys.mutate(key.id, 'bind', { instances: [source.id] })
    fs.appendFileSync(path.join(source.directory, 'config.yaml'), '\napi-keys:\n  - sk-backup-test12345\n')
    const manual = await f.instances.backup(source.id, { name: 'manual', port: await port() })
    const [automatic] = await f.instances.operations.run('global', () => f.instances.automaticBackups([source.id], 'test'))
    const bindings = f.store.keyBindings(key.id)
    assert.equal(bindings.length, 3)
    for (const copy of [manual, automatic]) {
      assert.equal(bindings.find(item => item.instance_id === copy.id).status, 'copied')
      assert.match(fs.readFileSync(path.join(copy.directory, 'config.yaml'), 'utf8'), /sk-backup-test12345/)
      assert.throws(() => f.store.assertNoKeyBindings(copy.id), /仍绑定/)
    }
  } finally { f.close() }
})

async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) }) }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-backup-')); const store = new Store(':memory:'); const runtime = new FakeRuntime()
  const instances = new InstanceService({ root, store, runtime, units: new NoopUnitManager(), secrets: openSecretStore(path.join(root, 'secret')), requireVersion: false })
  return { root, store, runtime, instances, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

for (const v8 of [false, true]) test(`backup preserves independent configuration, auth and plugin data (v8=${v8})`, async () => {
  const f = fixture()
  try {
    const source = await f.instances.create({ name: 'source', port: await port(), version: 'v1', management_password: 'child-test-secret' })
    const file = path.join(source.directory, 'config.yaml')
    if (v8) fs.writeFileSync(file, `config-version: 8\nserver:\n    port: ${source.port}\nmanagement:\n    secret-key: "child-test-secret"\noauth:\n    auth-dir: ${JSON.stringify(path.join(source.directory, 'auths'))}\nplugins:\n    enabled: true\n    configs:\n        demo:\n            enabled: true\n            database: ${JSON.stringify(path.join(source.directory, 'plugins', 'billing.db'))}\n`)
    fs.writeFileSync(path.join(source.directory, 'auths', 'account.json'), '{"token":"synthetic"}')
    fs.mkdirSync(path.join(source.directory, 'plugins')); fs.writeFileSync(path.join(source.directory, 'plugins', 'billing.db'), 'database before upgrade'); fs.writeFileSync(path.join(source.directory, 'plugins', 'demo.so'), 'plugin before upgrade')
    fs.writeFileSync(path.join(source.directory, '.multi-cpa.pid'), '12345'); fs.writeFileSync(path.join(source.directory, 'logs', 'old.log'), 'log'); fs.mkdirSync(path.join(source.directory, '.plugin-backups')); fs.writeFileSync(path.join(source.directory, '.plugin-backups', 'old'), 'prior backup')
    const original = fs.readFileSync(file, 'utf8'); const newPort = await port()
    const copy = await f.instances.backup(source.id, { name: 'source-backup', port: newPort })
    assert.notEqual(copy.id, source.id); assert.equal(copy.version, 'v1'); assert.equal(copy.desired_state, 'stopped'); assert.equal(f.instances.decryptManagementSecret(copy), 'child-test-secret')
    const config = fs.readFileSync(path.join(copy.directory, 'config.yaml'), 'utf8')
    assert.match(config, new RegExp(`port: ${newPort}`)); assert.ok(config.includes(JSON.stringify(path.join(copy.directory, 'auths')))); assert.ok(!config.includes(JSON.stringify(source.directory).slice(1, -1))); assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.equal(fs.readFileSync(path.join(copy.directory, 'plugins', 'billing.db'), 'utf8'), 'database before upgrade')
    fs.writeFileSync(path.join(copy.directory, 'auths', 'account.json'), 'changed in clone'); assert.equal(fs.readFileSync(path.join(source.directory, 'auths', 'account.json'), 'utf8'), '{"token":"synthetic"}')
    for (const name of ['.multi-cpa.pid', '.plugin-backups', 'logs/old.log']) assert.equal(fs.existsSync(path.join(copy.directory, name)), false)
    assert.equal(backupMetadata(copy).source_id, source.id); assert.equal((await f.instances.list()).find(item => item.id === copy.id).backup.automatic, false)
  } finally { f.close() }
})

test('automatic backups finish before upgrading, skip locked sources and reserve distinct ports', async () => {
  const f = fixture()
  try {
    const source = await f.instances.create({ name: 'source', port: await port(), version: 'v1' }); const stopped = await f.instances.create({ name: 'stopped', port: await port(), version: 'v1' }); const locked = await f.instances.create({ name: 'locked', port: await port() }); await f.instances.setLocked(locked.id, true); await f.instances.start(source.id)
    const before = f.store.getInstance(source.id); const copies = await f.instances.operations.run('global', () => f.instances.automaticBackups([source.id, stopped.id, locked.id], 'CPA v2'))
    assert.equal(copies.length, 2); assert.notEqual(copies[0].port, copies[1].port); assert.deepEqual(f.store.getInstance(source.id), before); assert.equal((await f.runtime.status(source)).state, 'running'); assert.equal((await f.runtime.status(stopped)).state, 'stopped')
    for (const copy of copies) { assert.equal(f.store.getInstance(copy.id).locked, true); assert.equal(copy.desired_state, 'stopped'); assert.equal(backupMetadata(copy).reason, 'CPA v2'); assert.equal((await f.runtime.status(copy)).state, 'stopped') }
    assert.equal(f.store.listAuditLogs().filter(item => item.action === 'instance.backup').length, 2)
  } finally { f.close() }
})

test('capacity and occupied ports fail before interrupting a source', async () => {
  const f = fixture(); const occupied = net.createServer()
  try {
    const source = await f.instances.create({ name: 'source', port: await port() }); await f.instances.start(source.id)
    await f.instances.backup(source.id, { name: 'existing-backup', port: await port() })
    let stops = 0; const stop = f.runtime.stop.bind(f.runtime); f.runtime.stop = async item => { stops++; return stop(item) }
    f.store.saveInstanceLimits({ max_instances: 5, max_backups: 1 })
    await assert.rejects(f.instances.operations.run('global', () => f.instances.automaticBackups([source.id], 'plugin demo')), /实例名额/)
    f.store.saveInstanceLimits({ max_instances: 5, max_backups: 10 }); await new Promise(resolve => occupied.listen(0, '0.0.0.0', resolve))
    await assert.rejects(f.instances.backup(source.id, { name: 'bad-port', port: occupied.address().port }), { code: 'ERR_PORT_UNAVAILABLE' })
    await assert.rejects(f.instances.backup(source.id, { name: 'same-port', port: source.port }), { status: 409 })
    assert.equal(stops, 0); assert.equal(f.store.listInstances().length, 2); assert.equal((await f.runtime.status(source)).state, 'running')
  } finally { occupied.close(); f.close() }
})

test('copy or registration failure restores source state and removes the incomplete clone', async () => {
  const f = fixture()
  try {
    const source = await f.instances.create({ name: 'source', port: await port() }); await f.instances.start(source.id)
    const original = fs.readFileSync(path.join(source.directory, 'config.yaml'))
    // Unsupported inline server mapping fails after copying, while editing the new port.
    fs.writeFileSync(path.join(source.directory, 'config.yaml'), 'config-version: 8\nserver: {port: 8322}\n')
    await assert.rejects(f.instances.backup(source.id, { name: 'bad-config', port: await port() }), /block mapping/)
    assert.equal((await f.runtime.status(source)).state, 'running'); assert.equal(f.store.listInstances().length, 1); assert.deepEqual(fs.readdirSync(path.join(f.root, 'instances')), [source.id])
    fs.writeFileSync(path.join(source.directory, 'config.yaml'), original)
    f.instances.units.install = async () => { throw new Error('unit install failed') }
    await assert.rejects(f.instances.backup(source.id, { name: 'bad-unit', port: await port() }), /unit install failed/)
    assert.equal((await f.runtime.status(source)).state, 'running'); assert.equal(f.store.listInstances().length, 1); assert.deepEqual(fs.readdirSync(path.join(f.root, 'instances')), [source.id])
  } finally { f.close() }
})

test('external storage references are rejected, with comments and ordinary prefixes preserved', () => {
  const source = path.resolve('source'); const target = path.resolve('clone')
  assert.throws(() => relocateBackupConfig(`auth-dir: ${JSON.stringify(path.resolve('external'))}\n`, source, target), /实例目录外/)
  assert.throws(() => relocateBackupConfig('database-path: ../source/db\n', source, target), /实例目录外/)
  assert.throws(() => relocateBackupConfig(`dsn: ${JSON.stringify(`file:${path.resolve('external', 'billing.db')}`)}\n`, source, target), /实例目录外/)
  assert.throws(() => relocateBackupConfig('dsn: postgres://example.invalid/database\n', source, target), /本地数据库/)
  const config = 'prefix: /openai\n# auth-dir: /outside\n'
  assert.equal(relocateBackupConfig(config, source, target), config)
})

test('source restart failure aborts the backup and keeps its desired running state', async () => {
  const f = fixture()
  try {
    const source = await f.instances.create({ name: 'source', port: await port() }); await f.instances.start(source.id)
    f.runtime.start = async () => { throw new Error('restart denied') }
    await assert.rejects(f.instances.backup(source.id, { name: 'bad-restart', port: await port() }), /source restart after backup failed/)
    assert.equal(f.store.getInstance(source.id).desired_state, 'running'); assert.equal(f.store.listInstances().length, 1)
  } finally { f.close() }
})
