import crypto from 'node:crypto'
import { invalid } from './errors.js'
import { ConflictError } from './store.js'
import { generateApiKey } from '../shared/api-key.js'
import { recordRuntimeEvent } from './logging.js'

export class KeyService {
  constructor({ store, instances, clients, secrets, auth }) { Object.assign(this, { store, instances, clients, secrets, auth }) }
  list() { return this.store.listManagedKeys().map(key => this.view(key)) }
  view(key) {
    const { ciphertext, fingerprint, ...visible } = key
    const secret = this.secrets.decrypt(ciphertext)
    return { ...visible, masked_key: `${secret.slice(0, 3)}…${secret.slice(-4)}`, bindings: this.store.keyBindings(key.id) }
  }
  run(fn) { return this.instances.operations.run('global', fn) }
  editable(key) { if (key.locked) throw new ConflictError('Key 已锁定，请先解锁') }
  active(key) { if (key.deleting) throw new ConflictError('Key 正在撤销删除，只能重试删除') }
  groupId(value) {
    if (value === null || value === 'ungrouped') return null
    if (typeof value !== 'string') throw invalid('请选择分组')
    this.store.getKeyGroup(value)
    return value
  }
  listGroups() {
    const keys = this.store.listManagedKeys()
    return [...this.store.listKeyGroups(), { id: 'ungrouped', name: '未分组' }].map(group => ({ ...group, key_count: keys.filter(key => (key.group_id ?? 'ungrouped') === group.id).length }))
  }
  groupKeys(id) {
    const groupId = this.groupId(id)
    return this.store.listManagedKeys().filter(key => key.group_id === groupId)
  }
  async saveGroup(id, input) {
    return this.run(() => {
      const existing = id ? this.store.getKeyGroup(id) : null
      const name = input.name ?? existing?.name
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name) || name.trim() === '未分组') throw invalid('分组名称须为 1–80 个字符，且不能为“未分组”')
      const keyIds = input.key_ids ?? (existing ? this.groupKeys(id).map(key => key.id) : [])
      if (!Array.isArray(keyIds) || keyIds.length > 10000 || keyIds.some(value => typeof value !== 'string')) throw invalid('请选择有效的 Key')
      const selected = new Set(keyIds)
      keyIds.forEach(keyId => this.store.getManagedKey(keyId))
      for (const key of this.store.listManagedKeys()) {
        if ((selected.has(key.id) && (!id || key.group_id !== id)) || (id && key.group_id === id && !selected.has(key.id))) { this.editable(key); this.active(key) }
      }
      const group = { id: existing?.id ?? `group-${crypto.randomUUID()}`, name: name.trim(), created_at: existing?.created_at ?? new Date().toISOString() }
      this.store.saveKeyGroup(group, [...selected])
      return { ...group, key_count: selected.size }
    })
  }
  async deleteGroup(id) {
    return this.run(() => {
      this.store.getKeyGroup(id)
      this.groupKeys(id).forEach(key => { this.editable(key); this.active(key) })
      this.store.deleteKeyGroup(id)
      return { status: 'deleted' }
    })
  }
  async deployGroup(id, input, actor = 'admin') {
    return this.run(async () => {
      const keys = this.groupKeys(id)
      if (!keys.length) throw invalid('分组中没有 Key')
      const targets = this.instanceIds(input.instances)
      targets.forEach(target => this.store.getInstance(target))
      // Validate the entire selection before adding any binding or contacting CPA.
      for (const key of keys) {
        this.active(key)
        const bound = new Set(this.store.keyBindings(key.id).map(binding => binding.instance_id))
        if (targets.some(target => !bound.has(target))) this.editable(key)
      }
      this.store.transaction(() => keys.forEach(key => targets.forEach(target => this.store.bindKey(key.id, target))))
      const results = []
      for (const key of keys) {
        const deployed = await this.distributeUnlocked(key.id, { instanceIds: targets, actor })
        results.push(...deployed.results.map(result => ({ key_id: key.id, ...result })))
      }
      const failed = results.filter(result => result.status === 'failed').length
      recordRuntimeEvent(this.store, 'key', `API Key 分组下发结束：${results.length - failed} 个成功，${failed} 个失败`, { level: failed ? 'error' : 'info', event: 'key.group.completed', group_id: id, succeeded: results.length - failed, failed })
      return { results }
    })
  }
  async revokeGroup(id, input, actor = 'admin') {
    return this.run(async () => {
      const keys = this.groupKeys(id)
      if (!keys.length) throw invalid('分组中没有 Key')
      const targets = this.instanceIds(input.instances)
      targets.forEach(target => this.store.getInstance(target))
      const boundTargets = new Set(keys.flatMap(key => this.store.keyBindings(key.id).map(binding => binding.instance_id)))
      if (!targets.some(target => boundTargets.has(target))) throw invalid('所选实例没有绑定此组的 Key')
      // Validate the entire group before revoking any binding.
      for (const key of keys) { this.editable(key); this.active(key) }
      const results = []
      for (const key of keys) {
        const revoked = await this.distributeUnlocked(key.id, { revoke: true, instanceIds: targets, actor })
        results.push(...revoked.results.map(result => ({ key_id: key.id, ...result })))
      }
      const failed = results.filter(result => result.status === 'failed').length
      recordRuntimeEvent(this.store, 'key', `API Key 分组撤销结束：${results.length - failed} 个成功，${failed} 个失败`, { level: failed ? 'error' : 'info', event: 'key.group.revoked', group_id: id, succeeded: results.length - failed, failed })
      return { results }
    })
  }
  instanceIds(values) {
    if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(value => typeof value !== 'string')) throw invalid('请选择实例')
    return [...new Set(values)]
  }
  async create(input) {
    return this.run(() => {
      const secret = input.key === undefined ? generateApiKey() : input.key
      if (typeof secret !== 'string' || secret.length < 8 || secret.length > 512 || /\s|[\x00-\x1f\x7f]/.test(secret)) throw invalid('Key 必须为 8–512 个无空白字符')
      const note = this.note(input.note ?? '')
      const fingerprint = crypto.createHash('sha256').update(secret).digest('hex')
      const key = { id: `key-${crypto.randomUUID()}`, note, group_id: input.group_id === undefined ? null : this.groupId(input.group_id), ciphertext: this.secrets.encrypt(secret), fingerprint, locked: false, deleting: false, created_at: new Date().toISOString() }
      this.store.createManagedKey(key)
      return this.view(key)
    })
  }
  note(value) { if (typeof value !== 'string' || value.length > 200) throw invalid('备注最多 200 个字符'); return value.trim() }
  async mutate(id, action, input = {}) {
    return this.run(() => {
      const key = this.store.getManagedKey(id)
      if (action === 'unlock') { this.auth.verifyAdminPassword(input.admin_password); key.locked = false }
      else if (action === 'lock') key.locked = true
      else if (action === 'note') { this.editable(key); key.note = this.note(input.note) }
      else if (action === 'group') { this.editable(key); this.active(key); key.group_id = this.groupId(input.group_id) }
      else if (action === 'bind') {
        this.editable(key); this.active(key)
        const ids = this.instanceIds(input.instances)
        ids.forEach(instanceId => this.store.getInstance(instanceId))
        ids.forEach(instanceId => this.store.bindKey(id, instanceId))
      }
      this.store.saveManagedKey(key)
      return this.view(key)
    })
  }
  async reveal(id) { return this.run(() => ({ key: this.secrets.decrypt(this.store.getManagedKey(id).ciphertext) })) }
  async dismissDeployFailure(id, instanceId, actor = 'admin') {
    return this.run(() => {
      const key = this.store.getManagedKey(id)
      this.active(key)
      this.editable(key)
      const binding = this.store.keyBindings(id).find(item => item.instance_id === instanceId)
      if (!binding) throw invalid('实例未绑定此 Key')
      if (binding.status !== 'failed') throw new ConflictError('此绑定没有待关闭的下发错误')
      this.store.saveKeyBinding(id, instanceId, 'pending', '')
      this.store.appendAuditLog({ actor, action: 'key.deploy.failure.dismiss', resource_type: 'instance', resource_id: instanceId, outcome: 'success', detail: `Key ${id}` })
      return { status: 'dismissed' }
    })
  }
  async distribute(id, options = {}) { return this.run(() => this.distributeUnlocked(id, options)) }
  async distributeUnlocked(id, { revoke = false, instanceId = null, instanceIds = null, remove = false, actor = 'admin' } = {}) {
      const key = this.store.getManagedKey(id)
      if (revoke) this.editable(key)
      else this.active(key)
      const bindings = this.store.keyBindings(id).filter(binding => !instanceIds || instanceIds.includes(binding.instance_id))
      if (instanceId !== null && !bindings.some(item => item.instance_id === instanceId)) throw invalid('实例未绑定此 Key')
      if (remove) { key.deleting = true; this.store.saveManagedKey(key) }
      const secret = this.secrets.decrypt(key.ciphertext)
      const results = []
      const action = revoke ? '撤销' : '推送'
      recordRuntimeEvent(this.store, 'key', `API Key ${action}开始`, { event: 'key.started', key_id: id, action, targets: bindings.filter(item => instanceId === null || item.instance_id === instanceId).length })
      for (const binding of bindings.filter(item => instanceId === null || item.instance_id === instanceId)) {
        const target = binding.instance_id
        try {
          await this.instances.withInstanceLock(target, async () => {
            this.instances.assertUpgradeIdle()
            const instance = this.store.getInstance(target)
            this.instances.assertUnlocked(instance)
            if (!this.instances.runtime || (await this.instances.runtime.status(instance)).state !== 'running') throw new ConflictError('实例未运行，请启动后重试')
            // Persist intent before sending: a lost response must never erase the binding.
            this.store.saveKeyBinding(id, target, revoke ? 'revoking' : 'pending', '')
            const client = await this.clients(instance)
            const current = await client.readClientKeys()
            const exists = current.keys.includes(secret)
            const next = revoke ? current.keys.filter(value => value !== secret) : exists ? current.keys : [...current.keys, secret]
            // CPA unregisters its config-key authenticator for an empty list.
            // Keep an unissued random key so revocation cannot enable anonymous access.
            const guarded = revoke && next.length === 0
            if (guarded) next.push(`sk-controller-guard-${crypto.randomBytes(32).toString('base64url')}`)
            if (revoke ? exists || guarded : !exists) {
              // Re-read before replacing a list to detect changes since the initial read.
              const latest = await client.readClientKeys()
              if (JSON.stringify(latest.keys) !== JSON.stringify(current.keys)) throw new ConflictError('实例 Key 列表已变化，请重试')
              await client.writeClientKeys(current.path, next)
            }
            const verified = await client.readClientKeys()
            if (verified.keys.includes(secret) === revoke || next.some(value => value !== secret && !verified.keys.includes(value))) throw new ConflictError('Key 写入验证失败，请重试')
            if (revoke) this.store.unbindKey(id, target)
            else this.store.saveKeyBinding(id, target, exists ? 'exists' : 'deployed', '')
            results.push({ instance_id: target, status: revoke ? 'revoked' : exists ? 'exists' : 'deployed', ...(guarded ? { authentication_guard: true } : {}) })
          })
        } catch (error) {
          // Never expose upstream errors: they may contain the plaintext key or list.
          const message = error instanceof ConflictError ? error.message : 'CPA 连接、鉴权或接口验证失败，请检查实例后重试'
          this.store.saveKeyBinding(id, target, revoke ? 'revoke-failed' : 'failed', message)
          results.push({ instance_id: target, status: 'failed', message })
        }
        const result = results.at(-1)
        recordRuntimeEvent(this.store, 'key', `API Key ${action}${result.status === 'failed' ? '失败' : result.status === 'exists' ? '完成（已存在）' : '成功'}`, { level: result.status === 'failed' ? 'error' : 'info', instanceId: target, event: 'key.result', key_id: id, action, status: result.status, ...(result.status === 'failed' ? { reason: result.message } : {}) })
        this.store.appendAuditLog({ actor, action: revoke ? 'key.revoke.instance' : 'key.deploy.instance', resource_type: 'instance', resource_id: target, outcome: result.status === 'failed' ? 'failed' : 'success', detail: `Key ${id}: ${result.status}` })
      }
      const deleted = remove && this.store.keyBindings(id).length === 0
      if (deleted) this.store.deleteManagedKey(id)
      const failed = results.filter(item => item.status === 'failed').length
      recordRuntimeEvent(this.store, 'key', `API Key ${action}结束：${results.length - failed} 个成功，${failed} 个失败`, { level: failed ? 'error' : 'info', event: 'key.completed', key_id: id, action, succeeded: results.length - failed, failed, deleted })
      return { deleted, results, ...(deleted ? {} : { item: this.view(this.store.getManagedKey(id)) }) }
  }
}
