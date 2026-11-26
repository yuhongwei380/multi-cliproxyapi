import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from './store.js'
import { SubscriptionSync, quotaResetCandidates, PLANS_PATH, RESET_PATH, AUTO_WINDOW_MS } from './subscription-sync.js'

const H = 3600000
const at = ms => new Date(ms).toISOString()
function fixture() {
  const store = new Store(':memory:')
  const now0 = Date.parse('2026-11-06T00:00:00Z'); let now = now0
  store.createInstance({ id: 'cpa-a', name: 'a', port: 18001, directory: '/tmp/a', management_secret_ciphertext: 'encrypted', desired_state: 'running', version: '', revision: 1, created_at: at(now), updated_at: at(now) })
  const accounts = [
    { account_id: 'a', provider: 'codex', status: 'ok', values: [{ name: '周限额', reset_at: at(now0 + 4 * H) }] },
    { account_id: 'b', provider: 'claude', status: 'ok', values: [{ name: '周限额', reset_at: at(now0 + 2 * H) }, { name: '月限额', reset_at: at(now0 + H) }] }
  ]
  const plans = [0, 1].map(index => ({ id: `plan-${index}`, name: `Plan ${index}`, currency: 'USD', shared_quota: false, windows: [
    { id: 'week', name: 'weekly', period_seconds: 604800, request_limit: 10, cycle_anchor_at: at(now0 + 5 * H) },
    { id: 'month', name: 'monthly', period_seconds: 2592000, amount: 20, token_limit: 100, cycle_anchor_at: at(now0 + 6 * H) }
  ] }))
  const writes = [], reads = []
  const client = { singleRequest: async (method, path, _signal, body) => {
    if (method === 'GET') { assert.equal(path, PLANS_PATH); reads.push(path); return { status: 200, body: JSON.stringify({ plans }) } }
    writes.push({ method, path, body })
    if (method === 'PATCH') {
      assert.equal(path, PLANS_PATH)
      const plan = plans.find(plan => plan.id === body.id); plan.windows = structuredClone(body.windows)
      return { status: 200, body: JSON.stringify({ plan }) }
    }
    assert.equal(method, 'POST'); assert.equal(path, RESET_PATH); assert.deepEqual(body, { mode: 'global' })
    return { status: 200, body: JSON.stringify({ keys: 0, windows: 0, pools: 0 }) }
  } }
  const instances = { operations: { run: async (_key, fn) => fn() }, withInstanceLock: async (_id, fn) => fn(), assertUnlocked: instance => { if (instance.locked) throw new Error('locked') }, assertUpgradeIdle() {} }
  const quota = { intervalMs: () => 6 * H }
  const sync = new SubscriptionSync({ store, instances, quota, clients: async () => client, clock: () => new Date(now) })
  let previous = []
  const observe = () => { const snapshots = structuredClone(accounts), old = previous; previous = snapshots; return sync.observe('cpa-a', snapshots, { previous: old }) }
  return { sync, store, quota, instances, client, accounts, plans, writes, reads, now0, observe, setNow: value => { now = value } }
}

async function roll(f, delay = 1000) {
  await f.observe()
  f.setNow(f.now0 + H + delay)
  f.accounts[1].values[1].reset_at = at(f.now0 + 30 * 24 * H)
  await f.observe()
}

test('automatic sync waits for the earliest reset then updates all original unified plans before one global reset', async () => {
  const f = fixture(); try {
    const before = structuredClone(f.plans)
    await f.observe(); assert.equal(f.writes.length, 0)
    assert.equal(f.sync.get('cpa-a').watch.reset_at, at(f.now0 + H))
    await roll(f)
    const result = f.sync.get('cpa-a')
    assert.deepEqual(f.writes.map(item => [item.method, item.path]), [['PATCH', PLANS_PATH], ['PATCH', PLANS_PATH], ['POST', RESET_PATH]])
    assert.equal(result.last_sync.next_reset_at, at(f.now0 + 2 * H)); assert.equal(result.last_sync.reset_at, at(f.now0 + H))
    assert.equal(result.last_sync.plans, 2); assert.equal(result.last_sync.windows, 4)
    assert.equal(result.watch.reset_at, at(f.now0 + 2 * H)); assert.equal(result.pending, undefined)
    for (const [index, plan] of f.plans.entries()) for (const window of plan.windows) {
      const old = before[index].windows.find(item => item.id === window.id)
      assert.equal(window.cycle_anchor_at, at(f.now0 + 2 * H)); assert.equal(plan.shared_quota, false)
      for (const field of ['period_seconds', 'amount', 'token_limit', 'request_limit']) assert.equal(window[field], old[field] ?? 0)
    }
    assert.equal(f.sync.trigger, undefined)
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'subscription-sync.auto' && item.actor === 'system'))
  } finally { f.store.close() }
})

