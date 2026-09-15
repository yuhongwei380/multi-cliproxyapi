// Read-only, redacted probe for a real local CPA management endpoint.
// It deliberately never prints account identifiers, emails, auth indexes, or tokens.
const base = process.argv[2] || 'http://127.0.0.1:18317'
const managementSecret = process.argv[3] || 'admin'
const safeShape = value => Array.isArray(value)
  ? value.map(safeShape)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' ? '<string>' : safeShape(item)]))
    : typeof value === 'number' ? value : value === null ? null : typeof value
const auth = await fetch(`${base}/v0/management/auth-files`, { headers: { Authorization: `Bearer ${managementSecret}` } })
const authPayload = await auth.json().catch(() => ({}))
const files = Array.isArray(authPayload.files) ? authPayload.files : []
console.log(JSON.stringify({
  auth_status: auth.status,
  account_count: files.length,
  accounts: files.map(file => ({
    provider: file.provider || file.type || '',
    has_auth_index: typeof file.auth_index === 'string' || typeof file.auth_index === 'number',
    has_chatgpt_account_id: Boolean(file.id_token && typeof file.id_token === 'object' && typeof file.id_token.chatgpt_account_id === 'string'),
    token_fields_present: ['token', 'access_token', 'refresh_token', 'id_token'].filter(key => key in file)
  }))
}))
for (const file of files) {
  const provider = String(file.provider || file.type || '').toLowerCase()
  const url = provider === 'codex' ? 'https://chatgpt.com/backend-api/wham/usage' : provider === 'claude' ? 'https://api.anthropic.com/api/oauth/usage' : null
  if (!url || file.auth_index === undefined || file.auth_index === null) continue
  const accountId = file.id_token && typeof file.id_token === 'object' && typeof file.id_token.chatgpt_account_id === 'string' ? file.id_token.chatgpt_account_id : ''
  const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' }
  if (provider === 'codex') {
    header['User-Agent'] = 'codex-tui/0.149.1'
    if (accountId) header['Chatgpt-Account-Id'] = accountId
  } else header['anthropic-beta'] = 'oauth-2025-04-20'
  const response = await fetch(`${base}/v0/management/api-call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${managementSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authIndex: String(file.auth_index), method: 'GET', url, header })
  })
  const wrapper = await response.json().catch(() => ({}))
  let body = wrapper.body
  if (typeof body === 'string') body = await Promise.resolve().then(() => JSON.parse(body)).catch(() => ({}))
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
  console.log(JSON.stringify({
    provider,
    api_call_status: response.status,
    upstream_status: wrapper.status_code,
    body_type: typeof wrapper.body,
    body_keys: Object.keys(body).sort(),
    has_rate_limit: Boolean(body.rate_limit),
    has_primary_window: Boolean(body.rate_limit?.primary_window),
    has_secondary_window: Boolean(body.rate_limit?.secondary_window),
    has_code_review_window: Boolean(body.code_review_rate_limit?.primary_window),
    rate_limit_shape: safeShape(body.rate_limit),
    code_review_rate_limit_shape: safeShape(body.code_review_rate_limit),
    additional_rate_limits_shape: safeShape(body.additional_rate_limits),
    model_usage_shape: safeShape(body.model_usage)
  }))
}
