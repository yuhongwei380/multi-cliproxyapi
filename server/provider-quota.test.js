import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { HTTPClient } from './cpa.js'
import { parseProviderQuota } from './provider-quota.js'

test('Codex accepts a missing additional quota list', () => {
  const values = parseProviderQuota('codex', {
    rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
    additional_rate_limits: null,
  })
  assert.equal(values.length, 1)
  assert.equal(values[0].remaining, 75)
})

test('Codex uses the real CPA api-call contract and preserves exactly zero remaining', async () => {
  let request
  const server = http.createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    request = { path: incoming.url, method: incoming.method, headers: incoming.headers, body: JSON.parse(Buffer.concat(chunks)) }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1800000000 }, secondary_window: { used_percent: 25, limit_window_seconds: 18000 } } }) }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new HTTPClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, managementSecret: 'management-secret' })
    const quota = await client.fetchQuota({ id: 'account-1', provider: 'codex', auth_index: 'index-1', chatgpt_account_id: 'account-id' })
    assert.equal(request.path, '/v0/management/api-call')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer management-secret')
    assert.equal(request.body.authIndex, 'index-1')
    assert.equal(request.body.url, 'https://chatgpt.com/backend-api/wham/usage')
    assert.equal(request.body.method, 'GET')
    assert.equal(request.body.header.Authorization, 'Bearer $TOKEN$')
    assert.equal(request.body.header['Chatgpt-Account-Id'], 'account-id')
    assert.equal(quota.values[0].remaining, 0)
    assert.equal(quota.values[1].remaining, 75)
    assert.equal(quota.values[0].total, 100)
    assert.equal(quota.values[0].name, '周限额')
    assert.equal(quota.values[1].name, '5 小时限额')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Claude uses OAuth usage windows and omits absent windows', async () => {
  let body
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async (_, options) => { body = JSON.parse(options.body); return Response.json({ status_code: 200, body: { five_hour: { utilization: 12.5, resets_at: '2026-09-14T10:00:00Z' }, seven_day: null } }) } })
  const quota = await client.fetchQuota({ id: 'claude-1', provider: 'claude', auth_index: 'index' })
  assert.equal(body.url, 'https://api.anthropic.com/api/oauth/usage')
  assert.equal(body.header['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(quota.values.length, 1)
  assert.equal(quota.values[0].remaining, 87.5)
  assert.equal(quota.values[0].name, '5 小时限额')
})

test('Kimi proxies OAuth usage and parses weekly and rolling windows without reading credentials', async () => {
  let request
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) }
    return Response.json({ status_code: 200, body: JSON.stringify({
      usage: { limit: '200', used: '50', remaining: '150', resetTime: '2030-10-07T00:00:00Z' },
      limits: [{ detail: { limit: '100', used: '100', remaining: '0', resetTime: '2030-10-06T12:00:00Z' }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }],
    }) })
  } })
  const quota = await client.fetchQuota({ id: 'kimi-1.json', provider: 'KIMI', auth_index: 'kimi-index' })
  assert.equal(request.url, 'http://127.0.0.1:8317/v0/management/api-call')
  assert.deepEqual(request.body, { authIndex: 'kimi-index', method: 'GET', url: 'https://api.kimi.com/coding/v1/usages', header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' } })
  assert.equal(quota.status, 'ok')
  assert.deepEqual(quota.values, [
    { name: '5 小时限额', remaining: 0, total: 100, unit: '%', reset_at: '2030-10-06T12:00:00.000Z' },
    { name: '周限额', remaining: 75, total: 100, unit: '%', reset_at: '2030-10-07T00:00:00.000Z' },
  ])
})

test('Kimi handles remaining-only, used-only, flat limits and monthly-only plans', () => {
  const values = parseProviderQuota('kimi', {
    limits: [
      { limit: '80', used: '20', duration: '5', timeUnit: 'TIME_UNIT_HOUR' },
      { detail: { limit: 200, remaining: 0 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } },
    ],
    usages: { limit_month_total: { used_ratio: '0.2529', reset_time: '2030-11-01T00:00:00Z' } },
  })
  assert.equal(values[0].name, '5 小时限额')
  assert.equal(values[0].remaining, 75)
  assert.equal(values[1].name, '周限额')
  assert.equal(values[1].remaining, 0)
  assert.equal(values[2].name, '月限额')
  assert.ok(Math.abs(values[2].remaining - 74.71) < 1e-10)
  assert.equal(values[2].reset_at, '2030-11-01T00:00:00.000Z')
  assert.equal(parseProviderQuota('kimi', { usages: { limit_month_total: { used_ratio: 0 } } })[0].remaining, 100)
  const before = Date.now()
  const reset = Date.parse(parseProviderQuota('kimi', { usage: { limit: 100, used: 125, resetIn: '60' } })[0].reset_at)
  assert.ok(reset >= before + 60000 && reset <= Date.now() + 60000)
})

