import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { URL } from 'node:url'
import { instanceView } from './domain.js'
import { normalizeBearer } from './security.js'
import { statusForError } from './errors.js'
import { NotFoundError } from './store.js'

const cookieName = 'multi_cpa_session'
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
}
const jsonHeaders = { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function writeJson(response, status, body, headers = {}) { response.writeHead(status, { ...jsonHeaders, ...headers }); response.end(JSON.stringify(body)) }
function writeError(response, error) { const status = statusForError(error); writeJson(response, status, { error: status >= 500 ? 'internal server error' : (error?.message || 'request failed') }) }
function parseCookies(header = '') { const result = Object.create(null); for (const chunk of header.split(';')) { const index = chunk.indexOf('='); if (index <= 0) continue; try { result[chunk.slice(0, index).trim()] = decodeURIComponent(chunk.slice(index + 1).trim()) } catch {} } return result }
async function readJson(request, limit = 64 * 1024) {
  const contentLength = Number(request.headers['content-length'] || 0); if (contentLength > limit) throw Object.assign(new Error('request body is too large'), { status: 413 })
  let size = 0; const chunks = []
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error('request body is too large'), { status: 413 }); chunks.push(chunk) }
  if (!chunks.length) return {}
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object'); return value } catch { throw Object.assign(new Error('invalid body: expected a JSON object'), { status: 400 }) }
}
function sameOrigin(request) { const origin = request.headers.origin; if (!origin) return true; return origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}` }
function safeStatic(root, requestPath) {
  try {
    const relative = requestPath === '/management.html' || requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
    const rootResolved = fs.realpathSync(root); const candidate = path.resolve(rootResolved, relative)
    if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) return null
    const resolved = fs.realpathSync(candidate)
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) return null
    return resolved
  } catch { return null }
}
function publicInstance(instance, status, request) { const view = instanceView(instance, status, request); delete view.directory; delete view.management_secret_ciphertext; return view }
function safeClientAddress(request) { return String(request.socket?.remoteAddress || 'local').replace(/^::ffff:/, '').slice(0, 128) }
function logLimit(url) { const limit = Number(url.searchParams.get('limit') || 200); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('invalid limit'), { status: 400 }); return limit }
function auditTarget(request, pathname) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return null
  if (pathname === '/api/auth/password') return { action: 'auth.password.change', resource_type: 'administrator', resource_id: 'admin' }
  if (pathname === '/api/branding') return { action: 'branding.update', resource_type: 'branding', resource_id: 'singleton' }
  if (pathname === '/api/instances') return { action: 'instance.create', resource_type: 'instance', resource_id: '' }
  if (pathname === '/api/quota/settings') return { action: 'quota.settings.update', resource_type: 'quota-settings', resource_id: 'singleton' }
  if (pathname === '/api/versions/install') return { action: 'version.install', resource_type: 'version', resource_id: '' }
  if (pathname === '/api/versions/upgrade') return { action: 'version.upgrade', resource_type: 'version', resource_id: '' }
  if (pathname === '/api/versions/uninstall') return { action: 'version.uninstall', resource_type: 'version', resource_id: '' }
  if (pathname === '/api/upgrade/recover') return { action: 'version.recover', resource_type: 'upgrade', resource_id: 'singleton' }
  const match = pathname.match(/^\/api\/instances\/([^/]+)(?:\/([^/]+))?$/)
  if (!match) return null
  const suffix = match[2] || 'update'
  const action = suffix === 'delete-challenge' ? 'delete.prepare' : suffix
  return { action: `instance.${action}`, resource_type: 'instance', resource_id: match[1] }
}

export class Controller {
  constructor({ auth, instances, deleteService, quota, upgrade, installer, versionService, activator, branding, store, staticRoot, secureCookies = false, logger = console } = {}) { Object.assign(this, { auth, instances, deleteService, quota, upgrade, installer, versionService, activator, branding, store, staticRoot, secureCookies, logger }) }
  token(request) { const cookies = parseCookies(request.headers.cookie || ''); return cookies[cookieName] || normalizeBearer(request.headers.authorization || '') }
  authenticated(request) { return this.auth.authenticate(this.token(request)) }
  audit(entry) { try { this.store.appendAuditLog?.(entry) } catch (error) { this.logger?.error?.(error) } }
  runtimeError(request, error) { try { this.store.appendRuntimeLog?.({ level: 'error', source: 'http', message: error?.message || 'request failed', context: { method: request.method, path: new URL(request.url, 'http://localhost').pathname, status: statusForError(error) } }) } catch {} }
  async handle(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); const pathname = url.pathname
      if (pathname === '/health' || pathname === '/api/health') return writeJson(response, 200, { status: 'ok' })
      if (['/', '/index.html', '/management.html'].includes(pathname) || pathname.startsWith('/assets/')) return this.serveStatic(pathname, response)
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) return writeJson(response, 403, { error: 'origin check failed' })
      if (pathname === '/api/auth/login' && request.method === 'POST') return await this.login(request, response)
      if (pathname === '/api/auth/logout' && request.method === 'POST') return this.logout(request, response)
      if (pathname === '/api/auth/status' && request.method === 'GET') return this.authStatus(request, response)
      let username
      try { username = this.authenticated(request) } catch { return writeJson(response, 401, { error: 'authentication required' }) }
      const target = auditTarget(request, pathname)
      try {
        const result = await this.routeApi(request, response, url, username)
        if (target) this.audit({ actor: username, ...target, outcome: 'success', client_address: safeClientAddress(request) })
        return result
      } catch (error) {
        if (target) this.audit({ actor: username, ...target, outcome: 'failed', client_address: safeClientAddress(request), detail: error?.message || 'request failed' })
        throw error
      }
    } catch (error) { this.logger?.error?.(error); if (statusForError(error) >= 500) this.runtimeError(request, error); return writeError(response, error) }
  }
  serveStatic(requestPath, response) {
    const file = safeStatic(this.staticRoot, requestPath); if (!file) return writeJson(response, 404, { error: 'not found' })
    try { const info = fs.statSync(file); if (!info.isFile()) throw new Error('not found'); const ext = path.extname(file).toLowerCase(); const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream'; response.writeHead(200, { ...securityHeaders, 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' }); return fs.createReadStream(file).pipe(response) } catch { return writeJson(response, 404, { error: 'not found' }) }
  }
  async login(request, response) {
    const body = await readJson(request); const actor = typeof body.username === 'string' ? body.username.slice(0, 64) : 'unknown'
    try { const result = this.auth.login(body.username, body.password, request.socket?.remoteAddress || 'local'); const maxAge = Math.max(1, Math.floor((result.expires.getTime() - Date.now()) / 1000)); const cookie = `${cookieName}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secureCookies ? '; Secure' : ''}`; this.audit({ actor, action: 'auth.login', resource_type: 'session', outcome: 'success', client_address: safeClientAddress(request) }); return writeJson(response, 200, { username: body.username, expires_at: result.expires.toISOString() }, { 'Set-Cookie': cookie }) } catch (error) { this.audit({ actor, action: 'auth.login', resource_type: 'session', outcome: 'failed', client_address: safeClientAddress(request), detail: error?.message || 'login failed' }); throw error }
  }
  logout(request, response) { let actor = 'unknown'; try { actor = this.authenticated(request) } catch {}; try { this.auth.logout(this.token(request)) } catch {}; this.audit({ actor, action: 'auth.logout', resource_type: 'session', outcome: 'success', client_address: safeClientAddress(request) }); const cookie = `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookies ? '; Secure' : ''}`; return writeJson(response, 200, { status: 'ok' }, { 'Set-Cookie': cookie }) }
  authStatus(request, response) { const branding = this.branding?.get?.(); try { return writeJson(response, 200, { authenticated: true, username: this.authenticated(request), ...(branding ? { branding } : {}) }) } catch { return writeJson(response, 200, { authenticated: false, ...(branding ? { branding } : {}) }) } }
  async routeApi(request, response, url) {
    const route = url.pathname.replace(/^\/api/, '')
    if (route === '/auth/password' && request.method === 'PATCH') { const body = await readJson(request); this.auth.changeAdminPassword(body.current_password, body.new_password); return writeJson(response, 200, { status: 'updated' }) }
    if (route === '/instances' && request.method === 'GET') { const items = await this.instances.list(); return writeJson(response, 200, { items: items.map(item => publicInstance(item, item.status, request)) }) }
    if (route === '/instances' && request.method === 'POST') { const input = await readJson(request); const instance = await this.instances.create({ name: input.name, port: Number(input.port), management_password: input.management_password, version: input.version }); return writeJson(response, 201, publicInstance(instance, { instance_id: instance.id, state: 'stopped', ready: false, version: instance.version }, request)) }
    if (route === '/versions' && request.method === 'GET') return writeJson(response, 200, { items: this.store.listVersions().map(item => { const { path: _path, ...publicVersion } = item; return publicVersion }) })
    if (route === '/upgrade/state' && request.method === 'GET') { try { return writeJson(response, 200, this.store.getUpgradeState()) } catch (error) { if (error.code === 'ERR_NOT_FOUND') return writeJson(response, 200, { state: 'idle' }); throw error } }
    if (route === '/operations' && request.method === 'GET') { const limit = Number(url.searchParams.get('limit') || 50); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('invalid limit'), { status: 400 }); return writeJson(response, 200, { items: this.store.listOperations(limit) }) }
    if (route === '/logs/runtime' && request.method === 'GET') return writeJson(response, 200, { items: this.store.listRuntimeLogs(logLimit(url)) })
    if (route === '/logs/audit' && request.method === 'GET') return writeJson(response, 200, { items: this.store.listAuditLogs(logLimit(url)) })
    if (route === '/branding' && request.method === 'PATCH') { if (!this.branding) throw new Error('branding service unavailable'); const body = await readJson(request); return writeJson(response, 200, this.branding.update(body)) }
    if (route === '/quota/settings' && request.method === 'GET') return writeJson(response, 200, this.quota.getSettings())
    if (route === '/quota/settings' && request.method === 'PATCH') { const body = await readJson(request); return writeJson(response, 200, this.quota.updateSettings(body)) }
    if (route === '/versions/install' && request.method === 'POST') { if (!this.installer) throw new Error('version installer unavailable'); const body = await readJson(request); const installed = await this.installer.install(body.version || ''); this.store.saveVersion(installed); const instances = this.store.listInstances(); if (!instances.length && this.activator) await this.activator.activateVersion(installed.tag); this.instances.setDefaultVersionIfEmpty(installed.tag); const { path: _path, ...publicVersion } = installed; return writeJson(response, 201, publicVersion) }
    if (route === '/versions/upgrade' && request.method === 'POST') { const body = await readJson(request); await this.upgrade.upgrade(body.version); return writeJson(response, 200, { status: 'upgraded', version: body.version }) }
    if (route === '/versions/uninstall' && request.method === 'POST') { if (!this.versionService) throw new Error('version uninstaller unavailable'); const body = await readJson(request); await this.versionService.uninstall(body.version); return writeJson(response, 200, { status: 'uninstalled', version: body.version }) }
    if (route === '/upgrade/recover' && request.method === 'POST') { await this.upgrade.recover(); return writeJson(response, 200, { status: 'recovered' }) }
    if (route.startsWith('/instances/')) return await this.instanceRoute(request, response, url, route.slice('/instances/'.length))
    return writeJson(response, 404, { error: 'not found' })
  }
  async instanceRoute(request, response, url, rest) {
    const parts = rest.split('/').filter(Boolean); const instanceId = parts[0]; if (!instanceId) return writeJson(response, 404, { error: 'instance not found' })
    if (parts.length === 1 && request.method === 'GET') { const instance = this.store.getInstance(instanceId); const status = await this.instances.status(instanceId); return writeJson(response, 200, publicInstance(instance, status, request)) }
    if (parts.length === 1 && request.method === 'PATCH') { const body = await readJson(request); const instance = await this.instances.update(instanceId, { name: body.name, port: body.port === undefined ? undefined : Number(body.port), management_password: body.management_password, expected_revision: Number(body.expected_revision) || 0 }); const status = await this.instances.status(instanceId); return writeJson(response, 200, publicInstance(instance, status, request)) }
    if (parts.length !== 2) return writeJson(response, 404, { error: 'not found' })
    const action = parts[1]
    if (['start', 'stop', 'restart'].includes(action) && request.method === 'POST') { await this.instances[action](instanceId); return writeJson(response, 202, { status: action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting' }) }
    if (action === 'quotas') { if (request.method === 'GET') return writeJson(response, 200, { items: await this.quota.list(instanceId) }); if (request.method === 'POST') { await this.quota.refreshInstance(instanceId); return writeJson(response, 202, { status: 'refreshed', items: await this.quota.list(instanceId) }) } }
    if (action === 'delete-challenge' && request.method === 'POST') { const challenge = this.deleteService.preview(instanceId); return writeJson(response, 200, { challenge_id: challenge.id, instance_id: challenge.instance_id, expires_at: challenge.expires_at, scope: 'configuration, authentication data, logs and instance service' }) }
    if (action === 'delete' && request.method === 'POST') { const body = await readJson(request); await this.deleteService.confirm(instanceId, body.challenge_id, body.admin_password); return writeJson(response, 200, { status: 'deleted' }) }
    return writeJson(response, 404, { error: 'not found' })
  }
}

export function createHttpServer(options, { isReady = () => true } = {}) {
  const controller = options instanceof Controller ? options : new Controller(options); const server = http.createServer((request, response) => isReady() ? controller.handle(request, response) : writeJson(response, 503, { error: 'controller is initializing' }))
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 100
  return server
}
