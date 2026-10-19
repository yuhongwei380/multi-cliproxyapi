import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import { URL } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import { DesiredState, DiscoveryAccountId, ObservedState, isActive, isStopped, nowIso } from './domain.js'
import { checkPassword, hashPassword, hashToken, newToken } from './security.js'
import { NotFoundError, ConflictError } from './store.js'
import { unsupported } from './cpa.js'
import { prepareInstanceBinary } from './instance-binary.js'
import { editChildConfig } from './child-config.js'
import { backupMetadata, copyBackupTree, relocateBackupConfig } from './instance-backup.js'
import { recordRuntimeEvent } from './logging.js'

export const ErrInvalidCredentials = Object.assign(new Error('invalid credentials'), { code: 'ERR_INVALID_CREDENTIALS', status: 401 })
export const ErrRateLimited = Object.assign(new Error('too many authentication attempts'), { code: 'ERR_RATE_LIMITED', status: 429 })
export const ErrNotInitialized = Object.assign(new Error('administrator is not initialized'), { code: 'ERR_NOT_INITIALIZED', status: 503 })
export const ErrInvalidInstance = message => Object.assign(new Error(message || 'invalid instance'), { code: 'ERR_INVALID_INSTANCE', status: 400 })
export const ErrPortUnavailable = Object.assign(new Error('port is unavailable'), { code: 'ERR_PORT_UNAVAILABLE', status: 409 })
export const ErrStartNotConfirmed = message => Object.assign(new Error(message || 'instance start was not confirmed'), { code: 'ERR_START_NOT_CONFIRMED', status: 409 })
export const ErrStopNotConfirmed = message => Object.assign(new Error(message || 'instance stop was not confirmed'), { code: 'ERR_STOP_NOT_CONFIRMED', status: 409 })
export const ErrDeleteNotSafe = Object.assign(new Error('instance is not safe to delete'), { code: 'ERR_DELETE_NOT_SAFE', status: 409 })
export const ErrInvalidQuotaSettings = message => Object.assign(new Error(message || 'invalid quota settings'), { code: 'ERR_INVALID_QUOTA_SETTINGS', status: 400 })

class KeyedMutex {
  constructor() { this.queues = new Map() }
  async run(key, fn) {
    const previous = this.queues.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.queues.set(key, tail)
    await previous
    try { return await fn() } finally { release(); if (this.queues.get(key) === tail) this.queues.delete(key) }
  }
}

const validName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/
const validateName = name => { if (typeof name !== 'string' || !validName.test(name) || name.trim() !== name) throw ErrInvalidInstance('name must use letters, digits, spaces, ".", "_" or "-"') }
const validatePort = port => { if (!Number.isInteger(port) || port < 1024 || port > 65535) throw ErrInvalidInstance('port must be between 1024 and 65535') }
export const DEFAULT_CHILD_MANAGEMENT_PASSWORD = 'admin'
export const DEFAULT_CHILD_BIND_HOST = '0.0.0.0'
function managementPassword(value) {
  if (value === undefined || value === null || value === '') return { secret: DEFAULT_CHILD_MANAGEMENT_PASSWORD, configured: false }
  if (typeof value !== 'string') throw ErrInvalidInstance('management password must be a string')
  return { secret: value, configured: true }
}
const id = prefix => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const ensureDirectory = directory => { if (!directory) throw new Error('directory path is required'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = fs.lstatSync(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('directory path must be a real directory'); fs.chmodSync(directory, 0o700) }

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => { server.close(); resolve(false) })
    server.listen({ host: '0.0.0.0', port }, () => server.close(() => resolve(true)))
  })
}

export class AuthService {
  constructor(store, { now = () => new Date(), sessionTtlMs = 12 * 60 * 60 * 1000 } = {}) { this.store = store; this.now = now; this.sessionTtlMs = sessionTtlMs; this.failures = new Map() }
  initializeAdmin(password) { this.store.setAdminHash('admin', hashPassword(password)) }
  setAdminPassword(username = 'admin', password) { this.store.setAdminHash(username || 'admin', hashPassword(password)) }
  loginFailureKey(username, clientKey = 'local') {
    const client = typeof clientKey === 'string' && clientKey.length <= 128 ? clientKey : 'unknown'
    return `login:${client}:${username === 'admin' ? 'admin' : 'unknown'}`
  }
  checkBlocked(key) { const entry = this.failures.get(key); if (entry?.blockedUntil > this.now().getTime()) throw ErrRateLimited }
  recordFailure(key) { const current = this.now().getTime(); const entry = this.failures.get(key) || { times: [], blockedUntil: 0 }; entry.times = entry.times.filter(value => value > current - 15 * 60 * 1000); entry.times.push(current); if (entry.times.length >= 5) { entry.blockedUntil = current + 30 * 60 * 1000; entry.times = [] } this.failures.set(key, entry) }
  clearFailures(key) { this.failures.delete(key) }
  verifyPassword(password, failureKey = 'admin-change') {
    this.checkBlocked(failureKey)
    if (typeof password !== 'string' || password.length < 1 || password.length > 4096) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    let encoded
    try { encoded = this.store.getAdminHash('admin') } catch (error) { if (error.code === 'ERR_NOT_FOUND') throw ErrNotInitialized; throw error }
    if (!checkPassword(encoded, password)) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    this.clearFailures(failureKey)
  }
  login(username, password, clientKey = 'local') {
    const failureKey = this.loginFailureKey(username, clientKey); this.checkBlocked(failureKey)
    if (typeof username !== 'string' || username.length < 1 || username.length > 64 || typeof password !== 'string' || password.length < 1 || password.length > 4096) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    let encoded
    try { encoded = this.store.getAdminHash(username) } catch (error) { if (error.code === 'ERR_NOT_FOUND') { this.recordFailure(failureKey); throw ErrInvalidCredentials } throw error }
    if (!checkPassword(encoded, password)) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    this.clearFailures(failureKey)
    const token = newToken(); const expires = new Date(this.now().getTime() + this.sessionTtlMs)
    this.store.cleanupSessions?.(this.now().toISOString())
    this.store.createSession(hashToken(token), username, expires.toISOString())
    return { token, expires }
  }
  authenticate(token) {
    if (!token) throw ErrInvalidCredentials
    let session
    try { session = this.store.getSession(hashToken(token)) } catch (error) { if (error.code === 'ERR_NOT_FOUND') throw ErrInvalidCredentials; throw error }
    if (Date.parse(session.expiresAt) <= this.now().getTime()) { this.store.deleteSession(hashToken(token)); throw ErrInvalidCredentials }
    return session.username
  }
  logout(token) { if (token) this.store.deleteSession(hashToken(token)) }
  changeAdminPassword(currentPassword, newPassword) {
    this.verifyPassword(currentPassword, 'admin-change')
    if (typeof newPassword !== 'string' || newPassword.length < 1 || newPassword.length > 4096) throw ErrInvalidCredentials
    this.setAdminPassword('admin', newPassword)
  }
  verifyAdminPassword(password) {
    this.verifyPassword(password, 'admin-delete')
  }
}