test('Kimi rejects missing and malformed usage instead of reporting full quota', async () => {
  for (const payload of [
    {}, { limits: [] }, { limits: {} }, { limits: [null] },
    { usage: { limit: 100 } }, { usage: { limit: '100', used: '' } },
    { usage: { limit: 0, used: 0 } }, { usage: { limit: 100, remaining: -1 } },
    { usage: { limit: 100, used: true } }, { usage: { limit: 100, used: 0, resetTime: 'invalid' } },
    { usages: { limit_month_total: { used_ratio: null } } },
    { usages: [] }, { usages: { limit_5h: [] } }, { usages: { limit_7d: { used_ratio: -1 } } },
  ]) assert.throws(() => parseProviderQuota('kimi', payload))
  for (const status of [401, 403, 429, 502]) {
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => Response.json({ status_code: status, body: {} }) })
    await assert.rejects(client.fetchQuota({ id: 'kimi', provider: 'kimi', auth_index: 'index' }), error => error.code !== 'ERR_UNSUPPORTED')
  }
})

test('Kimi named windows distinguish monthly plans and override legacy summaries without duplicates', () => {
  for (const weekly of [false, true]) {
    const values = parseProviderQuota('kimi', {
      usage: { limit: 100, remaining: 96, resetTime: '2030-11-10T00:00:00Z' },
      limits: [{ detail: { limit: 100, remaining: 100 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }],
      usages: {
        limit_5h: { used_ratio: 0, reset_time: '2030-10-10T08:00:00Z' },
        limit_7d: weekly ? { used_ratio: '0.25', reset_time: '2030-10-17T00:00:00Z' } : null,
        limit_month_total: { used_ratio: 1, reset_time: '2030-11-10T00:00:00Z' },
      },
    })
    assert.deepEqual(values.map(value => value.name), weekly ? ['5 小时限额', '周限额', '月限额'] : ['5 小时限额', '月限额'])
    assert.equal(values[0].remaining, 100)
    assert.equal(values.at(-1).remaining, 0)
    assert.equal(values[0].reset_at, '2030-10-10T08:00:00.000Z')
    if (weekly) assert.equal(values[1].remaining, 75)
  }
})

test('Kimi legacy monthly-only and weekly/monthly plans retain their actual windows', () => {
  const monthly = { limit_month_total: { used_ratio: 0.5 } }
  const rolling = { limit: 100, remaining: 80, duration: 5, timeUnit: 'HOUR' }
  assert.deepEqual(parseProviderQuota('kimi', { limits: [rolling], usages: monthly }).map(value => value.name), ['5 小时限额', '月限额'])
  assert.deepEqual(parseProviderQuota('kimi', { limits: [rolling], usage: { limit: 100, remaining: 60 }, usages: monthly }).map(value => value.name), ['5 小时限额', '周限额', '月限额'])
  for (const [duration, timeUnit, name] of [[30, 'DAY', '月限额'], [1, 'TIME_UNIT_MONTH', '月限额'], [14, 'DAY', '14 天限额']]) {
    const values = parseProviderQuota('kimi', { limits: [{ limit: 100, remaining: 25, duration, timeUnit }] })
    assert.equal(values[0].name, name)
  }
})

test('upstream errors and missing usage cannot masquerade as successful quota values', async () => {
  for (const payload of [{ status_code: 401, body: {} }, { status_code: 429, body: {} }, { status_code: 200, body: 'not JSON' }, { status_code: 200, body: { rate_limit: { primary_window: { used_percent: null } } } }, {}]) {
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => Response.json(payload) })
    await assert.rejects(client.fetchQuota({ id: 'a', provider: 'codex', auth_index: 'index' }))
  }
})

test('unknown providers are unsupported and missing auth index never falls back to another credential', async () => {
  let calls = 0
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => { calls++; throw new Error('unexpected network') } })
  await assert.rejects(client.fetchQuota({ id: 'a', provider: 'unknown' }), error => error.code === 'ERR_UNSUPPORTED')
  await assert.rejects(client.fetchQuota({ id: 'a', provider: 'codex' }), /auth_index/)
  await assert.rejects(client.fetchQuota({ id: 'a', provider: 'kimi' }), /auth_index/)
  assert.equal(calls, 0)
})

test('account discovery keeps only structured account identity and discards token fields', async () => {
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => Response.json({ files: [{ id: 'a', auth_index: 'i', provider: 'codex', id_token: { chatgpt_account_id: 'account', access_token: 'private' }, access_token: 'private' }] }) })
  const accounts = await client.listAccounts()
  assert.equal(accounts[0].chatgpt_account_id, 'account')
  assert.equal(JSON.stringify(accounts).includes('private'), false)
  assert.equal(accounts[0].id_token, undefined)
})
