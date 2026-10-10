// Codex/Claude contracts verified against CPA 7.2.159 management.html;
// Kimi follows the official Management Center's quota constants/builders.
// CPA substitutes $TOKEN$ internally; the controller never reads it.
export function providerQuotaRequest(account) {
  const provider = String(account.provider || '').toLowerCase()
  if (!['codex', 'claude', 'kimi'].includes(provider)) return null
  if (!account.auth_index) throw new Error('OAuth account is missing auth_index')
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' }
  let url
  if (provider === 'codex') {
    url = 'https://chatgpt.com/backend-api/wham/usage'
    header['User-Agent'] = 'codex-tui/0.149.1'
    if (account.chatgpt_account_id) header['Chatgpt-Account-Id'] = account.chatgpt_account_id
  } else if (provider === 'claude') {
    url = 'https://api.anthropic.com/api/oauth/usage'
    header['anthropic-beta'] = 'oauth-2025-04-20'
  } else {
    url = 'https://api.kimi.com/coding/v1/usages'
  }
  return { authIndex: account.auth_index, method: 'GET', url, header }
}

function periodLabel(window, fallback) {
  const seconds = Number(window.limit_window_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  if (seconds >= 28 * 24 * 60 * 60 && seconds <= 31 * 24 * 60 * 60) return '月限额'
  if (seconds === 7 * 24 * 60 * 60) return '周限额'
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)} 天限额`
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)} 小时限额`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟限额`
  return fallback
}

function windowName(base, window, fallback) {
  const period = periodLabel(window, fallback)
  if (!base || base === 'Codex') return period
  return `${base} ${period}`
}

function percentWindow(name, window, field, fallback) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) throw new Error('invalid provider quota window')
  const used = window[field]
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) throw new Error('provider quota window has no valid usage percentage')
  let reset = window.reset_at ?? window.resets_at
  if (typeof reset === 'number') reset = new Date(reset * 1000).toISOString()
  else if (reset !== undefined && reset !== null && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset)))) throw new Error('invalid provider quota reset time')
  return { name: windowName(name, window, fallback), remaining: Math.max(0, 100 - used), total: 100, unit: '%', ...(reset ? { reset_at: reset } : {}) }
}

function kimiNumber(value) {
  if (typeof value === 'string' && value.trim()) value = Number(value)
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid Kimi quota number')
  return value
}

function kimiReset(window) {
  const absolute = window.reset_at ?? window.resetAt ?? window.reset_time ?? window.resetTime
  if (absolute !== undefined && absolute !== null) {
    const date = typeof absolute === 'number' ? new Date(absolute * 1000) : typeof absolute === 'string' && absolute.trim() ? new Date(absolute) : null
    if (!date || !Number.isFinite(date.getTime())) throw new Error('invalid Kimi quota reset time')
    return { reset_at: date.toISOString() }
  }
  const relative = window.reset_in ?? window.resetIn ?? window.ttl
  if (relative === undefined || relative === null) return {}
  const date = new Date(Date.now() + kimiNumber(relative) * 1000)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid Kimi quota reset time')
  return { reset_at: date.toISOString() }
}

function kimiWindow(detail, name) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('invalid Kimi quota window')
  const total = kimiNumber(detail.limit)
  if (total <= 0) throw new Error('Kimi quota window has no positive limit')
  // Prefer the provider's remaining value; zero is a real exhausted window.
  const remaining = detail.remaining !== undefined && detail.remaining !== null
    ? kimiNumber(detail.remaining) : Math.max(0, total - kimiNumber(detail.used))
  return { name, remaining: Math.min(100, remaining / total * 100), total: 100, unit: '%', ...kimiReset(detail) }
}

function kimiLimitName(item, detail, index) {
  const window = item.window ?? {}
  if (typeof window !== 'object' || Array.isArray(window) || window === null) throw new Error('invalid Kimi quota duration')
  const duration = window.duration ?? item.duration ?? detail.duration
  if (duration !== undefined && duration !== null) {
    const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? 'MINUTE').toUpperCase().replace(/^TIME_UNIT_/, '').replace(/S$/, '')
    const seconds = { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800, MONTH: 2592000 }[unit]
    if (!seconds) throw new Error('invalid Kimi quota time unit')
    return periodLabel({ limit_window_seconds: kimiNumber(duration) * seconds }, `限额 ${index + 1}`)
  }
  return item.name || item.title || item.scope || detail.name || detail.title || `限额 ${index + 1}`
}

export function parseProviderQuota(provider, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw new Error('invalid provider quota response')
  const values = []
  if (provider === 'codex') {
    const append = (name, rate) => {
      if (!rate) return
      for (const [key, label] of [['primary_window', '主要窗口'], ['secondary_window', '次要窗口']]) if (rate[key]) values.push(percentWindow(name, rate[key], 'used_percent', label))
    }
    append('Codex', payload.rate_limit)
    append('代码审查', payload.code_review_rate_limit)
    if (payload.additional_rate_limits !== undefined && payload.additional_rate_limits !== null && !Array.isArray(payload.additional_rate_limits)) throw new Error('invalid additional quota limits')
    for (const limit of payload.additional_rate_limits || []) append(limit.limit_name || limit.metered_feature || '附加额度', limit.rate_limit)
  } else if (provider === 'claude') {
    const labels = { five_hour: '5 小时限额', seven_day: '周限额', seven_day_oauth_apps: 'OAuth 应用周限额', seven_day_opus: 'Opus 周限额', seven_day_sonnet: 'Sonnet 周限额', seven_day_cowork: 'Cowork 周限额', iguana_necktie: 'Iguana Necktie 周限额' }
    for (const key of Object.keys(labels)) if (payload[key]) values.push(percentWindow('', payload[key], 'utilization', labels[key]))
  } else if (provider === 'kimi') {
    const usages = payload.usages
    if (usages !== undefined && usages !== null && (typeof usages !== 'object' || Array.isArray(usages))) throw new Error('invalid Kimi quota usages')
    // Named windows identify the plan. Do not invent a weekly window from the
    // legacy summary when the provider explicitly supplies 5h/monthly windows.
    const namedCodeWindows = usages?.limit_5h != null || usages?.limit_7d != null
    const namedWindows = new Map()
    for (const [key, name] of [['limit_5h', '5 小时限额'], ['limit_7d', '周限额'], ['limit_month_total', '月限额']]) {
      const window = usages?.[key]
      if (window === undefined || window === null) continue
      if (typeof window !== 'object' || Array.isArray(window)) throw new Error('invalid Kimi quota window')
      namedWindows.set(name, { name, remaining: Math.max(0, 100 - kimiNumber(window.used_ratio) * 100), total: 100, unit: '%', ...kimiReset(window) })
    }
    if (payload.limits !== undefined && payload.limits !== null && !Array.isArray(payload.limits)) throw new Error('invalid Kimi quota limits')
    for (const [index, item] of (payload.limits || []).entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid Kimi quota limit')
      const detail = item.detail ?? item
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('invalid Kimi quota window')
      const name = kimiLimitName(item, detail, index)
      if (!namedWindows.has(name)) values.push(kimiWindow(detail, name))
    }
    if (payload.usage && !namedCodeWindows && !values.some(value => value.name === '周限额')) values.push(kimiWindow(payload.usage, '周限额'))
    values.push(...namedWindows.values())
  }
  if (!values.length) throw new Error('provider response contains no quota windows')
  return values
}
