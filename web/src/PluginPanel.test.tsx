import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { PluginPanel } from './PluginPanel'
import { api } from './api'
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
test('themed plugin picker supports keyboard selection and unchecked deployment', async () => {
  vi.mocked(api.get).mockImplementation(async route => route === '/plugins/jobs' ? { items: [] } : { catalog: [{ id: 'cpa-key-billing', name: 'Key Billing', repository: 'haowang02/cpa-plugin-key-billing' }, { id: 'other', name: 'Other', repository: 'demo/other' }], instances: [{ id: 'one', name: '实例一', locked: false, state: 'running', plugins: [] }] })
  render(<PluginPanel />)
  fireEvent.click(await screen.findByLabelText('选择 实例一'))
  const picker = screen.getByRole('combobox', { name: '插件: Key Billing' })
  fireEvent.keyDown(picker, { key: 'ArrowDown' })
  expect(screen.getByRole('listbox', { name: '插件' })).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('option', { name: 'Key Billing' }), { key: 'End' })
  fireEvent.click(screen.getByRole('option', { name: 'Other' }))
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByLabelText('安装后启用')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '统一安装 / 升级' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/plugins/deploy', { plugin: 'other', version: '', instances: ['one'], enable: false }))
})
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
test('record deletion requires confirmation and refreshes history after success', async () => {
  let items = [{ id: 'done', plugin: 'cpa-key-billing', version: '1.3.20', state: 'completed', message: '', results: [], created_at: '2026-10-12T03:00:00Z' }]
  vi.mocked(api.get).mockImplementation(async route => route === '/plugins/jobs' ? { items } : { catalog: [], instances: [] })
  vi.mocked(api.delete).mockImplementation(async () => { items = []; return { status: 'deleted' } })
  render(<PluginPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '删除部署记录 done' }))
  expect(api.delete).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '删除部署记录？' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(api.delete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '删除部署记录 done' }))
  fireEvent.click(screen.getByRole('button', { name: '确认删除记录' }))
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/plugins/jobs/done'))
  expect(await screen.findByText('暂无部署记录')).toBeInTheDocument()
})
test('running and blocked records cannot be deleted, and failure keeps the record', async () => {
  vi.mocked(api.get).mockImplementation(async route => route === '/plugins/jobs' ? { items: ['running', 'blocked', 'failed'].map(state => ({ id: state, plugin: 'cpa-key-billing', version: '1.3.20', state, message: '', results: [] })) } : { catalog: [], instances: [] })
  vi.mocked(api.delete).mockRejectedValue(new Error('删除失败，请重试'))
  render(<PluginPanel />)
  expect(await screen.findByRole('button', { name: '删除部署记录 running' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '删除部署记录 blocked' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '删除部署记录 failed' }))
  fireEvent.click(screen.getByRole('button', { name: '确认删除记录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('删除失败，请重试')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '删除部署记录 failed' })).toBeInTheDocument()
})
