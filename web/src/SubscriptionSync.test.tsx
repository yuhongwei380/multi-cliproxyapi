import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'
import { SubscriptionSync } from './SubscriptionSync'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('status is initially read-only and refresh queries live quotas before reloading the sync result', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ available: true, watch: { reset_at: '2026-11-07T00:00:00Z' } })
  const post = vi.spyOn(api, 'post')
  let complete!: () => void
  const refresh = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  render(<SubscriptionSync instanceId="instance-one" onRefresh={refresh} />)
  expect(await screen.findByText(/观察中的最早账户重置时间/)).toBeInTheDocument()
  expect(screen.getByText('自动订阅周期同步')).toBeInTheDocument()
  expect(screen.getByText(/重置后 15 分钟内/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '手动同步订阅' })).not.toBeInTheDocument()
  expect(refresh).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新同步状态' }))
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '查询与同步中…' })).toBeDisabled()
  expect(get).toHaveBeenCalledTimes(1)
  get.mockResolvedValue({ available: true, message: '本次同步完成' })
  complete()
  expect(await screen.findByText('本次同步完成')).toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(2)
  expect(post).not.toHaveBeenCalled()
})

test('unsupported original plans explain the reason without offering a manual override', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: false, capability_message: '全部订阅计划必须使用统一周期' })
  render(<SubscriptionSync instanceId="instance-one" onRefresh={vi.fn()} />)
  expect(await screen.findByText('全部订阅计划必须使用统一周期')).toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

test('completion, missed windows, and uncertain partial operations are displayed', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true, message: '同步完成', pending: { status: 'in_flight' }, last_missed_reset_at: '2026-11-05T00:00:00Z', last_sync: { at: '2026-11-06T00:00:00Z', next_reset_at: '2026-11-07T00:00:00Z', plans: 2, windows: 4 } })
  const post = vi.spyOn(api, 'post')
  render(<SubscriptionSync instanceId="instance-one" onRefresh={vi.fn()} />)
  expect(await screen.findByText(/2 个计划／4 个额度窗口/)).toBeInTheDocument()
  expect(screen.getByText(/上次错过的重置时间/)).toBeInTheDocument()
  expect(screen.getByText(/本轮不自动重试，请核对插件/)).toBeInTheDocument()
  expect(screen.getByText('上次同步设定的重置时间：')).toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

test('locked and busy instances explain the automatic execution restriction', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true })
  const refresh = vi.fn()
  render(<SubscriptionSync instanceId="instance-one" disabled onRefresh={refresh} />)
  expect(await screen.findByText(/实例锁定或操作中时暂停执行/)).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新同步状态' }))
  expect(refresh).not.toHaveBeenCalled()
})

test('a failed live refresh reports its error and allows retrying', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ available: true })
  render(<SubscriptionSync instanceId="instance-one" onRefresh={vi.fn().mockRejectedValue(new Error('上游不可用'))} />)
  await screen.findByRole('status')
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新同步状态' }))
  expect(await screen.findByText('上游不可用')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新同步状态' })).toBeEnabled()
  expect(get).toHaveBeenCalledTimes(1)
})
