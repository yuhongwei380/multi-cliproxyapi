// Contracts verified against the official management.html downloaded for
// CPA 7.2.159. CPA substitutes $TOKEN$ internally; the controller never reads it.
export function providerQuotaRequest(account) {
  const provider = String(account.provider || '').toLowerCase()
  if (!['codex', 'claude'].includes(provider)) return null
  if (!account.auth_index) throw new Error('OAuth account is missing auth_index')
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' }
  let url
  if (provider === 'codex') {
    url = 'https://chatgpt.com/backend-api/wham/usage'
    header['User-Agent'] = 'codex-tui/0.149.1'
    if (account.chatgpt_account_id) header['Chatgpt-Account-Id'] = account.chatgpt_account_id
  } else {
    url = 'https://api.anthropic.com/api/oauth/usage'
    header['anthropic-beta'] = 'oauth-2025-04-20'
  }
  return { authIndex: account.auth_index, method: 'GET', url, header }
}

function periodLabel(window, fallback) {
  const seconds = Number(window.limit_window_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  if (seconds >= 6 * 24 * 60 * 60) return '周限额'
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
    if (payload.additional_rate_limits !== undefined && !Array.isArray(payload.additional_rate_limits)) throw new Error('invalid additional quota limits')
    for (const limit of payload.additional_rate_limits || []) append(limit.limit_name || limit.metered_feature || '附加额度', limit.rate_limit)
  } else if (provider === 'claude') {
    const labels = { five_hour: '5 小时限额', seven_day: '周限额', seven_day_oauth_apps: 'OAuth 应用周限额', seven_day_opus: 'Opus 周限额', seven_day_sonnet: 'Sonnet 周限额', seven_day_cowork: 'Cowork 周限额', iguana_necktie: 'Iguana Necktie 周限额' }
    for (const key of Object.keys(labels)) if (payload[key]) values.push(percentWindow('', payload[key], 'utilization', labels[key]))
  }
  if (!values.length) throw new Error('provider response contains no quota windows')
  return values
}
