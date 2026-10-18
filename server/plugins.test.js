import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Store } from './store.js'
import { FakeRuntime, NoopUnitManager } from './runtime.js'
import { InstanceService } from './services.js'
import { openSecretStore } from './security.js'
import { PluginService, PluginArtifacts, PLUGIN_CATALOG } from './plugins.js'
import { editChildConfig } from './child-config.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-plugins-')); const store = new Store(':memory:'); const runtime = new FakeRuntime()
  const instances = new InstanceService({ root, store, runtime, secrets: openSecretStore(path.join(root, 'secret')), units: new NoopUnitManager(), requireVersion: false })
  const library = path.join(root, 'new.so'); fs.writeFileSync(library, 'new library')
  const artifacts = { catalog: PLUGIN_CATALOG, descriptor: id => { assert.equal(id, 'cpa-key-billing'); return PLUGIN_CATALOG[0] }, prepare: async () => ({ id: 'cpa-key-billing', version: '1.3.20', sha256: crypto.createHash('sha256').update('new library').digest('hex'), file: library }) }
  const service = new PluginService({ store, instances, runtime, artifacts, clients: async instance => ({ request: async () => ({ body: JSON.stringify({ plugins_enabled: true, plugins: [{ id: 'cpa-key-billing', path: path.join(instance.directory, 'plugins', 'cpa-key-billing.so'), enabled: true, registered: true, effective_enabled: true, metadata: { version: '1.3.20' } }] }) }), health: async () => {} }) })
  instances.pluginService = service
  return { root, store, runtime, instances, service, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}
async function child(f, name, port) { return f.instances.create({ name, port, management_password: 'testing' }) }

for (const fail of [false, true]) test(`plugin runtime events record ${fail ? 'failure and rollback' : 'completion'} without leaking upstream data`, async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'runtime-log', 19394); await f.instances.start(instance.id)
    if (fail) f.service.verify = async () => { throw new Error('sk-private-plugin-token https://example.invalid/?access_token=private') }
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id], enable: true })
    await f.service.pending
    const logs = f.store.listRuntimeLogs(500, { source: 'plugin' })
    assert.ok(logs.some(item => item.context.status === 'running'))
    assert.ok(logs.some(item => item.context.status === (fail ? 'failed' : 'completed')))
    assert.ok(logs.some(item => item.instance_id === instance.id && item.context.status === (fail ? 'rolled-back' : 'verified')))
    assert.ok(logs.every(item => item.context.job_id === job.id))
    assert.equal(JSON.stringify(logs).includes('private'), false)
  } finally { f.close() }
})

test('insufficient automatic backup capacity prevents all plugin writes and restarts', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'capacity', 19391); await f.instances.start(instance.id)
    await f.instances.backup(instance.id, { name: 'existing-backup', port: 19491 })
    f.store.saveInstanceLimits({ max_instances: 5, max_backups: 1 })
    const config = fs.readFileSync(path.join(instance.directory, 'config.yaml'))
    let stops = 0; f.runtime.stop = async () => { stops++; throw new Error('must not stop') }
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id], enable: true }); await f.service.pending
    assert.equal(job.state, 'failed'); assert.match(job.message, /实例名额/); assert.equal(stops, 0); assert.equal(f.store.listInstances().length, 2); assert.deepEqual(fs.readFileSync(path.join(instance.directory, 'config.yaml')), config); assert.equal(fs.existsSync(path.join(instance.directory, 'plugins', 'cpa-key-billing.so')), false)
  } finally { f.close() }
})

test('a later backup failure leaves earlier backups intact and prevents deployment to every target', async () => {
  const f = fixture()
  try {
    const first = await child(f, 'before-failure', 19392); const second = await child(f, 'bad-backup', 19393)
    fs.rmSync(path.join(second.directory, 'config.yaml'))
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [first.id, second.id], enable: true }); await f.service.pending
    assert.equal(job.state, 'failed'); assert.equal(job.results[0].state, 'cancelled'); assert.equal(job.results[1].state, 'failed')
    assert.equal(f.store.getInstance(job.results[0].backup_id).locked, true)
    for (const source of [first, second]) assert.equal(fs.existsSync(path.join(source.directory, 'plugins', 'cpa-key-billing.so')), false)
  } finally { f.close() }
})

