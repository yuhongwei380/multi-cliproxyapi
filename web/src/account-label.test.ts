import { expect, test } from 'vitest'
import { quotaAccountLabel } from './account-label'

test.each([
  ['claude-55865e71-gptxxxx@xxxx.com-self-serve-business-prolite.json', 'claude', 'gptxxxx-Pro 200'],
  ['codex-8657d006-first.last+work@example.com-pro.json', 'codex', 'first.last+work-Pro'],
  ['claude-55865e71-gpt-team@company-domain.co.uk-pro-200.json', 'claude', 'gpt-team-Pro 200'],
  ['first-last@example.com-plus.json', '', 'first-last-Plus'],
  ['codex-first-last@example.com.json', 'codex', 'first-last'],
  ['claude-55865e71-user@example.com-new-plan.json', 'claude', 'user-new-plan'],
  ['custom-provider-55865e71-user@example.com-max_20x.json', 'custom-provider', 'user-Max 20x'],
  ['oauth-1', 'codex', 'oauth-1'],
  ['kimi-1791601029340.json', 'kimi', 'kimi-1791601029340.json'],
  ['__discovery__', '', 'OAuth 账户'],
])('formats %s (%s) as %s', (account, provider, expected) => {
  expect(quotaAccountLabel(account, provider)).toBe(expected)
})
