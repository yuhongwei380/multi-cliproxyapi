import { isStopped } from './domain.js'

export const PLANS_PATH = '/v0/management/plugins/cpa-key-billing/plans'
export const AUTO_WINDOW_MS = 15 * 60000
const POLL_MS = 60000
export const RESET_PATH = '/v0/management/plugins/cpa-key-billing/keys/reset'
const UNSUPPORTED = '无法读取原版 Key Billing 订阅计划，请检查插件是否已启用且支持计划管理接口'
const err = (message, status = 409) => Object.assign(new Error(message), { status })
const iso = ms => new Date(ms).toISOString()
const typeOf = name => typeof name !== 'string' ? '' : /周限额$/.test(name) ? 'week' : /月限额$/.test(name) ? 'month' : ''

export function quotaResetCandidates(snapshots, now) {
  const accounts = snapshots.filter(item => item.account_id !== '__discovery__')
  if (!accounts.length) throw err('没有可查询的 OAuth 账户')
  if (accounts.some(item => item.status !== 'ok')) throw err('部分账户额度查询失败或不支持，无法确定最早重置时间')
  const result = { week: [], month: [] }
  for (const item of accounts) for (const value of item.values || []) {
    const kind = typeOf(value.name)
    if (!kind) continue
    const time = Date.parse(value.reset_at || '')
    if (!Number.isFinite(time)) throw err(`${kind === 'week' ? '周' : '月'}额度缺少有效重置时间`)
    if (time <= now) throw err('账户返回的重置时间尚未更新，请稍后重试')
    result[kind].push({ account_id: item.account_id, window_name: value.name, reset_at: iso(time) })
  }
  for (const kind of Object.keys(result)) result[kind].sort((a, b) => Date.parse(a.reset_at) - Date.parse(b.reset_at) || a.account_id.localeCompare(b.account_id))
  if (!result.week.length && !result.month.length) throw err('账户未提供周／月额度重置时间')
  return result
}
const earliest = fresh => [...fresh.week, ...fresh.month].sort((a, b) => Date.parse(a.reset_at) - Date.parse(b.reset_at))[0]