for (const scenario of [
  { name: 'fresh disabled install', global: true, enabled: false, old: false, relative: true },
  { name: 'disabled upgrade', global: true, enabled: false, old: true },
  { name: 'globally disabled upgrade', global: false, enabled: true, old: true },
  { name: 'enabled upgrade without explicit enable', global: true, enabled: true, old: true }
]) test(scenario.name + ' preserves configured state', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'unchecked', 19389); await f.instances.start(instance.id)
    const file = path.join(instance.directory, 'plugins', 'cpa-key-billing.so')
    if (scenario.old) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'old library') }
    const config = fs.readFileSync(path.join(instance.directory, 'config.yaml'), 'utf8')
    const loaded = scenario.global && scenario.enabled
    f.service.clients = async () => ({ request: async () => ({ body: JSON.stringify({ plugins_enabled: scenario.global, plugins: !fs.existsSync(file) ? [] : [{ id: 'cpa-key-billing', path: scenario.relative ? 'plugins/cpa-key-billing.so' : file, enabled: scenario.enabled, registered: loaded, effective_enabled: loaded, metadata: loaded ? { version: '1.3.20' } : null }] }) }), health: async () => {} })
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id], enable: false }); await f.service.pending
    assert.equal(job.state, 'completed'); assert.equal(job.results[0].state, loaded ? 'verified' : 'installed-disabled')
    assert.equal(fs.readFileSync(file, 'utf8'), 'new library'); assert.equal(fs.readFileSync(path.join(instance.directory, 'config.yaml'), 'utf8'), config)
    assert.equal((await f.runtime.status(instance)).state, 'running')
  } finally { f.close() }
})

test('unchecked enabled upgrade still rolls back when registration fails', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'load-failure', 19390); await f.instances.start(instance.id)
    const file = path.join(instance.directory, 'plugins', 'cpa-key-billing.so'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'old library')
    f.service.clients = async () => ({ request: async () => ({ body: JSON.stringify({ plugins_enabled: true, plugins: [{ id: 'cpa-key-billing', path: file, enabled: true, registered: false, effective_enabled: false, metadata: null }] }) }), health: async () => {} })
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id], enable: false }); await f.service.pending
    assert.equal(job.state, 'failed'); assert.equal(job.results[0].state, 'rolled-back'); assert.match(job.message, /registration/); assert.equal(fs.readFileSync(file, 'utf8'), 'old library')
  } finally { f.close() }
})

