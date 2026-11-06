import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Store } from './store.js'
import { AuthService, InstanceService, QuotaService } from './services.js'
import { HTTPClient } from './cpa.js'
import { SubscriptionSync } from './subscription-sync.js'
import { Controller, createHttpServer } from './http.js'

const binary = process.env.CPA_SYNC_TEST_BINARY, library = process.env.CPA_SYNC_TEST_LIBRARY
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'); child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(timer) }
}
async function eventually(fn) {
  let error
  for (let index = 0; index < 100; index++) {
    try { return await fn() } catch (cause) { error = cause; await pause(100) }
  }
  throw error
}

test('quota refresh automatically resets and aligns every bound key through a real CPA and the unmodified original plugin', { skip: !binary || !library, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-subscription-e2e-'))
  const store = new Store(':memory:')
  let child, server, upstream
  try {
    upstream = http.createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'dummy-sync', object: 'chat.completion', created: 1, model: 'sync-test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
      })
    })
    const upstreamPort = await listen(upstream)
    const reserved = http.createServer(); const port = await listen(reserved); await new Promise(resolve => reserved.close(resolve))
    fs.mkdirSync(path.join(root, 'plugins')); fs.mkdirSync(path.join(root, 'auth'))
    fs.copyFileSync(library, path.join(root, 'plugins', 'cpa-key-billing.so'))
    const keys = ['sk-sync-integration-one', 'sk-sync-integration-two']
    const config = [
      'host: "127.0.0.1"', `port: ${port}`, `auth-dir: ${JSON.stringify(path.join(root, 'auth'))}`,
      `api-keys: ${JSON.stringify(keys)}`, 'remote-management:', '  allow-remote: false', '  secret-key: "dummy-sync-management"', '  disable-control-panel: true',
      'plugins:', '  enabled: true', `  dir: ${JSON.stringify(path.join(root, 'plugins'))}`, '  configs:', '    cpa-key-billing:', '      enabled: true', `      state_file: ${JSON.stringify(path.join(root, 'state.db'))}`,
      'openai-compatibility:', '  - name: dummy-sync', `    base-url: "http://127.0.0.1:${upstreamPort}/v1"`, '    api-key-entries:', '      - api-key: dummy-upstream', '    models:', '      - name: sync-test-model'
    ].join('\n')
    const configFile = path.join(root, 'config.yaml'); fs.writeFileSync(configFile, config, { mode: 0o600 })
    const client = new HTTPClient({ baseUrl: `http://127.0.0.1:${port}`, managementSecret: 'dummy-sync-management', timeoutMs: 3000, maxRetries: 0 })
    const start = async () => {
      child = spawn(binary, ['-config', configFile, '-local-model'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] })
      let spawnError; child.on('error', error => { spawnError = error })
      await eventually(async () => {
        if (spawnError) throw spawnError
        const response = await client.singleRequest('GET', '/v0/management/plugins')
        assert.equal(response.status, 200)
        const plugin = JSON.parse(response.body).plugins.find(item => item.id === 'cpa-key-billing')
        assert.equal(plugin?.metadata?.version, '1.4.17'); assert.equal(plugin?.effective_enabled, true)
      })
    }
    await start()
    const pluginCall = async (method, suffix, body) => {
      const response = await client.singleRequest(method, `/v0/management/plugins/cpa-key-billing${suffix}`, undefined, body)
      assert.ok(response.status >= 200 && response.status < 300, `${method} ${suffix}: ${response.status} ${response.body}`)
      return JSON.parse(response.body)
    }
    await pluginCall('POST', '/keys/sync', { keys })
    const rows = (await pluginCall('GET', '/keys')).keys
    assert.equal(rows.length, 2)
    const originalAnchor = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 3600000).toISOString()
    for (const [index, row] of rows.entries()) await pluginCall('POST', '/plans', { name: `Plan ${index}`, windows: [{ name: 'week', period_seconds: 604800, request_limit: 10, cycle_anchor_at: originalAnchor }, { name: 'month', period_seconds: 2592000, request_limit: 20, cycle_anchor_at: originalAnchor }], scopes: [row.scope] })
    await pluginCall('PUT', '/prices', { model_id: 'sync-test-model', currency: 'USD', input_per_1m: 1, output_per_1m: 1 })
    const consume = async key => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sync-test-model', messages: [{ role: 'user', content: 'test' }], stream: false }) })
      assert.equal(response.status, 200, await response.text())
    }
    for (const key of keys) await consume(key)
    const requestCount = row => row.windows[0].dimensions.find(item => item.metric === 'requests')?.used
    await eventually(async () => { const current = (await pluginCall('GET', '/keys')).keys; assert.ok(current.every(row => String(requestCount(row)) === '1')) })
    const baseTime = Math.floor(Date.now() / 1000) * 1000
    const due = baseTime + 60000, target = new Date(baseTime + 30 * 60000).toISOString()
    let now = baseTime, refreshes = 0, rolledOver = false, tooFar = false
    const clock = () => new Date(now)
    const at = new Date().toISOString()
    store.createInstance({ id: 'sync-test', name: 'sync test', port, directory: root, management_secret_ciphertext: 'unused', desired_state: 'running', revision: 1, version: 'test', created_at: at, updated_at: at })
    // Use the actual controller mutexes: the quota callback must release them
    // before the plugin update reacquires the same instance/global locks.
    const instances = new InstanceService({ store, root, runtime: { status: async () => ({ state: 'running' }) }, requireVersion: false })
    const quota = new QuotaService({ store, instances, clock, clients: async () => ({
      listAccounts: async () => { refreshes++; return [{ id: 'a' }, { id: 'b' }] },
      fetchQuota: async account => ({ values: [{ name: account.id === 'a' ? '周限额' : '月限额', reset_at: tooFar ? new Date(baseTime + 20 * 86400000).toISOString() : account.id === 'a' ? new Date(baseTime + 2 * 3600000).toISOString() : rolledOver ? target : new Date(due).toISOString() }] })
    }) })
    const sync = new SubscriptionSync({ store, quota, instances, clients: async () => client, clock })
    quota.subscriptionSync = sync
    const auth = new AuthService(store); auth.initializeAdmin('dummy-sync-admin')
    server = createHttpServer(new Controller({ store, auth, subscriptionSync: sync, logger: { error() {} } }))
    const controlPort = await listen(server), route = `http://127.0.0.1:${controlPort}/api/instances/sync-test/subscription-sync`
    const login = await fetch(`http://127.0.0.1:${controlPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'dummy-sync-admin' }) })
    assert.equal(login.status, 200)
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
    assert.equal((await (await fetch(route, { headers })).json()).available, true)
    assert.equal(refreshes, 0)
    assert.equal((await fetch(route, { method: 'POST', headers, body: '{}' })).status, 405)
    await quota.refreshDue()
    assert.equal(sync.get('sync-test').last_sync, undefined)
    assert.equal(sync.get('sync-test').watch.reset_at, new Date(due).toISOString())
    assert.equal(refreshes, 1)
    now = due + 1000; rolledOver = true
    await quota.refreshDue()
    assert.equal(sync.get('sync-test').last_sync.next_reset_at, target)
    assert.equal(sync.get('sync-test').last_sync.reset_at, new Date(due).toISOString())
    assert.equal(refreshes, 2)
    const assertAligned = async () => {
      const current = (await pluginCall('GET', '/keys')).keys
      for (const row of current) for (const window of row.windows) {
        assert.equal(Date.parse(window.end_at), Date.parse(target))
        assert.equal(Date.parse(window.start_at), Date.parse(target) - window.period_seconds * 1000)
        assert.equal(Date.parse(window.cycle_anchor_at), Date.parse(target))
        assert.equal(String(window.dimensions.find(item => item.metric === 'requests').used), '0')
      }
    }
    const plans = (await pluginCall('GET', '/plans')).plans
    assert.equal(plans.length, 2)
    assert.ok(plans.every(plan => plan.shared_quota === false && plan.windows.every(window => Date.parse(window.cycle_anchor_at) === Date.parse(target))))
    await assertAligned(); await stop(child); await start(); await assertAligned()
    await consume(keys[0])
    await eventually(async () => { const current = (await pluginCall('GET', '/keys')).keys; assert.ok(current.some(row => String(requestCount(row)) === '1')) })
    await fetch(route, { headers })
    assert.ok((await pluginCall('GET', '/keys')).keys.some(row => String(requestCount(row)) === '1'))
    // Repeated live reads and controller restart do not replay this round.
    await quota.refreshInstance('sync-test')
    assert.ok((await pluginCall('GET', '/keys')).keys.some(row => String(requestCount(row)) === '1'))
    const restarted = new SubscriptionSync({ store, quota, instances, clients: async () => client, clock })
    quota.subscriptionSync = restarted
    await quota.refreshInstance('sync-test')
    assert.ok((await pluginCall('GET', '/keys')).keys.some(row => String(requestCount(row)) === '1'))
    // The next reset is observed, but a target beyond a 7-day window is rejected before any write.
    now = Date.parse(target) + 1000; tooFar = true
    await quota.refreshDue()
    assert.equal(restarted.get('sync-test').pending, undefined)
    assert.match(restarted.get('sync-test').message, /超出/)
    assert.ok((await pluginCall('GET', '/keys')).keys.some(row => String(requestCount(row)) === '1'))
    assert.ok(store.listAuditLogs().some(item => item.action === 'subscription-sync.auto' && item.outcome === 'success'))

  } finally {
    await stop(child)
    if (server) await new Promise(resolve => server.close(resolve))
    if (upstream) await new Promise(resolve => upstream.close(resolve))
    store.close(); fs.rmSync(root, { recursive: true, force: true })
  }
})
