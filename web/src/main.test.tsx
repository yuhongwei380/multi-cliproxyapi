import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from './main'

function response(body: unknown, status = 200) { return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) }

beforeEach(() => { vi.restoreAllMocks(); window.location.hash = '' })
afterEach(() => { cleanup() })

test('requires login before showing the instance runway', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: false }) as any)
    .mockImplementationOnce(() => response({ username: 'admin', expires_at: '2030-01-01T00:00:00Z' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
  const user = userEvent.setup(); render(<App />)
  expect(await screen.findByRole('heading', { name: 'CPA 总控' })).toBeInTheDocument()
  expect(screen.getByText('CLI Proxy API Management Center')).toBeInTheDocument()
  expect(screen.getByText('当前地址')).toBeInTheDocument()
  const passwordInput = screen.getByLabelText('管理员密码')
  expect(passwordInput).toHaveAttribute('type', 'password')
  await user.click(screen.getByRole('button', { name: '显示密码' }))
  expect(passwordInput).toHaveAttribute('type', 'text')
  await user.type(screen.getByLabelText('管理员密码'), 'administrator-password')
  await user.click(screen.getByRole('button', { name: '进入总控' }))
  expect(await screen.findByText('还没有运行轨')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(5)
})

test('uses an optional child password and provides a show/hide control', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
  const user = userEvent.setup(); render(<App />)
  await screen.findByRole('button', { name: '+ 创建实例' })
  await user.click(screen.getByRole('button', { name: '+ 创建实例' }))
  const password = screen.getByLabelText('子实例管理密码（可选）')
  expect(password).toHaveAttribute('type', 'password')
  expect(password).not.toBeRequired()
  await user.click(screen.getByRole('button', { name: '显示密码' }))
  expect(password).toHaveAttribute('type', 'text')
  expect(screen.getByRole('button', { name: '隐藏密码' })).toBeInTheDocument()
})

test('delete confirmation requires a challenge and administrator password', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, directory: '/safe', desired_state: 'stopped', version: 'v1', revision: 1, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
    .mockImplementationOnce(() => response({ challenge_id: 'del_1', expires_at: '2030-01-01T00:00:00Z' }) as any)
    .mockImplementationOnce(() => response({ status: 'deleted' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
  const user = userEvent.setup(); render(<App />)
  await screen.findByText('one')
  await user.click(screen.getByRole('button', { name: '删除' }))
  expect(await screen.findByText('删除 one？')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled()
  await user.type(screen.getByLabelText('输入总控管理员密码确认删除'), 'administrator-password')
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByText('删除 one？')).not.toBeInTheDocument())
})

test('shows quota values returned by the child instance', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, directory: '/safe', desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } }] }) as any)
    .mockImplementationOnce(() => response({ items: [{ instance_id: 'cpa_1', account_id: 'oauth-1', provider: 'openai', status: 'ok', collected_at: '2030-01-01T00:00:00Z', attempted_at: '2030-01-01T00:00:00Z', values: [{ name: 'six-hour', remaining: 3, total: 10, unit: 'requests' }] }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  render(<App />)
  expect(await screen.findByText('查看 OAuth 配额（1 个账户）')).toBeInTheDocument()
  expect(screen.getByText('3 / 10 requests')).toBeInTheDocument()
})

test('renders OAuth windows as percentage bars with reset metadata', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } }] }) as any)
    .mockImplementationOnce(() => response({ items: [{ instance_id: 'cpa_1', account_id: 'oauth-1', provider: 'codex', status: 'ok', collected_at: '2030-01-01T00:00:00Z', attempted_at: '2030-01-01T00:00:00Z', values: [{ name: '周限额', remaining: 31, total: 100, unit: '%', reset_at: '2030-09-19T08:09:00Z' }, { name: 'GPT-5.3-Codex-Spark 5 小时限额', remaining: 100, total: 100, unit: '%', reset_at: '2030-09-15T18:09:00Z' }] }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  render(<App />)
  expect(await screen.findByText('周限额')).toBeInTheDocument()
  expect(screen.getByText('31%')).toBeInTheDocument()
  expect(screen.getByText('GPT-5.3-Codex-Spark 5 小时限额')).toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: '周限额 剩余配额' })).toHaveAttribute('aria-valuenow', '31')
  expect(screen.getByRole('progressbar', { name: 'GPT-5.3-Codex-Spark 5 小时限额 剩余配额' })).toHaveAttribute('aria-valuenow', '100')
  expect(screen.getByText(/09\/19/)).toBeInTheDocument()
})