test('status reads never reset quotas or reactivate legacy manual/automatic settings', async () => {
  const f = fixture(); try {
    f.sync.save('cpa-a', { enabled: true, windows: { week: { reset_at: at(f.now0) } } })
    const state = await f.sync.inspect('cpa-a')
    assert.equal(state.available, true); assert.equal(state.enabled, undefined); assert.equal(state.windows, undefined)
    assert.equal(f.writes.length, 0); assert.equal(state.watch, undefined)
  } finally { f.store.close() }
})

test('a first observation of a new future date does not infer that an official reset just happened', async () => {
  const f = fixture(); try {
    f.setNow(f.now0 + H + 1000); f.accounts[1].values[1].reset_at = at(f.now0 + 30 * 24 * H)
    await f.observe(); assert.equal(f.writes.length, 0)
    assert.equal(f.sync.get('cpa-a').watch.reset_at, at(f.now0 + 2 * H))
  } finally { f.store.close() }
})

test('upstream quota recovery before its due date resets subscriptions once, including a non-earliest account', async () => {
  for (const [index, window, moved] of [[0, 0, false], [0, 0, true], [1, 1, false], [1, 1, true]]) {
    const f = fixture(); try {
      const value = f.accounts[index].values[window]
      Object.assign(value, { remaining: 10, total: 100, unit: '%' })
      await f.observe(); f.setNow(f.now0 + 60000)
      value.remaining = 95
      if (moved) value.reset_at = at(f.now0 + 7 * 24 * H)
      await f.observe()
      assert.equal(f.writes.length, 3)
      assert.equal(f.sync.get('cpa-a').last_sync.reset_at, at(f.now0 + 60000))
      assert.equal(f.sync.get('cpa-a').last_sync.next_reset_at, at(f.now0 + (index === 1 && moved ? 2 : 1) * H))
      assert.equal(f.sync.get('cpa-a').upstream_reset, undefined)
      await f.observe(); assert.equal(f.writes.length, 3)
      const restarted = new SubscriptionSync({ store: f.store, quota: f.quota, instances: f.instances, clients: async () => f.client, clock: () => new Date(f.now0 + 120000) })
      await restarted.observe('cpa-a', structuredClone(f.accounts), { previous: structuredClone(f.accounts) })
      assert.equal(f.writes.length, 3)
    } finally { f.store.close() }
  }
})

test('date drift, changed limits, failed accounts and short windows do not imply an early reset', async () => {
  for (const alter of [
    value => { value.remaining = 10 }, value => { value.remaining = 5 },
    value => { value.total = 200 }, value => { value.unit = 'tokens' },
    value => { value.reset_at = 'invalid' }, value => { value.reset_at = '2026-11-06T03:00:00Z' },
    (value, account) => { account.account_id = 'replacement' },
    (value, account) => { account.provider = 'replacement' },
    (value, account) => { account.status = 'failed' },
    value => { value.name = '5 小时限额' }, value => { value.remaining = 101 },
  ]) {
    const f = fixture(); try {
      Object.assign(f.accounts[0].values[0], { remaining: 10, total: 100, unit: '%' })
      await f.observe(); f.setNow(f.now0 + 60000)
      f.accounts[0].values[0].remaining = 100
      alter(f.accounts[0].values[0], f.accounts[0])
      await f.observe(); assert.equal(f.writes.length, 0)
    } finally { f.store.close() }
  }
})

