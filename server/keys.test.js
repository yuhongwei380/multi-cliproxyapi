import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'
import { InstanceService, AuthService, DeleteService } from './services.js'
import { KeyService } from './keys.js'
import { HTTPClient } from './cpa.js'
import { Controller, createHttpServer } from './http.js'
import { DatabaseSync } from 'node:sqlite'

function fixture(t, file = ':memory:') {
  const store = new Store(file); t.after(() => store.close())
  const secretKey = crypto.randomBytes(32)
  const secrets = {
    encrypt(value) { const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, nonce); return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64') },
    decrypt(value) { const bytes = Buffer.from(value, 'base64'); const cipher = crypto.createDecipheriv('aes-256-gcm', secretKey, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString() }
  }
  const states = new Map([['one', 'running'], ['two', 'running']]); const remote = new Map([['one', ['existing-key']], ['two', []]]); const writes = []; const failures = new Set()
  for (const [index, id] of ['one', 'two'].entries()) store.createInstance({ id, name: id, port: 18000 + index, directory: `/test/${id}`, management_secret_ciphertext: 'test', desired_state: 'running', version: 'v8', revision: 1, created_at: 'now', updated_at: 'now' })
  const runtime = { status: async instance => ({ state: states.get(instance.id) }) }
  const instances = new InstanceService({ store, runtime, secrets })
  const auth = new AuthService(store); auth.initializeAdmin('password')
  const clients = async instance => ({
    readClientKeys: async () => { if (failures.has(instance.id)) throw new Error('remote-secret-must-not-leak'); return { keys: [...remote.get(instance.id)], path: '/v8/management/config/access/api-keys' } },
    writeClientKeys: async (path, keys) => { writes.push(instance.id); remote.set(instance.id, [...keys]) }
  })
  const service = new KeyService({ store, secrets, instances, clients, auth })
  return { store, service, remote, writes, failures, states, instances, auth, clients, secrets }
}
const secret = 'sk-test-abcdefgh12345678'

test('Key pushes log partial failures and success without plaintext keys or upstream errors', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret })
  await f.service.mutate(key.id, 'bind', { instances: ['one', 'two'] }); f.failures.add('two')
  await f.service.distribute(key.id)
  const logs = f.store.listRuntimeLogs(500, { source: 'key' })
  assert.ok(logs.some(item => item.context.event === 'key.started'))
  assert.ok(logs.some(item => item.instance_id === 'one' && item.context.status === 'deployed'))
  assert.ok(logs.some(item => item.instance_id === 'two' && item.level === 'error'))
  assert.ok(logs.some(item => item.context.succeeded === 1 && item.context.failed === 1))
  assert.equal(JSON.stringify(logs).includes(secret), false)
  assert.equal(JSON.stringify(logs).includes('remote-secret'), false)
  f.failures.clear()
  f.store.appendRuntimeLog = () => { throw new Error('log unavailable') }
  assert.ok((await f.service.distribute(key.id)).results.every(item => item.status !== 'failed'))
})

test('encrypted keys, locks, delete intent and failed bindings survive reopening the database', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-keys-'))
  const f = fixture(t, path.join(root, 'control.db')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const key = await f.service.create({ key: secret, note: '持久备注' })
  const group = await f.service.saveGroup(null, { name: '持久分组', key_ids: [key.id] })
  await f.service.mutate(key.id, 'bind', { instances: ['one'] }); f.failures.add('one')
  await f.service.distribute(key.id, { revoke: true, remove: true }); await f.service.mutate(key.id, 'lock')
  const reopened = new Store(path.join(root, 'control.db'))
  try {
    const service = new KeyService({ ...f, store: reopened, clients: f.clients })
    const saved = service.list()[0]
    assert.equal(saved.note, '持久备注'); assert.equal(saved.locked, true); assert.equal(saved.deleting, true)
    assert.equal(saved.group_id, group.id); assert.equal(service.listGroups()[0].name, '持久分组')
    assert.equal(saved.bindings[0].status, 'revoke-failed'); assert.equal((await service.reveal(key.id)).key, secret)
  } finally { reopened.close() }
})