test('reports partial quota refresh failures while keeping successful instances visible', async () => {
  const instances = [
    { id: 'cpa_1', name: 'one', port: 8317, desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } },
    { id: 'cpa_2', name: 'stopped', port: 8318, desired_state: 'stopped', version: 'v1', revision: 1, status: { state: 'stopped', ready: false } }
  ]
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input)
    if (path === '/api/auth/status') return response({ authenticated: true, username: 'admin' }) as any
    if (path === '/api/instances') return response({ items: instances }) as any
    if (path === '/api/versions') return response({ items: [] }) as any
    if (path === '/api/upgrade/state') return response({ state: 'idle' }) as any
    if (path === '/api/quota/settings') return response({ refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false }) as any
    if (path === '/api/instances/cpa_1/quotas') {
      if (init?.method === 'POST') return response({ status: 'refreshed', items: [] }, 202) as any
      return response({ items: [{ instance_id: 'cpa_1', account_id: 'oauth-1', provider: 'codex', status: 'ok', collected_at: '2030-01-01T00:00:00Z', attempted_at: '2030-01-01T00:00:00Z', values: [{ name: 'primary', remaining: 32, total: 100, unit: '%' }] }] }) as any
    }
    if (path === '/api/instances/cpa_2/quotas') {
      if (init?.method === 'POST') return response({ error: 'instance is stopped; start it before refreshing quotas' }, 409) as any
      return response({ items: [] }) as any
    }
    throw new Error(`unexpected request: ${path}`)
  })
  const user = userEvent.setup()
  render(<App />)
  await screen.findByText('one')
  await user.click(screen.getByRole('link', { name: '配额观察' }))
  await user.click(screen.getByRole('button', { name: '手动查看配额' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('配额刷新完成：1 个实例成功，1 个实例失败')
  expect(screen.getByText('32%')).toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([input, init]) => input === '/api/instances/cpa_2/quotas' && init?.method === 'POST')).toBe(true)
})

test('distinguishes a successful zero-account discovery from no snapshot', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'empty', port: 8317, desired_state: 'stopped', version: 'v1', revision: 1, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [{ instance_id: 'cpa_1', account_id: '__discovery__', status: 'empty', message: 'no OAuth accounts configured', collected_at: '2030-01-01T00:00:00Z', attempted_at: '2030-01-01T00:00:00Z' }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  render(<App />)
  expect(await screen.findByText('0 个账户')).toBeInTheDocument()
  expect(screen.getByText('查看 OAuth 配额（0 个账户）')).toBeInTheDocument()
})

