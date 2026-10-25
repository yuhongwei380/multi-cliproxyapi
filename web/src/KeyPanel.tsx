import { useEffect, useState } from 'react'
import { api, Instance } from './api'
import { generateApiKey } from '../../shared/api-key.js'
import './keys.css'

type Binding = { instance_id: string; instance_name: string; instance_port?: number; status: string; message: string }
type KeyRecord = { id: string; note: string; masked_key: string; group_id?: string | null; locked: boolean; deleting: boolean; bindings: Binding[] }
type KeyGroup = { id: string; name: string }
type Dialog = { kind: 'create' | 'bind' | 'note' | 'unlock' | 'delete' | 'revoke' | 'group' | 'create-group' | 'edit-group' | 'delete-group' | 'deploy-group'; key?: KeyRecord; binding?: Binding; group?: KeyGroup }
const ungrouped: KeyGroup = { id: 'ungrouped', name: '未分组' }
const labels: Record<string, string> = { pending: '待下发', copied: '备份继承，待验证', deployed: '已下发', exists: '已存在', failed: '下发失败', revoking: '撤销中', 'revoke-failed': '撤销失败' }
const failedBindings = (key: KeyRecord) => key.bindings.filter(binding => ['failed', 'revoke-failed'].includes(binding.status))

export function KeyPanel() {
  const [items, setItems] = useState<KeyRecord[]>([])
  const [groups, setGroups] = useState<KeyGroup[]>([ungrouped])
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const [groupName, setGroupName] = useState('')
  const [groupId, setGroupId] = useState('ungrouped')
  const [choiceSearch, setChoiceSearch] = useState('')
  const [instances, setInstances] = useState<Instance[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState('')
  const [value, setValue] = useState('')
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [revealBusy, setRevealBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [instanceFilter, setInstanceFilter] = useState('')
  const [search, setSearch] = useState('')
  const load = async () => {
    const [keys, children] = await Promise.all([api.get('/keys'), api.get('/instances')])
    setItems(keys.items ?? []); setInstances(children.items ?? [])
    const nextGroups: KeyGroup[] = [...(keys.groups ?? []).filter((group: KeyGroup) => group.id !== 'ungrouped'), ungrouped]
    setGroups(nextGroups)
    setExpandedGroups(previous => [...new Set([...previous.filter(id => nextGroups.some(group => group.id === id)), ...(keys.items ?? []).filter((key: KeyRecord) => failedBindings(key).length > 0).map((key: KeyRecord) => key.group_id ?? 'ungrouped')])])
    const ids = new Set((keys.items ?? []).map((key: KeyRecord) => key.id))
    setRevealed(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))))
    setExpanded(previous => [...new Set([...previous.filter(id => ids.has(id)), ...(keys.items ?? []).filter((key: KeyRecord) => failedBindings(key).length > 0).map((key: KeyRecord) => key.id)])])
    const boundIds = new Set((keys.items ?? []).flatMap((key: KeyRecord) => key.bindings.map(binding => binding.instance_id)))
    setInstanceFilter(previous => !previous || previous === 'unbound' || boundIds.has(previous) ? previous : '')
  }
  useEffect(() => { void load().catch(cause => setError(cause.message)) }, [])
  const groupMembers = (group: KeyGroup) => items.filter(key => (key.group_id ?? 'ungrouped') === group.id)
  const filterByInstance = (id: string) => { setInstanceFilter(id); setExpandedGroups(groups.map(group => group.id)) }
  const open = (next: Dialog) => {
    setDialog(next); setNote(next.key?.note ?? ''); setValue(''); setPassword(''); setError(''); setNotice(''); setChoiceSearch('')
    setGroupName(next.group?.name ?? ''); setGroupId(next.key?.group_id ?? 'ungrouped')
    const members = next.group ? groupMembers(next.group) : []
    setSelected(next.kind === 'edit-group' ? members.map(key => key.id) : next.kind === 'deploy-group' ? instances.filter(instance => !instance.locked && instance.status.state === 'running' && members.some(key => key.bindings.some(binding => binding.instance_id === instance.id))).map(instance => instance.id) : [])
  }
  const perform = async (work: () => Promise<void>, reload = true) => {
    setBusy(true); setError(''); setNotice('')
    try { await work(); if (reload) await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') } finally { setBusy(false) }
  }
  const revealKey = async (key: KeyRecord, onRevealed: (secret: string) => void | Promise<void>) => {
    if (revealBusy[key.id]) return
    setRevealBusy(previous => ({ ...previous, [key.id]: true })); setError('')
    try { const response = await action(key, 'reveal'); await onRevealed(response.key) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Key 读取失败') } finally {
      setRevealBusy(previous => { const next = { ...previous }; delete next[key.id]; return next })
    }
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
      if (dialog.kind === 'create') await api.post('/keys', { note, ...(value ? { key: value } : {}), ...(groupId !== 'ungrouped' ? { group_id: groupId } : {}) })
      else if (dialog.kind === 'create-group' || dialog.kind === 'edit-group') {
        const created = await api.post(dialog.group ? `/key-groups/${dialog.group.id}/update` : '/key-groups', { name: groupName, key_ids: selected })
        if (created.id) setExpandedGroups(previous => [...new Set([...previous, created.id])])
        setNotice('分组已保存。')
      } else if (dialog.kind === 'delete-group' && dialog.group) {
        await api.post(`/key-groups/${dialog.group.id}/delete`, {})
        setNotice('分组已删除，组内 Key 已归入“未分组”。')
      } else if (dialog.kind === 'deploy-group' && dialog.group) {
        const result = await api.post(`/key-groups/${dialog.group.id}/deploy`, { instances: selected })
        const failed = result.results.filter((item: { status: string }) => item.status === 'failed').length
        setNotice(`批量下发完成：${result.results.length - failed} 项成功，${failed} 项失败。${failed ? '失败绑定已保留，可展开组内 Key 查看并重试。' : ''}`)
        setExpandedGroups(previous => [...new Set([...previous, dialog.group!.id])])
      }
      else if (dialog.key) {
        if (dialog.kind === 'revoke') await action(dialog.key, 'revoke', { instance_id: dialog.binding?.instance_id })
        else await action(dialog.key, dialog.kind, dialog.kind === 'bind' ? { instances: selected } : dialog.kind === 'note' ? { note } : dialog.kind === 'group' ? { group_id: groupId === 'ungrouped' ? null : groupId } : dialog.kind === 'unlock' ? { admin_password: password } : {})
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
  const searchTerm = search.trim().toLocaleLowerCase()
  const filteredItems = items.filter(key => {
    const matchesInstance = !instanceFilter || (instanceFilter === 'unbound' ? !key.bindings.length : key.bindings.some(binding => binding.instance_id === instanceFilter))
    const matchesSearch = !searchTerm || key.note.toLocaleLowerCase().includes(searchTerm)
    return matchesInstance && matchesSearch
  })
  const choosingKeys = dialog?.kind === 'create-group' || dialog?.kind === 'edit-group'
  const deploymentMembers = dialog?.group ? groupMembers(dialog.group) : []
  const invalidDeployment = dialog?.kind === 'deploy-group' && (deploymentMembers.some(key => key.deleting) || deploymentMembers.some(key => key.locked && selected.some(id => !key.bindings.some(binding => binding.instance_id === id))))
  return <section className="module-pane key-panel" aria-label="API Key 管理">
    <div className="key-heading"><div><div className="eyebrow">API KEYS</div><h2>API Key 管理</h2><p>按组管理 API Key，展开组查看 Key，或将整组 Key 批量下发到所选 CPA 实例。</p></div><div className="key-actions"><button type="button" className="button ghost" disabled={busy} onClick={() => void perform(load, false)}>刷新</button><button type="button" className="button ghost" disabled={busy} onClick={() => open({ kind: 'create-group' })}>新建组</button><button type="button" className="button primary" disabled={busy} onClick={() => open({ kind: 'create' })}>创建 Key</button></div></div>
    {error && <p role="alert" className="key-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="key-search-bar"><label className="key-search-label" htmlFor="key-note-search">搜索 API Key 备注<input id="key-note-search" aria-label="搜索 API Key 备注" value={search} onChange={event => { setSearch(event.target.value); setExpandedGroups(groups.map(group => group.id)) }} placeholder="输入备注关键词" autoComplete="off" /></label>{search && <button type="button" className="button ghost key-search-clear" onClick={() => setSearch('')}>清除</button>}</div>
    <div className="key-filter-bar"><div className="key-filters" role="group" aria-label="绑定实例筛选">
      <button type="button" className="key-filter" aria-pressed={!instanceFilter} onClick={() => filterByInstance('')}>全部<span>{items.length}</span></button>
      <button type="button" className="key-filter" aria-pressed={instanceFilter === 'unbound'} onClick={() => filterByInstance('unbound')}>未绑定<span>{unboundCount}</span></button>
      {[...boundInstances].map(([id, instance]) => <button type="button" className="key-filter" key={id} aria-pressed={instanceFilter === id} onClick={() => filterByInstance(id)}>{instance.name}<span>{instance.count}</span></button>)}
    </div><span className="key-filter-count" aria-live="polite">显示 {filteredItems.length} / {items.length} 个 Key</span></div>
    {!items.length && <p>尚未创建 Key。</p>}
    {items.length > 0 && !filteredItems.length && <p className="key-muted">{searchTerm ? `没有匹配“${search.trim()}”的 Key。` : instanceFilter === 'unbound' ? '暂无未绑定的 Key。' : '该实例暂无绑定的 Key。'}</p>}
    <div className="key-groups">{groups.map(group => {
      const members = groupMembers(group)
      const visible = filteredItems.filter(key => (key.group_id ?? 'ungrouped') === group.id)
      if ((searchTerm || instanceFilter) && !visible.length) return null
      const isExpanded = expandedGroups.includes(group.id)
      const failures = members.reduce((count, key) => count + failedBindings(key).length, 0)
      return <section className="key-group" key={group.id} aria-label={group.name}>
        <div className="key-group-heading"><button type="button" className="key-group-toggle" aria-expanded={isExpanded} aria-controls={`group-${group.id}`} onClick={() => setExpandedGroups(previous => previous.includes(group.id) ? previous.filter(id => id !== group.id) : [...previous, group.id])}><svg className="key-expand-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg><strong>{group.name}</strong><span className="key-group-count">{members.length} 个 Key</span>{failures > 0 && <span className="key-failure-badge">{failures} 个失败</span>}</button><div className="key-actions">{group.id !== 'ungrouped' && <><button type="button" className="button ghost" disabled={busy} onClick={() => open({ kind: 'edit-group', group })}>编辑分组</button><button type="button" className="button ghost" disabled={busy || members.some(key => key.locked || key.deleting)} onClick={() => open({ kind: 'delete-group', group })}>删除分组</button></>}<button type="button" className="button primary" disabled={busy || !members.length} onClick={() => open({ kind: 'deploy-group', group })}>批量下发</button></div></div>
        {isExpanded && <div id={`group-${group.id}`} className="key-group-content">{!visible.length && <p className="key-muted">此组暂无 Key，可通过编辑分组或 Key 的“分组”按钮添加。</p>}<div className="key-list">{visible.map(key => <article className={`key-card${failedBindings(key).length ? ' has-failure' : ''}`} key={key.id}>
      <div className="key-row"><div className="key-identity"><div className="key-name"><h3 title={key.note || '未命名 Key'}>{key.note || '未命名 Key'}</h3>{key.locked && <span className="state-pill">CPA已锁定</span>}{key.deleting && <span className="state-pill">待完成删除</span>}</div><code title={revealed[key.id] || key.masked_key}>{revealed[key.id] || key.masked_key}</code></div>
        <div className="key-binding-summary">{key.bindings.length ? <button type="button" className="key-expand key-bound" aria-expanded={expanded.includes(key.id)} aria-controls={`bindings-${key.id}`} title={key.bindings.map(binding => `${binding.instance_name || binding.instance_id}：${labels[binding.status] || binding.status}`).join('；')} onClick={() => setExpanded(previous => previous.includes(key.id) ? previous.filter(id => id !== key.id) : [...previous, key.id])}>已绑定实例（{key.bindings.length}）{failedBindings(key).length > 0 && <span className="key-failure-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11h.01" /></svg>{failedBindings(key).length} 个失败</span>}<svg className="key-expand-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></button> : <span className="key-unbound">未绑定</span>}</div>
        <div className="key-actions key-row-actions">
        <button type="button" className="button ghost" disabled={busy || revealBusy[key.id]} onClick={() => void revealKey(key, async secret => { await copyKey(secret); setNotice('Key 已复制。') })}>复制</button>
        <button type="button" className="button ghost" disabled={busy || revealBusy[key.id]} onClick={() => revealed[key.id] ? setRevealed(previous => { const next = { ...previous }; delete next[key.id]; return next }) : void revealKey(key, secret => { setRevealed(previous => ({ ...previous, [key.id]: secret })) })}>{revealed[key.id] ? '隐藏' : '显示'}</button>
        <button type="button" className="button ghost" disabled={busy || key.locked} onClick={() => open({ kind: 'note', key })}>备注</button>
        <button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} onClick={() => open({ kind: 'group', key })}>分组</button>
        <button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} onClick={() => open({ kind: 'bind', key })}>绑定</button>
        <button type="button" className="button primary" disabled={busy || key.deleting || !key.bindings.length} onClick={() => void perform(async () => { await action(key, 'deploy') })}>下发 Key</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => key.locked ? open({ kind: 'unlock', key }) : void perform(async () => { await action(key, 'lock') })}>{key.locked ? '解锁' : '锁定'}</button>
        <button type="button" className="button danger" disabled={busy || key.locked} onClick={() => open({ kind: 'delete', key })}>{key.deleting ? '重试删除' : '删除'}</button>
      </div></div>
      {key.bindings.length > 0 && <div id={`bindings-${key.id}`} className="key-binding-details" hidden={!expanded.includes(key.id)}>{key.bindings.map(binding => { const instance = instances.find(item => item.id === binding.instance_id); const name = instance?.name || binding.instance_name || binding.instance_id; const port = instance?.port ?? binding.instance_port; return <div className={`key-binding${['failed', 'revoke-failed'].includes(binding.status) ? ' has-failure' : ''}`} key={binding.instance_id}><div className="key-binding-info"><div className="key-binding-name"><strong>{name}</strong>{port !== undefined && <span className="key-binding-port">端口 {port}</span>}<span className="state-pill">{labels[binding.status] || binding.status}</span></div>{binding.message && <small className="key-error">{binding.message}</small>}</div><div className="key-binding-actions">{binding.status === 'failed' && <button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} title="关闭失败提示，保留绑定并设为待下发" onClick={() => void perform(async () => { await api.post(`/keys/${key.id}/dismiss-failure`, { instance_id: binding.instance_id }); setNotice('已关闭下发失败提示，绑定已保留为待下发。') })}>关闭报错</button>}<button type="button" className="button ghost" disabled={busy || key.locked || key.deleting} onClick={() => open({ kind: 'revoke', key, binding })}>解绑并撤销</button></div></div> })}</div>}
    </article>)}</div></div>}
      </section>
    })}</div>
    {dialog && <dialog open className="modal-backdrop"><div className="dialog key-dialog"><button type="button" className="dialog-close" disabled={busy} aria-label="关闭" onClick={() => setDialog(null)}>×</button><h2>{{ create: '创建 Key', bind: '绑定 CPA 实例', note: '编辑备注', unlock: '解锁 Key', delete: '删除 Key', revoke: '解绑并撤销', group: '调整 Key 分组', 'create-group': '新建组', 'edit-group': '编辑分组', 'delete-group': '删除分组', 'deploy-group': '批量下发 Key' }[dialog.kind]}</h2>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        {['create', 'note'].includes(dialog.kind) && <label>备注（可选）<input aria-label="Key 备注" value={note} maxLength={200} onChange={event => setNote(event.target.value)} placeholder="例如：测试" /></label>}
        {['create', 'group'].includes(dialog.kind) && <label>所属分组<select aria-label="所属分组" value={groupId} onChange={event => setGroupId(event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
        {choosingKeys && <><label>分组名称<input aria-label="分组名称" required maxLength={80} value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="例如：生产环境" /></label><label>选择 Key（已选 {selected.length} 个）<input aria-label="搜索可选 Key" value={choiceSearch} onChange={event => setChoiceSearch(event.target.value)} placeholder="搜索 Key 备注" /></label><div className="key-choices">{items.filter(key => key.note.toLocaleLowerCase().includes(choiceSearch.trim().toLocaleLowerCase())).map(key => <label className="checkbox-label" key={key.id}><input type="checkbox" checked={selected.includes(key.id)} disabled={key.locked || key.deleting} onChange={event => setSelected(previous => event.target.checked ? [...previous, key.id] : previous.filter(id => id !== key.id))} /><span>{key.note || '未命名 Key'} <small>{key.masked_key} · {groups.find(group => group.id === key.group_id)?.name ?? '未分组'}{key.locked ? ' · 已锁定' : key.deleting ? ' · 待删除' : ''}</small></span></label>)}</div><p className="key-muted">每个 Key 归属一个组。选择其他组的 Key 会将其移入此组；取消选择的原组 Key 归入“未分组”。已有实例绑定会保留。</p></>}
        {dialog.kind === 'delete-group' && <p>删除“{dialog.group?.name}”后，{deploymentMembers.length} 个 Key 将归入“未分组”，已有实例绑定会保留。</p>}
        {dialog.kind === 'deploy-group' && <><p>将“{dialog.group?.name}”中的全部 {deploymentMembers.length} 个 Key 下发到所选 CPA 实例，保留实例中已有的 Key。</p><div className="key-choices">{instances.map(instance => <label className="checkbox-label" key={instance.id}><input type="checkbox" checked={selected.includes(instance.id)} disabled={instance.locked || instance.status.state !== 'running'} onChange={event => setSelected(previous => event.target.checked ? [...previous, instance.id] : previous.filter(id => id !== instance.id))} />{instance.name} · 端口 {instance.port} · {instance.status.state === 'running' ? '运行中' : '未运行'}{instance.locked ? ' · 已锁定' : ''}</label>)}</div>{!instances.length && <p className="key-muted">暂无 CPA 实例。</p>}<p className="key-muted">下发会为组内 Key 添加所选实例绑定。实例须运行且未锁定；已锁定 Key 仅能下发到已绑定实例。</p>{invalidDeployment && <p className="key-error">组内含待删除 Key，或已锁定 Key 尚未绑定所选实例，请先处理后重试。</p>}</>}
        {dialog.kind === 'create' && <><label>API Key<div className="key-input"><input aria-label="API Key" value={value} onChange={event => setValue(event.target.value)} minLength={8} maxLength={512} placeholder="手动输入，或留空由服务器随机生成" autoComplete="off" /><button type="button" className="button ghost" onClick={generate}>生成</button></div></label><small>备注和 Key 保存在总控，创建后可绑定多个实例。</small></>}
        {dialog.kind === 'unlock' && <label>总控管理员密码<input aria-label="总控管理员密码" type="password" value={password} autoComplete="current-password" onChange={event => setPassword(event.target.value)} required /></label>}
        {dialog.kind === 'bind' && <div className="key-choices">{instances.map(instance => { const bound = dialog.key?.bindings.some(binding => binding.instance_id === instance.id); return <label className="checkbox-label" key={instance.id}><input type="checkbox" checked={Boolean(bound) || selected.includes(instance.id)} disabled={bound} onChange={event => setSelected(previous => event.target.checked ? [...previous, instance.id] : previous.filter(id => id !== instance.id))} />{instance.name} · {instance.status.state === 'running' ? '运行中' : '未运行'}{instance.locked ? ' · 已锁定' : ''}{bound ? ' · 已绑定' : ''}</label> })}<p>绑定不会立即下发。已锁定或未运行的实例需要处理后才能下发。</p></div>}
        {dialog.kind === 'delete' && <><p>将从以下所有绑定实例移除该 Key。全部验证成功后，才删除总控记录；失败项保留，支持重试。若移除后列表为空，会保留一个未发放的随机保护 Key，避免开放匿名访问。</p><ul>{dialog.key?.bindings.map(binding => { const instance = instances.find(item => item.id === binding.instance_id); const name = instance?.name || binding.instance_name || binding.instance_id; const port = instance?.port ?? binding.instance_port; return <li key={binding.instance_id}>{name}{port !== undefined ? ` · 端口 ${port}` : ''}</li> })}</ul>{!dialog.key?.bindings.length && <p>此 Key 没有绑定实例，可直接移除总控记录。</p>}</>}
        {dialog.kind === 'revoke' && <p>将从 {(() => { const instance = instances.find(item => item.id === dialog.binding?.instance_id); const name = instance?.name || dialog.binding?.instance_name || dialog.binding?.instance_id; const port = instance?.port ?? dialog.binding?.instance_port; return `${name}${port !== undefined ? ` · 端口 ${port}` : ''}` })()} 删除此 Key，验证成功后解除绑定。其他实例不受影响。若移除后列表为空，会保留一个未发放的随机保护 Key，避免开放匿名访问。</p>}
        {error && <p role="alert" className="key-error">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={busy || (['bind', 'deploy-group'].includes(dialog.kind) && !selected.length) || (choosingKeys && !groupName.trim()) || Boolean(invalidDeployment)}>{busy ? '处理中…' : dialog.kind === 'delete' ? '撤销并删除' : dialog.kind === 'delete-group' ? '确认删除分组' : dialog.kind === 'deploy-group' ? '确认下发' : dialog.kind === 'revoke' ? '确认撤销' : '保存'}</button></div>
      </form></div></dialog>}
  </section>
}