export class InstanceService {
  constructor({ store, runtime, secrets, units, root, binaryByVersion = null, clock = () => new Date(), defaultVersion = '', requireVersion = true, healthCheck = null, maxInstances = 5 } = {}) {
    this.store = store; this.runtime = runtime; this.secrets = secrets; this.units = units; this.root = root; this.binaryByVersion = binaryByVersion; this.clock = clock; this.defaultVersion = defaultVersion; this.requireVersion = requireVersion; this.healthCheck = healthCheck; this.maxInstances = maxInstances; this.locks = new KeyedMutex(); this.operations = new KeyedMutex()
  }
  runtimeLog(level, instance, message, context = {}) {
    try { this.store.appendRuntimeLog?.({ level, source: 'instance', instance_id: instance?.id || '', message, context, created_at: this.clock().toISOString() }) } catch {}
  }
  assertUnlocked(instance) {
    if (instance.locked) throw new ConflictError(`实例「${instance.name}」已锁定，请先解锁`)
  }
  async setLocked(instanceId, locked) {
    return this.operations.run('global', () => this.withInstanceLock(instanceId, async () => {
      this.assertUpgradeIdle()
      const current = this.store.getInstance(instanceId)
      if (current.locked === locked) return current
      const next = { ...current, locked, revision: current.revision + 1, updated_at: this.clock().toISOString() }
      this.store.updateInstance(next, current.revision)
      return next
    }))
  }
  async prepareBinary(instance) { return prepareInstanceBinary(instance, this.binaryByVersion) }
  async withInstanceLock(instanceId, fn) { return this.locks.run(instanceId, fn) }
  assertUpgradeIdle() {
    this.pluginService?.assertIdle()
    let state
    try { state = this.store.getUpgradeState() } catch (error) { if (error.code === 'ERR_NOT_FOUND') return; throw error }
    if (!['committed', 'rolled-back'].includes(state.state)) throw new ConflictError(`upgrade state is ${state.state}; recover the upgrade first`)
  }
  async create(input) {
    return this.operations.run('global', () => { this.assertUpgradeIdle(); return this.createUnlocked(input) })
  }
  getLimits() {
    const limits = this.store.getInstanceLimits() || { max_instances: this.maxInstances, max_backups: 10 }
    const items = this.store.listInstances()
    return { ...limits, instances_used: items.filter(item => !item.is_backup).length, backups_used: items.filter(item => item.is_backup).length }
  }
  async updateLimits(input) {
    return this.operations.run('global', () => {
      this.assertUpgradeIdle()
      for (const key of ['max_instances', 'max_backups']) {
        if (!Number.isInteger(input?.[key]) || input[key] < 1 || input[key] > 1000) throw Object.assign(new Error('实例上限必须为 1 到 1000 的整数'), { status: 400 })
      }
      const current = this.getLimits()
      if (input.max_instances < current.instances_used || input.max_backups < current.backups_used) throw new ConflictError('上限不能低于当前已使用数量，请先删除不再需要的实例或备份')
      this.store.saveInstanceLimits({ max_instances: input.max_instances, max_backups: input.max_backups })
      return this.getLimits()
    })
  }
  assertCapacity(backup, count = 1) {
    const limits = this.getLimits()
    const maximum = backup ? limits.max_backups : limits.max_instances
    const used = backup ? limits.backups_used : limits.instances_used
    if (maximum > 0 && used + count > maximum) throw new ConflictError(`${backup ? '备份' : '普通'}实例名额不足：需要 ${count} 个，已使用 ${used}/${maximum}；请在管理员设置中调整上限或清理实例`)
  }
  // Call only while holding the global operation lock.
  async createUnlocked(input, initialize = null, { locked = false, backup = false } = {}) {
      ensureDirectory(this.root); ensureDirectory(path.join(this.root, 'instances'))
      validateName(input?.name); validatePort(input?.port)
      if (!(await portAvailable(input.port))) throw ErrPortUnavailable
      const childPassword = managementPassword(input?.management_password)
      const existing = this.store.listInstances(); this.assertCapacity(backup)
      if (existing.some(item => item.name.toLowerCase() === input.name.toLowerCase() || item.port === input.port)) throw new ConflictError()
      const version = input.version || this.defaultVersion || this.store.listVersions().find(item => item.usable)?.tag || existing[0]?.version || ''
      if (this.requireVersion && !version) throw new Error('no usable CPA version is installed')
      if (this.requireVersion) { const installed = this.store.getVersion(version); if (!installed.usable) throw new Error(`CPA version ${version} is not usable`) }
      if (!this.secrets) throw new Error('secret store is unavailable')
      const instanceId = id('cpa'); const directory = path.join(this.root, 'instances', instanceId); const timestamp = this.clock().toISOString()
      const instance = { id: instanceId, name: input.name, port: input.port, directory, is_backup: backup, desired_state: DesiredState.STOPPED, locked, version, revision: 1, created_at: timestamp, updated_at: timestamp, management_secret_ciphertext: this.secrets.encrypt(childPassword.secret) }
      try {
        ensureDirectory(directory); ensureDirectory(path.join(directory, 'auths')); ensureDirectory(path.join(directory, 'logs'))
        this.writeInitialConfig(instance, childPassword.secret)
        if (initialize) await initialize(instance)
        await this.prepareBinary(instance)
        this.store.createInstance(instance)
        await this.units?.install(instance)
        this.runtimeLog('info', instance, `instance ${instance.name} created`, { port: instance.port, version: instance.version })
        return instance
      } catch (error) { try { this.store.deleteInstance(instance.id) } catch {} try { fs.rmSync(directory, { recursive: true, force: true }) } catch {} try { await this.units?.unregister(instance) } catch {}; throw error }
  }
  async backup(instanceId, input) {
    return this.operations.run('global', () => { this.assertUpgradeIdle(); return this.backupUnlocked(instanceId, input) })
  }
  async backupUnlocked(instanceId, input, { automatic = false, reason = '' } = {}) {
    return this.withInstanceLock(instanceId, async () => {
      const source = this.store.getInstance(instanceId); this.assertUnlocked(source)
      if (path.resolve(source.directory) !== path.resolve(this.root, 'instances', source.id)) throw new ConflictError('unsafe source instance directory')
      const sourceStat = fs.lstatSync(source.directory)
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new ConflictError('source instance directory must be a real directory')
      const status = await this.runtime.status(source)
      if (!['running', 'stopped', 'failed'].includes(status.state)) throw new ConflictError(`cannot back up instance while state is ${status.state}`)
      const wasRunning = status.state === 'running'
      const secret = this.decryptManagementSecret(source)
      // Validate path isolation before interrupting the source runtime.
      if (!fs.existsSync(path.join(source.directory, 'config.yaml'))) throw new ConflictError('instance config missing')
      relocateBackupConfig(fs.readFileSync(path.join(source.directory, 'config.yaml'), 'utf8'), source.directory, source.directory)
      const backup = await this.createUnlocked({ name: input?.name, port: input?.port, version: source.version, management_password: secret }, async target => {
        let stopAttempted = false
        try {
          if (wasRunning) {
            stopAttempted = true; await this.runtime.stop(source)
            if (!isStopped((await this.runtime.status(source)).state)) throw ErrStopNotConfirmed('source did not stop before backup')
          }
          for (const entry of fs.readdirSync(source.directory)) {
            if (['logs', '.multi-cpa.pid', '.plugin-backups', '.multi-cpa-backup.json'].includes(entry)) continue
            copyBackupTree(path.join(source.directory, entry), path.join(target.directory, entry))
          }
          const file = path.join(target.directory, 'config.yaml')
          let config = relocateBackupConfig(fs.readFileSync(file, 'utf8'), source.directory, target.directory)
          config = editChildConfig(config, { port: target.port })
          fs.writeFileSync(file, config, { mode: 0o600 })
          fs.writeFileSync(path.join(target.directory, '.multi-cpa-backup.json'), JSON.stringify({ source_id: source.id, source_name: source.name, reason, automatic, created_at: this.clock().toISOString() }), { mode: 0o600 })
        } finally {
          if (stopAttempted) {
            try { await this.runtime.start(source); await this.confirmStarted(source) }
            catch (error) { this.runtimeLog('error', source, 'source restart after backup failed'); throw ErrStartNotConfirmed(`source restart after backup failed: ${error.message}`) }
          }
        }
      }, { locked: automatic, backup: true })
      this.store.inheritKeyBindings(source.id, backup.id)
      this.runtimeLog('info', backup, 'instance backup created', { source_instance_id: source.id, port: backup.port })
      return backup
    })
  }
  // Upgrade callers hold the global operation lock and freeze their targets
  // before adding backups. Every backup finishes before any upgrade begins.
  async automaticBackups(ids, reason, onSaved = () => {}, onStarting = () => {}) {
    const sources = ids.map(id => this.store.getInstance(id)).filter(item => !item.locked)
    this.assertCapacity(true, sources.length)
    const reserved = new Set(this.store.listInstances().map(item => item.port)); const plans = []
    for (const source of sources) {
      let port = 18317
      while (port <= 65535 && (reserved.has(port) || !(await portAvailable(port)))) port++
      if (port > 65535) throw ErrPortUnavailable
      reserved.add(port)
      plans.push({ source, port, name: `${source.name.slice(0, 30)}-backup-${this.clock().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 4)}` })
    }
    const backups = []
    for (const plan of plans) {
      await onStarting(plan.source.id)
      const backup = await this.backupUnlocked(plan.source.id, { name: plan.name, port: plan.port }, { automatic: true, reason })
      backups.push(backup); await onSaved(plan.source.id, backup)
      this.store.appendAuditLog?.({ actor: 'system', action: 'instance.backup', resource_type: 'instance', resource_id: backup.id, outcome: 'success', detail: `source=${plan.source.id}; reason=${reason}`, created_at: this.clock().toISOString() })
    }
    return backups
  }
  // Internal cleanup used after a successful upgrade/deployment. Automatic
  // backups are locked and inherit key bindings, so the normal administrator
  // deletion flow cannot be used for them.
  async removeAutomaticBackup(instanceId) {
    return this.withInstanceLock(instanceId, async () => {
      const instance = this.store.getInstance(instanceId)
      const metadata = backupMetadata(instance)
      if (!instance.is_backup || !metadata?.automatic) throw new ConflictError('instance is not an automatic backup')
      const expected = path.resolve(this.root, 'instances', instance.id)
      if (path.resolve(instance.directory) !== expected) throw ErrDeleteNotSafe
      if (!this.runtime) throw ErrDeleteNotSafe
      const status = await this.runtime.status(instance)
      if (!isStopped(status.state)) {
        await this.runtime.stop(instance)
        if (!isStopped((await this.runtime.status(instance)).state)) throw ErrDeleteNotSafe
      }
      await this.units?.unregister(instance)
      validateDeletePath(this.root, instance.directory)
      await fsp.rm(instance.directory, { recursive: true, force: true })
      this.store.deleteInstance(instance.id, { removeKeyBindings: true })
      this.runtimeLog('info', instance, 'automatic upgrade backup removed', { source_instance_id: metadata.source_id, reason: metadata.reason })
      return instance
    })
  }
  writeInitialConfig(instance, secret) {
    const file = path.join(instance.directory, 'config.yaml'); const temporary = `${file}.tmp`
    // CPA disables the management API when secret-key is empty.  Keep the
    // controller's default password (admin) explicit in the child config so
    // newly-created default instances are manageable as well.
    const secretLine = `  secret-key: ${JSON.stringify(secret)}\n`
    // Listen on every IPv4 interface so proxy and management endpoints are
    // reachable from the LAN. Access remains protected by the CPA keys.
    const yaml = `host: ${DEFAULT_CHILD_BIND_HOST}\nport: ${instance.port}\nauth-dir: ${JSON.stringify(path.join(instance.directory, 'auths'))}\nremote-management:\n  allow-remote: true\n${secretLine}  disable-control-panel: false\nplugins:\n  enabled: true\nlogging-to-file: true\n`
    fs.writeFileSync(temporary, yaml, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600)
  }
  ensureManagementConfig(instance) {
    if (!this.secrets) throw new Error('secret store is unavailable')
    const file = path.join(instance.directory, 'config.yaml')
    const original = fs.readFileSync(file, 'utf8')
    const secret = this.decryptManagementSecret(instance)
    const updated = editChildConfig(original, { host: DEFAULT_CHILD_BIND_HOST, secret, ensure: true })
    if (updated === original) return false
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, updated, { mode: 0o600 })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
    return true
  }
  async mutate(instanceId, kind, desired, action) {
    return this.operations.run('global', () => this.withInstanceLock(instanceId, async () => {
      this.pluginService?.assertIdle()
      if (kind !== 'stop') this.assertUpgradeIdle()
      let instance = this.store.getInstance(instanceId)
      if (['stop', 'restart'].includes(kind)) this.assertUnlocked(instance)
      if (desired && kind !== 'stop') { const next = { ...instance, desired_state: desired, revision: instance.revision + 1, updated_at: this.clock().toISOString() }; this.store.updateInstance(next, instance.revision); instance = next }
      const operation = { id: id('op'), kind, instance_id: instanceId, state: 'running', message: '', created_at: this.clock().toISOString(), updated_at: this.clock().toISOString() }
      this.store.saveOperation(operation)
      this.runtimeLog('info', instance, `instance ${kind} started`, { operation_id: operation.id })
      let error
      try { await action(instance); if (desired === DesiredState.STOPPED && kind === 'stop') { const next = { ...instance, desired_state: desired, revision: instance.revision + 1, updated_at: this.clock().toISOString() }; this.store.updateInstance(next, instance.revision) } }
      catch (cause) { error = cause }
      operation.updated_at = this.clock().toISOString(); operation.state = error ? 'failed' : 'succeeded'; operation.message = error?.message || ''; this.store.updateOperation(operation)
      this.runtimeLog(error ? 'error' : 'info', instance, error ? `instance ${kind} failed: ${error.message}` : `instance ${kind} succeeded`, { operation_id: operation.id })
      if (error) throw error
    }))
  }
  async startRuntime(instance, restart = false) {
    try {
      await this.prepareBinary(instance)
      this.ensureManagementConfig(instance)
      if (restart) await this.runtime.restart(instance)
      else await this.runtime.start(instance)
      await this.confirmStarted(instance)
    } catch (error) {
      if (error?.code === 'ERR_START_NOT_CONFIRMED') throw error
      throw ErrStartNotConfirmed(`start failed: ${error.message}`)
    }
  }
  async start(instanceId) { return this.mutate(instanceId, 'start', DesiredState.RUNNING, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.startRuntime(instance) }) }
  async stop(instanceId) { return this.mutate(instanceId, 'stop', DesiredState.STOPPED, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.runtime.stop(instance); const status = await this.runtime.status(instance); if (!isStopped(status.state)) throw ErrStopNotConfirmed(`observed state ${status.state}`) }) }
  async restart(instanceId) { return this.mutate(instanceId, 'restart', DesiredState.RUNNING, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.startRuntime(instance, true) }) }
  async confirmStarted(instance) { const status = await this.runtime.status(instance); if (![ObservedState.RUNNING, ObservedState.STARTING].includes(status.state)) throw ErrStartNotConfirmed(`observed state ${status.state}`) }
  async status(instanceId) {
    return this.withInstanceLock(instanceId, async () => {
      const instance = this.store.getInstance(instanceId); let status
      if (!this.runtime) status = { instance_id: instance.id, state: ObservedState.UNKNOWN, ready: false, version: instance.version, message: 'runtime unavailable' }
      else status = { ...await this.runtime.status(instance) }
      // Runtime adapters may reuse their status object. Never retain a previous
      // successful health result after the management API becomes unavailable.
      delete status.management_ready
      delete status.management_message
      if (this.healthCheck && status.state === ObservedState.RUNNING) { try { await this.healthCheck(instance); status.management_ready = true } catch (error) { status.management_message = error.message } }
      return status
    })
  }
  async list() { const instances = this.store.listInstances(); return Promise.all(instances.map(async instance => ({ ...instance, backup: backupMetadata(instance), status: await this.status(instance.id) }))) }
  async update(instanceId, input) {
    return this.operations.run('global', () => this.withInstanceLock(instanceId, async () => {
      this.assertUpgradeIdle()
      const current = this.store.getInstance(instanceId); this.assertUnlocked(current); const expected = input.expected_revision || current.revision; if (expected !== current.revision) throw new ConflictError('instance revision conflict'); const next = { ...current }
      await this.prepareBinary(current)
      const passwordProvided = Object.prototype.hasOwnProperty.call(input, 'management_password') && input.management_password !== undefined && input.management_password !== null && input.management_password !== ''
      if (Object.prototype.hasOwnProperty.call(input, 'management_password') && input.management_password !== undefined && input.management_password !== null && typeof input.management_password !== 'string') throw ErrInvalidInstance('management password must be a string')
      const passwordChanged = passwordProvided
      if (passwordChanged) { if (!this.secrets) throw new Error('secret store is unavailable'); next.management_secret_ciphertext = this.secrets.encrypt(input.management_password) }
      if (input.name !== undefined) { validateName(input.name); if (input.name.toLowerCase() !== current.name.toLowerCase() && this.store.listInstances().some(item => item.id !== instanceId && item.name.toLowerCase() === input.name.toLowerCase())) throw new ConflictError(); next.name = input.name }
      let wasRunning = false; let originalConfig = null
      const portChanged = input.port !== undefined && input.port !== current.port
      if (portChanged || passwordChanged) {
        if (!this.runtime) throw new Error('runtime unavailable')
        if (portChanged) { validatePort(input.port); if (this.store.listInstances().some(item => item.id !== instanceId && item.port === input.port) || !(await portAvailable(input.port))) throw ErrPortUnavailable }
        originalConfig = fs.readFileSync(path.join(current.directory, 'config.yaml')); const status = await this.runtime.status(current)
        if (status.state === ObservedState.UNKNOWN) throw new ConflictError(`cannot update instance while state is ${status.state}`)
        wasRunning = isActive(status.state); if (wasRunning) { await this.runtime.stop(current); const stopped = await this.runtime.status(current); if (!isStopped(stopped.state)) throw new ConflictError('instance did not stop before port change') }
        try {
          const updated = editChildConfig(originalConfig.toString(), {
            port: portChanged ? input.port : undefined,
            secret: input.management_password,
            replaceSecret: passwordChanged
          })
          const temporary = path.join(current.directory, 'config.yaml.tmp'); fs.writeFileSync(temporary, updated, { mode: 0o600 }); fs.renameSync(temporary, path.join(current.directory, 'config.yaml')); if (portChanged) next.port = input.port
        }
        catch (error) { fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 }); if (wasRunning) await this.startRuntime(current); throw error }
      }
      if (next.name === current.name && next.port === current.port && !passwordChanged) return current
      next.revision = current.revision + 1; next.updated_at = this.clock().toISOString()
      try { this.store.updateInstance(next, current.revision) } catch (error) { if (originalConfig) fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 }); if (wasRunning) await this.startRuntime(current); throw error }
      if (wasRunning) {
        const updated = this.store.getInstance(instanceId)
        try { await this.startRuntime(updated) }
        catch (error) {
          try {
            await this.runtime.stop(updated)
            if (!isStopped((await this.runtime.status(updated)).state)) throw ErrStopNotConfirmed('new configuration process did not stop')
            fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 })
            const restored = { ...current, revision: updated.revision + 1, updated_at: this.clock().toISOString() }
            this.store.updateInstance(restored, updated.revision)
            await this.startRuntime(restored)
            this.runtimeLog('warn', restored, 'configuration update failed; previous configuration restored')
          } catch (recoveryError) {
            this.runtimeLog('error', updated, 'configuration update recovery failed')
            throw ErrStartNotConfirmed(`${error.message}; restore failed: ${recoveryError.message}`)
          }
          throw error
        }
      }
      return this.store.getInstance(instanceId)
    }))
  }
  async reconcileDesired() {
    return this.operations.run('global', async () => {
    this.assertUpgradeIdle()
    let firstError = null
    for (const instance of this.store.listInstances()) {
      try {
        await this.withInstanceLock(instance.id, async () => {
          const status = await this.runtime.status(instance)
          // Reattaching a controller must not migrate or restart a live child.
          // Prepare configuration and binaries only when a child needs starting.
          if (instance.desired_state === DesiredState.RUNNING && isStopped(status.state)) await this.startRuntime(instance)
        })
      } catch (error) { firstError ||= error }
    }
    if (firstError) throw firstError
    })
  }
  decryptManagementSecret(instance) { if (!this.secrets) throw new Error('secret store unavailable'); return this.secrets.decrypt(instance.management_secret_ciphertext) }
  setDefaultVersionAfterInstall(version) {
    if (version) this.defaultVersion = version
  }
}

