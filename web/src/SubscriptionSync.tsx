import { useEffect, useState } from 'react'
import { api } from './api'

type SyncState = {
  available: boolean
  capability_message?: string
  message?: string
  pending?: { status: string }
  watch?: { reset_at: string }
  last_missed_reset_at?: string
  last_sync?: { at: string; next_reset_at: string; plans: number; windows: number }
}
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function SubscriptionSync({ instanceId, disabled = false }: { instanceId: string; disabled?: boolean }) {
  const [state, setState] = useState<SyncState | null>(null)
  const [error, setError] = useState('')
  const route = `/instances/${encodeURIComponent(instanceId)}/subscription-sync`
  const load = async () => {
    try { setState(await api.get(route)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取同步状态失败') }
  }
  useEffect(() => {
    let cancelled = false
    setState(null); setError('')
    api.get(route).then(data => { if (!cancelled) setState(data) }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '读取同步状态失败') })
    return () => { cancelled = true }
  }, [route])
  return <div className="subscription-sync">
    <div className="subscription-sync-head"><strong>自动订阅周期同步</strong><button className="button ghost" onClick={() => void load()}>刷新同步状态</button></div>
    <p className="subscription-sync-description">按最早的周／月重置时间，在重置后 15 分钟内查询确认，同步统一周期日期并重置全部订阅额度。</p>
    {disabled && <p className="subscription-sync-notice warning">实例锁定或操作中时暂停执行；超过本轮 15 分钟窗口则跳过。</p>}
    {state && <div className="subscription-sync-status" role="status">
      {!state.available && <p className="subscription-sync-notice warning">{state.capability_message || '当前插件无法读取统一周期计划，请检查插件及计划设置后刷新状态。'}</p>}
      {state.message && <p className="subscription-sync-message">{state.message}</p>}
      {state.watch && <p className="subscription-sync-date"><span>观察中的最早账户重置时间：</span><time dateTime={state.watch.reset_at}>{dateLabel(state.watch.reset_at)}</time></p>}
      {state.last_missed_reset_at && <p className="subscription-sync-date warning"><span>上次错过的重置时间：</span><time dateTime={state.last_missed_reset_at}>{dateLabel(state.last_missed_reset_at)}</time></p>}
      {state.last_sync && <p className="subscription-sync-date"><span>上次同步：</span><time dateTime={state.last_sync.at}>{dateLabel(state.last_sync.at)}</time> · {state.last_sync.plans ?? '—'} 个计划／{state.last_sync.windows} 个额度窗口<br /><span>下一次重置：</span><time dateTime={state.last_sync.next_reset_at}>{dateLabel(state.last_sync.next_reset_at)}</time></p>}
      {state.pending?.status === 'in_flight' && <p className="subscription-sync-notice danger">本轮操作未全部确认，可能已修改部分计划或额度。本轮不自动重试，请核对插件。</p>}
    </div>}
    {error && <div className="settings-inline-error" role="alert">{error}</div>}
  </div>
}