test('legacy databases migrate existing keys into ungrouped without changing encrypted values', async t => {
  const f = fixture(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-groups-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'control.db'); const legacy = new DatabaseSync(file)
  const ciphertext = f.secrets.encrypt(secret)
  legacy.exec('CREATE TABLE managed_keys (id TEXT PRIMARY KEY, note TEXT NOT NULL, ciphertext TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, locked INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)')
  legacy.prepare('INSERT INTO managed_keys VALUES(?,?,?,?,0,0,?)').run('legacy', '旧 Key', ciphertext, 'legacy-fingerprint', 'now')
  legacy.close()
  const migrated = new Store(file)
  try {
    const service = new KeyService({ ...f, store: migrated })
    assert.equal(service.list()[0].group_id, null)
    assert.equal(migrated.getManagedKey('legacy').ciphertext, ciphertext)
    assert.equal((await service.reveal('legacy')).key, secret)
    assert.equal(service.listGroups().find(group => group.id === 'ungrouped').key_count, 1)
    const group = await service.saveGroup(null, { name: '迁移后分组', key_ids: ['legacy'] })
    assert.equal(service.list()[0].group_id, group.id)
  } finally { migrated.close() }
})

test('groups select and move keys atomically, keep bindings, and return removed members to ungrouped', async t => {
  const f = fixture(t)
  const one = await f.service.create({ key: secret }); const two = await f.service.create({})
  await f.service.mutate(one.id, 'bind', { instances: ['one'] })
  const first = await f.service.saveGroup(null, { name: '  生产环境  ', key_ids: [one.id] })
  const second = await f.service.saveGroup(null, { name: '测试环境', key_ids: [two.id] })
  assert.equal(first.name, '生产环境')
  await f.service.saveGroup(second.id, { name: '测试环境改名', key_ids: [one.id, two.id, one.id] })
  assert.equal(f.service.listGroups().find(group => group.id === first.id).key_count, 0)
  assert.equal(f.service.listGroups().find(group => group.id === second.id).key_count, 2)
  assert.equal(f.store.keyBindings(one.id).length, 1); assert.equal(f.writes.length, 0)
  await f.service.saveGroup(second.id, { key_ids: [two.id] })
  assert.equal(f.store.getManagedKey(one.id).group_id, null)
  await assert.rejects(f.service.saveGroup(first.id, { name: '测试环境改名', key_ids: [one.id] }), /已存在/)
  assert.equal(f.store.getManagedKey(one.id).group_id, null)
  await assert.rejects(f.service.saveGroup(first.id, { key_ids: [one.id, 'missing'] }), /不存在/)
  assert.equal(f.store.getManagedKey(one.id).group_id, null)
  for (const name of ['', ' ', '未分组', 'x'.repeat(81), 'bad\nname']) await assert.rejects(f.service.saveGroup(null, { name }))
  const created = await f.service.create({ group_id: first.id })
  assert.equal(created.group_id, first.id)
  await f.service.mutate(created.id, 'group', { group_id: second.id })
  await f.service.deleteGroup(second.id)
  assert.equal(f.store.getManagedKey(two.id).group_id, null)
  assert.equal(f.store.getManagedKey(created.id).group_id, null)
  assert.equal(f.store.keyBindings(one.id).length, 1)
  await assert.rejects(f.service.deleteGroup('ungrouped'), /不存在/)
})

