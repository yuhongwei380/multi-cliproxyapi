import test from 'node:test'
import assert from 'node:assert/strict'

test('streamed UTF-8 account identities survive boundaries inside a character', async () => {
  const bytes = Buffer.from(JSON.stringify({ files: [{ id: '账户', name: '中文账号', provider: 'demo' }] }))
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })) })
  assert.equal((await client.listAccounts())[0].id, '账户')
})

test('account records without a stable identity are rejected', async () => {
  for (const file of [{}, null, { id: {} }, { disabled: true }]) {
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => Response.json({ files: [file] }) })
    await assert.rejects(client.listAccounts())
  }
})

test('malformed quota responses cannot become successful empty snapshots', async () => {
  for (const payload of [{ error: 'upstream failure' }, {}, { values: [{ remaining: 'bad' }] }]) {
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', quotaPath: '/quota', fetchImpl: async () => Response.json(payload) })
    await assert.rejects(client.fetchQuota({ id: 'a' }))
  }
})
import { HTTPClient } from './cpa.js'

test('malformed account responses are failures rather than empty discovery', async () => {
  for (const payload of [{ error: 'upstream unavailable' }, { files: null }, { files: {} }, { files: [], success: false }]) {
    const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => fakeResponse(payload) })
    await assert.rejects(() => client.listAccounts(), /invalid CPA auth-files response/)
  }
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => fakeResponse({ files: [] }) })
  assert.deepEqual(await client.listAccounts(), [])
})

function fakeResponse(body, status = 200, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name.toLowerCase()] || null }, body: null, text: async () => JSON.stringify(body) }
}

test('CPA client discovers accounts and quota windows', async () => {
  let redirectMode = ''
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'secret', quotaPath: '/quota', fetchImpl: async (url, options) => { redirectMode = options.redirect; return url.endsWith('/auth-files') ? fakeResponse({ files: [{ id: 'account-1', provider: 'demo', email: 'user@example.com' }] }) : fakeResponse({ values: [{ name: '6h', remaining: 42, total: 100, unit: 'requests' }] }) } })
  const accounts = await client.listAccounts(); assert.equal(accounts[0].id, 'account-1'); const quota = await client.fetchQuota(accounts[0]); assert.equal(quota.values[0].remaining, 42)
  assert.equal(redirectMode, 'error')
})

test('CPA client classifies unsupported, failed wrappers, and duplicate identities', async () => {
  const duplicate = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'secret', fetchImpl: async () => fakeResponse({ files: [{ id: 'same' }, { id: 'same' }] }) }); await assert.rejects(() => duplicate.listAccounts(), /duplicate/)
  const failed = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'secret', quotaPath: '/quota', fetchImpl: async () => fakeResponse({ status_code: 502, message: 'upstream down' }) }); await assert.rejects(() => failed.fetchQuota({ id: 'a', provider: 'p' }), /upstream request failed/)
})

test('CPA client is restricted to loopback and quota paths cannot escape it', async () => { assert.throws(() => new HTTPClient({ baseUrl: 'http://child.test', managementSecret: 'secret' }), /loopback/); const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'secret', quotaPath: 'https://evil.example/quota', fetchImpl: async () => fakeResponse({}) }); await assert.rejects(() => client.fetchQuota({ id: 'a' }), /relative/) })

test('CPA client retries transient connection failures during child startup', async () => {
  let attempts = 0
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'secret', maxRetries: 3, retryBaseMs: 0, fetchImpl: async () => { attempts += 1; if (attempts < 3) throw new TypeError('fetch failed'); return fakeResponse({ ok: true }) } })
  await client.health()
  assert.equal(attempts, 3)
})

test('malformed auth responses cannot expose response snippets through error messages', async () => {
  const client = new HTTPClient({ baseUrl: 'http://127.0.0.1:8317', managementSecret: 'test', fetchImpl: async () => new Response('private-oauth-token-not-json') })
  await assert.rejects(client.listAccounts(), error => /invalid JSON/.test(error.message) && !error.message.includes('private-oauth-token'))
})
