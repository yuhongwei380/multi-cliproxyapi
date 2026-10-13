import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { KeyPanel } from './KeyPanel'
import { api } from './api'
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const key = { id: 'key-one', note: '测试', masked_key: 'sk-…1234', locked: false, deleting: false, bindings: [{ instance_id: 'one', instance_name: 'CPA 一', instance_port: 8317, status: 'deployed', message: '' }] }
function setup(items = [key]) {
  vi.mocked(api.get).mockImplementation(async path => path === '/keys' ? { items } : { items: [{ id: 'one', name: 'CPA 一', port: 8317, status: { state: 'running' } }, { id: 'two', name: 'CPA 二', port: 8318, status: { state: 'stopped' }, locked: true }] })
  vi.mocked(api.post).mockResolvedValue({})
  render(<KeyPanel />)
}

test('creates a server generated key with a persisted note, or a securely generated manual value', async () => {
  setup([]); fireEvent.click(screen.getByRole('button', { name: '创建 Key' }))
  fireEvent.change(screen.getByLabelText('Key 备注'), { target: { value: '集成测试' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys', { note: '集成测试' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: '创建 Key' })); fireEvent.click(screen.getByRole('button', { name: '生成' }))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toMatch(/^sk-[A-Za-z0-9]{48}$/)
})

test('revealing a key updates only the row without reloading the module', async () => {
  setup(); vi.mocked(api.post).mockResolvedValue({ key: 'sk-test-secret' })
  await screen.findByRole('button', { name: '显示' })
  expect(api.get).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '显示' }))
  expect(await screen.findByText('sk-test-secret')).toBeInTheDocument()
  expect(api.get).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '隐藏' }))
  expect(screen.getByText('sk-…1234')).toBeInTheDocument()
  expect(api.get).toHaveBeenCalledTimes(2)
})

test('binding selects only new children and does not implicitly deploy', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name: '绑定' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('checkbox', { name: /CPA 一/ })).toBeDisabled()
  fireEvent.click(dialog.getByRole('checkbox', { name: /CPA 二/ })); fireEvent.click(dialog.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/bind', { instances: ['two'] }))
  expect(api.post).toHaveBeenCalledTimes(1)
})

test('delete confirms affected instances and retains partial failure for retry', async () => {
  setup(); vi.mocked(api.post).mockResolvedValue({ deleted: false, results: [{ instance_id: 'one', status: 'failed' }] })
  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  expect(within(screen.getByRole('dialog')).getByText(/CPA 一/)).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '撤销并删除' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/delete', {}))
  expect(await screen.findByRole('status')).toHaveTextContent('绑定已保留')
  expect(screen.getByText('sk-…1234')).toBeInTheDocument()
})

test('single unbind explicitly revokes and locked keys block destructive actions', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name: /绑定实例/ })); expect(screen.getByText('端口 8317')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '解绑并撤销' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/revoke', { instance_id: 'one' }))
  cleanup(); setup([{ ...key, locked: true }])
  expect(await screen.findByRole('button', { name: '删除' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /绑定实例/ }))
  expect(screen.getByRole('button', { name: '解绑并撤销' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '下发 Key' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '解锁' }))
  fireEvent.change(screen.getByLabelText('总控管理员密码'), { target: { value: 'password' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/unlock', { admin_password: 'password' }))
})

test('failed binding details open automatically and the failure badge survives collapse', async () => {
  setup([{ ...key, bindings: [{ ...key.bindings[0], status: 'failed', message: '实例连接失败' }] }])
  const toggle = await screen.findByRole('button', { name: /绑定实例/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(toggle).toHaveTextContent('1 个失败')
  expect(screen.getByText('实例连接失败')).toBeVisible()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveTextContent('1 个失败')
  expect(screen.queryByRole('button', { name: '解绑并撤销' })).not.toBeInTheDocument()
})

test('instance filters include multi-bound keys and allow returning to all or unbound', async () => {
  const second = { instance_id: 'two', instance_name: 'CPA 二', instance_port: 8318, status: 'pending', message: '' }
  setup([
    key,
    { ...key, id: 'multi', note: '多实例 Key', bindings: [...key.bindings, second] },
    { ...key, id: 'two-only', note: '二号 Key', bindings: [second] },
    { ...key, id: 'unused', note: '未分配 Key', bindings: [] },
  ])
  const filters = within(await screen.findByRole('group', { name: '绑定实例筛选' }))
  const first = await filters.findByRole('button', { name: 'CPA 一2' })
  fireEvent.click(first)
  expect(first).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('heading', { name: '测试' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '多实例 Key' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '二号 Key' })).not.toBeInTheDocument()
  fireEvent.click(filters.getByRole('button', { name: 'CPA 二2' }))
  expect(screen.getByRole('heading', { name: '多实例 Key' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '二号 Key' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '测试' })).not.toBeInTheDocument()
  fireEvent.click(filters.getByRole('button', { name: '未绑定1' }))
  expect(screen.getByRole('heading', { name: '未分配 Key' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '多实例 Key' })).not.toBeInTheDocument()
  fireEvent.click(filters.getByRole('button', { name: '全部4' }))
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4)
})