test('group membership respects locked and deleting keys through all entry points', async t => {
  const f = fixture(t); const key = await f.service.create({})
  await f.service.mutate(key.id, 'lock')
  await assert.rejects(f.service.saveGroup(null, { name: '不能移入', key_ids: [key.id] }), /已锁定/)
  const group = await f.service.saveGroup(null, { name: '目标组' })
  await assert.rejects(f.service.mutate(key.id, 'group', { group_id: group.id }), /已锁定/)
  await f.service.mutate(key.id, 'unlock', { admin_password: 'password' })
  await f.service.mutate(key.id, 'group', { group_id: group.id })
  await f.service.mutate(key.id, 'lock')
  await f.service.saveGroup(group.id, { name: '允许改组名', key_ids: [key.id] })
  await assert.rejects(f.service.saveGroup(group.id, { key_ids: [] }), /已锁定/)
  await assert.rejects(f.service.deleteGroup(group.id), /已锁定/)
  await f.service.mutate(key.id, 'unlock', { admin_password: 'password' })
  f.store.saveManagedKey({ ...f.store.getManagedKey(key.id), deleting: true })
  await assert.rejects(f.service.mutate(key.id, 'group', { group_id: null }), /正在撤销删除/)
  await assert.rejects(f.service.saveGroup(group.id, { key_ids: [] }), /正在撤销删除/)
  await assert.rejects(f.service.deleteGroup(group.id), /正在撤销删除/)
})

test('group deployment targets selected children, preserves other bindings and is idempotent', async t => {
  const f = fixture(t)
  const one = await f.service.create({ key: secret }); const two = await f.service.create({})
  const secondSecret = (await f.service.reveal(two.id)).key
  const unrelated = await f.service.create({})
  const group = await f.service.saveGroup(null, { name: '批量下发', key_ids: [one.id, two.id] })
  await f.service.mutate(one.id, 'bind', { instances: ['two'] })
  const deployed = await f.service.deployGroup(group.id, { instances: ['one', 'one'] })
  assert.equal(deployed.results.length, 2)
  assert.ok(deployed.results.every(result => result.instance_id === 'one' && result.status === 'deployed' && result.key_id))
  assert.deepEqual(f.remote.get('two'), [])
  assert.ok(f.remote.get('one').includes('existing-key'))
  assert.ok(f.remote.get('one').includes(secret)); assert.ok(f.remote.get('one').includes(secondSecret))
  assert.equal(f.store.keyBindings(one.id).length, 2)
  assert.equal(f.store.keyBindings(unrelated.id).length, 0)
  assert.ok((await f.service.deployGroup(group.id, { instances: ['one'] })).results.every(result => result.status === 'exists'))
  assert.equal(f.writes.length, 2)
  assert.ok(!JSON.stringify(deployed).includes(secret))
})

test('group deployment reports partial failures for every key and instance, retaining bindings for retries', async t => {
  const f = fixture(t); const one = await f.service.create({ key: secret }); const two = await f.service.create({})
  const group = await f.service.saveGroup(null, { name: '部分失败', key_ids: [one.id, two.id] })
  f.failures.add('two')
  const deployed = await f.service.deployGroup(group.id, { instances: ['one', 'two'] })
  assert.equal(deployed.results.length, 4)
  assert.equal(deployed.results.filter(result => result.status === 'failed').length, 2)
  for (const key of [one, two]) assert.equal(f.store.keyBindings(key.id).find(binding => binding.instance_id === 'two').status, 'failed')
  assert.ok(!JSON.stringify(deployed).includes('remote-secret'))
  f.failures.clear()
  assert.ok((await f.service.deployGroup(group.id, { instances: ['one', 'two'] })).results.every(result => result.status !== 'failed'))
  assert.ok(!JSON.stringify(f.store.listRuntimeLogs()).includes(secret))
})

