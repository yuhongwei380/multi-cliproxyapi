import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class NotFoundError extends Error {
  constructor(message = 'not found') { super(message); this.code = 'ERR_NOT_FOUND'; this.status = 404 }
}
export class ConflictError extends Error {
  constructor(message = 'conflict') { super(message); this.code = 'ERR_CONFLICT'; this.status = 409 }
}

const json = value => JSON.stringify(value ?? null)
const parse = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export class Store {
  constructor(file) {
    if (!file) throw new Error('database path is required')
    if (file !== ':memory:') {
      try {
        const info = fs.lstatSync(file)
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('database path must be a regular file')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    }
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        port INTEGER NOT NULL UNIQUE,
        directory TEXT NOT NULL,
        management_secret_ciphertext TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quotas (
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        values_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        collected_at TEXT NOT NULL DEFAULT '',
        attempted_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (instance_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS quota_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        refresh_interval_minutes INTEGER NOT NULL DEFAULT 360,
        webhook_enabled INTEGER NOT NULL DEFAULT 0,
        webhook_url TEXT NOT NULL DEFAULT '',
        alert_threshold_percent REAL NOT NULL DEFAULT 20,
        webhook_signing_enabled INTEGER NOT NULL DEFAULT 0,
        webhook_signing_secret_ciphertext TEXT NOT NULL DEFAULT '',
        webhook_url_ciphertext TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS branding_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        brand_name TEXT NOT NULL,
        brand_subtitle TEXT NOT NULL DEFAULT '',
        banner_title TEXT NOT NULL,
        banner_description TEXT NOT NULL,
        page_title TEXT NOT NULL,
        page_description TEXT NOT NULL,
        copyright TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        instance_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        instance_id TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        client_address TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        tag TEXT PRIMARY KEY,
        asset TEXT NOT NULL DEFAULT '',
        install_path TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',
        installed_at TEXT NOT NULL,
        usable INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS upgrade_state (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        old_version TEXT NOT NULL DEFAULT '',
        new_version TEXT NOT NULL DEFAULT '',
        original_running_json TEXT NOT NULL DEFAULT '[]',
        original_desired_json TEXT NOT NULL DEFAULT '{}',
        instance_stages_json TEXT NOT NULL DEFAULT '{}',
        message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delete_challenges (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS operations_updated_idx ON operations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_logs_created_idx ON runtime_logs(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
    `)
    // Existing installations were created before Webhook signing was added.
    // Add the columns explicitly so an upgrade keeps the current settings row.
    const quotaColumns = new Set(this.db.prepare('PRAGMA table_info(quota_settings)').all().map(row => row.name))
    if (!quotaColumns.has('webhook_signing_enabled')) this.db.exec('ALTER TABLE quota_settings ADD COLUMN webhook_signing_enabled INTEGER NOT NULL DEFAULT 0')
    if (!quotaColumns.has('webhook_signing_secret_ciphertext')) this.db.exec("ALTER TABLE quota_settings ADD COLUMN webhook_signing_secret_ciphertext TEXT NOT NULL DEFAULT ''")
    if (!quotaColumns.has('webhook_url_ciphertext')) this.db.exec("ALTER TABLE quota_settings ADD COLUMN webhook_url_ciphertext TEXT NOT NULL DEFAULT ''")
    this.db.prepare('INSERT OR IGNORE INTO quota_settings(id, refresh_interval_minutes, webhook_enabled, webhook_url, alert_threshold_percent, webhook_signing_enabled, webhook_signing_secret_ciphertext, webhook_url_ciphertext) VALUES(1, 360, 0, \'\', 20, 0, \'\', \'\')').run()
    if (file !== ':memory:') {
      const info = fs.lstatSync(file)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('initialized database path must be a regular file')
      fs.chmodSync(file, 0o600)
    }
  }

  close() { this.db?.close(); this.db = null }
  init() {}

  getAdminHash(username) {
    const row = this.db.prepare('SELECT password_hash FROM admins WHERE username = ?').get(username)
    if (!row) throw new NotFoundError('administrator is not initialized')
    return row.password_hash
  }
  setAdminHash(username, hash) {
    this.db.prepare('INSERT INTO admins(username,password_hash) VALUES(?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash').run(username, hash)
  }
  createSession(tokenHash, username, expiresAt) {
    this.db.prepare('INSERT INTO sessions(token_hash,username,expires_at) VALUES(?,?,?)').run(tokenHash, username, expiresAt)
  }
  getSession(tokenHash) {
    const row = this.db.prepare('SELECT username,expires_at FROM sessions WHERE token_hash = ?').get(tokenHash)
    if (!row) throw new NotFoundError()
    return { username: row.username, expiresAt: row.expires_at }
  }
  deleteSession(tokenHash) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash) }
  cleanupSessions(now = new Date().toISOString()) { this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now) }

  toInstance(row) {
    return {
      id: row.id, name: row.name, port: Number(row.port), directory: row.directory,
      management_secret_ciphertext: row.management_secret_ciphertext,
      desired_state: row.desired_state, version: row.version || '', revision: Number(row.revision),
      created_at: row.created_at, updated_at: row.updated_at
    }
  }
  createInstance(instance) {
    try {
      this.db.prepare(`INSERT INTO instances(id,name,port,directory,management_secret_ciphertext,desired_state,version,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(instance.id, instance.name, instance.port, instance.directory, instance.management_secret_ciphertext, instance.desired_state, instance.version || '', instance.revision, instance.created_at, instance.updated_at)
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ConflictError()
      throw error
    }
  }
  getInstance(id) {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id)
    if (!row) throw new NotFoundError('instance not found')
    return this.toInstance(row)
  }
  listInstances() { return this.db.prepare('SELECT * FROM instances ORDER BY created_at, id').all().map(row => this.toInstance(row)) }
  updateInstance(instance, expectedRevision) {
    const result = this.db.prepare(`UPDATE instances SET name=?,port=?,directory=?,management_secret_ciphertext=?,desired_state=?,version=?,revision=?,created_at=?,updated_at=? WHERE id=? AND revision=?`).run(
      instance.name, instance.port, instance.directory, instance.management_secret_ciphertext, instance.desired_state, instance.version || '', instance.revision, instance.created_at, instance.updated_at, instance.id, expectedRevision)
    if (Number(result.changes) !== 1) {
      const exists = this.db.prepare('SELECT 1 FROM instances WHERE id=?').get(instance.id)
      if (!exists) throw new NotFoundError('instance not found')
      throw new ConflictError('instance revision conflict')
    }
  }
  deleteInstance(id) {
    const result = this.db.prepare('DELETE FROM instances WHERE id = ?').run(id)
    if (Number(result.changes) !== 1) throw new NotFoundError('instance not found')
  }

  saveQuota(snapshot) {
    this.db.prepare(`INSERT INTO quotas(instance_id,account_id,provider,values_json,status,message,collected_at,attempted_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instance_id,account_id) DO UPDATE SET provider=excluded.provider,values_json=excluded.values_json,status=excluded.status,message=excluded.message,collected_at=excluded.collected_at,attempted_at=excluded.attempted_at`).run(
      snapshot.instance_id, snapshot.account_id, snapshot.provider || '', json(snapshot.values || []), snapshot.status || '', snapshot.message || '', snapshot.collected_at || '', snapshot.attempted_at || '')
  }
  listQuotas(instanceId) {
    return this.db.prepare('SELECT * FROM quotas WHERE instance_id = ? ORDER BY account_id').all(instanceId).map(row => ({
      instance_id: row.instance_id, account_id: row.account_id, provider: row.provider || '', values: parse(row.values_json, []), status: row.status,
      message: row.message || '', collected_at: row.collected_at || '', attempted_at: row.attempted_at || ''
    }))
  }
  deleteQuota(instanceId, accountId) { this.db.prepare('DELETE FROM quotas WHERE instance_id=? AND account_id=?').run(instanceId, accountId) }

  getQuotaSettings({ includeSecretCiphertext = false } = {}) {
    const row = this.db.prepare('SELECT refresh_interval_minutes, webhook_enabled, webhook_url, alert_threshold_percent, webhook_signing_enabled, webhook_signing_secret_ciphertext, webhook_url_ciphertext FROM quota_settings WHERE id=1').get()
    if (!row) {
      const fallback = { refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false }
      if (includeSecretCiphertext) { fallback.webhook_signing_secret_ciphertext = ''; fallback.webhook_url_ciphertext = ''; fallback.webhook_url_legacy = '' }
      return fallback
    }
    const ciphertext = row.webhook_signing_secret_ciphertext || ''; const urlCiphertext = row.webhook_url_ciphertext || ''; const legacyUrl = row.webhook_url || ''
    const settings = { refresh_interval_minutes: Number(row.refresh_interval_minutes) || 360, webhook_enabled: Boolean(row.webhook_enabled), webhook_url: '', webhook_url_configured: Boolean(urlCiphertext || legacyUrl), alert_threshold_percent: Number(row.alert_threshold_percent), webhook_signing_enabled: Boolean(row.webhook_signing_enabled), webhook_secret_configured: Boolean(ciphertext) }
    if (includeSecretCiphertext) { settings.webhook_signing_secret_ciphertext = ciphertext; settings.webhook_url_ciphertext = urlCiphertext; settings.webhook_url_legacy = legacyUrl }
    return settings
  }
  saveQuotaSettings(settings) {
    const current = this.getQuotaSettings({ includeSecretCiphertext: true })
    const ciphertext = Object.prototype.hasOwnProperty.call(settings, 'webhook_signing_secret_ciphertext') ? (settings.webhook_signing_secret_ciphertext || '') : (current.webhook_signing_secret_ciphertext || '')
    const urlCiphertext = Object.prototype.hasOwnProperty.call(settings, 'webhook_url_ciphertext') ? (settings.webhook_url_ciphertext || '') : (current.webhook_url_ciphertext || '')
    this.db.prepare(`INSERT INTO quota_settings(id, refresh_interval_minutes, webhook_enabled, webhook_url, alert_threshold_percent, webhook_signing_enabled, webhook_signing_secret_ciphertext, webhook_url_ciphertext)
      VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET refresh_interval_minutes=excluded.refresh_interval_minutes, webhook_enabled=excluded.webhook_enabled, webhook_url=excluded.webhook_url, alert_threshold_percent=excluded.alert_threshold_percent, webhook_signing_enabled=excluded.webhook_signing_enabled, webhook_signing_secret_ciphertext=excluded.webhook_signing_secret_ciphertext, webhook_url_ciphertext=excluded.webhook_url_ciphertext`).run(
      settings.refresh_interval_minutes, settings.webhook_enabled ? 1 : 0, settings.webhook_url || '', settings.alert_threshold_percent, settings.webhook_signing_enabled ? 1 : 0, ciphertext, urlCiphertext)
    return this.getQuotaSettings()
  }

  getBranding() {
    const row = this.db.prepare('SELECT brand_name, brand_subtitle, banner_title, banner_description, page_title, page_description, copyright, icon FROM branding_settings WHERE id=1').get()
    if (!row) return null
    return { brand_name: row.brand_name, brand_subtitle: row.brand_subtitle || '', banner_title: row.banner_title, banner_description: row.banner_description, page_title: row.page_title, page_description: row.page_description, copyright: row.copyright || '', icon: row.icon || '' }
  }
  saveBranding(settings) {
    this.db.prepare(`INSERT INTO branding_settings(id, brand_name, brand_subtitle, banner_title, banner_description, page_title, page_description, copyright, icon)
      VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET brand_name=excluded.brand_name, brand_subtitle=excluded.brand_subtitle, banner_title=excluded.banner_title, banner_description=excluded.banner_description, page_title=excluded.page_title, page_description=excluded.page_description, copyright=excluded.copyright, icon=excluded.icon`).run(
      settings.brand_name, settings.brand_subtitle || '', settings.banner_title, settings.banner_description, settings.page_title, settings.page_description, settings.copyright || '', settings.icon || '')
    return this.getBranding()
  }

  saveOperation(operation) {
    this.db.prepare(`INSERT INTO operations(id,kind,instance_id,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(operation.id, operation.kind, operation.instance_id || '', operation.state, operation.message || '', operation.created_at, operation.updated_at)
  }
  updateOperation(operation) {
    this.db.prepare('UPDATE operations SET kind=?,instance_id=?,state=?,message=?,created_at=?,updated_at=? WHERE id=?').run(operation.kind, operation.instance_id || '', operation.state, operation.message || '', operation.created_at, operation.updated_at, operation.id)
  }
  listOperations(limit = 50) { return this.db.prepare('SELECT * FROM operations ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 50))).map(row => ({ id: row.id, kind: row.kind, instance_id: row.instance_id || '', state: row.state, message: row.message || '', created_at: row.created_at, updated_at: row.updated_at })) }

  appendRuntimeLog(entry) {
    const createdAt = entry.created_at || new Date().toISOString()
    const result = this.db.prepare('INSERT INTO runtime_logs(level,source,instance_id,message,context_json,created_at) VALUES(?,?,?,?,?,?)').run(entry.level || 'info', entry.source || 'controller', entry.instance_id || '', entry.message || '', json(entry.context || {}), createdAt)
    this.db.prepare('DELETE FROM runtime_logs WHERE id <= (SELECT COALESCE(MAX(id),0) - 10000 FROM runtime_logs)').run()
    return { id: Number(result.lastInsertRowid), level: entry.level || 'info', source: entry.source || 'controller', instance_id: entry.instance_id || '', message: entry.message || '', context: entry.context || {}, created_at: createdAt }
  }
  listRuntimeLogs(limit = 200) {
    return this.db.prepare('SELECT * FROM runtime_logs ORDER BY created_at DESC, id DESC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 200))).map(row => ({ id: Number(row.id), level: row.level, source: row.source, instance_id: row.instance_id || '', message: row.message, context: parse(row.context_json, {}), created_at: row.created_at }))
  }
  appendAuditLog(entry) {
    const createdAt = entry.created_at || new Date().toISOString()
    const result = this.db.prepare('INSERT INTO audit_logs(actor,action,resource_type,resource_id,outcome,client_address,detail,created_at) VALUES(?,?,?,?,?,?,?,?)').run(entry.actor || 'unknown', entry.action || 'unknown', entry.resource_type || '', entry.resource_id || '', entry.outcome || 'success', entry.client_address || '', entry.detail || '', createdAt)
    this.db.prepare('DELETE FROM audit_logs WHERE id <= (SELECT COALESCE(MAX(id),0) - 20000 FROM audit_logs)').run()
    return { id: Number(result.lastInsertRowid), actor: entry.actor || 'unknown', action: entry.action || 'unknown', resource_type: entry.resource_type || '', resource_id: entry.resource_id || '', outcome: entry.outcome || 'success', client_address: entry.client_address || '', detail: entry.detail || '', created_at: createdAt }
  }
  listAuditLogs(limit = 200) {
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 200))).map(row => ({ id: Number(row.id), actor: row.actor, action: row.action, resource_type: row.resource_type || '', resource_id: row.resource_id || '', outcome: row.outcome, client_address: row.client_address || '', detail: row.detail || '', created_at: row.created_at }))
  }

  saveVersion(version) {
    this.db.prepare(`INSERT INTO versions(tag,asset,install_path,sha256,installed_at,usable) VALUES(?,?,?,?,?,?)
      ON CONFLICT(tag) DO UPDATE SET asset=excluded.asset,install_path=excluded.install_path,sha256=excluded.sha256,installed_at=excluded.installed_at,usable=excluded.usable`).run(version.tag, version.asset || '', version.path || version.install_path || '', version.sha256 || '', version.installed_at, version.usable ? 1 : 0)
  }
  toVersion(row) { return { tag: row.tag, asset: row.asset || '', path: row.install_path || '', sha256: row.sha256 || '', installed_at: row.installed_at, usable: Boolean(row.usable) } }
  getVersion(tag) { const row = this.db.prepare('SELECT * FROM versions WHERE tag=?').get(tag); if (!row) throw new NotFoundError('version not found'); return this.toVersion(row) }
  listVersions() { return this.db.prepare('SELECT * FROM versions ORDER BY installed_at DESC, tag').all().map(row => this.toVersion(row)) }
  deleteVersion(tag) {
    const result = this.db.prepare('DELETE FROM versions WHERE tag=?').run(tag)
    if (Number(result.changes) !== 1) throw new NotFoundError('version not found')
  }

  saveUpgradeState(state) {
    this.db.prepare(`INSERT INTO upgrade_state(id,state,old_version,new_version,original_running_json,original_desired_json,instance_stages_json,message,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,old_version=excluded.old_version,new_version=excluded.new_version,original_running_json=excluded.original_running_json,original_desired_json=excluded.original_desired_json,instance_stages_json=excluded.instance_stages_json,message=excluded.message,updated_at=excluded.updated_at`).run(
      state.id || 'singleton', state.state, state.old_version || '', state.new_version || '', json(state.original_running || []), json(state.original_desired || {}), json(state.instance_stages || {}), state.message || '', state.updated_at)
  }
  getUpgradeState() {
    const row = this.db.prepare('SELECT * FROM upgrade_state WHERE id=?').get('singleton')
    if (!row) throw new NotFoundError('upgrade state not found')
    return { id: row.id, state: row.state, old_version: row.old_version || '', new_version: row.new_version || '', original_running: parse(row.original_running_json, []), original_desired: parse(row.original_desired_json, {}), instance_stages: parse(row.instance_stages_json, {}), message: row.message || '', updated_at: row.updated_at }
  }
  clearUpgradeState() { this.db.prepare('DELETE FROM upgrade_state WHERE id=?').run('singleton') }

  createDeleteChallenge(challenge) {
    this.db.prepare('INSERT INTO delete_challenges(id,instance_id,revision,expires_at,used) VALUES(?,?,?,?,0)').run(challenge.id, challenge.instance_id, challenge.revision, challenge.expires_at)
  }
  consumeDeleteChallenge(id, instanceId, revision, now = new Date().toISOString()) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM delete_challenges WHERE id=?').get(id)
      if (!row || row.instance_id !== instanceId || Number(row.revision) !== Number(revision) || Number(row.used) !== 0 || row.expires_at <= now) throw new ConflictError('delete challenge is invalid or expired')
      const result = this.db.prepare('UPDATE delete_challenges SET used=1 WHERE id=? AND used=0').run(id)
      if (Number(result.changes) !== 1) throw new ConflictError('delete challenge has already been used')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }
}
