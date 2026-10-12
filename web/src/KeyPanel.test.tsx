import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { KeyPanel } from './KeyPanel'
import { api } from './api'
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks() })

const key = { id: 'key-one', note: '测试', masked_key: 'sk-…1234', locked: false, deleting: false, bindings: [{ instance_id: 'one', instance_name: 'CPA 一', status: 'deployed', message: '' }] }
function setup(items = [key]) {
  vi.mocked(api.get).mockImplementation(async path => path === '/keys' ? { items } : { items: [{ id: 'one', name: 'CPA 一', status: { state: 'running' } }, { id: 'two', name: 'CPA 二', status: { state: 'stopped' }, locked: true }] })
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
  const first = (screen.getByLabelText('API Key') as HTMLInputElement).value
  expect(first).toMatch(/^sk-[A-Za-z0-9]{48}$/)
  fireEvent.click(screen.getByRole('button', { name: '生成' }))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).not.toBe(first)
})

test('key generation rejects biased bytes and refills until 48 characters', () => {
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(bytes => {
    (bytes as Uint8Array).fill(255); return bytes
  }).mockImplementation(bytes => {
    const values = bytes as Uint8Array
    values.fill(0); values[0] = 61; values[1] = 62; values[2] = 247
    return bytes
  })
  setup([]); fireEvent.click(screen.getByRole('button', { name: '创建 Key' })); fireEvent.click(screen.getByRole('button', { name: '生成' }))
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('sk-9A9' + 'A'.repeat(45))
  expect(random).toHaveBeenCalledTimes(2)
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
  expect(within(screen.getByRole('dialog')).getByText('CPA 一')).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '撤销并删除' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/delete', {}))
  expect(await screen.findByRole('status')).toHaveTextContent('绑定已保留')
  expect(screen.getByText('sk-…1234')).toBeInTheDocument()
})

test('single unbind explicitly revokes and locked keys block destructive actions', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name: '解绑并撤销' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/revoke', { instance_id: 'one' }))
  cleanup(); setup([{ ...key, locked: true }])
  expect(await screen.findByRole('button', { name: '删除' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '解绑并撤销' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '下发 Key' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '解锁' }))
  fireEvent.change(screen.getByLabelText('总控管理员密码'), { target: { value: 'password' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/keys/key-one/unlock', { admin_password: 'password' }))
})
