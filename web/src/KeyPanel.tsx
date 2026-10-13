import { useEffect, useState } from 'react'
import { api, Instance } from './api'
import { generateApiKey } from '../../shared/api-key.js'
import './keys.css'

type Binding = { instance_id: string; instance_name: string; instance_port?: number; status: string; message: string }
type KeyRecord = { id: string; note: string; masked_key: string; locked: boolean; deleting: boolean; bindings: Binding[] }
type Dialog = { kind: 'create' | 'bind' | 'note' | 'unlock' | 'delete' | 'revoke'; key?: KeyRecord; binding?: Binding }
const labels: Record<string, string> = { pending: '待下发', copied: '备份继承，待验证', deployed: '已下发', exists: '已存在', failed: '下发失败', revoking: '撤销中', 'revoke-failed': '撤销失败' }
const failedBindings = (key: KeyRecord) => key.bindings.filter(binding => ['failed', 'revoke-failed'].includes(binding.status))

export function KeyPanel() {
  const [items, setItems] = useState<KeyRecord[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState('')
  const [value, setValue] = useState('')
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [instanceFilter, setInstanceFilter] = useState('')
  const load = async () => {
    const [keys, children] = await Promise.all([api.get('/keys'), api.get('/instances')])
    setItems(keys.items ?? []); setInstances(children.items ?? [])
    const ids = new Set((keys.items ?? []).map((key: KeyRecord) => key.id))
    setRevealed(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))))
    setExpanded(previous => [...new Set([...previous.filter(id => ids.has(id)), ...(keys.items ?? []).filter((key: KeyRecord) => failedBindings(key).length > 0).map((key: KeyRecord) => key.id)])])
    const boundIds = new Set((keys.items ?? []).flatMap((key: KeyRecord) => key.bindings.map(binding => binding.instance_id)))
    setInstanceFilter(previous => !previous || previous === 'unbound' || boundIds.has(previous) ? previous : '')
  }
  useEffect(() => { void load().catch(cause => setError(cause.message)) }, [])
  const open = (next: Dialog) => { setDialog(next); setNote(next.key?.note ?? ''); setValue(''); setPassword(''); setSelected([]); setError(''); setNotice('') }
  const perform = async (work: () => Promise<void>, reload = true) => {
    setBusy(true); setError(''); setNotice('')
    try { await work(); if (reload) await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') } finally { setBusy(false) }
  }
  const action = async (key: KeyRecord, kind: string, body = {}) => {
    const result = await api.post(`/keys/${key.id}/${kind}`, body)
    if (result.results) {
      const failed = result.results.filter((item: { status: string }) => item.status === 'failed').length
      const guarded = result.results.filter((item: { authentication_guard?: boolean }) => item.authentication_guard).length
      const message = result.deleted ? '所有绑定已撤销，Key 已删除。' : failed ? `${failed} 个实例操作失败，绑定已保留，请处理后重试。` : '操作完成。'
      setNotice(message + (guarded ? ` ${guarded} 个实例保留了未发放的随机保护 Key，避免清空 Key 后开放匿名访问。` : ''))
    }
    return result
  }
  const submit = async () => {
    if (!dialog) return
    await perform(async () => {
      if (dialog.kind === 'create') await api.post('/keys', { note, ...(value ? { key: value } : {}) })
      else if (dialog.key) {
        if (dialog.kind === 'revoke') await action(dialog.key, 'revoke', { instance_id: dialog.binding?.instance_id })
        else await action(dialog.key, dialog.kind, dialog.kind === 'bind' ? { instances: selected } : dialog.kind === 'note' ? { note } : dialog.kind === 'unlock' ? { admin_password: password } : {})
      }
      setDialog(null); setPassword(''); setValue('')
    })
  }
  const generate = () => {
    setValue(generateApiKey())
  }
  const copyKey = async (secret: string) => {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(secret); return }
    const field = document.createElement('textarea'); field.value = secret; field.style.position = 'fixed'; field.style.opacity = '0'
    document.body.append(field)
    try { field.select(); if (!document.execCommand('copy')) throw new Error('浏览器不支持复制，请显示 Key 后手动复制') } finally { field.remove() }
  }
  const unboundCount = items.filter(key => !key.bindings.length).length
  const boundInstances = new Map<string, { name: string; count: number }>()
  items.forEach(key => key.bindings.forEach(binding => {
    const instance = instances.find(item => item.id === binding.instance_id)
    const existing = boundInstances.get(binding.instance_id)
    boundInstances.set(binding.instance_id, { name: instance?.name || binding.instance_name || binding.instance_id, count: (existing?.count ?? 0) + 1 })
  }))
  const filteredItems = items.filter(key => !instanceFilter || (instanceFilter === 'unbound' ? !key.bindings.length : key.bindings.some(binding => binding.instance_id === instanceFilter)))
  return <section className="module-pane key-panel" aria-label="API Key 管理">
    <div className="key-heading"><div><div className="eyebrow">API KEYS</div><h2>API Key 管理</h2><p>每个 API Key 可绑定多个 CPA 实例，下发时保留现有 Key。删除前逐实例撤销。</p></div><div className="key-actions"><button type="button" className="button ghost" disabled={busy} onClick={() => void perform(load, false)}>刷新</button><button type="button" className="button primary" disabled={busy} onClick={() => open({ kind: 'create' })}>创建 Key</button></div></div>
    {error && <p role="alert" className="key-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="key-filter-bar"><div className="key-filters" role="group" aria-label="绑定实例筛选">
      <button type="button" className="key-filter" aria-pressed={!instanceFilter} onClick={() => setInstanceFilter('')}>全部<span>{items.length}</span></button>
      <button type="button" className="key-filter" aria-pressed={instanceFilter === 'unbound'} onClick={() => setInstanceFilter('unbound')}>未绑定<span>{unboundCount}</span></button>
      {[...boundInstances].map(([id, instance]) => <button type="button" className="key-filter" key={id} aria-pressed={instanceFilter === id} onClick={() => setInstanceFilter(id)}>{instance.name}<span>{instance.count}</span></button>)}
    </div><span className="key-filter-count" aria-live="polite">显示 {filteredItems.length} / {items.length} 个 Key</span></div>
    {!items.length && <p>尚未创建 Key。</p>}
    {items.length > 0 && !filteredItems.length && <p className="key-muted">{instanceFilter === 'unbound' ? '暂无未绑定的 Key。' : '该实例暂无绑定的 Key。'}</p>}
    <div className="key-list">{filteredItems.map(key => <article className={`key-card${failedBindings(key).length ? ' has-failure' : ''}`} key={key.id}>
      <div className="key-row"><div className="key-identity"><div className="key-name"><h3 title={key.note || '未命名 Key'}>{key.note || '未命名 Key'}</h3>{key.locked && <span className="state-pill">已锁定</span>}{key.deleting && <span className="state-pill">待完成删除</span>}</div><code title={revealed[key.id] || key.masked_key}>{revealed[key.id] || key.masked_key}</code></div>
        <div className="key-binding-summary">{key.bindings.length ? <button type="button" className="key-expand key-bound" aria-expanded={expanded.includes(key.id)} aria-controls={`bindings-${key.id}`} title={key.bindings.map(binding => `${binding.instance_name || binding.instance_id}：${labels[binding.status] || binding.status}`).join('；')} onClick={() => setExpanded(previous => previous.includes(key.id) ? previous.filter(id => id !== key.id) : [...previous, key.id])}>已绑定实例（{key.bindings.length}）{failedBindings(key).length > 0 && <span className="key-failure-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11h.01" /></svg>{failedBindings(key).length} 个失败</span>}<svg className="key-expand-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></button> : <span className="key-unbound">未绑定实例</span>}</div>
        <div className="key-actions key-row-actions">
        <button type="button" className="button ghost" disabled={busy} onClick={() => void perform(async () => { const response = await action(key, 'reveal'); await copyKey(response.key); setNotice('Key 已复制。') }, false)}>复制</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => revealed[key.id] ? setRevealed(previous => { const next = { ...previous }; delete next[key.id]; return next }) : void perform(async () => { const response = await action(key, 'reveal'); setRevealed(previous => ({ ...previous, [key.id]: response.key })) }, false)}>{revealed[key.id] ? '隐藏' : '显示'}</button>
        <button type="button" className="button ghost" disabled={busy || key.locked} onClick={() => open({ kind: 'note', key })}>备注</button>
        <button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} onClick={() => open({ kind: 'bind', key })}>绑定</button>
        <button type="button" className="button primary" disabled={busy || key.deleting || !key.bindings.length} onClick={() => void perform(async () => { await action(key, 'deploy') })}>下发 Key</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => key.locked ? open({ kind: 'unlock', key }) : void perform(async () => { await action(key, 'lock') })}>{key.locked ? '解锁' : '锁定'}</button>
        <button type="button" className="button danger" disabled={busy || key.locked} onClick={() => open({ kind: 'delete', key })}>{key.deleting ? '重试删除' : '删除'}</button>
      </div></div>
      {key.bindings.length > 0 && <div id={`bindings-${key.id}`} className="key-binding-details" hidden={!expanded.includes(key.id)}>{key.bindings.map(binding => { const instance = instances.find(item => item.id === binding.instance_id); const name = instance?.name || binding.instance_name || binding.instance_id; const port = instance?.port ?? binding.instance_port; return <div className={`key-binding${['failed', 'revoke-failed'].includes(binding.status) ? ' has-failure' : ''}`} key={binding.instance_id}><div className="key-binding-info"><div className="key-binding-name"><strong>{name}</strong>{port !== undefined && <span className="key-binding-port">端口 {port}</span>}<span className="state-pill">{labels[binding.status] || binding.status}</span></div>{binding.message && <small className="key-error">{binding.message}</small>}</div><button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} onClick={() => open({ kind: 'revoke', key, binding })}>解绑并撤销</button></div> })}</div>}
    </article>)}</div>
    {dialog && <dialog open className="modal-backdrop"><div className="dialog key-dialog"><button type="button" className="dialog-close" disabled={busy} aria-label="关闭" onClick={() => setDialog(null)}>×</button><h2>{{ create: '创建 Key', bind: '绑定 CPA 实例', note: '编辑备注', unlock: '解锁 Key', delete: '删除 Key', revoke: '解绑并撤销' }[dialog.kind]}</h2>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        {['create', 'note'].includes(dialog.kind) && <label>备注（可选）<input aria-label="Key 备注" value={note} maxLength={200} onChange={event => setNote(event.target.value)} placeholder="例如：测试" /></label>}
        {dialog.kind === 'create' && <><label>API Key<div className="key-input"><input aria-label="API Key" value={value} onChange={event => setValue(event.target.value)} minLength={8} maxLength={512} placeholder="手动输入，或留空由服务器随机生成" autoComplete="off" /><button type="button" className="button ghost" onClick={generate}>生成</button></div></label><small>备注和 Key 保存在总控，创建后可绑定多个实例。</small></>}
        {dialog.kind === 'unlock' && <label>总控管理员密码<input aria-label="总控管理员密码" type="password" value={password} autoComplete="current-password" onChange={event => setPassword(event.target.value)} required /></label>}
        {dialog.kind === 'bind' && <div className="key-choices">{instances.map(instance => { const bound = dialog.key?.bindings.some(binding => binding.instance_id === instance.id); return <label className="checkbox-label" key={instance.id}><input type="checkbox" checked={Boolean(bound) || selected.includes(instance.id)} disabled={bound} onChange={event => setSelected(previous => event.target.checked ? [...previous, instance.id] : previous.filter(id => id !== instance.id))} />{instance.name} · {instance.status.state === 'running' ? '运行中' : '未运行'}{instance.locked ? ' · 已锁定' : ''}{bound ? ' · 已绑定' : ''}</label> })}<p>绑定不会立即下发。已锁定或未运行的实例需要处理后才能下发。</p></div>}
        {dialog.kind === 'delete' && <><p>将从以下所有绑定实例移除该 Key。全部验证成功后，才删除总控记录；失败项保留，支持重试。若移除后列表为空，会保留一个未发放的随机保护 Key，避免开放匿名访问。</p><ul>{dialog.key?.bindings.map(binding => { const instance = instances.find(item => item.id === binding.instance_id); const name = instance?.name || binding.instance_name || binding.instance_id; const port = instance?.port ?? binding.instance_port; return <li key={binding.instance_id}>{name}{port !== undefined ? ` · 端口 ${port}` : ''}</li> })}</ul>{!dialog.key?.bindings.length && <p>此 Key 没有绑定实例，可直接移除总控记录。</p>}</>}
        {dialog.kind === 'revoke' && <p>将从 {(() => { const instance = instances.find(item => item.id === dialog.binding?.instance_id); const name = instance?.name || dialog.binding?.instance_name || dialog.binding?.instance_id; const port = instance?.port ?? dialog.binding?.instance_port; return `${name}${port !== undefined ? ` · 端口 ${port}` : ''}` })()} 删除此 Key，验证成功后解除绑定。其他实例不受影响。若移除后列表为空，会保留一个未发放的随机保护 Key，避免开放匿名访问。</p>}
        {error && <p role="alert" className="key-error">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={busy || (dialog.kind === 'bind' && !selected.length)}>{busy ? '处理中…' : dialog.kind === 'delete' ? '撤销并删除' : dialog.kind === 'revoke' ? '确认撤销' : '保存'}</button></div>
      </form></div></dialog>}
  </section>
}