test('group deployment validates all members and instances before mutation and supports ungrouped', async t => {
  const f = fixture(t); const one = await f.service.create({}); const two = await f.service.create({})
  const group = await f.service.saveGroup(null, { name: '全量预检', key_ids: [one.id, two.id] })
  await f.service.mutate(two.id, 'lock')
  await assert.rejects(f.service.deployGroup(group.id, { instances: ['one'] }), /已锁定/)
  assert.equal(f.store.keyBindings(one.id).length, 0); assert.equal(f.writes.length, 0)
  await f.service.mutate(two.id, 'unlock', { admin_password: 'password' })
  await assert.rejects(f.service.deployGroup(group.id, { instances: ['one', 'missing'] }), /not found/)
  await assert.rejects(f.service.deployGroup(group.id, { instances: [] }), /请选择实例/)
  assert.equal(f.store.keyBindings(one.id).length, 0)
  await f.service.mutate(two.id, 'bind', { instances: ['one'] }); await f.service.mutate(two.id, 'lock')
  assert.ok((await f.service.deployGroup(group.id, { instances: ['one'] })).results.every(result => result.status === 'deployed'))
  f.store.saveManagedKey({ ...f.store.getManagedKey(one.id), deleting: true })
  await assert.rejects(f.service.deployGroup(group.id, { instances: ['one'] }), /正在撤销删除/)
  await assert.rejects(f.service.deployGroup('ungrouped', { instances: ['one'] }), /没有 Key/)
  const ungrouped = await f.service.create({})
  assert.deepEqual((await f.service.deployGroup('ungrouped', { instances: ['one'] })).results.map(result => result.key_id), [ungrouped.id])
})

test('changed remote lists and unsuccessful verification retain binding without claiming success', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret }); await f.service.mutate(key.id, 'bind', { instances: ['one'] })
  let reads = 0
  f.service.clients = async () => ({ readClientKeys: async () => ({ path: '/v8/management/config/access/api-keys', keys: ++reads === 1 ? ['existing-key'] : ['external-change'] }), writeClientKeys: async () => { assert.fail('Changed list must not be overwritten') } })
  assert.equal((await f.service.distribute(key.id)).results[0].status, 'failed')
  f.service.clients = async () => ({ readClientKeys: async () => ({ path: '/v8/management/config/access/api-keys', keys: ['existing-key'] }), writeClientKeys: async () => {} })
  assert.equal((await f.service.distribute(key.id)).results[0].status, 'failed')
  assert.equal(f.store.keyBindings(key.id).length, 1)
})

test('creation encrypts secrets, masks listings, rejects duplicates and persists metadata', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret, note: '测试' })
  assert.equal(key.note, '测试'); assert.equal(key.ciphertext, undefined)
  assert.ok(!JSON.stringify(f.service.list()).includes(secret)); assert.ok(!JSON.stringify(f.store.getManagedKey(key.id)).includes(secret))
  await assert.rejects(f.service.create({ key: secret }), /已存在/)
  assert.equal((await f.service.reveal(key.id)).key, secret)
  const generated = await f.service.create({}); assert.match((await f.service.reveal(generated.id)).key, /^sk-[A-Za-z0-9]{48}$/)
  await assert.rejects(f.service.create({ key: 'bad key with space' }))
})

test('bindings do not deploy; repeated deploy is idempotent and preserves existing keys', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret })
  await f.service.mutate(key.id, 'bind', { instances: ['one', 'two', 'one'] })
  assert.equal(f.service.list()[0].bindings.find(item => item.instance_id === 'one').instance_port, 18000)
  assert.equal(f.writes.length, 0)
  assert.throws(() => f.store.deleteManagedKey(key.id), /未撤销绑定/)
  assert.throws(() => f.store.assertNoKeyBindings('one'), /仍绑定/)
  assert.ok(new DeleteService({ store: f.store, instances: f.instances }).preview('one').id)
  const deployed = await f.service.distribute(key.id); assert.deepEqual(deployed.results.map(item => item.status), ['deployed', 'deployed'])
  assert.deepEqual(f.remote.get('one'), ['existing-key', secret])
  const repeated = await f.service.distribute(key.id); assert.ok(repeated.results.every(item => item.status === 'exists')); assert.equal(f.writes.length, 2)
})

test('key locks prohibit revoke/delete/bind/note but allow deployment; unlock validates password', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret })
  await f.service.mutate(key.id, 'bind', { instances: ['one'] }); await f.service.mutate(key.id, 'lock')
  assert.equal(f.store.getManagedKey(key.id).locked, true)
  for (const action of ['bind', 'note']) await assert.rejects(f.service.mutate(key.id, action, { instances: ['two'], note: 'new' }), /已锁定/)
  await assert.rejects(f.service.distribute(key.id, { revoke: true, remove: true }), /已锁定/)
  assert.equal((await f.service.distribute(key.id)).results[0].status, 'deployed')
  await assert.rejects(f.service.mutate(key.id, 'unlock', { admin_password: 'wrong' }))
  await f.service.mutate(key.id, 'unlock', { admin_password: 'password' }); assert.equal(f.store.getManagedKey(key.id).locked, false)
})