export class DeleteService {
  constructor({ store, runtime, units, instances, auth, clock = () => new Date(), challengeTtlMs = 10 * 60 * 1000 } = {}) { this.store = store; this.runtime = runtime; this.units = units; this.instances = instances; this.auth = auth; this.clock = clock; this.challengeTtlMs = challengeTtlMs; this.running = new Set() }
  preview(instanceId) { const instance = this.store.getInstance(instanceId); this.instances.assertUnlocked(instance); const challenge = { id: id('del'), instance_id: instance.id, revision: instance.revision, expires_at: new Date(this.clock().getTime() + this.challengeTtlMs).toISOString() }; this.store.createDeleteChallenge(challenge); return challenge }
  async confirm(instanceId, challengeId, password) {
    if (!this.auth) throw new Error('authentication service unavailable'); this.auth.verifyAdminPassword(password); if (this.running.has(instanceId)) throw new Error('delete already in progress'); this.running.add(instanceId)
    try {
      return await this.instances.operations.run('global', () => this.instances.withInstanceLock(instanceId, async () => {
        this.instances.pluginService?.assertIdle()
        const instance = this.store.getInstance(instanceId); this.instances.assertUnlocked(instance); this.store.consumeDeleteChallenge(challengeId, instanceId, instance.revision, this.clock().toISOString()); const operation = { id: id('op'), kind: 'delete', instance_id: instanceId, state: 'running', message: '', created_at: this.clock().toISOString(), updated_at: this.clock().toISOString() }; this.store.saveOperation(operation)
        try { await this.remove(instance); operation.state = 'succeeded'; operation.updated_at = this.clock().toISOString(); this.store.updateOperation(operation) }
        catch (error) { operation.state = 'failed'; operation.message = error.message; operation.updated_at = this.clock().toISOString(); this.store.updateOperation(operation); throw error }
      }))
    } finally { this.running.delete(instanceId) }
  }
  async remove(instance) {
    const expected = path.resolve(this.instances.root, 'instances', instance.id); if (path.resolve(instance.directory) !== expected) throw ErrDeleteNotSafe
    if (!this.runtime) throw ErrDeleteNotSafe
    let status = await this.runtime.status(instance); if (!isStopped(status.state)) { await this.runtime.stop(instance); status = await this.runtime.status(instance); if (!isStopped(status.state)) throw ErrDeleteNotSafe }
    await this.units?.unregister(instance)
    validateDeletePath(this.instances.root, instance.directory)
    await fsp.rm(instance.directory, { recursive: true, force: true })
    // The process and its configuration are gone; no CPA call is needed to
    // revoke keys on this instance. Keep bindings until removal succeeds.
    this.store.deleteInstance(instance.id, { removeKeyBindings: true })
  }
}

