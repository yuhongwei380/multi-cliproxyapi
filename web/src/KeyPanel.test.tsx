import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { KeyPanel } from './KeyPanel'
import { api } from './api'
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const key = { id: 'key-one', note: '测试', masked_key: 'sk-…1234', locked: false, deleting: false, bindings: [{ instance_id: 'one', instance_name: 'CPA 一', instance_port: 8317, status: 'deployed', message: '' }] }
type TestKey = typeof key & { group_id?: string | null }
async function setup(items: TestKey[] = [key], groups: { id: string; name: string }[] = [], expand = true) {
  vi.mocked(api.get).mockImplementation(async path => path === '/keys' ? { items, groups } : { items: [{ id: 'one', name: 'CPA 一', port: 8317, status: { state: 'running' } }, { id: 'two', name: 'CPA 二', port: 8318, status: { state: 'stopped' }, locked: true }] })
  vi.mocked(api.post).mockResolvedValue({})
  render(<KeyPanel />)
  const toggle = await screen.findByRole('button', { name: /^未分组/ })
  if (expand && toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

test('creates a server generated key with a persisted note, or a securely generated manual value', async () => {
  await setup([]); fireEvent.click(screen.getByRole('button', { name: '创建 Key' }))
  fireEvent.change(screen.getByLabelText('Key 备注'), { target: { value: '集成测试' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys', { note: '集成测试' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: '创建 Key' })); fireEvent.click(screen.getByRole('button', { name: '生成' }))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toMatch(/^sk-[A-Za-z0-9]{48}$/)
})

test('revealing a key updates only the row without reloading the module', async () => {
  await setup(); vi.mocked(api.post).mockResolvedValue({ key: 'sk-test-secret' })
  await screen.findByRole('button', { name: '显示' })
  expect(api.get).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '显示' }))
  expect(await screen.findByText('sk-test-secret')).toBeInTheDocument()
  expect(api.get).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '隐藏' }))
  expect(screen.getByText('sk-…1234')).toBeInTheDocument()
  expect(api.get).toHaveBeenCalledTimes(2)
})

