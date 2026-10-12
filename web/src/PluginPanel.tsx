import { useEffect, useState } from 'react'
import { api } from './api'

type Plugin = { id: string; installed: boolean; version: string; registered: boolean | null; enabled: boolean | null }
type Inventory = { catalog: { id: string; name: string; repository: string }[]; instances: { id: string; name: string; locked: boolean; state: string; plugins: Plugin[]; message: string }[] }
type Job = { id: string; plugin: string; version: string; state: string; message: string; results: { id: string; state: string; message?: string }[] }
const labels: Record<string, string> = { queued: '排队中', running: '部署中', blocked: '需要恢复', completed: '完成', failed: '失败', pending: '待处理', 'skipped-locked': '已锁定，跳过', 'backing-up': '备份中', prepared: '备份完成', installing: '安装中', verifying: '验证中', verified: '加载验证通过', 'installed-pending-verification': '已安装，待启动验证', 'rolled-back': '已回滚', restoring: '回滚中', cancelled: '已取消' }
export function PluginPanel() {
  const [inventory, setInventory] = useState<Inventory>({ catalog: [], instances: [] })
  const [jobs, setJobs] = useState<Job[]>([])
  const [plugin, setPlugin] = useState('cpa-key-billing')
  const [version, setVersion] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [enable, setEnable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = jobs.some(job => ['queued', 'running', 'blocked'].includes(job.state))
  async function refresh() {
    try { const [data, history] = await Promise.all([api.get('/plugins'), api.get('/plugins/jobs')]); setInventory(data); setJobs(history.items); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : '读取插件失败') }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [])
  async function deploy() {
    setBusy(true); setError('')
    try { await api.post('/plugins/deploy', { plugin, version: version.trim(), instances: selected, enable }); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : '部署失败') } finally { setBusy(false) }
  }
  const eligible = inventory.instances.filter(item => selected.includes(item.id) && !item.locked)
  return <section className="version-panel" aria-label="插件管理">
    <div className="version-heading"><div><div className="eyebrow">PLUGIN CONTROL</div><h2>插件管理</h2><p>统一下载并校验插件，按所选顺序逐个部署。首个失败会停止后续部署并尝试回滚。</p></div><button className="button ghost" onClick={() => void refresh()}>刷新</button></div>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void deploy() }}>
      <div className="version-install"><label>插件 <select aria-label="插件" value={plugin} onChange={event => setPlugin(event.target.value)}>{inventory.catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><input aria-label="插件版本" placeholder="留空下载 latest，例如 1.3.20" value={version} onChange={event => setVersion(event.target.value)} /><label><input type="checkbox" checked={enable} onChange={event => setEnable(event.target.checked)} />安装后启用</label></div>
      <p>升级保留插件配置。运行中的实例会短暂重启；停止中的实例保持停止，加载结果待启动验证。回滚恢复插件文件和配置，不会逆转插件的数据迁移。</p>
      <div className="version-list">{inventory.instances.map(instance => { const item = instance.plugins.find(item => item.id === plugin); return <div className="version-row" key={instance.id}><label><input type="checkbox" aria-label={`选择 ${instance.name}`} disabled={active || busy} checked={selected.includes(instance.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, instance.id] : ids.filter(id => id !== instance.id))} /> {instance.name} {instance.locked ? '（已锁定）' : ''}</label><span>{item?.installed ? item.version || '已安装，版本待确认' : '未安装'} · {item?.enabled === null ? '待启动验证' : item?.enabled ? '已启用' : '未启用'} · {instance.state}</span>{instance.message && <small>{instance.message}</small>}</div> })}</div>
      <p role="status">将部署 {eligible.length} 个实例，跳过 {selected.length - eligible.length} 个已锁定实例。首个实例：{eligible[0]?.name || '—'}。</p>
      <button className="button primary" disabled={busy || active || !eligible.length}>统一安装 / 升级</button>
    </form>
    {jobs.some(job => job.state === 'blocked') && <button className="button ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.post('/plugins/recover'); await refresh() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }}>重试回滚</button>}
    <h3>部署记录</h3>{jobs.slice(0, 10).map(job => <div className="upgrade-banner" key={job.id}><strong>{job.plugin} {job.version || 'latest'} · {labels[job.state] || job.state}</strong>{job.message && <p>{job.message}</p>}{job.results.map(result => <p key={result.id}>{inventory.instances.find(item => item.id === result.id)?.name || result.id}：{labels[result.state] || result.state}{result.message && ` · ${result.message}`}</p>)}</div>)}
  </section>
}