function validateDeletePath(root, target) {
  const rootAbs = path.resolve(root); const targetAbs = path.resolve(target); const relative = path.relative(rootAbs, targetAbs)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw ErrDeleteNotSafe
  let current = rootAbs
  for (const component of relative.split(path.sep)) { if (!component || component === '.') continue; current = path.join(current, component); let info; try { info = fs.lstatSync(current) } catch (error) { if (error.code === 'ENOENT') return; throw error } if (info.isSymbolicLink() || !info.isDirectory()) throw ErrDeleteNotSafe }
}

export const DEFAULT_QUOTA_SETTINGS = Object.freeze({ refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false })
export const QUOTA_NOTIFICATION_TIMEZONE = 'UTC+8'
export const QUOTA_NOTIFICATION_WORK_WINDOWS = Object.freeze([{ start: '09:00', end: '12:00' }, { start: '13:30', end: '18:00' }])

function validateQuotaSettings(input, current = DEFAULT_QUOTA_SETTINGS) {
  const next = { ...current }
  if (input.refresh_interval_minutes !== undefined) {
    const value = Number(input.refresh_interval_minutes)
    if (!Number.isInteger(value) || value < 1 || value > 10080) throw ErrInvalidQuotaSettings('refresh interval must be between 1 and 10080 minutes')
    next.refresh_interval_minutes = value
  }
  if (input.webhook_enabled !== undefined) {
    if (typeof input.webhook_enabled !== 'boolean') throw ErrInvalidQuotaSettings('webhook_enabled must be boolean')
    next.webhook_enabled = input.webhook_enabled
  }
  if (input.webhook_url !== undefined) {
    if (typeof input.webhook_url !== 'string') throw ErrInvalidQuotaSettings('webhook_url must be a string')
    const url = input.webhook_url.trim()
    if (url) {
      let parsed
      try { parsed = new URL(url) } catch { throw ErrInvalidQuotaSettings('webhook_url must be a valid HTTP(S) URL') }
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'oapi.dingtalk.com' || parsed.port || parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/robot/send' || !parsed.searchParams.get('access_token')) throw ErrInvalidQuotaSettings('webhook_url must be a DingTalk HTTPS robot URL with an access_token')
    }
    next.webhook_url = url
  }
  if (input.webhook_signing_enabled !== undefined) {
    if (typeof input.webhook_signing_enabled !== 'boolean') throw ErrInvalidQuotaSettings('webhook_signing_enabled must be boolean')
    next.webhook_signing_enabled = input.webhook_signing_enabled
  }
  if (input.webhook_secret !== undefined) {
    if (typeof input.webhook_secret !== 'string') throw ErrInvalidQuotaSettings('webhook_secret must be a string')
    if (input.webhook_secret.length > 256) throw ErrInvalidQuotaSettings('webhook_secret must be 256 characters or fewer')
    next.webhook_secret = input.webhook_secret
    next.webhook_secret_configured = Boolean(input.webhook_secret)
  }
  if (input.alert_threshold_percent !== undefined) {
    const value = Number(input.alert_threshold_percent)
    if (!Number.isFinite(value) || value < 0 || value > 100) throw ErrInvalidQuotaSettings('alert threshold must be between 0 and 100 percent')
    next.alert_threshold_percent = Math.round(value * 100) / 100
  }
  if (next.webhook_enabled && !next.webhook_url) throw ErrInvalidQuotaSettings('webhook_url is required when webhook notifications are enabled')
  if (next.webhook_signing_enabled && !next.webhook_secret) throw ErrInvalidQuotaSettings('webhook_secret is required when webhook signing is enabled')
  return next
}