test('partial delete retains failed bindings, blocks redeployment, and can retry safely', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret })
  await f.service.mutate(key.id, 'bind', { instances: ['one', 'two'] }); await f.service.distribute(key.id)
  f.failures.add('two')
  const result = await f.service.distribute(key.id, { revoke: true, remove: true })
  assert.equal(result.deleted, false); assert.deepEqual(f.remote.get('one'), ['existing-key'])
  assert.equal(result.item.bindings.length, 1); assert.equal(result.item.bindings[0].instance_id, 'two')
  assert.ok(!JSON.stringify(result).includes('remote-secret'))
  await assert.rejects(f.service.distribute(key.id), /正在撤销删除/)
  await assert.rejects(f.service.mutate(key.id, 'bind', { instances: ['one'] }), /正在撤销删除/)
  f.failures.clear(); assert.equal((await f.service.distribute(key.id, { revoke: true, remove: true })).deleted, true)
  assert.throws(() => f.store.getManagedKey(key.id)); assert.equal(f.remote.get('two').length, 1)
  assert.match(f.remote.get('two')[0], /^sk-controller-guard-/); assert.ok(!f.remote.get('two').includes(secret))
})

test('single revoke preserves other bindings; stopped and locked children retain failed bindings', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret })
  await f.service.mutate(key.id, 'bind', { instances: ['one', 'two'] }); await f.service.distribute(key.id)
  await assert.rejects(f.service.distribute(key.id, { revoke: true, instanceId: '' }), /实例未绑定/)
  await f.service.distribute(key.id, { revoke: true, instanceId: 'one' }); assert.deepEqual(f.remote.get('two'), [secret])
  f.states.set('two', 'stopped'); assert.equal((await f.service.distribute(key.id, { revoke: true, remove: true })).deleted, false)
  f.states.set('two', 'running'); await f.instances.setLocked('two', true)
  assert.equal((await f.service.distribute(key.id, { revoke: true, remove: true })).deleted, false)
  await f.instances.setLocked('two', false); f.remote.set('two', [])
  const removed = await f.service.distribute(key.id, { revoke: true, remove: true })
  assert.equal(removed.deleted, true); assert.equal(removed.results[0].authentication_guard, true)
})

test('ambiguous writes retain binding until retry verifies remote state', async t => {
  const f = fixture(t); const key = await f.service.create({ key: secret }); await f.service.mutate(key.id, 'bind', { instances: ['one'] })
  const ordinary = f.service.clients
  f.service.clients = async instance => { const client = await ordinary(instance); return { ...client, writeClientKeys: async (...args) => { await client.writeClientKeys(...args); throw new Error(secret) } } }
  assert.equal((await f.service.distribute(key.id)).results[0].status, 'failed')
  assert.equal(f.store.keyBindings(key.id).length, 1)
  f.service.clients = ordinary; assert.equal((await f.service.distribute(key.id)).results[0].status, 'exists')
  assert.equal(f.writes.length, 1)
})

test('v8 and legacy CPA keys use correct paths; malformed/auth failures never fall back or write', async () => {
  for (const legacy of [false, true]) {
    const calls = []
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async (url, options) => { calls.push([url, options]); return legacy && url.includes('/v8/') ? Response.json({}, { status: 404 }) : Response.json(options.method === 'PUT' ? { status: 'ok' } : legacy ? { 'api-keys': [secret] } : [secret]) } })
    const current = await client.readClientKeys(); assert.deepEqual(current.keys, [secret]); await client.writeClientKeys(current.path, [secret, 'another'])
    assert.equal(calls.at(-1)[0].endsWith(legacy ? '/v0/management/api-keys' : '/v8/management/config/access/api-keys'), true)
    assert.deepEqual(JSON.parse(calls.at(-1)[1].body), [secret, 'another'])
  }
  for (const [payload, status] of [[{}, 200], [[], 401]]) {
    let count = 0; const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => { count++; return Response.json(payload, { status }) } })
    await assert.rejects(client.readClientKeys()); assert.equal(count, 1)
  }
  const emptyLegacy = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async url => url.includes('/v8/') ? Response.json({}, { status: 404 }) : Response.json({ 'api-keys': null }) })
  assert.deepEqual((await emptyLegacy.readClientKeys()).keys, [])
})