test('late natural recovery cannot bypass the original 15 minute deadline', async () => {
  const f = fixture(); try {
    Object.assign(f.accounts[1].values[1], { remaining: 10, total: 100, unit: '%' })
    await f.observe(); f.setNow(f.now0 + H + AUTO_WINDOW_MS + 1)
    Object.assign(f.accounts[1].values[1], { remaining: 100, reset_at: at(f.now0 + 30 * 24 * H) })
    await f.observe(); assert.equal(f.writes.length, 0)
    assert.equal(f.sync.get('cpa-a').last_missed_reset_at, at(f.now0 + H))
  } finally { f.store.close() }
})

test('rolling quota recovery does not reset subscriptions', async () => {
  const f = fixture(); try {
    f.accounts[0].provider = 'kimi'
    Object.assign(f.accounts[0].values[0], { remaining: 10, total: 100, unit: '%' })
    await f.observe(); f.setNow(f.now0 + 60000)
    Object.assign(f.accounts[0].values[0], { remaining: 100, reset_at: at(f.now0 + 7 * 24 * H) })
    await f.observe(); assert.equal(f.writes.length, 0)
  } finally { f.store.close() }
})

test('an early reset is discarded if its source changes before a retry', async () => {
  for (const change of [
    f => { f.accounts[0].provider = 'claude' },
    f => { f.accounts[0].values[0].reset_at = at(f.now0 + 4 * H) },
  ]) {
    const f = fixture(); try {
      Object.assign(f.accounts[0].values[0], { remaining: 10, total: 100, unit: '%' })
      await f.observe(); f.setNow(f.now0 + 60000)
      Object.assign(f.accounts[0].values[0], { remaining: 100, reset_at: at(f.now0 + 7 * 24 * H) })
      f.instances.assertUnlocked = () => { throw new Error('locked') }
      await f.observe()
      f.instances.assertUnlocked = () => {}; change(f)
      await f.observe(); assert.equal(f.writes.length, 0)
      assert.equal(f.sync.get('cpa-a').upstream_reset, undefined)
    } finally { f.store.close() }
  }
})

test('an early reset survives preflight failure and restart, with polling bounded by detection plus 15 minutes', async () => {
  for (const delay of [120000, AUTO_WINDOW_MS + 1]) {
    const f = fixture(); try {
      Object.assign(f.accounts[0].values[0], { remaining: 10, total: 100, unit: '%' })
      await f.observe(); f.setNow(f.now0 + 60000)
      f.accounts[0].values[0].remaining = 100
      f.instances.assertUnlocked = () => { throw new Error('locked') }
      await f.observe(); assert.equal(f.writes.length, 0)
      assert.equal(f.sync.get('cpa-a').upstream_reset.reset_at, at(f.now0 + 60000))
      assert.equal(f.sync.nextRefreshAt('cpa-a'), f.now0 + 120000)
      f.instances.assertUnlocked = () => {}
      const restarted = new SubscriptionSync({ store: f.store, quota: f.quota, instances: f.instances, clients: async () => f.client, clock: () => new Date(f.now0 + 60000 + delay) })
      await restarted.observe('cpa-a', structuredClone(f.accounts), { previous: structuredClone(f.accounts) })
      assert.equal(f.writes.length, delay <= AUTO_WINDOW_MS ? 3 : 0)
      assert.equal(restarted.get('cpa-a').upstream_reset, undefined)
    } finally { f.store.close() }
  }
})

test('an early reset waits for all accounts and never retries an uncertain write', async () => {
  const f = fixture(); try {
    Object.assign(f.accounts[0].values[0], { remaining: 10, total: 100, unit: '%' })
    await f.observe(); f.setNow(f.now0 + 60000)
    f.accounts[0].values[0].remaining = 100; f.accounts[1].status = 'failed'
    await f.observe(); assert.equal(f.writes.length, 0)
    f.accounts[1].status = 'ok'
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => { const result = await request(...args); if (args[0] === 'PATCH') throw new Error('lost response'); return result }
    await f.observe(); assert.equal(f.writes.length, 1)
    await f.observe(); assert.equal(f.writes.length, 1)
    assert.equal(f.sync.get('cpa-a').pending.status, 'in_flight')
  } finally { f.store.close() }
})

