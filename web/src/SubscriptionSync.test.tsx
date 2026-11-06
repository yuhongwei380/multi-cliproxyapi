import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'
import { SubscriptionSync } from './SubscriptionSync'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('automatic status is read-only and there is no manual synchronization button', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true, watch: { reset_at: '2026-11-07T00:00:00Z' } })
  const post = vi.spyOn(api, 'post')
  render(<SubscriptionSync instanceId="instance-one" />)
  expect(await screen.findByText(/观察中的最早账户重置时间/)).toBeInTheDocument()
  expect(screen.getByText('自动订阅周期同步')).toBeInTheDocument()
  expect(screen.getByText(/重置后 15 分钟内/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '手动同步订阅' })).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新同步状态' }))
  expect(post).not.toHaveBeenCalled()
})

test('unsupported original plans explain the reason without offering a manual override', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: false, capability_message: '全部订阅计划必须使用统一周期' })
  render(<SubscriptionSync instanceId="instance-one" />)
  expect(await screen.findByText('全部订阅计划必须使用统一周期')).toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

test('completion, missed windows, and uncertain partial operations are displayed', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true, message: '同步完成', pending: { status: 'in_flight' }, last_missed_reset_at: '2026-11-05T00:00:00Z', last_sync: { at: '2026-11-06T00:00:00Z', next_reset_at: '2026-11-07T00:00:00Z', plans: 2, windows: 4 } })
  const post = vi.spyOn(api, 'post')
  render(<SubscriptionSync instanceId="instance-one" />)
  expect(await screen.findByText(/2 个计划／4 个额度窗口/)).toBeInTheDocument()
  expect(screen.getByText(/上次错过的重置时间/)).toBeInTheDocument()
  expect(screen.getByText(/本轮不自动重试，请核对插件/)).toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

test('locked and busy instances explain the automatic execution restriction', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true })
  render(<SubscriptionSync instanceId="instance-one" disabled />)
  expect(await screen.findByText(/实例锁定或操作中时暂停执行/)).toBeInTheDocument()
})