export class DingTalkNotifier {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 10000, clock = () => Date.now() } = {}) { this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.clock = clock }
  signedWebhookUrl(settings) {
    if (!settings.webhook_signing_enabled) return settings.webhook_url
    if (!settings.webhook_secret) throw new Error('webhook signing secret is unavailable')
    const now = this.clock(); const timestamp = String(now instanceof Date ? now.getTime() : now)
    const sign = crypto.createHmac('sha256', settings.webhook_secret).update(`${timestamp}\n${settings.webhook_secret}`).digest('base64')
    const url = new URL(settings.webhook_url)
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('sign', sign)
    return url.toString()
  }
  async notify(settings, message) {
    if (!settings.webhook_enabled || !settings.webhook_url) return false
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.signedWebhookUrl(settings), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: message } }), signal: controller.signal })
      if (!response.ok) throw new Error(`DingTalk webhook returned HTTP ${response.status}`)
      let payload = null
      try { payload = await response.json() } catch {}
      if (!payload || ![0, '0'].includes(payload.errcode)) throw new Error('DingTalk webhook did not confirm delivery')
      return true
    } finally { clearTimeout(timer) }
  }
}

function quotaPercent(value) {
  if (value?.remaining == null || value?.total == null) return null
  const remaining = Number(value?.remaining); const total = Number(value?.total)
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, remaining / total * 100))
}

export const QUOTA_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 60 * 1000

function quotaNotificationKey(instanceId, snapshot, value) {
  return JSON.stringify([instanceId, snapshot.account_id || '', snapshot.provider || '', value?.name || '默认窗口'])
}

function formatQuotaResetNotice(resetAt) {
  const millis = Date.parse(resetAt || '')
  if (!Number.isFinite(millis)) return '，额度刷新时间未提供'
  const utc8 = new Date(millis + 8 * 60 * 60 * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `，额度刷新时间 ${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth() + 1)}-${pad(utc8.getUTCDate())} ${pad(utc8.getUTCHours())}:${pad(utc8.getUTCMinutes())}（UTC+8）`
}

function formatQuotaNotification(items, test = false) {
  const lines = items.map(({ instance, snapshot, value, percent, message }) => `${instance.name} / ${snapshot.provider || 'OAuth'} ${snapshot.account_id} / ${value?.name || '默认窗口'}：${message || (percent === null ? '额度未提供' : `剩余 ${percent.toFixed(1)}%`)}${formatQuotaResetNotice(value?.reset_at)}`)
  return `${test ? '【测试消息】' : ''}CLIProxyAPI 配额告警\n${lines.join('\n')}`
}

export function isQuotaNotificationWorkTime(value = new Date()) {
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(millis)) return false
  const utc8 = new Date(millis + 8 * 60 * 60 * 1000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 13 * 60 + 30 && minutes < 18 * 60)
}