test('edits managed instance fields with the current revision', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, desired_state: 'stopped', version: 'v1', revision: 4, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
    .mockImplementationOnce(() => response({ id: 'cpa_1', name: 'renamed', port: 8318, revision: 5, desired_state: 'stopped', version: 'v1', status: { state: 'stopped', ready: false } }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'renamed', port: 8318, desired_state: 'stopped', version: 'v1', revision: 5, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
  const user = userEvent.setup()
  render(<App />)
  await screen.findByText('one')
  await user.click(screen.getByRole('button', { name: '配置' }))
  expect(await screen.findByRole('heading', { name: '配置 one' })).toBeInTheDocument()
  await user.clear(screen.getByLabelText('监听端口'))
  await user.type(screen.getByLabelText('监听端口'), '8318')
  await user.clear(screen.getByLabelText('实例名称'))
  await user.type(screen.getByLabelText('实例名称'), 'renamed')
  await user.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(screen.getByText('renamed')).toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledTimes(10)
  const patchCall = fetchMock.mock.calls[5]
  expect(patchCall[0]).toBe('/api/instances/cpa_1')
  expect((patchCall[1] as RequestInit).method).toBe('PATCH')
  expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toEqual({ name: 'renamed', port: 8318, expected_revision: 4 })
})

test('shows installed versions and submits a unified upgrade', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, directory: '/safe', desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [{ tag: 'v2', asset: 'cpa-v2-linux-amd64.tar.gz', installed_at: '2030-01-01T00:00:00Z', usable: true }, { tag: 'v1', asset: 'cpa-v1-linux-amd64.tar.gz', installed_at: '2029-01-01T00:00:00Z', usable: true }] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
    .mockImplementationOnce(() => response({ status: 'upgraded', version: 'v2' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, directory: '/safe', desired_state: 'running', version: 'v2', revision: 2, status: { state: 'running', ready: true } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [{ tag: 'v2', asset: 'cpa-v2-linux-amd64.tar.gz', installed_at: '2030-01-01T00:00:00Z', usable: true }] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  const user = userEvent.setup()
  render(<App />)
  expect(await screen.findByText('v2')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '统一升级' }))
  await waitFor(() => expect(screen.queryByText('v1')).not.toBeInTheDocument())
})

test('renders the source-style workbench shell around the dashboard', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  render(<App />)
  expect(await screen.findByRole('complementary', { name: '主导航' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '总览' })).toHaveAttribute('href', '#dashboard')
  expect(screen.getByRole('link', { name: /实例运行轨/ })).toHaveAttribute('href', '#instances')
  expect(screen.getByRole('link', { name: '版本管理' })).toHaveAttribute('href', '#versions')
  expect(screen.getByRole('link', { name: '运行日志' })).toHaveAttribute('href', '#runtime-logs')
  expect(screen.getByRole('link', { name: '审计日志' })).toHaveAttribute('href', '#audit-logs')
  expect(screen.getByText('LAN / AMD64')).toBeInTheDocument()
})

test('shows separate runtime and audit timelines with status filtering', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 1, level: 'error', source: 'instance', instance_id: 'cpa-one', message: 'instance restart failed', created_at: '2030-01-01T00:00:00Z' }] }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 2, actor: 'admin', action: 'instance.restart', resource_type: 'instance', resource_id: 'cpa-one', outcome: 'success', client_address: '127.0.0.1', created_at: '2030-01-01T00:01:00Z' }] }) as any)
  const user = userEvent.setup(); render(<App />)
  await screen.findByText('静候流量。')
  await user.click(screen.getByRole('link', { name: '运行日志' }))
  expect(await screen.findByText('instance restart failed')).toBeInTheDocument()
  expect(fetchMock.mock.calls[4][0]).toBe('/api/logs/runtime?limit=500')
  await user.click(screen.getByRole('link', { name: '审计日志' }))
  expect(await screen.findByText('重启实例')).toBeInTheDocument()
  expect(screen.getByText('127.0.0.1')).toBeInTheDocument()
  expect(fetchMock.mock.calls[5][0]).toBe('/api/logs/audit?limit=500')
})

test('opens administrator settings from the avatar and submits a password change', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
  const user = userEvent.setup(); render(<App />)
  await screen.findByText('静候流量。')
  await user.click(screen.getAllByRole('button', { name: '管理员设置' })[0])
  expect(await screen.findByRole('heading', { name: '管理员设置' })).toBeInTheDocument()
  await user.type(screen.getByLabelText('当前管理员密码'), 'admin')
  await user.type(screen.getByLabelText('新管理员密码'), 'new-password')
  await user.type(screen.getByLabelText('确认新管理员密码'), 'new-password')
  fetchMock.mockImplementationOnce(() => response({ status: 'updated' }) as any)
  await user.click(screen.getByRole('button', { name: '保存新密码' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
  const patchCall = fetchMock.mock.calls[4]
  expect(patchCall[0]).toBe('/api/auth/password')
  expect((patchCall[1] as RequestInit).method).toBe('PATCH')
  expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toEqual({ current_password: 'admin', new_password: 'new-password' })
  expect(screen.getByRole('status')).toHaveTextContent('管理员密码已更新')
})


test('separates the instance module and keeps a second create action discoverable', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, management_url: 'http://127.0.0.1:8317/management.html', desired_state: 'stopped', version: 'v1', revision: 1, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)

  const user = userEvent.setup()
  render(<App />)
  await screen.findByText('one')
  expect(screen.queryByText('快速开始')).not.toBeInTheDocument()
  expect(screen.getByText('实例 + 配额')).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: /CLIProxyAPI 实例管理/ }))
  expect(await screen.findByRole('heading', { name: 'CLIProxyAPI 实例管理' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '+ 创建实例' })).toBeInTheDocument()
  const management = screen.getByRole('button', { name: /CPA 管理/ })
  expect(management).toHaveClass('button', 'ghost')
  expect(screen.getByRole('button', { name: '删除' })).toHaveClass('danger-outline')
  expect(document.querySelector('.instance-list')).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' })
})

