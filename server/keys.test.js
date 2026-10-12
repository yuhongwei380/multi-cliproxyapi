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

test('encrypted keys, locks, delete intent and failed bindings survive reopening the database', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-keys-'))
  const f = fixture(t, path.join(root, 'control.db')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const key = await f.service.create({ key: secret, note: '持久备注' })
  await f.service.mutate(key.id, 'bind', { instances: ['one'] }); f.failures.add('one')
  await f.service.distribute(key.id, { revoke: true, remove: true }); await f.service.mutate(key.id, 'lock')
  const reopened = new Store(path.join(root, 'control.db'))
  try {
    const service = new KeyService({ ...f, store: reopened, clients: f.clients })
    const saved = service.list()[0]
    assert.equal(saved.note, '持久备注'); assert.equal(saved.locked, true); assert.equal(saved.deleting, true)
    assert.equal(saved.bindings[0].status, 'revoke-failed'); assert.equal((await service.reveal(key.id)).key, secret)
  } finally { reopened.close() }
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
  assert.equal(f.writes.length, 0)
  assert.throws(() => f.store.deleteManagedKey(key.id), /未撤销绑定/)
  assert.throws(() => f.store.assertNoKeyBindings('one'), /仍绑定/)
  assert.throws(() => new DeleteService({ store: f.store, instances: f.instances }).preview('one'), /仍绑定/)
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