test('exactly 15 minutes after reset is allowed, but later observations only rearm the next date', async () => {
  for (const delay of [15 * 60000, 15 * 60000 + 1, 20 * 60000]) {
    const f = fixture(); try {
      await roll(f, delay)
      assert.equal(f.writes.length, delay === 15 * 60000 ? 3 : 0)
      if (delay > 15 * 60000) assert.equal(f.sync.get('cpa-a').last_missed_reset_at, at(f.now0 + H))
    } finally { f.store.close() }
  }
})

test('stale official dates wait within the window and failed accounts cannot cause a reset', async () => {
  const f = fixture(); try {
    await f.observe(); f.setNow(f.now0 + H + 1000)
    await f.observe(); assert.equal(f.writes.length, 0)
    assert.equal(f.sync.get('cpa-a').watch.reset_at, at(f.now0 + H))
    f.accounts[1].values[1].reset_at = at(f.now0 + 30 * 24 * H); f.accounts[0].status = 'failed'
    await f.observe(); assert.equal(f.writes.length, 0)
    f.accounts[0].status = 'ok'; await f.observe(); assert.equal(f.writes.length, 3)
    assert.throws(() => quotaResetCandidates([{ account_id: 'a', status: 'ok', values: [{ name: '月限额' }] }], 0), /缺少有效重置时间/)
  } finally { f.store.close() }
})

test('removed source accounts or renamed source windows cannot trigger an unrelated reset', async () => {
  for (const remove of [f => f.accounts.pop(), f => { f.accounts[1].values[1].name = '其他月限额' }]) {
    const f = fixture(); try {
      await f.observe(); f.setNow(f.now0 + H + 1000); f.accounts[1].values[1].reset_at = at(f.now0 + 30 * 24 * H); remove(f)
      await f.observe(); assert.equal(f.writes.length, 0)
      assert.notEqual(f.sync.get('cpa-a').watch.reset_at, at(f.now0 + H))
    } finally { f.store.close() }
  }
})

test('repeated quota queries and a controller restart do not repeat a handled reset', async () => {
  const f = fixture(); try {
    await roll(f); await f.observe(); assert.equal(f.writes.length, 3)
    const restarted = new SubscriptionSync({ store: f.store, quota: f.quota, instances: f.instances, clients: async () => f.client, clock: () => new Date(f.now0 + H + 2000) })
    await restarted.observe('cpa-a', structuredClone(f.accounts)); assert.equal(f.writes.length, 3)
    // Crash between durable mutation marker and the first remote write must also suppress replay.
    const state = restarted.get('cpa-a'); state.watch = { account_id: 'b', window_name: '月限额', reset_at: at(f.now0 + H) }; state.pending = { status: 'in_flight', reset_at: at(f.now0 + H) }; restarted.save('cpa-a', state)
    await restarted.observe('cpa-a', structuredClone(f.accounts)); assert.equal(f.writes.length, 3)
  } finally { f.store.close() }
})

test('the next distinct natural reset can execute again after a successful previous round', async () => {
  const f = fixture(); try {
    await roll(f); f.setNow(f.now0 + 2 * H + 1000)
    f.accounts[1].values[0].reset_at = at(f.now0 + 7 * 24 * H)
    await f.observe(); assert.equal(f.writes.length, 6)
    assert.equal(f.sync.get('cpa-a').last_sync.next_reset_at, at(f.now0 + 4 * H))
  } finally { f.store.close() }
})

test('unsupported or malformed original plan APIs never receive mutations', async () => {
  for (const response of [{ status: 404, body: '' }, { status: 200, body: '{}' }, { status: 200, body: '{"plans":[]}' }, { status: 200, body: '{"plans":[{}]}' }]) {
    const f = fixture(); try {
      f.client.singleRequest = async method => { assert.equal(method, 'GET'); return response }
      assert.equal((await f.sync.inspect('cpa-a')).available, false)
      await roll(f); assert.equal(f.sync.get('cpa-a').pending, undefined)
    } finally { f.store.close() }
  }
})

