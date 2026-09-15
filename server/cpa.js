import crypto from 'node:crypto'
import { URL } from 'node:url'
import { providerQuotaRequest, parseProviderQuota } from './provider-quota.js'

export class CPAError extends Error { constructor(message, code = 'ERR_CPA') { super(message); this.code = code } }
export const unsupported = message => new CPAError(message || 'CPA endpoint is unsupported', 'ERR_UNSUPPORTED')
export const authentication = message => new CPAError(message || 'CPA management authentication failed', 'ERR_AUTHENTICATION')
export const rateLimited = message => new CPAError(message || 'CPA endpoint is rate limited', 'ERR_RATE_LIMITED')

const stringify = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value && typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : ''
const sleep = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')) }, { once: true }) })
const retryableNetworkError = error => {
  if (!error) return false
  if (error.name === 'TypeError' || error.name === 'AbortError') return true
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.code || error.cause?.code)
}

export class HTTPClient {
  constructor({ baseUrl, managementSecret, quotaPath = '', fetchImpl = globalThis.fetch, timeoutMs = 10000, maxResponseBytes = 4 * 1024 * 1024, maxRetries = 2, retryBaseMs = 100 } = {}) {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.hash) throw new Error('CPA base URL must use loopback HTTP')
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('CPA response size limit is invalid')
    this.baseUrl = parsed.toString(); this.baseOrigin = parsed.origin; this.managementSecret = managementSecret; this.quotaPath = quotaPath; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.maxResponseBytes = maxResponseBytes; this.maxRetries = maxRetries; this.retryBaseMs = retryBaseMs
  }
  endpoint(requestPath) { const result = new URL(requestPath.replace(/^\/+/, ''), `${String(this.baseUrl).replace(/\/+$/, '')}/`); if (result.origin !== this.baseOrigin) throw new Error('CPA request URL must remain on loopback'); return result.toString() }
  async singleRequest(method, requestPath, signal, body) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }) }
    try {
      const response = await this.fetchImpl(this.endpoint(requestPath), { method, redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${this.managementSecret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const reader = response.body?.getReader?.(); let text = ''
      if (reader) {
        let size = 0
        const decoder = new TextDecoder()
        while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > this.maxResponseBytes) { try { await reader.cancel() } catch {}; throw new Error('CPA response exceeds size limit') } text += decoder.decode(item.value, { stream: true }) }
        text += decoder.decode()
      } else {
        text = await response.text(); if (Buffer.byteLength(text) > this.maxResponseBytes) throw new Error('CPA response exceeds size limit')
      }
      return { body: text, status: response.status, retryAfter: parseRetryAfter(response.headers.get('retry-after')) }
    } finally { clearTimeout(timer) }
  }
  async request(method, requestPath, signal, body) {
    let retries = Number.isInteger(this.maxRetries) ? this.maxRetries : 2
    if (retries > 5) retries = 5
    for (let attempt = 0; ; attempt += 1) {
      let result
      try {
        result = await this.singleRequest(method, requestPath, signal, body)
      } catch (error) {
        if (!retryableNetworkError(error) || retries < 0 || attempt >= retries || signal?.aborted) throw error
        await sleep(Math.min(5000, this.retryBaseMs * (2 ** attempt)), signal)
        continue
      }
      if (result.status !== 429 || retries < 0 || attempt >= retries) return result
      const delay = Math.min(5000, result.retryAfter || this.retryBaseMs * (2 ** attempt))
      await sleep(delay, signal)
    }
  }
  async health(signal) {
    const result = await this.request('GET', '/v0/management/config', signal)
    if (result.status === 401 || result.status === 403) throw authentication()
    if (result.status === 429) throw rateLimited()
    if (result.status < 200 || result.status >= 300) throw new Error(`CPA health returned HTTP ${result.status}`)
  }
  async listAccounts(signal) {
    const result = await this.request('GET', '/v0/management/auth-files', signal)
    if (result.status === 401 || result.status === 403) throw authentication()
    if (result.status === 429) throw rateLimited()
    if (result.status === 404) throw unsupported()
    if (result.status < 200 || result.status >= 300) throw new Error(`CPA auth-files returned HTTP ${result.status}`)
    let payload; try { payload = JSON.parse(result.body) } catch { throw new Error('decode CPA auth-files: invalid JSON') }
    if (!payload || !Array.isArray(payload.files) || payload.success === false || payload.error || ['error', 'failed'].includes(String(payload.status || '').toLowerCase()) || (payload.status_code !== undefined && (Number(payload.status_code) < 200 || Number(payload.status_code) >= 300))) {
      throw new Error('invalid CPA auth-files response')
    }
    const files = payload.files
    const seen = new Set(); const accounts = []
    for (const file of files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('invalid CPA auth-file record')
      for (const key of ['id', 'auth_index', 'name', 'provider', 'email']) if (file[key] !== undefined && file[key] !== null && !['string', 'number'].includes(typeof file[key])) throw new Error(`invalid CPA auth-file ${key}`)
      let id = stringify(file.id) || stringify(file.auth_index) || stringify(file.name)
      if (!id) {
        if (!file.email) throw new Error('CPA auth-file is missing a stable account identifier')
        const stable = JSON.stringify([file.provider || '', file.email])
        id = `account-${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16)}`
      }
      if (seen.has(id)) throw new Error(`CPA auth-files contain duplicate account identifier ${JSON.stringify(id)}`)
      seen.add(id)
      const identity = file.id_token && typeof file.id_token === 'object' ? file.id_token.chatgpt_account_id : undefined
      accounts.push({ id, auth_index: stringify(file.auth_index), name: file.name || '', provider: file.provider || file.type || '', ...(typeof identity === 'string' ? { chatgpt_account_id: identity } : {}), email: file.email || '', status: file.status || '', disabled: Boolean(file.disabled), unavailable: Boolean(file.unavailable), runtime_only: Boolean(file.runtime_only) })
    }
    return accounts
  }
  async fetchQuota(account, signal) {
    const snapshot = { account_id: account.id, provider: account.provider || '', attempted_at: new Date().toISOString(), values: [] }
    if (!this.quotaPath) {
      const request = providerQuotaRequest(account)
      if (!request) throw unsupported('quota provider has no verified adapter')
      const response = await this.request('POST', '/v0/management/api-call', signal, request)
      if ([401, 403].includes(response.status)) throw authentication()
      if ([404, 501].includes(response.status)) throw unsupported()
      if (response.status === 429) throw rateLimited()
      if (response.status < 200 || response.status >= 300) throw new Error(`CPA api-call returned HTTP ${response.status}`)
      let wrapper
      try { wrapper = JSON.parse(response.body) } catch { throw new Error('invalid CPA api-call response') }
      if (!wrapper || !Number.isInteger(wrapper.status_code)) throw new Error('invalid CPA api-call status')
      if ([401, 403].includes(wrapper.status_code)) throw authentication('OAuth provider rejected the account')
      if (wrapper.status_code === 429) throw rateLimited()
      if ([404, 501].includes(wrapper.status_code)) throw unsupported()
      if (wrapper.status_code < 200 || wrapper.status_code >= 300) throw new Error(`quota upstream returned HTTP ${wrapper.status_code}`)
      let payload = wrapper.body
      if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { throw new Error('invalid quota upstream JSON') } }
      return { ...snapshot, values: parseProviderQuota(String(account.provider).toLowerCase(), payload), status: 'ok', collected_at: new Date().toISOString() }
    }
    let requestPath = this.quotaPath || '/v0/management/quota'
    try { const parsed = new URL(requestPath, 'http://quota.local'); if (parsed.origin !== 'http://quota.local' || requestPath.startsWith('//')) throw new Error('quota path must be relative') } catch (error) { throw error.message === 'quota path must be relative' ? error : new Error('quota path must be relative') }
    if (requestPath.includes('{auth_index}')) requestPath = requestPath.replaceAll('{auth_index}', encodeURIComponent(account.auth_index || ''))
    const result = await this.request('GET', requestPath, signal)
    if (result.status === 401 || result.status === 403) throw authentication()
    if (result.status === 429) throw rateLimited()
    if (result.status === 404 || result.status === 501) throw unsupported()
    if (result.status < 200 || result.status >= 300) throw new Error(`CPA quota returned HTTP ${result.status}`)
    let payload; try { payload = JSON.parse(result.body) } catch { throw new Error('decode CPA quota: invalid JSON') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw new Error('invalid CPA quota response')
    if (payload.status_code !== undefined && (Number(payload.status_code) < 200 || Number(payload.status_code) >= 300)) throw new Error(`CPA quota upstream request failed: ${payload.error || payload.message || `upstream HTTP ${payload.status_code}`}`)
    if (payload.success === false) throw new Error(`CPA quota upstream request failed: ${payload.error || payload.message || 'upstream request failed'}`)
    if (String(payload.status || '').toLowerCase() === 'error' || String(payload.status || '').toLowerCase() === 'failed') throw new Error(`CPA quota request failed: ${payload.error || payload.message || 'quota request failed'}`)
    let values = Array.isArray(payload.values) ? payload.values : Array.isArray(payload.quotas) ? payload.quotas : []
    if (!values.length && (payload.remaining !== undefined || payload.total !== undefined)) values = [{ name: 'default', remaining: payload.remaining, total: payload.total, unit: payload.unit || '', reset_at: payload.reset_at }]
    if (String(payload.status || '').toLowerCase() === 'unsupported') throw unsupported()
    if (!Array.isArray(payload.values) && !Array.isArray(payload.quotas) && payload.remaining === undefined && payload.total === undefined) throw new Error('CPA quota response has no quota fields')
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid CPA quota window')
      for (const field of ['remaining', 'total']) if (value[field] !== undefined && value[field] !== null && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0)) throw new Error(`invalid CPA quota ${field}`)
    }
    return { ...snapshot, values, status: 'ok', message: payload.message || '', collected_at: new Date().toISOString() }
  }
}

function parseRetryAfter(value) {
  if (!value) return 0
  const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

export class StaticClient {
  constructor({ accounts = [], quotas = new Map(), error = null } = {}) { this.accounts = accounts; this.quotas = quotas; this.error = error }
  async listAccounts() { if (this.error) throw this.error; return [...this.accounts] }
  async fetchQuota(account) { if (this.error) throw this.error; const value = this.quotas instanceof Map ? this.quotas.get(account.id) : this.quotas[account.id]; if (!value) throw unsupported(); return { ...value } }
  async health() { if (this.error) throw this.error }
}