export class QuotaService {
  constructor({ store, instances, clients, secrets = null, clock = () => new Date(), refreshIntervalMs = 6 * 60 * 60 * 1000, maxConcurrent = 3, notifier = null } = {}) { this.store = store; this.instances = instances; this.clients = clients; this.secrets = secrets; this.clock = clock; this.refreshIntervalMs = refreshIntervalMs; this.maxConcurrent = maxConcurrent; this.notifier = notifier || new DingTalkNotifier(); this.running = new Set(); this.notificationSentAt = new Map(); this.migrateLegacyWebhookUrl() }
  getSettings() {
    const settings = typeof this.store.getQuotaSettings === 'function' ? this.store.getQuotaSettings() : { refresh_interval_minutes: Math.max(1, Math.round(this.refreshIntervalMs / 60000)) }
    const safe = { ...settings }; delete safe.webhook_secret; delete safe.webhook_signing_secret_ciphertext; delete safe.webhook_url_ciphertext; delete safe.webhook_url_legacy; delete safe.webhook_url; delete safe.targets_configured
    return { ...DEFAULT_QUOTA_SETTINGS, ...safe, instance_ids: Array.isArray(settings.instance_ids) ? settings.instance_ids : [], webhook_url: '', webhook_url_configured: Boolean(settings.webhook_url_configured || settings.webhook_url), webhook_secret_configured: Boolean(settings.webhook_secret_configured) }
  }
  storedSettings() {
    if (typeof this.store.getQuotaSettings !== 'function') return { ...this.getSettings(), webhook_signing_secret_ciphertext: '', webhook_url_ciphertext: '', webhook_url_legacy: '' }
    return this.store.getQuotaSettings({ includeSecretCiphertext: true })
  }
  migrateLegacyWebhookUrl() {
    if (typeof this.store?.getQuotaSettings !== 'function' || typeof this.store?.saveQuotaSettings !== 'function') return
    const stored = this.storedSettings()
    if (!stored.webhook_url_legacy || stored.webhook_url_ciphertext) return
    let webhookUrl = ''
    try { webhookUrl = validateQuotaSettings({ webhook_url: stored.webhook_url_legacy }, { ...DEFAULT_QUOTA_SETTINGS }).webhook_url } catch {}
    if (webhookUrl && !this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
    this.store.saveQuotaSettings({ ...stored, webhook_enabled: webhookUrl ? stored.webhook_enabled : false, webhook_url: '', webhook_url_ciphertext: webhookUrl ? this.secrets.encrypt(webhookUrl) : '' })
  }
  settingsWithSecret() {
    const stored = this.storedSettings(); let secret = ''; let webhookUrl = stored.webhook_url_legacy || ''
    if (stored.webhook_signing_secret_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      secret = this.secrets.decrypt(stored.webhook_signing_secret_ciphertext)
    }
    if (stored.webhook_url_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      webhookUrl = this.secrets.decrypt(stored.webhook_url_ciphertext)
    }
    const safe = { ...stored }; delete safe.webhook_signing_secret_ciphertext; delete safe.webhook_url_ciphertext; delete safe.webhook_url_legacy
    return { ...DEFAULT_QUOTA_SETTINGS, ...safe, webhook_url: webhookUrl, webhook_url_configured: Boolean(webhookUrl), webhook_secret: secret, webhook_secret_configured: Boolean(secret) }
  }
  instanceSettingsWithSecret(instanceId) {
    const instance = this.store.getInstance(instanceId); const global = this.settingsWithSecret(); const stored = this.store.getQuotaInstanceSettings?.(instanceId, { includeSecrets: true })
    if (!stored) return { ...global, instance_id: instance.id, instance_name: instance.name, instance_port: instance.port, configured: false }
    let secret = ''; let webhookUrl = ''
    if (stored.webhook_signing_secret_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      secret = this.secrets.decrypt(stored.webhook_signing_secret_ciphertext)
    }
    if (stored.webhook_url_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      webhookUrl = this.secrets.decrypt(stored.webhook_url_ciphertext)
    }
    return { ...DEFAULT_QUOTA_SETTINGS, ...stored, instance_id: instance.id, instance_name: instance.name, instance_port: instance.port, configured: true, webhook_url: webhookUrl, webhook_url_configured: Boolean(webhookUrl), webhook_secret: secret, webhook_secret_configured: Boolean(secret) }
  }
  publicInstanceNotificationSettings(instance) {
    const settings = this.instanceSettingsWithSecret(instance.id); const safe = { ...settings }
    delete safe.webhook_url; delete safe.webhook_secret; delete safe.webhook_signing_secret_ciphertext; delete safe.webhook_url_ciphertext; delete safe.instance_ids; delete safe.targets_configured
    return { ...safe, timezone: QUOTA_NOTIFICATION_TIMEZONE, work_windows: QUOTA_NOTIFICATION_WORK_WINDOWS }
  }
  listNotificationSettings() { return this.store.listInstances().map(instance => this.publicInstanceNotificationSettings(instance)) }
  updateNotificationSettings(instanceId, input = {}) {
    const current = this.instanceSettingsWithSecret(instanceId); const stored = this.store.getQuotaInstanceSettings?.(instanceId, { includeSecrets: true }); const next = validateQuotaSettings(input, current); const hasSecret = Object.prototype.hasOwnProperty.call(input, 'webhook_secret'); const hasUrl = Object.prototype.hasOwnProperty.call(input, 'webhook_url')
    let ciphertext = stored?.webhook_signing_secret_ciphertext || ''; let urlCiphertext = stored?.webhook_url_ciphertext || ''
    if (!stored && current.webhook_secret && !ciphertext && this.secrets?.encrypt) ciphertext = this.secrets.encrypt(current.webhook_secret)
    if (!stored && current.webhook_url && !urlCiphertext && this.secrets?.encrypt) urlCiphertext = this.secrets.encrypt(current.webhook_url)
    if (hasSecret) {
      if (next.webhook_secret) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        ciphertext = this.secrets.encrypt(next.webhook_secret)
      } else ciphertext = ''
    }
    if (hasUrl || (!urlCiphertext && next.webhook_url)) {
      if (next.webhook_url) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        urlCiphertext = this.secrets.encrypt(next.webhook_url)
      } else urlCiphertext = ''
    }
    delete next.webhook_secret; delete next.webhook_signing_secret_ciphertext; delete next.webhook_url_ciphertext; delete next.webhook_url_legacy; delete next.instance_id; delete next.instance_name; delete next.instance_port; delete next.configured
    this.store.saveQuotaInstanceSettings({ ...next, instance_id: instanceId, webhook_url: '', webhook_url_ciphertext: urlCiphertext, webhook_signing_secret_ciphertext: ciphertext })
    recordRuntimeEvent(this.store, 'quota', '实例额度通知配置已更新', { event: 'quota.settings.updated', instanceId, enabled: next.webhook_enabled })
    if (typeof this.store.listQuotaGlobalInstanceIds === 'function' && typeof this.store.saveQuotaGlobalInstanceIds === 'function') this.store.saveQuotaGlobalInstanceIds(this.store.listQuotaGlobalInstanceIds().filter(id => id !== instanceId))
    this.wakeScheduler?.()
    return this.publicInstanceNotificationSettings(this.store.getInstance(instanceId))
  }
  deleteNotificationSettings(instanceId) {
    const instance = this.store.getInstance(instanceId)
    this.store.deleteQuotaInstanceSettings?.(instanceId)
    recordRuntimeEvent(this.store, 'quota', '实例额度通知配置已移除，恢复全局配置', { event: 'quota.settings.deleted', instanceId })
    this.wakeScheduler?.()
    return this.publicInstanceNotificationSettings(instance)
  }
  async sendTestNotification(instanceId = '') {
    recordRuntimeEvent(this.store, 'quota', '额度测试通知开始：读取当前额度和重置时间', { event: 'quota.test.started', instanceId, mode: 'test' })
    try {
      const settings = instanceId ? this.instanceSettingsWithSecret(instanceId) : this.settingsWithSecret()
      if (!settings.webhook_enabled) throw Object.assign(new Error(instanceId ? '该实例的钉钉机器人通知未启用' : '全局钉钉机器人通知未启用'), { status: 400 })
      if (!settings.webhook_url) throw Object.assign(new Error('尚未配置钉钉机器人 Webhook 地址'), { status: 400 })
      const globalIds = new Set(settings.instance_ids || [])
      const customIds = new Set(this.store.listQuotaInstanceSettingIds?.() || [])
      const targets = instanceId ? [this.store.getInstance(instanceId)] : this.store.listInstances().filter(instance => globalIds.has(instance.id) && !customIds.has(instance.id))
      if (!targets.length) throw Object.assign(new Error('请先选择下发到 CPA 实例并保存配置'), { status: 400 })
      const items = []
      for (const instance of targets) {
        const snapshots = await this.refreshInstance(instance.id, undefined, { notify: false })
        if (!snapshots.length) items.push({ instance, snapshot: { account_id: 'OAuth 账户' }, percent: null, message: '未配置 OAuth 账户' })
        for (const snapshot of snapshots) {
          if (snapshot.status !== 'ok') {
            items.push({ instance, snapshot, percent: null, message: snapshot.status === 'unsupported' ? '不支持读取额度' : '额度读取失败' })
            continue
          }
          const values = snapshot.values || []
          const weekly = values.filter(value => /周|week|seven_day|7d/i.test(value.name || ''))
          // Some plans only expose rolling and monthly quotas. Keep their real windows and reset times.
          const windows = weekly.length ? weekly : values
          if (!windows.length) items.push({ instance, snapshot, percent: null, message: '未提供额度' })
          for (const value of windows) items.push({ instance, snapshot, value, percent: quotaPercent(value) })
        }
      }
      const sent = await this.notifier.notify(settings, formatQuotaNotification(items, true))
      if (!sent) throw Object.assign(new Error('测试消息未发送，请检查 Webhook 配置'), { status: 502 })
      recordRuntimeEvent(this.store, 'quota', '额度测试通知发送成功', { event: 'quota.test.sent', instanceId, mode: 'test', instances: targets.length, windows: items.length })
      return { status: 'sent', instance_id: instanceId || '' }
    } catch (error) {
      recordRuntimeEvent(this.store, 'quota', '额度测试通知失败，请检查通知配置、实例状态及网络', { event: 'quota.test.failed', instanceId, mode: 'test', level: 'error' })
      throw error
    }
  }
  updateSettings(input = {}) {
    const current = this.settingsWithSecret(); const stored = this.storedSettings(); const next = validateQuotaSettings(input, current); const hasSecret = Object.prototype.hasOwnProperty.call(input, 'webhook_secret'); const hasUrl = Object.prototype.hasOwnProperty.call(input, 'webhook_url'); const hasInstanceIds = Object.prototype.hasOwnProperty.call(input, 'instance_ids')
    let instanceIds = current.instance_ids || []
    if (hasInstanceIds) {
      if (!Array.isArray(input.instance_ids) || input.instance_ids.some(id => typeof id !== 'string')) throw ErrInvalidQuotaSettings('instance_ids must be an array of CPA instance IDs')
      const available = new Set(this.store.listInstances().map(instance => instance.id)); const configured = new Set(this.store.listQuotaInstanceSettingIds?.() || [])
      instanceIds = [...new Set(input.instance_ids)].filter(id => available.has(id) && !configured.has(id))
      if (instanceIds.length !== new Set(input.instance_ids).size) throw ErrInvalidQuotaSettings('instance_ids contains an unknown or separately configured CPA instance')
    }
    let ciphertext = stored.webhook_signing_secret_ciphertext || ''
    let urlCiphertext = stored.webhook_url_ciphertext || ''
    if (hasSecret) {
      if (next.webhook_secret) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        ciphertext = this.secrets.encrypt(next.webhook_secret)
      } else ciphertext = ''
    }
    if (hasUrl || (!urlCiphertext && next.webhook_url)) {
      if (next.webhook_url) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        urlCiphertext = this.secrets.encrypt(next.webhook_url)
      } else urlCiphertext = ''
    }
    delete next.webhook_secret; delete next.webhook_signing_secret_ciphertext; delete next.webhook_url_ciphertext; delete next.webhook_url_legacy; delete next.instance_ids; delete next.targets_configured
    const targetInput = hasInstanceIds ? { instance_ids: instanceIds } : {}
    const saved = typeof this.store.saveQuotaSettings === 'function' ? this.store.saveQuotaSettings({ ...next, ...targetInput, webhook_url: '', webhook_url_ciphertext: urlCiphertext, webhook_signing_secret_ciphertext: ciphertext }) : { ...DEFAULT_QUOTA_SETTINGS, ...next, ...targetInput, webhook_url: '', webhook_url_configured: Boolean(urlCiphertext), webhook_secret_configured: Boolean(ciphertext) }
    recordRuntimeEvent(this.store, 'quota', '全局额度通知配置已更新', { event: 'quota.settings.updated', enabled: next.webhook_enabled, instances: instanceIds.length })
    if (next.refresh_interval_minutes !== current.refresh_interval_minutes) this.wakeScheduler?.()
    return typeof this.store.getQuotaSettings === 'function' ? this.getSettings() : saved
  }
  intervalMs(instanceId = null) { const settings = instanceId ? this.instanceSettingsWithSecret(instanceId) : this.getSettings(); return Math.max(60000, Number(settings.refresh_interval_minutes) * 60000) }
  scheduledInstances() {
    const globalIds = new Set(this.getSettings().instance_ids || []); const customIds = new Set(this.store.listQuotaInstanceSettingIds?.() || [])
    return this.store.listInstances().filter(instance => globalIds.has(instance.id) || customIds.has(instance.id))
  }
  schedulerIntervalMs() {
    const instances = this.scheduledInstances()
    return instances.length ? Math.min(...instances.map(instance => this.intervalMs(instance.id))) : this.intervalMs()
  }
  notificationCoolingDown(key, now) {
    const sentAt = typeof this.store.getQuotaNotification === 'function' ? this.store.getQuotaNotification(key) : this.notificationSentAt.get(key) || ''
    const timestamp = Date.parse(sentAt)
    return Number.isFinite(timestamp) && now - timestamp < QUOTA_NOTIFICATION_COOLDOWN_MS
  }
  rememberNotification(key, sentAt) {
    if (typeof this.store.saveQuotaNotification === 'function') this.store.saveQuotaNotification(key, sentAt)
    else this.notificationSentAt.set(key, sentAt)
  }
  async refreshInstance(instanceId, signal, { notify = true } = {}) {
    if (this.running.has(instanceId)) throw new Error('quota refresh already in progress'); this.running.add(instanceId)
    try {
      return await this.instances.operations.run('global', () => this.instances.withInstanceLock(instanceId, async () => {
        signal?.throwIfAborted()
        const instance = this.store.getInstance(instanceId); const attempt = this.clock().toISOString(); let client
        if (this.instances.runtime && isStopped((await this.instances.runtime.status(instance)).state)) {
          const error = Object.assign(new Error('instance is stopped; start it before refreshing quotas'), { status: 409 })
          this.markDiscoveryFailure(instanceId, attempt, error)
          throw error
        }
        try { if (!this.clients) throw new Error('CPA client factory unavailable'); client = await this.clients(instance); const accounts = await client.listAccounts(signal); const previous = this.store.listQuotas(instanceId); const previousBy = new Map(previous.map(item => [item.account_id, item])); if (!accounts.length) { this.store.saveQuota({ instance_id: instanceId, account_id: DiscoveryAccountId, provider: '', values: [], status: 'empty', message: 'no OAuth accounts configured', attempted_at: attempt, collected_at: attempt }) }
          const results = []; let index = 0; const worker = async () => { while (index < accounts.length) { const account = accounts[index++]; let snapshot; try { snapshot = await client.fetchQuota(account, signal); snapshot = { ...snapshot, instance_id: instanceId, account_id: account.id, provider: account.provider || '', attempted_at: attempt, status: 'ok', collected_at: attempt } } catch (error) { const old = previousBy.get(account.id); snapshot = { instance_id: instanceId, account_id: account.id, provider: account.provider || '', values: old?.values || [], collected_at: old?.collected_at || '', attempted_at: attempt, status: error.code === 'ERR_UNSUPPORTED' ? 'unsupported' : 'failed', message: error.code === 'ERR_UNSUPPORTED' ? 'quota endpoint is not supported for this account' : error.message } } results.push(snapshot) } }
          await Promise.all(Array.from({ length: Math.max(1, Math.min(this.maxConcurrent, accounts.length || 1)) }, worker)); for (const snapshot of results) this.store.saveQuota(snapshot)
          const failedAccounts = results.filter(item => item.status !== 'ok').length
          recordRuntimeEvent(this.store, 'quota', failedAccounts ? '额度刷新完成，部分账户读取失败或不支持' : '额度刷新完成', { event: 'quota.refresh.completed', instanceId, accounts: results.length, failed: failedAccounts, level: failedAccounts ? 'warn' : 'info' })
          const settings = this.instanceSettingsWithSecret(instanceId); const alertAt = Date.parse(attempt)
          const low = results.filter(snapshot => snapshot.status === 'ok').flatMap(snapshot => (snapshot.values || []).map(value => ({ snapshot, value, percent: quotaPercent(value) })).filter(item => item.percent !== null && item.percent < settings.alert_threshold_percent))
          const pendingNotifications = low.map(item => ({ ...item, key: quotaNotificationKey(instanceId, item.snapshot, item.value) })).filter(item => !this.notificationCoolingDown(item.key, alertAt))
          if (notify && pendingNotifications.length && isQuotaNotificationWorkTime(new Date(attempt)) && this.notifier && settings.webhook_enabled && settings.webhook_url) {
            recordRuntimeEvent(this.store, 'quota', '额度通知开始发送', { event: 'quota.notification.started', instanceId, mode: 'scheduled', windows: pendingNotifications.length })
            try {
              const delivered = await this.notifier.notify(settings, formatQuotaNotification(pendingNotifications.map(item => ({ ...item, instance }))))
              if (delivered !== false) for (const item of pendingNotifications) this.rememberNotification(item.key, attempt)
              recordRuntimeEvent(this.store, 'quota', delivered === false ? '额度通知未发送，请检查通知配置' : '额度通知发送成功', { event: delivered === false ? 'quota.notification.failed' : 'quota.notification.sent', instanceId, mode: 'scheduled', windows: pendingNotifications.length, level: delivered === false ? 'warn' : 'info' })
            } catch {
              // Transport errors may contain the full signed webhook URL.
              recordRuntimeEvent(this.store, 'quota', '额度通知发送失败，请检查 Webhook 配置及网络', { event: 'quota.notification.failed', instanceId, mode: 'scheduled', level: 'error' })
            }
          } else if (notify && low.length) {
            const reason = !settings.webhook_enabled || !settings.webhook_url ? '通知未启用或未配置' : !pendingNotifications.length ? '处于五小时通知冷却期' : '当前不在通知工作时段'
            recordRuntimeEvent(this.store, 'quota', `额度通知已跳过：${reason}`, { event: 'quota.notification.skipped', instanceId, reason, windows: low.length })
          }
          const seen = new Set(accounts.map(account => account.id)); for (const old of previous) if ((old.account_id === DiscoveryAccountId && accounts.length) || (old.account_id !== DiscoveryAccountId && !seen.has(old.account_id))) this.store.deleteQuota(instanceId, old.account_id)
          return results
        } catch (error) { this.markDiscoveryFailure(instanceId, attempt, error); recordRuntimeEvent(this.store, 'quota', '额度刷新失败，请检查 OAuth 账户及 CPA 连接', { event: 'quota.refresh.failed', instanceId, level: 'error' }); throw new Error(`list OAuth accounts: ${error.message}`) }
      }))
    } finally { this.running.delete(instanceId) }
  }
  markDiscoveryFailure(instanceId, attempt, error) { const previous = this.store.listQuotas(instanceId); if (!previous.length) this.store.saveQuota({ instance_id: instanceId, account_id: DiscoveryAccountId, provider: '', values: [], status: 'failed', message: error.message, attempted_at: attempt, collected_at: '' }); else for (const item of previous) this.store.saveQuota({ ...item, attempted_at: attempt, status: 'failed', message: error.message }) }
  async list(instanceId) { this.store.getInstance(instanceId); const now = this.clock().getTime(); const interval = this.intervalMs(instanceId); return this.store.listQuotas(instanceId).map(item => item.status === 'ok' && (!item.attempted_at || now - Date.parse(item.attempted_at) >= interval) ? { ...item, status: 'stale', message: 'quota snapshot is older than the refresh interval' } : item) }
  async refreshDue(signal) { const now = this.clock().getTime(); for (const instance of this.scheduledInstances()) { const interval = this.intervalMs(instance.id); const snapshots = this.store.listQuotas(instance.id); if (!snapshots.length || snapshots.some(item => item.status === 'failed' || !item.attempted_at || now - Date.parse(item.attempted_at) >= interval)) { try { await this.refreshInstance(instance.id, signal) } catch {} } } }
  async run(signal) {
    if (signal?.aborted) return
    await this.refreshDue(signal)
    while (!signal?.aborted) {
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', finish)
          if (this.wakeScheduler === finish) this.wakeScheduler = null
          resolve()
        }
        const timer = setTimeout(finish, this.schedulerIntervalMs())
        this.wakeScheduler = finish
        signal?.addEventListener('abort', finish, { once: true })
        if (signal?.aborted) finish()
      })
      if (!signal?.aborted) await this.refreshDue(signal)
    }
  }
}