test('loads quota settings on demand and saves the refresh and DingTalk rules', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => response({ authenticated: true, username: 'admin' }) as any)
    .mockImplementationOnce(() => response({ items: [{ id: 'cpa_1', name: 'one', port: 8317, desired_state: 'stopped', version: 'v1', revision: 1, status: { state: 'stopped', ready: false } }] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ items: [] }) as any)
    .mockImplementationOnce(() => response({ state: 'idle' }) as any)
    .mockImplementationOnce(() => response({ refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false }) as any)
  const user = userEvent.setup()
  render(<App />)
  await screen.findByText('one')
  await user.click(screen.getByRole('link', { name: '配额观察' }))
  expect(await screen.findByRole('heading', { name: '配额观察' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '配额周期' }))
  expect(screen.getByRole('heading', { name: '配额周期与通知' })).toBeInTheDocument()
  const interval = screen.getByLabelText(/自动获取周期/)
  await user.clear(interval)
  await user.type(interval, '120')
  const webhook = screen.getByLabelText(/钉钉机器人 Webhook URL/)
  await user.type(webhook, 'https://oapi.dingtalk.com/robot/send?access_token=test')
  await user.click(screen.getByRole('checkbox', { name: '启用钉钉机器人通知' }))
  await user.click(screen.getByRole('checkbox', { name: '启用 Webhook 加签' }))
  await user.type(screen.getByLabelText('钉钉机器人加签密钥'), 'ding-secret')
  const threshold = screen.getByLabelText(/告警阈值/)
  await user.clear(threshold)
  await user.type(threshold, '15')
  fetchMock.mockImplementationOnce(() => response({ refresh_interval_minutes: 120, webhook_enabled: true, webhook_url: '', webhook_url_configured: true, alert_threshold_percent: 15, webhook_signing_enabled: true, webhook_secret_configured: true }) as any)
  await user.click(screen.getByRole('button', { name: '保存配额设置' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))
  const patchCall = fetchMock.mock.calls[6]
  expect(patchCall[0]).toBe('/api/quota/settings')
  expect((patchCall[1] as RequestInit).method).toBe('PATCH')
  expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toMatchObject({ refresh_interval_minutes: 120, webhook_enabled: true, alert_threshold_percent: 15, webhook_signing_enabled: true, webhook_secret: 'ding-secret' })
})

test('locks all instance actions synchronously while one restart request is pending', async () => {
  let releaseRestart: (value: unknown) => void = () => undefined
  const restartResponse = new Promise(resolve => { releaseRestart = resolve })
  const instances = [
    { id: 'cpa_1', name: 'aaa', port: 8317, desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } },
    { id: 'cpa_2', name: 'bbb', port: 8318, desired_state: 'running', version: 'v1', revision: 1, status: { state: 'running', ready: true } }
  ]
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input)
    if (path === '/api/auth/status') return response({ authenticated: true, username: 'admin' }) as any
    if (path === '/api/instances') return response({ items: instances }) as any
    if (path.endsWith('/quotas')) return response({ items: [] }) as any
    if (path === '/api/versions') return response({ items: [] }) as any
    if (path === '/api/upgrade/state') return response({ state: 'idle' }) as any
    if (path === '/api/instances/cpa_1/restart') return restartResponse as any
    return response({}) as any
  })
  const user = userEvent.setup()
  render(<App />)
  await screen.findByText('aaa')
  const restartButtons = screen.getAllByRole('button', { name: '重启实例' })
  await user.click(restartButtons[0])
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => input === '/api/instances/cpa_1/restart')).toBe(true))
  expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '重启实例' })).toBeEnabled()
  expect(fetchMock.mock.calls.filter(([input]) => input === '/api/instances/cpa_2/restart')).toHaveLength(0)
  releaseRestart(response({ status: 'restarting' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: '重启实例' })).toHaveLength(2))
})

