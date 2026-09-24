import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nowIso, ObservedState, DesiredState, isStopped } from './domain.js'
import { ConflictError, NotFoundError } from './store.js'

const execFileAsync = promisify(execFile)
const safeTag = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const safeRepositoryPart = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
const DEFAULT_MAX_ASSET_BYTES = 256 * 1024 * 1024
const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024

async function readResponse(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response exceeds size limit')
  const reader = response.body?.getReader?.()
  if (!reader) {
    const result = Buffer.from(await response.arrayBuffer())
    if (result.length > maxBytes) throw new Error('response exceeds size limit')
    return result
  }
  const chunks = []; let size = 0
  while (true) {
    const item = await reader.read(); if (item.done) break
    size += item.value.byteLength
    if (size > maxBytes) { try { await reader.cancel() } catch {}; throw new Error('response exceeds size limit') }
    chunks.push(Buffer.from(item.value))
  }
  return Buffer.concat(chunks, size)
}

export class GitHubSource {
  constructor({ owner = 'router-for-me', repo = 'CLIProxyAPI', apiBase = 'https://api.github.com', fetchImpl = globalThis.fetch, userAgent = 'multi-cliproxyapi', timeoutMs = 30000, maxAssetBytes = DEFAULT_MAX_ASSET_BYTES } = {}) {
    if (!safeRepositoryPart(owner) || !safeRepositoryPart(repo)) throw new Error('GitHub repository contains unsafe characters')
    const api = new URL(apiBase)
    if (api.protocol !== 'https:' || api.hostname !== 'api.github.com' || api.username || api.password || api.port) throw new Error('GitHub API base must be https://api.github.com')
    if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) throw new Error('release asset size limit is invalid')
    this.owner = owner; this.repo = repo; this.apiBase = 'https://api.github.com'; this.fetchImpl = fetchImpl; this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.maxAssetBytes = maxAssetBytes
  }
  async get(url) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': this.userAgent } })
      if (!response.ok) throw new Error(`GitHub release API returned HTTP ${response.status}`)
      try { return JSON.parse((await readResponse(response, MAX_RELEASE_JSON_BYTES)).toString('utf8')) } catch (error) { throw new Error(`invalid GitHub release response: ${error.message}`) }
    } finally { clearTimeout(timer) }
  }
  normalize(payload) { return { tag: String(payload?.tag_name || '').replace(/^v/, ''), assets: (Array.isArray(payload?.assets) ? payload.assets : []).map(item => ({ name: String(item?.name || ''), url: String(item?.browser_download_url || ''), size: Number(item?.size) || 0, digest: String(item?.digest || '') })) } }
  async latest() { return this.normalize(await this.get(`${this.apiBase}/repos/${this.owner}/${this.repo}/releases/latest`)) }
  async byTag(tag) { if (!safeTag(tag)) throw new Error('invalid release tag'); return this.normalize(await this.get(`${this.apiBase}/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(tag)}`)) }
  async download(asset) {
    let requested
    try { requested = new URL(asset.url) } catch { throw new Error('release asset URL is invalid') }
    const expectedPrefix = `/${this.owner}/${this.repo}/releases/download/`.toLowerCase()
    if (requested.protocol !== 'https:' || requested.hostname !== 'github.com' || requested.username || requested.password || requested.port || !requested.pathname.toLowerCase().startsWith(expectedPrefix)) throw new Error('release asset URL is not trusted')
    const expectedSize = Number(asset.size) || 0
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.maxAssetBytes) throw new Error('release asset size is invalid or exceeds the limit')
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const options = { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/octet-stream', 'User-Agent': this.userAgent } }
      const allowedHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
      let current = requested; let response
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        response = await this.fetchImpl(current.toString(), options)
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        if (redirects === 3) throw new Error('release asset redirected too many times')
        const location = response.headers?.get?.('location')
        if (!location) throw new Error('release asset redirect has no location')
        const next = new URL(location, current)
        if (next.protocol !== 'https:' || !allowedHosts.has(next.hostname) || next.username || next.password || next.port) throw new Error('release asset redirected to an untrusted host')
        current = next
      }
      if (!response.ok) throw new Error(`release asset returned HTTP ${response.status}`)
      if (response.url) {
        const final = new URL(response.url)
        if (final.protocol !== 'https:' || !allowedHosts.has(final.hostname) || final.username || final.password || final.port) throw new Error('release asset redirected to an untrusted host')
      }
      const data = await readResponse(response, this.maxAssetBytes)
      if (expectedSize > 0 && data.length !== expectedSize) throw new Error('release asset size mismatch')
      if (asset.digest) {
        if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error('release asset digest is invalid')
        const actual = `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
        if (!crypto.timingSafeEqual(Buffer.from(actual.toLowerCase()), Buffer.from(asset.digest.toLowerCase()))) throw new Error('release asset digest mismatch')
      }
      return data
    } finally { clearTimeout(timer) }
  }
}

function isLinuxAmd64(name) {
  const lower = name.toLowerCase();
  return /(linux|ubuntu)/.test(lower) && /(amd64|x86_64|x64)/.test(lower) && !/(windows|darwin|macos|arm64|aarch64|386)/.test(lower)
}
function selectAsset(release) {
  const candidates = (release.assets || []).filter(asset => isLinuxAmd64(asset.name || '') && /\.(tar\.gz|tgz)$/i.test(asset.name || ''))
  const normal = candidates.filter(asset => !/no[-_.]?plugin/i.test(asset.name || ''))
  if (normal.length === 1) return normal[0]
  if (normal.length > 1) throw new Error('release contains multiple matching Linux amd64 assets')
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) throw new Error('release has no supported Linux amd64 asset')
  throw new Error('release contains multiple matching Linux amd64 assets')
}

function safeArchiveName(name) {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(name)) return false
  const normalized = path.posix.normalize(name.replaceAll('\\', '/'))
  return normalized !== '..' && !normalized.startsWith('../')
}

async function extractArchive(archive, destination) {
  const listing = await execFileAsync('tar', ['-tzf', archive, '--quoting-style=escape'], { maxBuffer: 8 * 1024 * 1024 })
  const names = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (names.length > 10000) throw new Error('release archive contains too many entries')
  for (const name of names) if (!safeArchiveName(name)) throw new Error('release archive contains an unsafe entry')
  const verbose = await execFileAsync('tar', ['-tvzf', archive, '--numeric-owner', '--quoting-style=escape'], { maxBuffer: 8 * 1024 * 1024 })
  let expandedBytes = 0
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error('release archive contains a special or link entry')
    const match = line.match(/^\S+\s+\d+\/\d+\s+(\d+)\s/)
    if (!match) throw new Error('release archive metadata is invalid')
    expandedBytes += Number(match[1])
    if (expandedBytes > 1024 * 1024 * 1024) throw new Error('release archive expands beyond the size limit')
  }
  await execFileAsync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { maxBuffer: 8 * 1024 * 1024 })
}

function walkNoSymlinks(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name); const info = fs.lstatSync(full)
    if (info.isSymbolicLink()) throw new Error('release archive contains a symlink')
    if (info.isDirectory()) walkNoSymlinks(full)
  }
}
function normalizeVersionDir(root) {
  for (let depth = 0; depth < 4; depth += 1) {
    const entries = fs.readdirSync(root, { withFileTypes: true }); if (entries.length !== 1 || !entries[0].isDirectory()) break
    const nested = path.join(root, entries[0].name); for (const entry of fs.readdirSync(nested)) fs.renameSync(path.join(nested, entry), path.join(root, entry)); fs.rmdirSync(nested)
  }
  const canonical = path.join(root, 'cli-proxy-api')
  if (fs.existsSync(canonical)) { const info = fs.lstatSync(canonical); if (!info.isFile() || info.isSymbolicLink()) throw new Error('release CPA binary is not a regular file'); fs.chmodSync(canonical, 0o755); return canonical }
  for (const name of ['cliproxyapi', 'CLIProxyAPI']) { const candidate = path.join(root, name); if (fs.existsSync(candidate)) { const info = fs.lstatSync(candidate); if (!info.isFile() || info.isSymbolicLink()) throw new Error('release CPA binary is not a regular file'); fs.renameSync(candidate, canonical); fs.chmodSync(canonical, 0o755); return canonical } }
  throw new Error('release archive has no executable CPA binary')
}

export class Installer {
  constructor({ source, root, clock = () => new Date() } = {}) { this.source = source; this.root = root; this.clock = clock; this.installing = new Map() }
  async install(requestedTag = '') {
    if (requestedTag && !safeTag(requestedTag)) throw Object.assign(new Error('invalid release tag'), { status: 400 })
    if (requestedTag && !this.installing.has(requestedTag)) this.assertNotInstalled(requestedTag)
    const release = requestedTag ? await this.source.byTag(requestedTag) : await this.source.latest(); const tag = requestedTag || release.tag
    if (!safeTag(tag)) throw new Error(`invalid release tag ${JSON.stringify(tag)}`)
    if (this.installing.has(tag)) return this.installing.get(tag)
    const task = this.performInstall(release, tag); this.installing.set(tag, task)
    try { return await task } finally { this.installing.delete(tag) }
  }
  assertNotInstalled(tag) {
    try { fs.lstatSync(path.join(this.root, tag)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    throw new ConflictError(`CPA version ${tag} is already installed`)
  }
  async performInstall(release, tag) {
    this.assertNotInstalled(tag)
    const asset = selectAsset(release); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); const archive = path.join(this.root, `.download-${tag}-${process.pid}-${Date.now()}.tar.gz`); const destination = path.join(this.root, tag); const temporary = `${destination}.partial-${process.pid}-${Date.now()}`
    try {
      const bytes = await this.source.download(asset); fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' }); const checksum = crypto.createHash('sha256').update(bytes).digest('hex'); fs.mkdirSync(temporary, { recursive: false, mode: 0o700 }); await extractArchive(archive, temporary); walkNoSymlinks(temporary); normalizeVersionDir(temporary); fs.renameSync(temporary, destination); return { tag, asset: asset.name, path: destination, sha256: checksum, installed_at: this.clock().toISOString(), usable: true }
    } catch (error) { try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {}; throw error } finally { try { fs.rmSync(archive, { force: true }) } catch {} }
  }
  async uninstall(version) {
    const tag = typeof version === 'string' ? version : version?.tag
    if (!safeTag(tag)) throw Object.assign(new Error('invalid release tag'), { status: 400 })
    const root = path.resolve(this.root)
    const destination = path.resolve(root, tag)
    if (destination === root || !destination.startsWith(`${root}${path.sep}`)) throw new ConflictError('version path is unsafe')
    if (version && typeof version === 'object' && path.resolve(version.path || '') !== destination) throw new ConflictError('version install path is unsafe')

    let rootInfo
    try { rootInfo = fs.lstatSync(root) } catch (error) { if (error.code === 'ENOENT') throw new NotFoundError('version files not found'); throw error }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new ConflictError('version root is not a safe directory')

    let info
    try { info = fs.lstatSync(destination) } catch (error) { if (error.code === 'ENOENT') throw new NotFoundError('version files not found'); throw error }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ConflictError('version path is not a safe directory')

    const pointer = path.join(root, 'current')
    try {
      const pointerInfo = fs.lstatSync(pointer)
      if (pointerInfo.isSymbolicLink()) {
        const activePath = path.resolve(path.dirname(pointer), fs.readlinkSync(pointer))
        if (activePath === destination) throw new ConflictError('cannot uninstall the active CPA version')
      } else throw new ConflictError('version current pointer is not a safe symlink')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await fsp.rm(destination, { recursive: true, force: false })
  }
}

export class VersionService {
  constructor({ store, instances, installer, clock = () => new Date() } = {}) { this.store = store; this.instances = instances; this.installer = installer; this.clock = clock }
  async uninstall(tag) {
    return this.instances.operations.run('global', async () => {
      if (!safeTag(tag)) throw Object.assign(new Error('invalid release tag'), { status: 400 })
      const installed = this.store.getVersion(tag)
      let state
      try { state = this.store.getUpgradeState() } catch (error) { if (error.code !== 'ERR_NOT_FOUND') throw error }
      if (state && ![UpgradeState.COMMITTED, UpgradeState.ROLLED_BACK].includes(state.state)) throw new ConflictError(`upgrade state is ${state.state}; recover the upgrade first`)
      if (this.store.listInstances().some(instance => instance.version === tag)) throw new ConflictError(`CPA version ${tag} is in use by an instance`)
      if (this.instances.defaultVersion === tag) throw new ConflictError(`CPA version ${tag} is the default version`)
      if (!this.installer) throw new Error('version installer unavailable')
      await this.installer.uninstall(installed)
      this.store.deleteVersion(tag)
      return installed
    })
  }
}

export const UpgradeState = Object.freeze({ PREPARED: 'prepared', STOPPING_OLD: 'stopping-old', OLD_STOPPED: 'old-stopped', STARTING_NEW: 'starting-new', COMMITTED: 'committed', RESTORING_OLD: 'restoring-old', ROLLED_BACK: 'rolled-back', BLOCKED: 'blocked' })

export class UpgradeService {
  constructor({ store, instances, runtime, activator = null, units = null, prepareVersion = null, clock = () => new Date() } = {}) { this.store = store; this.instances = instances; this.runtime = runtime; this.activator = activator; this.units = units; this.prepareVersion = prepareVersion; this.clock = clock }
  persist(state) { state.updated_at = this.clock().toISOString(); this.store.saveUpgradeState(state) }
  async upgrade(newVersion) {
    return this.instances.operations.run('global', async () => {
      if (!newVersion) throw new Error('new version is required'); const installed = this.store.getVersion(newVersion); if (!installed.usable) throw new Error('new version is not usable')
      const allInstances = this.store.listInstances(); const instances = allInstances.filter(instance => !instance.locked)
      if (allInstances.length && !instances.length) throw new ConflictError('all instances are locked; unlock at least one instance before upgrading')
      let oldState = null
      try { oldState = this.store.getUpgradeState(); if (![UpgradeState.COMMITTED, UpgradeState.ROLLED_BACK].includes(oldState.state)) throw new ConflictError(`upgrade state is ${oldState.state}`); this.store.clearUpgradeState() } catch (error) { if (!(error instanceof NotFoundError) && error.code !== 'ERR_NOT_FOUND') throw error }
      if (!instances.length || instances.every(item => item.version === newVersion)) return
      const oldVersion = instances[0].version
      // Complete network-dependent preparation before disrupting any process.
      // Keep the old version ready too, so rollback needs no network access.
      if (this.prepareVersion) {
        for (const version of new Set(instances.map(item => item.version))) await this.prepareVersion(version)
        await this.prepareVersion(newVersion)
      }
      const state = { id: 'singleton', state: UpgradeState.PREPARED, old_version: oldVersion, new_version: newVersion, original_running: [], original_desired: {}, instance_stages: {}, message: '', updated_at: this.clock().toISOString() }
      try {
        for (const instance of instances) { state.original_desired[instance.id] = { desired_state: instance.desired_state, version: instance.version }; const status = await this.runtime.status(instance); if (status.state === ObservedState.UNKNOWN) throw new Error(`inspect ${instance.id}: runtime state is unknown`); state.instance_stages[instance.id] = status.state; if (instance.desired_state === DesiredState.RUNNING && [ObservedState.RUNNING, ObservedState.STARTING].includes(status.state)) state.original_running.push(instance.id) }
        this.persist(state); state.state = UpgradeState.STOPPING_OLD; this.persist(state)
        for (const instance of instances) { const status = await this.runtime.status(instance); if (!isStopped(status.state)) { state.instance_stages[instance.id] = 'stopping-old'; this.persist(state); await this.runtime.stop(instance); const stopped = await this.runtime.status(instance); if (!isStopped(stopped.state)) throw new Error(`confirm ${instance.id} stopped`) } state.instance_stages[instance.id] = 'old-stopped'; this.persist(state) }
        state.state = UpgradeState.OLD_STOPPED; this.persist(state); if (this.activator) await this.activator.activateVersion(newVersion)
        for (const instance of instances) { const current = this.store.getInstance(instance.id); const updated = { ...current, version: newVersion, revision: current.revision + 1, updated_at: this.clock().toISOString() }; await this.instances.prepareBinary(updated); this.store.updateInstance(updated, current.revision); await this.units?.install(updated); state.instance_stages[instance.id] = 'new-configured'; this.persist(state) }
        state.state = UpgradeState.STARTING_NEW; this.persist(state)
        for (const id of state.original_running) { const instance = this.store.getInstance(id); state.instance_stages[id] = 'starting-new'; this.persist(state); await this.instances.prepareBinary(instance); await this.runtime.start(instance); const status = await this.runtime.status(instance); if (![ObservedState.RUNNING, ObservedState.STARTING].includes(status.state)) throw new Error(`confirm ${id} ready`); state.instance_stages[id] = 'new-running'; this.persist(state) }
        state.state = UpgradeState.COMMITTED; this.persist(state); this.store.clearUpgradeState(); this.instances.defaultVersion = newVersion
      } catch (error) { await this.rollback(state, instances, error); throw error }
    })
  }
  async rollback(state, originalInstances, cause) {
    state.state = UpgradeState.RESTORING_OLD; state.message = cause.message; this.persist(state); let blocked = null
    for (const old of originalInstances) { try { const current = this.store.getInstance(old.id); const status = await this.runtime.status(current); if (!isStopped(status.state)) { await this.runtime.stop(current); const stopped = await this.runtime.status(current); if (!isStopped(stopped.state)) throw new Error(`instance ${old.id} did not stop`) } } catch (error) { blocked ||= error } }
    if (blocked) {
      state.state = UpgradeState.BLOCKED
      state.message = `${cause.message}; ${blocked.message}`
      this.persist(state)
      return
    }
    try { if (this.activator) await this.activator.activateVersion(state.old_version) } catch (error) { blocked ||= error }
    for (const old of originalInstances) { try { const current = this.store.getInstance(old.id); const originalVersion = state.original_desired?.[old.id]?.version || state.old_version; const restored = current.version !== originalVersion ? { ...current, version: originalVersion, revision: current.revision + 1, updated_at: this.clock().toISOString() } : current; await this.instances.prepareBinary(restored); if (restored !== current) { this.store.updateInstance(restored, current.revision); await this.units?.install(restored) } } catch (error) { blocked ||= error } }
    if (!blocked) for (const old of originalInstances) if (state.original_running.includes(old.id)) { try { const current = this.store.getInstance(old.id); await this.instances.prepareBinary(current); await this.runtime.start(current); const status = await this.runtime.status(current); if (![ObservedState.RUNNING, ObservedState.STARTING].includes(status.state)) throw new Error(`old ${old.id} did not start`) } catch (error) { blocked ||= error } }
    state.state = blocked ? UpgradeState.BLOCKED : UpgradeState.ROLLED_BACK; state.message = blocked ? `${cause.message}; ${blocked.message}` : cause.message; this.persist(state)
  }
  async recover() {
    return this.instances.operations.run('global', async () => {
    let state; try { state = this.store.getUpgradeState() } catch (error) { if (error.code === 'ERR_NOT_FOUND') return; throw error }
    if ([UpgradeState.COMMITTED, UpgradeState.ROLLED_BACK].includes(state.state)) { this.store.clearUpgradeState(); return }
    const recordedStageIds = Object.keys(state.instance_stages || {}); const recordedIds = new Set(recordedStageIds.length ? recordedStageIds : Object.keys(state.original_desired || {})); const instances = this.store.listInstances().filter(instance => !recordedIds.size || recordedIds.has(instance.id)); await this.rollback(state, instances, new Error('upgrade interrupted; recovered to old version'))
    })
  }
}