test('revealing a key does not flash or disable unrelated key actions', async () => {
  await setup()
  let resolveReveal!: (value: { key: string }) => void
  vi.mocked(api.post).mockImplementation(() => new Promise(resolve => { resolveReveal = resolve }) as any)
  const show = await screen.findByRole('button', { name: '显示' })
  fireEvent.click(show)
  expect(show).toBeDisabled()
  expect(screen.getByRole('button', { name: '创建 Key' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
  resolveReveal({ key: 'sk-test-secret' })
  expect(await screen.findByText('sk-test-secret')).toBeInTheDocument()
})

test('searches API key notes and shows only matching rows', async () => {
  await setup([{ ...key, note: '测试环境' }, { ...key, id: 'production', note: '生产环境', bindings: [] }])
  const input = await screen.findByRole('textbox', { name: '搜索 API Key 备注' })
  fireEvent.change(input, { target: { value: '测试' } })
  expect(screen.getByRole('heading', { name: '测试环境' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '生产环境' })).not.toBeInTheDocument()
  expect(screen.getByText('显示 1 / 2 个 Key')).toBeInTheDocument()
  fireEvent.change(input, { target: { value: '生产' } })
  expect(screen.getByRole('heading', { name: '生产环境' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '测试环境' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '清除' }))
  expect(screen.getByRole('heading', { name: '测试环境' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '生产环境' })).toBeInTheDocument()
})

test('binding selects only new children and does not implicitly deploy', async () => {
  await setup(); fireEvent.click(await screen.findByRole('button', { name: '绑定' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('checkbox', { name: /CPA 一/ })).toBeDisabled()
  fireEvent.click(dialog.getByRole('checkbox', { name: /CPA 二/ })); fireEvent.click(dialog.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/bind', { instances: ['two'] }))
  expect(api.post).toHaveBeenCalledTimes(1)
})

test('delete confirms affected instances and retains partial failure for retry', async () => {
  await setup(); vi.mocked(api.post).mockResolvedValue({ deleted: false, results: [{ instance_id: 'one', status: 'failed' }] })
  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  expect(within(screen.getByRole('dialog')).getByText(/CPA 一/)).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '撤销并删除' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/delete', {}))
  expect(await screen.findByRole('status')).toHaveTextContent('绑定已保留')
  expect(screen.getByText('sk-…1234')).toBeInTheDocument()
})

test('single unbind explicitly revokes and locked keys block destructive actions', async () => {
  await setup(); fireEvent.click(await screen.findByRole('button', { name: /绑定实例/ })); expect(screen.getByText('端口 8317')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '解绑并撤销' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/revoke', { instance_id: 'one' }))
  cleanup(); await setup([{ ...key, locked: true }])
  expect(await screen.findByText('CPA已锁定')).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: '删除' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /绑定实例/ }))
  expect(screen.getByRole('button', { name: '解绑并撤销' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '下发 Key' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '解锁' }))
  fireEvent.change(screen.getByLabelText('总控管理员密码'), { target: { value: 'password' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/unlock', { admin_password: 'password' }))
})

test('failed binding details open automatically and the failure badge survives collapse', async () => {
  await setup([{ ...key, bindings: [{ ...key.bindings[0], status: 'failed', message: '实例连接失败' }] }])
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
  await setup([
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
  expect(screen.getByText('未绑定', { selector: '.key-unbound' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '多实例 Key' })).not.toBeInTheDocument()
  fireEvent.click(filters.getByRole('button', { name: '全部4' }))
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4)
})

test('shows collapsed groups by default and assigns keys without a group to ungrouped', async () => {
  await setup([key, { ...key, id: 'grouped', note: '组内 Key', group_id: 'production' }], [{ id: 'production', name: '生产组' }], false)
  const production = within(screen.getByRole('region', { name: '生产组' }))
  expect(production.getByRole('button', { name: '生产组1 个 Key' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('heading', { name: '组内 Key' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '测试' })).not.toBeInTheDocument()
  fireEvent.click(production.getByRole('button', { name: '生产组1 个 Key' }))
  expect(screen.getByRole('heading', { name: '组内 Key' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '未分组1 个 Key' }))
  expect(screen.getByRole('heading', { name: '测试' })).toBeInTheDocument()
})

test('search opens matching groups while allowing them to be collapsed and combines with instance filters', async () => {
  await setup([{ ...key, note: '生产 Key', group_id: 'work' }, { ...key, id: 'other', note: '生产备用', bindings: [] }], [{ id: 'work', name: '工作组' }], false)
  fireEvent.change(screen.getByLabelText('搜索 API Key 备注'), { target: { value: '生产' } })
  expect(screen.getByRole('heading', { name: '生产 Key' })).toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: '工作组1 个 Key' })
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('heading', { name: '生产 Key' })).not.toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('group', { name: '绑定实例筛选' })).getByRole('button', { name: 'CPA 一1' }))
  expect(screen.getByRole('heading', { name: '生产 Key' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '未分组' })).not.toBeInTheDocument()
})

test('creates a named group with selected keys and edits its membership', async () => {
  await setup([key, { ...key, id: 'locked', note: '锁定 Key', locked: true }])
  fireEvent.click(screen.getByRole('button', { name: '新建组' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled()
  fireEvent.change(dialog.getByLabelText('分组名称'), { target: { value: '工作组' } })
  expect(dialog.getByRole('checkbox', { name: /锁定 Key/ })).toBeDisabled()
  fireEvent.click(dialog.getByRole('checkbox', { name: /^测试/ }))
  fireEvent.click(dialog.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/key-groups', { name: '工作组', key_ids: ['key-one'] }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  cleanup()
  await setup([{ ...key, group_id: 'work' }, { ...key, id: 'other', note: '另一个 Key', group_id: 'other-group' }], [{ id: 'work', name: '工作组' }, { id: 'other-group', name: '其他组' }])
  fireEvent.click(within(screen.getByRole('region', { name: '工作组' })).getByRole('button', { name: '编辑分组' }))
  const edit = within(screen.getByRole('dialog'))
  expect(edit.getByRole('checkbox', { name: /^测试/ })).toBeChecked()
  fireEvent.click(edit.getByRole('checkbox', { name: /^测试/ }))
  fireEvent.click(edit.getByRole('checkbox', { name: /^另一个 Key/ }))
  fireEvent.change(edit.getByLabelText('分组名称'), { target: { value: '新组名' } })
  fireEvent.click(edit.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/key-groups/work/update', { name: '新组名', key_ids: ['other'] }))
})

test('moves an individual key to a group and creates keys directly in that group', async () => {
  await setup([key], [{ id: 'work', name: '工作组' }])
  fireEvent.click(screen.getByRole('button', { name: '分组' }))
  fireEvent.change(screen.getByLabelText('所属分组'), { target: { value: 'work' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/group', { group_id: 'work' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: '创建 Key' }))
  fireEvent.change(screen.getByLabelText('所属分组'), { target: { value: 'work' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys', { note: '', group_id: 'work' }))
})

test('group deployment selects target instances, reports partial failures, and blocks locked binding changes', async () => {
  await setup([{ ...key, group_id: 'work' }], [{ id: 'work', name: '工作组' }], false)
  vi.mocked(api.post).mockResolvedValue({ results: [{ key_id: key.id, instance_id: 'one', status: 'failed' }] })
  fireEvent.click(within(screen.getByRole('region', { name: '工作组' })).getByRole('button', { name: '批量下发' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('checkbox', { name: /CPA 一/ })).toBeChecked()
  expect(dialog.getByRole('checkbox', { name: /CPA 二/ })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: '确认下发' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/key-groups/work/deploy', { instances: ['one'] }))
  expect(await screen.findByRole('status')).toHaveTextContent('0 项成功，1 项失败')
  expect(screen.getByRole('heading', { name: '测试' })).toBeInTheDocument()
  cleanup()
  await setup([{ ...key, group_id: 'work', locked: true, bindings: [] }], [{ id: 'work', name: '工作组' }], false)
  fireEvent.click(within(screen.getByRole('region', { name: '工作组' })).getByRole('button', { name: '批量下发' }))
  expect(screen.getByRole('button', { name: '确认下发' })).toBeDisabled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: /CPA 一/ }))
  expect(screen.getByText(/组内含待删除 Key/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '确认下发' })).toBeDisabled()
})

test('deleting a group confirms that keys return to ungrouped and leaves key records intact', async () => {
  await setup([{ ...key, group_id: 'work' }], [{ id: 'work', name: '工作组' }], false)
  fireEvent.click(screen.getByRole('button', { name: '删除分组' }))
  expect(within(screen.getByRole('dialog')).getByText(/1 个 Key 将归入/)).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认删除分组' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/key-groups/work/delete', {}))
  expect(await screen.findByRole('status')).toHaveTextContent('组内 Key 已归入')
})