test('all plans are preflighted before edits, including unsupported modes and unknown window fields', async () => {
  for (const alter of [
    plan => { plan.shared_quota = true }, plan => { delete plan.windows[0].cycle_anchor_at },
    plan => { plan.windows[0].period_seconds = 60 }, plan => { plan.windows[0].new_quota_dimension = 5 },
    plan => { plan.windows[0].amount = -1 }, plan => { plan.windows[0].cycle_anchor_at = 'invalid' }
  ]) {
    const f = fixture(); try {
      alter(f.plans[1]); await roll(f)
      assert.equal(f.writes.length, 0); assert.equal(f.sync.get('cpa-a').pending, undefined)
    } finally { f.store.close() }
  }
})

test('a lost PATCH response records uncertain progress and stops this round without retrying', async () => {
  const f = fixture(); try {
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => { const result = await request(...args); if (args[0] === 'PATCH') throw new Error('lost response'); return result }
    await roll(f); assert.equal(f.writes.length, 1); assert.equal(f.sync.get('cpa-a').pending.phase, 'plans')
    await f.observe(); await f.sync.inspect('cpa-a'); assert.equal(f.writes.length, 1)
    assert.equal(f.sync.get('cpa-a').last_sync, undefined)
    assert.ok(f.store.listAuditLogs().some(item => item.action === 'subscription-sync.auto' && item.outcome === 'failure'))
  } finally { f.store.close() }
})

test('later plan failure preserves partial progress and never advances to global reset', async () => {
  const f = fixture(); try {
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => args[0] === 'PATCH' && args[3].id === 'plan-1' ? { status: 400, body: '{}' } : request(...args)
    await roll(f)
    const state = f.sync.get('cpa-a'); assert.equal(state.pending.updated_plans, 1); assert.equal(state.last_sync, undefined)
    assert.equal(f.writes.filter(item => item.method === 'POST').length, 0)
  } finally { f.store.close() }
})

test('malformed write responses and lost global reset responses remain uncertain without replay', async () => {
  for (const fail of ['plan', 'reset', 'lost-reset']) {
    const f = fixture(); try {
      const request = f.client.singleRequest
      f.client.singleRequest = async (...args) => {
        const response = await request(...args)
        if (fail === 'plan' && args[0] === 'PATCH') return { status: 200, body: '{}' }
        if (args[0] === 'POST') {
          if (fail === 'lost-reset') throw new Error('lost reset response')
          if (fail === 'reset') return { status: 200, body: '{"keys":-1,"windows":0,"pools":0}' }
        }
        return response
      }
      await roll(f); const count = f.writes.length
      await f.observe(); await f.sync.inspect('cpa-a')
      assert.equal(f.writes.length, count); assert.equal(f.sync.get('cpa-a').last_sync, undefined)
    } finally { f.store.close() }
  }
})

test('native equivalent anchors are accepted and still followed by global reset', async () => {
  const f = fixture(); try {
    for (const plan of f.plans) for (const window of plan.windows) window.cycle_anchor_at = at(f.now0 + 2 * H - window.period_seconds * 1000)
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => {
      if (args[0] === 'PATCH') { f.writes.push({ method: 'PATCH' }); return { status: 200, body: JSON.stringify({ plan: f.plans.find(plan => plan.id === args[3].id) }) } }
      return request(...args)
    }
    await roll(f); assert.equal(f.writes.at(-1).method, 'POST')
  } finally { f.store.close() }
})

test('external plan changes stop before global reset', async () => {
  const f = fixture(); try {
    const request = f.client.singleRequest; let reads = 0
    f.client.singleRequest = async (...args) => {
      if (args[0] === 'GET' && ++reads === 2) f.plans[0].windows[0].request_limit++
      return request(...args)
    }
    await roll(f); assert.equal(f.writes.filter(item => item.method === 'POST').length, 0)
    assert.equal(f.sync.get('cpa-a').pending.status, 'in_flight')
  } finally { f.store.close() }
})

