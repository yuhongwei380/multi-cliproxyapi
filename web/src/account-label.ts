const planLabels = new Map(Object.entries({
  'self-serve-business-prolite': 'Business Premium',
  'business-prolite': 'Business Premium',
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  max: 'Max',
}))

// Only shorten recognizable email-based filenames; keep opaque account IDs intact.
export function quotaAccountLabel(accountId: string, provider = ''): string {
  if (accountId === '__discovery__') return 'OAuth 账户'
  let name = accountId.replace(/\.json$/i, '')
  const prefix = [provider, 'claude', 'codex', 'kimi', 'openai', 'gemini', 'antigravity', 'qwen', 'iflow']
    .find(value => value && name.toLowerCase().startsWith(`${value.toLowerCase()}-`))
  if (prefix) name = name.slice(prefix.length + 1).replace(/^[a-f\d]{8,64}-/i, '')
  const email = name.match(/^([^@\s]+)@(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?:-(.+))?$/i)
  if (!email) return accountId
  const [, username, suffix] = email
  if (!suffix) return username
  const plan = planLabels.get(suffix.toLowerCase())
    ?? suffix.replace(/^(pro|max)[-_ ]?(\d+(?:x)?)$/i, (_, tier: string, amount: string) => `${tier[0].toUpperCase()}${tier.slice(1).toLowerCase()} ${amount}`)
  return `${username}-${plan}`
}