// Send only the original API's writable window fields, never quota views or keys.
const windowFields = ['id', 'name', 'period_seconds', 'amount', 'token_limit', 'request_limit', 'cycle_anchor_at']
function normalizePlan(plan) {
  if (!plan || typeof plan.id !== 'string' || !plan.id || !['USD', 'CNY'].includes(plan.currency) || !Array.isArray(plan.windows) || !plan.windows.length) throw err('插件返回的订阅计划数据无效')
  if (plan.shared_quota !== false || plan.windows.some(window => !window?.cycle_anchor_at)) throw err('全部订阅计划必须使用统一周期且每个 Key 独享额度；请先检查独立周期或共享额度计划')
  const ids = new Set(), periods = new Set()
  const windows = plan.windows.map(window => {
    const anchor = Date.parse(window.cycle_anchor_at)
    if (Object.keys(window).some(field => !windowFields.includes(field)) || typeof window.id !== 'string' || !window.id || ids.has(window.id) || typeof window.name !== 'string' || !window.name || !Number.isSafeInteger(window.period_seconds) || window.period_seconds <= 0 || window.period_seconds > 9223372036 || periods.has(window.period_seconds) || !Number.isFinite(anchor) || anchor % 1000) throw err('插件返回的统一周期窗口数据无效')
    const amount = window.amount ?? 0, tokenLimit = window.token_limit ?? 0, requestLimit = window.request_limit ?? 0
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(tokenLimit) || tokenLimit < 0 || !Number.isSafeInteger(requestLimit) || requestLimit < 0 || (!amount && !tokenLimit && !requestLimit)) throw err('插件返回的额度上限数据无效')
    ids.add(window.id); periods.add(window.period_seconds)
    return { id: window.id, name: window.name, period_seconds: window.period_seconds, amount, token_limit: tokenLimit, request_limit: requestLimit, cycle_anchor_at: iso(anchor) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return { id: plan.id, windows }
}
const samePlan = (actual, expected) => actual.id === expected.id && actual.windows.length === expected.windows.length && actual.windows.every((window, index) => {
  const wanted = expected.windows[index]
  return window.id === wanted.id && window.name === wanted.name && window.period_seconds === wanted.period_seconds && window.amount === wanted.amount && window.token_limit === wanted.token_limit && window.request_limit === wanted.request_limit && (Date.parse(window.cycle_anchor_at) - Date.parse(wanted.cycle_anchor_at)) % (window.period_seconds * 1000) === 0
})
const payload = response => { try { return JSON.parse(response.body) } catch { throw err('插件响应数据无效，请核对操作结果') } }

export class SubscriptionSync {
  constructor({ store, quota, instances, clients, clock = () => new Date() }) {
    Object.assign(this, { store, quota, instances, clients, clock }); this.running = new Set()
    store.db.exec('CREATE TABLE IF NOT EXISTS subscription_sync (instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE, payload TEXT NOT NULL)')
  }
  get(id) {
    this.store.getInstance(id)
    const row = this.store.db.prepare('SELECT payload FROM subscription_sync WHERE instance_id=?').get(id)
    const { enabled, windows, last_scan, last_missed, ...state } = row ? JSON.parse(row.payload) : {}
    return { instance_id: id, ...state }
  }
  save(id, state) {
    const { instance_id, ...data } = state
    this.store.db.prepare('INSERT INTO subscription_sync(instance_id,payload) VALUES(?,?) ON CONFLICT(instance_id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(data))
    return { instance_id: id, ...data }
  }
  async readPlans(client, signal) {
    const response = await client.singleRequest('GET', PLANS_PATH, signal)
    if (response.status !== 200) throw err(UNSUPPORTED)
    const data = payload(response)
    if (!Array.isArray(data?.plans) || !data.plans.length) throw err('插件中没有可同步的订阅计划')
    const plans = data.plans.map(normalizePlan).sort((a, b) => a.id.localeCompare(b.id))
    if (new Set(plans.map(plan => plan.id)).size !== plans.length) throw err('插件返回了重复订阅计划')
    return plans
  }
  async clientFor(id) {
    const instance = this.store.getInstance(id)
    if (this.instances.runtime && isStopped((await this.instances.runtime.status(instance)).state)) throw err('实例已停止，请启动后同步订阅')
    return this.clients(instance)
  }
  async inspect(id) {
    let available = false, capabilityMessage = ''
    try { await this.readPlans(await this.clientFor(id)); available = true } catch (error) { capabilityMessage = error.message }
    // Read again after the network call so concurrent synchronization is visible.
    const state = this.get(id)
    if (!this.running.has(id)) this.finishConfirmed(id, state)
    return { ...state, available, capability_message: capabilityMessage }
  }
  finishConfirmed(id, state) {
    if (state.pending?.status !== 'confirmed') return
    state.last_sync = { ...state.pending.result, at: state.pending.started_at }
    state.message = '全部订阅额度已重置，统一周期日期同步完成'
    delete state.pending
    this.save(id, state)
  }
  async reset(id, state, { fresh, event, signal }) {
    return this.instances.operations.run('global', () => this.instances.withInstanceLock(id, async () => {
      signal?.throwIfAborted()
      const instance = this.store.getInstance(id)
      this.instances.assertUnlocked(instance); this.instances.assertUpgradeIdle(); this.instances.pluginService?.assertIdle()
      const client = await this.clientFor(id)
      const plans = await this.readPlans(client, signal)
      // The original plugin accepts anchors only at second precision.
      const target = iso(Math.floor(Date.parse(earliest(fresh).reset_at) / 1000) * 1000)
      const checkTime = () => {
        signal?.throwIfAborted()
        const now = this.clock().getTime()
        if (now < Date.parse(event.reset_at) || now > Date.parse(event.reset_at) + AUTO_WINDOW_MS) throw err('已超出账户重置后 15 分钟自动同步窗口')
        if (Date.parse(target) <= now) throw err('目标重置日期已到，请重新查询账户额度')
        if (plans.some(plan => plan.windows.some(window => Date.parse(target) > now + window.period_seconds * 1000))) throw err('目标重置日期超出某个额度窗口的一个周期，未开始同步；请检查计划周期长度')
      }
      // Validate every plan before the first edit. There is no multi-plan
      // transaction in the original API, so each mutation gets a durable marker.
      checkTime()
      const previousPending = state.pending
      const expected = plans.map(plan => ({ ...plan, windows: plan.windows.map(window => ({ ...window, cycle_anchor_at: target })) }))
      let attempted = false
      const send = async (method, path, body, phase) => {
        checkTime()
        state.pending = { status: 'in_flight', reset_at: event.reset_at, target, started_at: state.pending?.started_at || this.clock().toISOString(), updated_plans: state.pending?.updated_plans || 0, phase }
        state.message = '正在更新统一周期日期并重置全部订阅额度'
        state.last_attempted_reset_at = event.reset_at
        this.save(id, state)
        attempted = true
        return client.singleRequest(method, path, signal, body)
      }
      // Do not carry the previous attempt's progress into an explicitly new run.
      delete state.pending
      try {
        for (const plan of expected) {
          const response = await send('PATCH', PLANS_PATH, { id: plan.id, windows: plan.windows }, 'plans')
          if (response.status !== 200) throw err('插件计划更新未确认，请核对操作结果')
          if (!samePlan(normalizePlan(payload(response)?.plan), plan)) throw err('插件返回的计划设置与目标不一致，请核对操作结果')
          state.pending.updated_plans++
          this.save(id, state)
        }
        const verify = async () => {
          const actual = await this.readPlans(client, signal)
          if (actual.length !== expected.length || actual.some((plan, index) => !samePlan(plan, expected[index]))) throw err('订阅计划在同步期间发生变化，请核对后重试')
        }
        await verify()
        const response = await send('POST', RESET_PATH, { mode: 'global' }, 'reset')
        if (response.status !== 200) throw err('插件额度重置未确认，请核对操作结果')
        const result = payload(response)
        if (![result?.keys, result?.windows, result?.pools].every(value => Number.isSafeInteger(value) && value >= 0)) throw err('插件额度重置结果无效，请核对操作结果')
        await verify()
        checkTime()
        state.pending.status = 'confirmed'
        state.pending.result = { reset_at: event.reset_at, plans: expected.length, windows: expected.reduce((sum, plan) => sum + plan.windows.length, 0), next_reset_at: target }
        this.save(id, state)
        return result
      } catch (error) {
        if (!attempted) { if (previousPending) state.pending = previousPending; else delete state.pending }
        throw error
      }
    }))
  }
  nextRefreshAt(id) {
    const state = this.get(id), now = this.clock().getTime()
    const attempted = Math.max(0, ...this.store.listQuotas(id).map(item => Date.parse(item.attempted_at) || 0), Date.parse(state.last_observed_at) || 0)
    if (state.watch) {
      const due = Date.parse(state.watch.reset_at)
      // Do not poll stopped/unreachable instances every minute forever after
      // their execution window has expired. A later live query records the miss.
      return now > due + AUTO_WINDOW_MS && attempted > due + AUTO_WINDOW_MS ? attempted + this.quota.intervalMs(id) : Math.max(due, attempted + POLL_MS)
    }
    // Bootstrap with live data even if an old cache is within its normal 6h TTL.
    return state.last_observed_at ? attempted + this.quota.intervalMs(id) : Math.max(now, attempted + POLL_MS)
  }
  log(id, message, level = 'info', context = {}) {
    try { this.store.appendRuntimeLog?.({ source: 'quota', level, instance_id: id, message, context }) } catch {}
  }
  async observe(id, snapshots, { signal } = {}) {
    if (this.running.has(id)) return
    this.running.add(id)
    const state = this.get(id)
    try {
      this.finishConfirmed(id, state)
      const now = this.clock().getTime()
      state.last_observed_at = iso(now)
      const event = state.watch
      const missed = event && now > Date.parse(event.reset_at) + AUTO_WINDOW_MS
      if (missed) {
        state.last_missed_reset_at = event.reset_at
        delete state.watch
        state.message = '已错过本轮重置后 15 分钟窗口，跳过同步并等待下一轮'
        this.log(id, state.message, 'warn')
      }
      let fresh
      try { fresh = quotaResetCandidates(snapshots, now) } catch {
        if (!missed) state.message = '等待全部账户提供有效的下一次周／月重置日期，本次不修改订阅'
        this.save(id, state); return
      }
      const next = earliest(fresh)
      const arm = () => { state.watch = next; this.save(id, state) }
      if (missed) { arm(); return }
      if (!event || now < Date.parse(event.reset_at)) {
        if (!state.pending) state.message = '等待实例内最早账户重置，自动同步仅在重置后 15 分钟内执行'
        arm(); return
      }
      if ((state.last_attempted_reset_at && Date.parse(state.last_attempted_reset_at) >= Date.parse(event.reset_at)) || (state.pending?.status === 'in_flight' && (!state.pending.reset_at || state.pending.reset_at === event.reset_at))) {
        state.message = '本轮同步已有执行记录，不自动重复；结果未确认时请核对插件计划和额度'
        arm(); return
      }
      const source = snapshots.find(item => item.account_id === event.account_id)?.values?.find(value => value.name === event.window_name)
      if (!source || Date.parse(source.reset_at) <= Date.parse(event.reset_at)) {
        state.message = '原重置账户或额度窗口已变化，跳过本轮并重新观察'
        arm(); return
      }
      try {
        await this.reset(id, state, { fresh, event, signal })
        this.finishConfirmed(id, state)
        this.log(id, '账户自然重置后，全部订阅额度及统一周期自动同步完成', 'info', { reset_at: event.reset_at, next_reset_at: state.last_sync.next_reset_at, plans: state.last_sync.plans, windows: state.last_sync.windows })
        try { this.store.appendAuditLog?.({ actor: 'system', action: 'subscription-sync.auto', resource_type: 'instance', resource_id: id, outcome: 'success', detail: JSON.stringify(state.last_sync) }) } catch {}
        arm()
      } catch (error) {
        const attempted = state.last_attempted_reset_at === event.reset_at
        state.message = attempted ? '本轮同步未全部确认，可能已修改部分计划或额度；本轮不自动重试，请核对插件' : error.message || '自动订阅同步暂不可用'
        if (attempted) state.watch = next
        this.save(id, state)
        this.log(id, state.message, 'warn', { reset_at: event.reset_at })
        if (attempted) try { this.store.appendAuditLog?.({ actor: 'system', action: 'subscription-sync.auto', resource_type: 'instance', resource_id: id, outcome: 'failure', detail: '本轮自动同步未全部确认，不自动重发' }) } catch {}
      }
    } finally { this.running.delete(id) }
  }
}
