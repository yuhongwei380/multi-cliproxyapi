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
  assert.equal(calls, 0)
})

test('account discovery keeps only structured account identity and discards token fields', async () => {
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => Response.json({ files: [{ id: 'a', auth_index: 'i', provider: 'codex', id_token: { chatgpt_account_id: 'account', access_token: 'private' }, access_token: 'private' }] }) })
  const accounts = await client.listAccounts()
  assert.equal(accounts[0].chatgpt_account_id, 'account')
  assert.equal(JSON.stringify(accounts).includes('private'), false)
  assert.equal(accounts[0].id_token, undefined)
})
