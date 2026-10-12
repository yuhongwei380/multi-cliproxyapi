import { useEffect, useState } from 'react'
import { api } from './api'
import './plugins.css'

type Plugin = { id: string; installed: boolean; version: string; registered: boolean | null; enabled: boolean | null }
type Inventory = { catalog: { id: string; name: string; repository: string }[]; instances: { id: string; name: string; locked: boolean; state: string; plugins: Plugin[]; message: string }[] }
type Job = { id: string; plugin: string; version: string; state: string; created_at?: string; message: string; results: { id: string; state: string; message?: string }[] }
const labels: Record<string, string> = { queued: '排队中', running: '部署中', blocked: '需要恢复', completed: '完成', failed: '失败', pending: '待处理', 'skipped-locked': '已锁定，跳过', 'backing-up': '备份中', prepared: '备份完成', installing: '安装中', verifying: '验证中', verified: '加载验证通过', 'installed-pending-verification': '已安装，待启动验证', 'rolled-back': '已回滚', restoring: '回滚中', cancelled: '已取消' }
const runtimeLabels: Record<string, string> = { running: '运行中', stopped: '已停止', failed: '运行失败', starting: '启动中', stopping: '停止中', unknown: '未知' }
const finished = (job: Job) => ['completed', 'failed'].includes(job.state)
const tone = (state: string) => state === 'completed' || state === 'verified' ? 'success' : state === 'failed' || state === 'blocked' ? 'danger' : ['running', 'queued', 'installing', 'verifying', 'restoring'].includes(state) ? 'progress' : 'neutral'
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知'