test('HTTP endpoints require login, respect origin checks and audit without plaintext', async t => {
  const f = fixture(t)
  const server = createHttpServer(new Controller({ keys: f.service, auth: f.auth, store: f.store, logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  assert.equal((await fetch(`${base}/keys`)).status, 401)
  const headers = { authorization: `Bearer ${f.auth.login('admin', 'password').token}`, 'content-type': 'application/json' }
  assert.equal((await fetch(`${base}/keys`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403)
  const create = await fetch(`${base}/keys`, { method: 'POST', headers, body: JSON.stringify({ key: secret, note: '测试' }) }); assert.equal(create.status, 201)
  const key = await create.json(); assert.equal(key.ciphertext, undefined)
  assert.ok(!(await (await fetch(`${base}/keys`, { headers })).text()).includes(secret))
  assert.equal((await fetch(`${base}/keys/${key.id}/unlock`, { method: 'POST', headers, body: '{"admin_password":"wrong"}' })).status, 401)
  assert.ok(f.store.listAuditLogs().some(item => item.action === 'key.create'))
  assert.ok(!JSON.stringify(f.store.listAuditLogs()).includes(secret))
})

test('group HTTP endpoints enforce authentication and origin, expose groups, deploy and audit safely', async t => {
  const f = fixture(t)
  const server = createHttpServer(new Controller({ keys: f.service, auth: f.auth, store: f.store, logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const headers = { authorization: `Bearer ${f.auth.login('admin', 'password').token}`, 'content-type': 'application/json' }
  const post = (route, body, overrides = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) })
  assert.equal((await fetch(`${base}/key-groups`)).status, 401)
  assert.equal((await fetch(`${base}/key-groups`, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await post('/key-groups', { name: '组' }, { origin: 'https://untrusted.invalid' })).status, 403)
  const key = await f.service.create({ key: secret })
  const created = await post('/key-groups', { name: '接口组', key_ids: [key.id] })
  assert.equal(created.status, 201)
  const group = await created.json()
  const listing = await (await fetch(`${base}/keys`, { headers })).json()
  assert.equal(listing.items[0].group_id, group.id)
  assert.equal(listing.groups.find(item => item.id === group.id).key_count, 1)
  assert.equal((await post(`/key-groups/${group.id}/deploy`, { instances: ['one'] }, { authorization: '' })).status, 401)
  const deployed = await (await post(`/key-groups/${group.id}/deploy`, { instances: ['one'] })).json()
  assert.equal(deployed.results[0].key_id, key.id); assert.equal(deployed.results[0].status, 'deployed')
  assert.equal((await post(`/key-groups/${group.id}/update`, { name: '新名称', key_ids: [key.id] })).status, 200)
  assert.equal((await post(`/keys/${key.id}/group`, { group_id: null })).status, 200)
  assert.equal((await post(`/key-groups/${group.id}/delete`, {})).status, 200)
  assert.equal(f.store.keyBindings(key.id).length, 1)
  assert.ok((await (await fetch(`${base}/key-groups`, { headers })).json()).items.some(item => item.id === 'ungrouped'))
  const logs = f.store.listAuditLogs()
  for (const action of ['key.group.create', 'key.group.update', 'key.group.deploy', 'key.group.delete']) assert.ok(logs.some(item => item.action === action))
  assert.ok(!JSON.stringify({ logs, deployed, listing }).includes(secret))
})