test('overlapping quota callbacks cannot duplicate writes', async () => {
  const f = fixture(); let release
  try {
    await f.observe(); f.setNow(f.now0 + H + 1000); f.accounts[1].values[1].reset_at = at(f.now0 + 30 * 24 * H)
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => {
      if (args[0] === 'GET' && !release) await new Promise(resolve => { release = resolve })
      return request(...args)
    }
    const first = f.observe(); await new Promise(resolve => setImmediate(resolve)); await f.observe(); release(); await first
    assert.equal(f.writes.filter(item => item.method === 'POST').length, 1)
  } finally { f.store.close() }
})

test('locked, stopped, upgrading and deploying instances cannot be reset; safe preflight failures can recover within 15 minutes', async () => {
  for (const alter of [
    f => { f.instances.assertUnlocked = () => { throw new Error('locked') } },
    f => { f.instances.runtime = { status: async () => ({ state: 'stopped' }) } },
    f => { f.instances.assertUpgradeIdle = () => { throw new Error('upgrading') } },
    f => { f.instances.pluginService = { assertIdle() { throw new Error('deploying') } } }
  ]) {
    const f = fixture(); try { alter(f); await roll(f); assert.equal(f.writes.length, 0); assert.equal(f.sync.get('cpa-a').pending, undefined) } finally { f.store.close() }
  }
  const f = fixture(); try {
    f.instances.assertUnlocked = () => { throw new Error('locked') }; await roll(f)
    f.instances.assertUnlocked = () => {}; await f.observe(); assert.equal(f.writes.length, 3)
  } finally { f.store.close() }
})

test('deadline expiry while queued for a lock never starts edits', async () => {
  const f = fixture(); try {
    f.instances.withInstanceLock = async (_id, fn) => { f.setNow(f.now0 + H + AUTO_WINDOW_MS + 1); return fn() }
    await roll(f); assert.equal(f.writes.length, 0); assert.equal(f.sync.get('cpa-a').pending, undefined)
  } finally { f.store.close() }
})

test('deadline expiration between plan updates stops without global reset', async () => {
  const f = fixture(); try {
    const request = f.client.singleRequest
    f.client.singleRequest = async (...args) => { const response = await request(...args); if (args[0] === 'PATCH') f.setNow(f.now0 + H + AUTO_WINDOW_MS + 1); return response }
    await roll(f); assert.equal(f.writes.length, 1); assert.equal(f.sync.get('cpa-a').pending.updated_plans, 1)
  } finally { f.store.close() }
})

test('weekly subwindows select the earliest event and native anchors use second precision', async () => {
  const fresh = quotaResetCandidates([{ account_id: 'a', status: 'ok', values: [
    { name: '周限额', reset_at: at(2000) }, { name: 'Opus 周限额', reset_at: at(1000) }, { name: '5 小时限额', reset_at: at(500) }
  ] }], 0)
  assert.equal(fresh.week[0].reset_at, at(1000)); assert.equal(fresh.week[0].window_name, 'Opus 周限额')
  const f = fixture(); try { f.accounts[1].values[0].reset_at = at(f.now0 + 2 * H + 123); await roll(f); assert.equal(f.sync.get('cpa-a').last_sync.next_reset_at, at(f.now0 + 2 * H)) } finally { f.store.close() }
})

test('scheduler brings forward the next live quota query and polls stale rollover data once per minute', async () => {
  const f = fixture(); try {
    assert.equal(f.sync.nextRefreshAt('cpa-a'), f.now0)
    await f.observe(); assert.equal(f.sync.nextRefreshAt('cpa-a'), f.now0 + H)
    f.setNow(f.now0 + H + 1000); await f.observe()
    assert.equal(f.sync.nextRefreshAt('cpa-a'), f.now0 + H + 61000)
  } finally { f.store.close() }
})

test('confirmed records finish locally after restart without replay', async () => {
  const f = fixture(); try {
    f.sync.save('cpa-a', { pending: { status: 'confirmed', started_at: at(f.now0), result: { plans: 2, windows: 4, next_reset_at: at(f.now0 + H) } } })
    const state = await f.sync.inspect('cpa-a')
    assert.equal(state.pending, undefined); assert.equal(state.last_sync.next_reset_at, at(f.now0 + H)); assert.equal(f.writes.length, 0)
  } finally { f.store.close() }
})
