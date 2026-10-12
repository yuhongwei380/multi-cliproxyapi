import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { PluginPanel } from './PluginPanel'
import { api } from './api'
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
test('shows locked skips, submits selected instances and explicit enable option', async () => {
  vi.mocked(api.get).mockImplementation(async route => route === '/plugins/jobs' ? { items: [] } : { catalog: [{ id: 'cpa-key-billing', name: 'Key Billing', repository: 'haowang02/cpa-plugin-key-billing' }], instances: [
    { id: 'one', name: '实例一', locked: false, state: 'running', plugins: [{ id: 'cpa-key-billing', installed: true, version: '1.3.19', enabled: true }] },
    { id: 'two', name: '实例二', locked: true, state: 'stopped', plugins: [{ id: 'cpa-key-billing', installed: false, version: '', enabled: null }] }
  ] })
  render(<PluginPanel />)
  fireEvent.click(await screen.findByLabelText('选择 实例一')); fireEvent.click(screen.getByLabelText('选择 实例二'))
  expect(screen.getByRole('status').textContent).toContain('将部署 1 个实例，跳过 1 个已锁定实例')
  fireEvent.change(screen.getByLabelText('插件版本'), { target: { value: '1.3.20' } }); fireEvent.click(screen.getByLabelText('安装后启用'))
  fireEvent.click(screen.getByRole('button', { name: '统一安装 / 升级' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/plugins/deploy', { plugin: 'cpa-key-billing', version: '1.3.20', instances: ['one', 'two'], enable: true }))
})
test('blocked deployment prevents another rollout and offers rollback recovery', async () => {
  vi.mocked(api.get).mockImplementation(async route => route === '/plugins/jobs' ? { items: [{ id: 'job', plugin: 'cpa-key-billing', version: '1.3.20', state: 'blocked', message: 'stop denied', results: [] }] } : { catalog: [], instances: [] })
  render(<PluginPanel />)
  await screen.findByText(/stop denied/)
  expect((screen.getByRole('button', { name: '统一安装 / 升级' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '重试回滚' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/plugins/recover'))
})