export function PluginPanel() {
  const [inventory, setInventory] = useState<Inventory>({ catalog: [], instances: [] })
  const [jobs, setJobs] = useState<Job[]>([])
  const [plugin, setPlugin] = useState('cpa-key-billing')
  const [version, setVersion] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [enable, setEnable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null)
  const active = jobs.some(job => ['queued', 'running', 'blocked'].includes(job.state))
  async function refresh() {
    try {
      const [data, history] = await Promise.all([api.get('/plugins'), api.get('/plugins/jobs')])
      setInventory(data); setJobs(history.items); setLoadError('')
      setSelected(ids => ids.filter(id => data.instances.some((item: Inventory['instances'][number]) => item.id === id)))
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : '读取插件失败') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await refresh(); if (!cancelled) timer = setTimeout(() => void poll(), 3000) }
    void poll(); return () => { cancelled = true; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (!deleteTarget) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setDeleteTarget(null) }
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape)
  }, [deleteTarget, busy])
  async function deploy() {
    setBusy(true); setError('')
    try { await api.post('/plugins/deploy', { plugin, version: version.trim(), instances: selected, enable }); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '部署失败') }
    finally { setBusy(false) }
  }
  async function recover() {
    setBusy(true); setError('')
    try { await api.post('/plugins/recover'); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') }
    finally { setBusy(false) }
  }
  async function deleteRecord() {
    if (!deleteTarget) return
    setBusy(true); setError('')
    try { await api.delete(`/plugins/jobs/${encodeURIComponent(deleteTarget.id)}`); setJobs(items => items.filter(item => item.id !== deleteTarget.id)); setDeleteTarget(null); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除记录失败') }
    finally { setBusy(false) }
  }
  const eligible = selected.map(id => inventory.instances.find(item => item.id === id)).filter(item => item && !item.locked)
  const descriptor = inventory.catalog.find(item => item.id === plugin)
  const instanceName = (id: string) => inventory.instances.find(item => item.id === id)?.name || id
  return <section className="module-pane plugins-module" aria-label="插件管理">
    <div className="section-heading module-heading"><div><div className="eyebrow">PLUGIN CONTROL</div><h1>插件管理</h1><p>集中管理插件版本，按所选顺序逐个部署到实例。</p></div><div className="section-actions"><button className="button ghost" disabled={busy} onClick={() => void refresh()}>刷新</button></div></div>
    {(error || loadError) && !deleteTarget && <p className="settings-inline-error" role="alert">{error || loadError}</p>}
    {jobs.some(job => job.state === 'blocked') && <div className="plugin-recovery"><div><strong>部署需要恢复</strong><p>上次回滚未完成，恢复后可继续安装或升级插件。</p></div><button className="button ghost" disabled={busy} onClick={() => void recover()}>重试回滚</button></div>}
    <form className="plugin-card plugin-form" onSubmit={event => { event.preventDefault(); void deploy() }}>
      <div className="plugin-card-heading"><div><h2>部署插件</h2><p>升级保留配置；运行中的实例会短暂重启，停止中的实例保持停止。</p></div><span className="plugin-badge neutral">{inventory.instances.length} 个实例</span></div>
      <div className="plugin-fields"><label>插件<select aria-label="插件" disabled={busy || active || loading} value={plugin} onChange={event => setPlugin(event.target.value)}>{inventory.catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{descriptor?.repository || '正在读取插件目录'}</small></label><label>目标版本<input aria-label="插件版本" disabled={busy || active} placeholder="latest，例如 1.3.20" value={version} onChange={event => setVersion(event.target.value)} /><small>留空使用最新发布版本</small></label><div className="plugin-enable"><label className="checkbox-label"><input type="checkbox" disabled={busy || active} checked={enable} onChange={event => setEnable(event.target.checked)} />安装后启用</label><small>默认保留当前启用状态</small></div></div>
      <div className="plugin-target-heading"><h3>选择实例</h3><button className="button ghost" type="button" disabled={busy || active || !inventory.instances.some(item => !item.locked)} onClick={() => setSelected(inventory.instances.filter(item => !item.locked).map(item => item.id))}>选择未锁定实例</button></div>
      {loading ? <div className="plugin-empty">正在读取实例…</div> : !inventory.instances.length ? <div className="plugin-empty">暂无实例。创建 CPA 实例后即可部署插件。</div> : <div className="plugin-table-wrap"><table className="plugin-table"><thead><tr><th>实例</th><th>插件版本</th><th>插件状态</th><th>运行状态</th></tr></thead><tbody>{inventory.instances.map(instance => {
        const item = instance.plugins.find(item => item.id === plugin)
        return <tr key={instance.id}><td><label className="checkbox-label"><input type="checkbox" aria-label={`选择 ${instance.name}`} disabled={active || busy} checked={selected.includes(instance.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, instance.id] : ids.filter(id => id !== instance.id))} /><span>{instance.name}{instance.locked && <small className="plugin-lock">已锁定</small>}</span></label>{instance.message && <small className="plugin-instance-error">{instance.message}</small>}</td><td className="plugin-version">{item?.installed ? item.version || '版本待确认' : '—'}</td><td><span className={`plugin-badge ${item?.enabled ? 'success' : 'neutral'}`}>{!item?.installed ? '未安装' : item.enabled === null ? '待启动验证' : item.enabled ? '已启用' : '未启用'}</span></td><td><span className={`plugin-runtime ${instance.state === 'running' ? 'live' : ''}`}>{runtimeLabels[instance.state] || instance.state}</span></td></tr>
      })}</tbody></table></div>}
      <div className="plugin-deploy-footer"><div><p role="status">将部署 {eligible.length} 个实例，跳过 {selected.length - eligible.length} 个已锁定实例。</p><small>首个实例：{eligible[0]?.name || '—'}；首个失败会回滚并停止后续部署。</small></div><button className="button primary" disabled={loading || busy || active || !eligible.length}>{busy ? '处理中…' : '统一安装 / 升级'}</button></div>
    </form>
    <section className="plugin-card plugin-history" aria-label="部署记录"><div className="plugin-card-heading"><div><h2>部署记录</h2><p>查看每次部署结果，已结束的记录可删除。</p></div><span className="plugin-badge neutral">{jobs.length} 条记录</span></div>
      {!jobs.length ? <div className="plugin-empty">{loading ? '正在读取记录…' : '暂无部署记录'}</div> : <div className="plugin-job-list">{jobs.map(job => <article className="plugin-job" key={job.id}>
        <div className="plugin-job-heading"><div><strong>{inventory.catalog.find(item => item.id === job.plugin)?.name || job.plugin}</strong><span className="plugin-version">{job.version || 'latest'}</span><span className={`plugin-badge ${tone(job.state)}`}>{labels[job.state] || job.state}</span></div><button className="button ghost plugin-record-delete" type="button" disabled={busy || !finished(job)} title={!finished(job) ? '运行中或待恢复的记录无法删除' : '删除此部署记录'} aria-label={`删除部署记录 ${job.id}`} onClick={() => { setError(''); setDeleteTarget(job) }}>删除记录</button></div>
        <div className="plugin-job-meta"><time dateTime={job.created_at}>{dateLabel(job.created_at)}</time><span>{job.results.length} 个实例</span><span>{job.results.filter(result => ['verified', 'installed-pending-verification'].includes(result.state)).length} 个已安装</span>{job.results.some(result => result.state === 'rolled-back') && <span>包含回滚</span>}</div>
        <details open={job.state === 'blocked' || undefined}><summary>实例结果与详情</summary>{job.message && <p className="plugin-job-message">{job.message}</p>}<ul className="plugin-job-results">{job.results.map(result => <li key={result.id}><span>{instanceName(result.id)}</span><span className={`plugin-badge ${tone(result.state)}`}>{labels[result.state] || result.state}</span>{result.message && <p>{result.message}</p>}</li>)}</ul></details>
      </article>)}</div>}
      <p className="plugin-history-note">回滚恢复插件文件和 CPA 配置，不会逆转插件自身的数据迁移。</p>
    </section>
    {deleteTarget && <dialog open className="modal-backdrop" aria-labelledby="plugin-delete-title"><div className="dialog plugin-delete-dialog"><button className="dialog-close" disabled={busy} aria-label="关闭删除记录对话框" onClick={() => setDeleteTarget(null)}>×</button><div className="eyebrow">DEPLOYMENT HISTORY</div><h2 id="plugin-delete-title">删除部署记录？</h2><p>{deleteTarget.plugin} · {deleteTarget.version || 'latest'} · {dateLabel(deleteTarget.created_at)}</p><p>删除后无法恢复此记录。已安装的插件、实例配置和备份会保留。</p>{error && <p className="settings-inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => void deleteRecord()}>{busy ? '删除中…' : '确认删除记录'}</button></div></div></dialog>}
  </section>
}