test('per-plugin enabling preserves four-space settings and is idempotent', () => {
  const source = 'plugins:\n    enabled: true\n    configs:\n        cpa-key-billing:\n            enabled: false\n            custom: preserved\nconfig-version: 8\n'
  const edited = editChildConfig(source, { plugin: { id: 'cpa-key-billing' } })
  assert.match(edited, /            enabled: true\n            custom: preserved/)
  assert.equal(editChildConfig(edited, { plugin: { id: 'cpa-key-billing' } }), edited)
})
test('deployment skips locked instances and preserves stopped state and config', async () => {
  const f = fixture()
  try {
    const stopped = await child(f, 'stopped', 19381); const locked = await child(f, 'locked', 19382); await f.instances.setLocked(locked.id, true)
    const config = fs.readFileSync(path.join(stopped.directory, 'config.yaml'), 'utf8')
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [stopped.id, locked.id] }); await f.service.pending
    assert.equal(job.state, 'completed'); assert.deepEqual(job.results.map(item => item.state), ['installed-pending-verification', 'skipped-locked'])
    assert.equal((await f.runtime.status(stopped)).state, 'stopped'); assert.equal(fs.readFileSync(path.join(stopped.directory, 'config.yaml'), 'utf8'), config)
    const backup = f.store.getInstance(job.results[0].backup_id)
    assert.equal(backup.locked, true); assert.equal(backup.desired_state, 'stopped'); assert.notEqual(backup.port, stopped.port)
    assert.equal(fs.existsSync(path.join(backup.directory, 'plugins', 'cpa-key-billing.so')), false)
    assert.equal(fs.existsSync(path.join(locked.directory, 'plugins', 'cpa-key-billing.so')), false)
    assert.equal((await f.service.inventory()).instances[0].plugins[0].enabled, null)
  } finally { f.close() }
})
test('running rollout verifies actual registration and excludes concurrent mutations', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'running', 19383); await f.instances.start(instance.id)
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id], enable: true })
    assert.throws(() => f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id] }), { status: 409 })
    await f.service.pending; assert.equal(job.results[0].state, 'verified'); assert.equal((await f.runtime.status(instance)).state, 'running')
    assert.match(fs.readFileSync(path.join(instance.directory, 'config.yaml'), 'utf8'), /cpa-key-billing:\n\s+enabled: true/)
  } finally { f.close() }
})
test('failed verification restores old library/config and halts subsequent instances', async () => {
  const f = fixture()
  try {
    const first = await child(f, 'first', 19384); const second = await child(f, 'second', 19385); await f.instances.start(first.id)
    fs.mkdirSync(path.join(first.directory, 'plugins')); const file = path.join(first.directory, 'plugins', 'cpa-key-billing.so'); fs.writeFileSync(file, 'old library')
    const config = fs.readFileSync(path.join(first.directory, 'config.yaml'), 'utf8')
    f.service.verify = async () => { throw new Error('ABI failure') }
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [first.id, second.id], enable: true }); await f.service.pending
    assert.equal(job.state, 'failed'); assert.equal(job.results[0].state, 'rolled-back'); assert.equal(fs.readFileSync(file, 'utf8'), 'old library'); assert.equal(fs.readFileSync(path.join(first.directory, 'config.yaml'), 'utf8'), config)
    assert.equal((await f.runtime.status(first)).state, 'running'); assert.equal(fs.existsSync(path.join(second.directory, 'plugins', 'cpa-key-billing.so')), false)
    assert.equal(job.results[1].state, 'cancelled')
    assert.equal(fs.readFileSync(path.join(f.store.getInstance(job.results[0].backup_id).directory, 'plugins', 'cpa-key-billing.so'), 'utf8'), 'old library')
  } finally { f.close() }
})
test('interrupted deployment recovers from durable backups, with retry after rollback failure', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'recover', 19386); const job = { id: crypto.randomUUID(), plugin: 'cpa-key-billing', state: 'running', results: [{ id: instance.id, state: 'installing', was_running: false }] }
    const files = f.service.paths(job, instance); fs.mkdirSync(files.backup); fs.copyFileSync(files.config, path.join(files.backup, 'config')); fs.writeFileSync(files.file, 'partial new library'); f.store.savePluginJob(job)
    const stop = f.runtime.stop; f.runtime.stop = async () => { throw new Error('systemd denied') }; await f.service.recover()
    assert.equal(f.service.jobs()[0].state, 'blocked'); assert.throws(() => f.service.assertIdle(), { status: 409 })
    f.runtime.stop = stop; await f.service.recover(); assert.equal(f.service.jobs()[0].results[0].state, 'rolled-back'); assert.equal(fs.existsSync(files.file), false); f.service.assertIdle()
  } finally { f.close() }
})
test('checksum failure occurs before touching an instance and cache tampering is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cache-'))
  try {
    const artifacts = new PluginArtifacts({ root, sourceFactory: () => ({ download: async item => item.url.endsWith('checksums.txt') ? Buffer.from(`${'0'.repeat(64)}  cpa-key-billing_1.3.20_linux_amd64.tar.gz`) : Buffer.from('wrong archive') }) })
    await assert.rejects(artifacts.prepare('cpa-key-billing', '1.3.20'), /checksum mismatch/)
    const cache = path.join(root, 'cpa-key-billing-1.3.20'); fs.mkdirSync(cache); const bytes = Buffer.alloc(64); bytes.write('ELF', 1); bytes[0] = 127; bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); fs.writeFileSync(path.join(cache, 'cpa-key-billing.so'), bytes); fs.writeFileSync(path.join(cache, 'manifest.json'), JSON.stringify({ id: 'cpa-key-billing', version: '1.3.20', sha256: 'bad' }))
    await assert.rejects(artifacts.prepare('cpa-key-billing', '1.3.20'), /integrity mismatch/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('backup failure reports the instance failure before any runtime or library mutation', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'missing-config', 19387); fs.rmSync(path.join(instance.directory, 'config.yaml'))
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id] }); await f.service.pending
    assert.equal(job.state, 'failed'); assert.equal(job.results[0].state, 'failed'); assert.match(job.results[0].message, /config missing/)
    assert.equal((await f.runtime.status(instance)).state, 'stopped'); assert.equal(fs.existsSync(path.join(instance.directory, 'plugins', 'cpa-key-billing.so')), false)
  } finally { f.close() }
})
test('deleting terminal deployment records preserves plugin files, config and backups', async () => {
  const f = fixture()
  try {
    const instance = await child(f, 'delete-history', 19388)
    const job = f.service.submit({ plugin: 'cpa-key-billing', instances: [instance.id] }); await f.service.pending
    const files = f.service.paths(job, instance); const config = fs.readFileSync(files.config); const library = fs.readFileSync(files.file)
    f.service.deleteRecord(job.id)
    assert.equal(f.service.jobs().length, 0); assert.deepEqual(fs.readFileSync(files.config), config); assert.deepEqual(fs.readFileSync(files.file), library); assert.ok(fs.existsSync(path.join(files.backup, 'config')))
    assert.equal((await f.runtime.status(instance)).state, 'stopped')
    assert.throws(() => f.service.deleteRecord(job.id), { status: 404 })
    for (const state of ['queued', 'running', 'blocked']) {
      const protectedJob = { id: crypto.randomUUID(), state, results: [] }; f.store.savePluginJob(protectedJob)
      assert.throws(() => f.service.deleteRecord(protectedJob.id), { status: 409 }); assert.ok(f.service.jobs().some(item => item.id === protectedJob.id))
    }
    const failed = { id: crypto.randomUUID(), state: 'failed', results: [] }; f.store.savePluginJob(failed); f.service.deleteRecord(failed.id); assert.ok(!f.service.jobs().some(item => item.id === failed.id))
  } finally { f.close() }
})
