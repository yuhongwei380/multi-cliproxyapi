import { InputHTMLAttributes, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import webPackage from '../package.json'
import { api, AuditLog, BrandingSettings, Instance, QuotaNotificationSettings, QuotaSettings, QuotaSnapshot, QuotaValue, RuntimeLog, UpgradeState, VersionInstall } from './api'
import './app.css'
import './management-link.css'
import { Dropdown, DropdownOption, MultiSelect } from './Dropdown'
import { PluginPanel } from './PluginPanel'
import { KeyPanel } from './KeyPanel'

type Modal = 'create' | 'backup' | 'delete' | 'edit' | 'unlock' | 'uninstall-version' | 'admin-settings' | null
type Module = 'overview' | 'instances' | 'quotas' | 'quota-notifications' | 'versions' | 'plugins' | 'keys' | 'runtime-logs' | 'audit-logs'

const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  instance_ids: [],
  refresh_interval_minutes: 360,
  webhook_enabled: false,
  webhook_url: '',
  webhook_url_configured: false,
  alert_threshold_percent: 20,
  webhook_signing_enabled: false,
  webhook_secret_configured: false,
  webhook_secret: ''
}

const APP_VERSION = webPackage.version
const DEFAULT_BRANDING: BrandingSettings = {
  brand_name: 'CPA',
  brand_subtitle: 'CONTROL CENTER',
  banner_title: '静候流量。',
  banner_description: 'CPA 总控 · 统一管理本机的 CLI Proxy API 实例。',
  page_title: 'CLI Proxy API Management Center',
  page_description: 'CPA 总控 · Local Control Plane',
  copyright: '© 2026 Multi CLIProxyAPI',
  icon: '',
  logo: ''
}

const MODULE_LABELS: Record<Module, string> = {
  overview: '总览',
  instances: 'CLIProxyAPI 实例管理',
  quotas: '额度观察',
  'quota-notifications': '定时额度通知',
  versions: '版本管理',
  plugins: '插件管理',
  keys: 'API Key 管理',
  'runtime-logs': '运行日志',
  'audit-logs': '审计日志'
}

const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const MAX_LOGO_BYTES = 256 * 1024

function moduleFromHash(hash: string): Module {
  if (hash === '#keys') return 'keys'
  if (hash === '#plugins') return 'plugins'
  const value = hash.replace(/^#/, '')
  if (value === 'instances' || value === 'quotas' || value === 'quota-notifications' || value === 'versions' || value === 'runtime-logs' || value === 'audit-logs') return value
  return 'overview'
}

function moduleHref(module: Module) {
  return module === 'overview' ? '#dashboard' : '#' + module
}


function App() {
  const [user, setUser] = useState<string | null>(null)
  const [branding, setBranding] = useState<BrandingSettings>(DEFAULT_BRANDING)
  const [authLoading, setAuthLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [instances, setInstances] = useState<Instance[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaSnapshot[]>>({})
  const [versions, setVersions] = useState<VersionInstall[]>([])
  const [upgradeState, setUpgradeState] = useState<UpgradeState>({ state: 'idle' })
  const [busy, setBusy] = useState<string | null>(null)
  const [instanceBusy, setInstanceBusy] = useState<Record<string, string>>({})
  const [modal, setModal] = useState<Modal>(null)
  const [deleteTarget, setDeleteTarget] = useState<Instance | null>(null)
  const [unlockTarget, setUnlockTarget] = useState<Instance | null>(null)
  const [editTarget, setEditTarget] = useState<Instance | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<VersionInstall | null>(null)
  const [challenge, setChallenge] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [activeModule, setActiveModule] = useState<Module>(() => moduleFromHash(typeof window === 'undefined' ? '' : window.location.hash))
  const [quotaSettings, setQuotaSettings] = useState<QuotaSettings | null>(null)
  const [quotaSettingsLoaded, setQuotaSettingsLoaded] = useState(false)
  const [quotaSettingsLoading, setQuotaSettingsLoading] = useState(false)
  const [quotaSettingsError, setQuotaSettingsError] = useState('')
  const [quotaNotificationSettings, setQuotaNotificationSettings] = useState<QuotaNotificationSettings[]>([])
  const [quotaNotificationSettingsLoaded, setQuotaNotificationSettingsLoaded] = useState(false)
  const [quotaNotificationSettingsLoading, setQuotaNotificationSettingsLoading] = useState(false)
  const [quotaNotificationSettingsError, setQuotaNotificationSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')
  const instanceActionLock = useRef(new Set<string>())

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/instances')
      const items = (response.items ?? []) as Instance[]
      setInstances(items)
      const currentIDs = new Set(items.map(instance => instance.id))
      setQuotas(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => currentIDs.has(id))))
      setQuotaNotificationSettings(previous => previous.filter(item => currentIDs.has(item.instance_id)))
      await Promise.all(items.map(async instance => {
        try {
          const q = await api.get('/instances/' + instance.id + '/quotas')
          setQuotas(previous => ({ ...previous, [instance.id]: q.items ?? [] }))
        } catch {
          /* card shows unknown */
        }
      }))
      try {
        const versionResponse = await api.get('/versions')
        setVersions((versionResponse.items ?? []) as VersionInstall[])
      } catch {
        /* version panel stays available for retry */
      }
      try {
        setUpgradeState(await api.get('/upgrade/state') as UpgradeState)
      } catch {
        /* keep last upgrade state */
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '加载失败'
      if (message === 'authentication required') setUser(null)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const loadQuotaSettings = async () => {
    if (quotaSettingsLoading) return
    setQuotaSettingsLoading(true)
    setQuotaSettingsError('')
    try {
      const response = await api.get('/quota/settings')
      setQuotaSettings({ ...DEFAULT_QUOTA_SETTINGS, ...response } as QuotaSettings)
      setQuotaSettingsLoaded(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '配额设置加载失败'
      setQuotaSettingsError(message)
      setError(message)
      setQuotaSettingsLoaded(true)
    } finally {
      setQuotaSettingsLoading(false)
    }
  }

  const loadQuotaNotificationSettings = async () => {
    if (quotaNotificationSettingsLoading) return
    setQuotaNotificationSettingsLoading(true)
    setQuotaNotificationSettingsError('')
    try {
      const response = await api.get('/quota/notifications')
      setQuotaNotificationSettings((response.items ?? []) as QuotaNotificationSettings[])
      setQuotaNotificationSettingsLoaded(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '定时额度通知配置加载失败'
      setQuotaNotificationSettingsError(message)
      setError(message)
      setQuotaNotificationSettingsLoaded(true)
    } finally {
      setQuotaNotificationSettingsLoading(false)
    }
  }

  useEffect(() => {
    const onHashChange = () => setActiveModule(moduleFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (user && activeModule === 'quota-notifications') {
      if (!quotaSettingsLoaded && !quotaSettingsLoading) void loadQuotaSettings()
      if (!quotaNotificationSettingsLoaded && !quotaNotificationSettingsLoading) void loadQuotaNotificationSettings()
    }
  }, [user, activeModule, quotaSettingsLoaded, quotaSettingsLoading, quotaNotificationSettingsLoaded, quotaNotificationSettingsLoading])

  useEffect(() => {
    api.get('/auth/status')
      .then(status => {
        if (status.branding) setBranding({ ...DEFAULT_BRANDING, ...status.branding } as BrandingSettings)
        if (status.authenticated) {
          setUser(status.username)
          void load()
        }
      })
      .catch(() => undefined)
      .finally(() => setAuthLoading(false))
  }, [])

  useEffect(() => { applyDocumentBranding(branding) }, [branding])

  if (authLoading) return <LoadingState label="正在检查会话…" />
  if (!user) return <Login branding={branding} onLoggedIn={name => { setUser(name); void load() }} />

  const navigate = (module: Module) => {
    setActiveModule(module)
    const href = moduleHref(module)
    if (window.location.hash !== href) window.location.hash = href
  }

  const beginUnlock = (instance: Instance) => {
    setUnlockTarget(instance)
    setModal('unlock')
    setError('')
  }

  const act = async (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas' | 'lock' | 'unlock' | 'backup') => {
    if (instanceActionLock.current.has(instance.id)) return
    if (instance.locked && (action === 'restart' || action === 'stop')) return
    if (action === 'unlock') { beginUnlock(instance); return }
    if (action === 'backup') { if (!instance.locked) { setEditTarget(instance); setModal('backup'); setError('') }; return }
    if ((action === 'restart' || action === 'stop') && !window.confirm(`确认${action === 'restart' ? '重启' : '停止'}实例「${instance.name}」？这会中断当前请求。`)) return
    instanceActionLock.current.add(instance.id)
    setInstanceBusy(previous => ({ ...previous, [instance.id]: action }))
    setError('')
    try {
      await api.post('/instances/' + instance.id + '/' + action)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      instanceActionLock.current.delete(instance.id)
      setInstanceBusy(previous => {
        const next = { ...previous }
        delete next[instance.id]
        return next
      })
    }
  }

  const refreshAllQuotas = async () => {
    setBusy('quotas:all')
    setError('')
    try {
      const results = await Promise.allSettled(instances.map(instance => api.post('/instances/' + instance.id + '/quotas')))
      await load()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) {
        const firstMessage = failures.find(result => result.status === 'rejected')?.reason
        const detail = firstMessage instanceof Error && firstMessage.message ? `（${firstMessage.message}）` : ''
        setError(`配额刷新完成：${results.length - failures.length} 个实例成功，${failures.length} 个实例失败${detail}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配额刷新失败')
    } finally {
      setBusy(null)
    }
  }

  const beginDelete = async (instance: Instance) => {
    setDeleteTarget(instance)
    setChallenge(null)
    setModal('delete')
    setError('')
    try {
      const response = await api.post('/instances/' + instance.id + '/delete-challenge')
      setChallenge(response.challenge_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法准备删除')
    }
  }

  const beginUninstall = (version: VersionInstall) => {
    setUninstallTarget(version)
    setModal('uninstall-version')
    setError('')
  }

  const installVersion = async (tag: string) => {
    setBusy('version:install')
    setError('')
    try { await api.post('/versions/install', { version: tag }); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '版本安装失败') } finally { setBusy(null) }
  }

  const upgradeVersion = async (tag: string) => {
    setBusy('version:upgrade:' + tag)
    setError('')
    try { const result = await api.post('/versions/upgrade', { version: tag }); const checked = Array.isArray(result?.checked) ? result.checked.length : 0; setSettingsNotice(result?.backups_removed === false && result?.verified === true ? '升级完成且服务验证通过，但自动备份清理失败，请在实例管理中手动清理。' : result?.backups_removed === false ? '升级完成，但自动备份清理失败，请在实例管理中手动清理。' : result?.verified === true ? `升级完成，已通过 ${checked} 个实例的模型列表验证，升级前的自动备份已清理。` : '升级完成，但服务验证未执行；请检查实例状态。'); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '版本升级失败'); await load() } finally { setBusy(null) }
  }

  const recoverUpgrade = async () => {
    setBusy('version:recover')
    setError('')
    try { await api.post('/upgrade/recover'); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') } finally { setBusy(null) }
  }

  const uninstallVersion = async (tag: string) => {
    setBusy('version:uninstall:' + tag)
    setError('')
    try { await api.post('/versions/uninstall', { version: tag }); await load(); setModal(null); setUninstallTarget(null) } catch (cause) { setError(cause instanceof Error ? cause.message : '版本卸载失败') } finally { setBusy(null) }
  }

  const saveQuotaSettings = (settings: QuotaSettings) => {
    setQuotaSettings(settings)
    setQuotaSettingsLoaded(true)
    setQuotaSettingsError('')
  }

  const saveQuotaNotificationSettings = (settings: QuotaNotificationSettings) => {
    setQuotaNotificationSettings(previous => previous.some(item => item.instance_id === settings.instance_id) ? previous.map(item => item.instance_id === settings.instance_id ? settings : item) : [...previous, settings])
    setQuotaNotificationSettingsLoaded(true)
    setQuotaNotificationSettingsError('')
  }

  const saveBranding = (settings: BrandingSettings) => {
    setBranding(settings)
    setSettingsNotice('品牌设置已更新')
    setModal(null)
  }

  return <div className="app-shell">
    <aside className="app-sidebar" aria-label="主导航">
      <div className="brand-lockup">
        <BrandIcon branding={branding} />
        <div><strong>{branding.brand_name}</strong>{branding.brand_subtitle && <small>{branding.brand_subtitle}</small>}</div>
      </div>
      <div className="sidebar-caption">运行</div>
      <nav className="sidebar-nav">
        <NavigationLink module="overview" activeModule={activeModule} onNavigate={navigate} icon="⌂">总览</NavigationLink>
      </nav>
      <div className="sidebar-caption nav-section-caption">控制</div>
      <nav className="sidebar-nav">
        <NavigationLink module="instances" activeModule={activeModule} onNavigate={navigate} icon="◈" ariaLabel="CLIProxyAPI 实例管理（实例运行轨）">CLIProxyAPI 实例管理<span className="nav-count">{instances.length}</span></NavigationLink>
        <NavigationLink module="quotas" activeModule={activeModule} onNavigate={navigate} icon="◌">额度观察</NavigationLink>
        <NavigationLink module="versions" activeModule={activeModule} onNavigate={navigate} icon="↥">版本管理</NavigationLink>
        <NavigationLink module="plugins" activeModule={activeModule} onNavigate={navigate} icon="◇">插件管理</NavigationLink>
        <NavigationLink module="keys" activeModule={activeModule} onNavigate={navigate} icon="⚿">API Key 管理</NavigationLink>
      </nav>
      <div className="sidebar-caption nav-section-caption">观测</div>
      <nav className="sidebar-nav">
        <NavigationLink module="quota-notifications" activeModule={activeModule} onNavigate={navigate} icon="◷">定时额度通知</NavigationLink>
        <NavigationLink module="runtime-logs" activeModule={activeModule} onNavigate={navigate} icon="≋">运行日志</NavigationLink>
        <NavigationLink module="audit-logs" activeModule={activeModule} onNavigate={navigate} icon="◎">审计日志</NavigationLink>
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-caption">连接</div>
        <div className="connection-state"><span className="dot" /><span><strong>本地总控在线</strong><small>仅限局域网访问</small></span></div>
        <div className="sidebar-user">
          <button type="button" className="sidebar-user-profile" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}>
            <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
            <span><strong>{user}</strong><small>管理员 · 设置</small></span>
          </button>
          <button type="button" className="icon-button settings-button" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}><SettingsIcon /></button>
          <button className="icon-button" aria-label="退出" title="退出" onClick={async () => { await api.post('/auth/logout'); setUser(null) }}>↗</button>
        </div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>控制中心</span><b>/</b><strong>{MODULE_LABELS[activeModule]}</strong></div>
        <div className="topbar-actions"><a className="button ghost upstream-repository" href="https://github.com/router-for-me/CLIProxyAPI" target="_blank" rel="noreferrer">上游CPA仓库</a><span className="connection-toast"><span className="dot" />已连接</span><span className="user-chip"><span className="dot" />{user}</span><button type="button" className="icon-button topbar-settings" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}><SettingsIcon /></button><button className="button ghost" onClick={async () => { await api.post('/auth/logout'); setUser(null) }}>退出</button></div>
      </header>
      <main id={activeModule === 'overview' ? 'dashboard' : activeModule} className="dashboard-content">
        {error && <div className="alert" role="alert"><span>!</span>{error}<button aria-label="关闭错误" onClick={() => setError('')}>×</button></div>}
        {settingsNotice && <div className="success-toast" role="status"><span>✓</span>{settingsNotice}<button aria-label="关闭提示" onClick={() => setSettingsNotice('')}>×</button></div>}
        {activeModule === 'overview' && <Overview branding={branding} instances={instances} quotas={quotas} versions={versions} upgradeState={upgradeState} loading={loading} busy={busy} instanceBusy={instanceBusy} onCreate={() => { setModal('create'); setError('') }} onRefresh={load} onAction={act} onDelete={beginDelete} onConfigure={instance => { setEditTarget(instance); setModal('edit'); setError('') }} onInstall={installVersion} onUpgrade={upgradeVersion} onRecover={recoverUpgrade} onUninstall={beginUninstall} onNavigate={navigate} />}
        {activeModule === 'instances' && <InstanceManagement instances={instances} quotas={quotas} loading={loading} instanceBusy={instanceBusy} onCreate={() => { setModal('create'); setError('') }} onRefresh={load} onAction={act} onDelete={beginDelete} onConfigure={instance => { setEditTarget(instance); setModal('edit'); setError('') }} />}
        {activeModule === 'quotas' && <QuotaObservation instances={instances} quotas={quotas} busy={busy} instanceBusy={instanceBusy} onRefreshAll={refreshAllQuotas} onRefreshInstance={instance => act(instance, 'quotas')} onCreate={() => { setModal('create'); setError('') }} onNavigate={navigate} />}
        {activeModule === 'quota-notifications' && <QuotaNotificationModule instances={instances} settings={quotaSettings ?? DEFAULT_QUOTA_SETTINGS} settingsLoaded={quotaSettingsLoaded} settingsLoading={quotaSettingsLoading} settingsError={quotaSettingsError} notificationSettings={quotaNotificationSettings} notificationSettingsLoaded={quotaNotificationSettingsLoaded} notificationSettingsLoading={quotaNotificationSettingsLoading} notificationSettingsError={quotaNotificationSettingsError} onSettingsSaved={saveQuotaSettings} onSettingsError={message => { setQuotaSettingsError(message); setError(message) }} onNotificationSaved={saveQuotaNotificationSettings} onNotificationError={message => { setQuotaNotificationSettingsError(message); setError(message) }} onRefresh={() => { void loadQuotaSettings(); void loadQuotaNotificationSettings() }} />}
        {activeModule === 'versions' && <section className="module-pane versions-module"><VersionPanel versions={versions} instances={instances} upgradeState={upgradeState} busy={busy} onInstall={installVersion} onUpgrade={upgradeVersion} onRecover={recoverUpgrade} onUninstall={beginUninstall} /></section>}
        {activeModule === 'runtime-logs' && <LogPage kind="runtime" instances={instances} />}
        {activeModule === 'plugins' && <PluginPanel />}
        {activeModule === 'keys' && <KeyPanel />}
        {activeModule === 'audit-logs' && <LogPage kind="audit" instances={instances} />}
      </main>
      <footer className="content-copyright" aria-label="版权信息"><span>{branding.copyright}</span><span className="content-version">v{APP_VERSION}</span></footer>
    </div>
    {modal === 'backup' && editTarget && <BackupDialog instance={editTarget} instances={instances} onClose={() => setModal(null)} onSaved={() => { setModal(null); setSettingsNotice('备份实例已保存，可单独启动进行测试升级。'); void load() }} />}
    {modal === 'create' && <CreateDialog onClose={() => setModal(null)} onCreated={() => { setModal(null); void load() }} onError={setError} />}
    {modal === 'edit' && editTarget && <EditDialog instance={editTarget} onClose={() => setModal(null)} onSaved={() => { setModal(null); setEditTarget(null); void load() }} onError={setError} />}
    {modal === 'delete' && deleteTarget && <DeleteDialog instance={deleteTarget} challenge={challenge} onClose={() => setModal(null)} onDeleted={() => { setModal(null); void load() }} onError={setError} />}
    {modal === 'unlock' && unlockTarget && <UnlockDialog instance={unlockTarget} onClose={() => { setModal(null); setUnlockTarget(null) }} onUnlocked={() => { setModal(null); setUnlockTarget(null); void load() }} onError={setError} />}
    {modal === 'uninstall-version' && uninstallTarget && <UninstallVersionDialog version={uninstallTarget} busy={busy === 'version:uninstall:' + uninstallTarget.tag} onClose={() => { if (!busy) { setModal(null); setUninstallTarget(null) } }} onConfirm={() => void uninstallVersion(uninstallTarget.tag)} />}
    {modal === 'admin-settings' && <AdminSettingsDialog branding={branding} onClose={() => setModal(null)} onSaved={() => { setModal(null); setSettingsNotice('管理员密码已更新') }} onBrandingSaved={saveBranding} />}
  </div>
}

function NavigationLink({ module, activeModule, onNavigate, icon, ariaLabel, children }: { module: Module; activeModule: Module; onNavigate: (module: Module) => void; icon: string; ariaLabel?: string; children: React.ReactNode }) {
  return <a className={'nav-item ' + (module === activeModule ? 'active' : '')} href={moduleHref(module)} aria-label={ariaLabel} aria-current={module === activeModule ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(module) }}><span className="nav-icon" aria-hidden="true">{icon}</span>{children}</a>
}

function Overview({ branding, instances, quotas, versions, upgradeState, loading, busy, instanceBusy, onCreate, onRefresh, onAction, onDelete, onConfigure, onInstall, onUpgrade, onRecover, onUninstall, onNavigate }: { branding: BrandingSettings; instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; versions: VersionInstall[]; upgradeState: UpgradeState; loading: boolean; busy: string | null; instanceBusy: Record<string, string>; onCreate: () => void; onRefresh: () => void; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas' | 'lock' | 'unlock' | 'backup') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void; onInstall: (tag: string) => void; onUpgrade: (tag: string) => void; onRecover: () => void; onUninstall: (version: VersionInstall) => void; onNavigate: (module: Module) => void }) {
  const running = instances.filter(instance => instance.status?.ready).length
  const snapshots = Object.values(quotas).flat()
  const successful = snapshots.filter(quota => quota.status === 'ok').length
  const accounts = snapshots.filter(quota => quota.account_id !== '__discovery__').length
  const low = snapshots.flatMap(quota => (quota.values ?? []).map(value => quotaPercent(value))).filter(value => value !== null && value <= 20).length
  return <>
    <section className="page-intro">
      <div className="hero-copy"><div className="eyebrow">{branding.brand_name} · CONTROL PLANE</div><h1>{branding.banner_title}</h1><p>{branding.banner_description}</p><div className="hero-actions"><button className="button primary" onClick={onCreate}>+ 创建实例</button><a className="hero-link" href="#instances" onClick={event => { event.preventDefault(); onNavigate('instances') }}>查看实例 <span aria-hidden="true">→</span></a></div></div>
      <div className="traffic-card"><div className="traffic-card-head"><span>运行观察</span><span className="live-pill"><span className="dot" />实时</span></div><strong>{running}</strong><small>正在运行的 CPA 实例</small><div className="traffic-rule"><span /><span /><span /></div><div className="traffic-footer"><span>托管实例 {instances.length}</span><span>快照 {successful}</span></div></div>
      <div className="intro-meta"><span className="live-indicator"><span className="dot" />服务在线</span><span className="mono-label">LAN / AMD64</span></div>
    </section>
    <section className="overview-strip" aria-label="总览">
      <div><span>托管实例</span><strong>{instances.length}<small> / 5</small></strong><em>已登记的 CPA 服务</em></div>
      <div><span>运行中</span><strong>{running}</strong><em>当前可接收请求</em></div>
      <div><span>配额快照</span><strong>{successful}<small> 个成功</small></strong><em>最近一次从子实例读取</em></div>
      <div><span>当前版本</span><strong className="metric-version">{instances[0]?.version || '—'}</strong><em>{loading ? '正在同步版本' : instances.length ? '由实例统一使用' : versions.some(version => version.usable) ? '版本已安装，等待创建实例' : '尚未安装 CPA 版本'}</em></div>
    </section>
    <section className="overview-combined-card" aria-label="实例 + 配额">
      <div className="combined-card-head"><div><div className="eyebrow">CONTROL PLANE PULSE</div><h2>实例 + 配额</h2><p>从一个视图确认服务数量、OAuth 账户和配额健康度。</p></div><button className="button ghost" onClick={() => onNavigate('quotas')}>查看额度观察 →</button></div>
      <div className="combined-metrics"><div><span>实例</span><strong>{instances.length}<small> / 5</small></strong><em>{running ? running + ' 个运行中' : '暂无运行实例'}</em></div><div><span>OAuth 账户</span><strong>{accounts}</strong><em>{successful ? successful + ' 个成功快照' : '等待首次采集'}</em></div><div><span>低配额提醒</span><strong className={low ? 'warn-text' : ''}>{low}</strong><em>{low ? '请打开额度观察处理' : '当前没有低于 20% 的窗口'}</em></div></div>
    </section>
    <section className="overview-preview">
      <section className="section-heading"><div><div className="eyebrow">INSTANCE SUMMARY</div><h2>实例概览</h2><p>每个实例独立运行，状态与 OAuth 配额在这里汇合。</p></div><button className="button ghost" onClick={onRefresh}>重新同步</button></section>
      {loading && instances.length === 0 ? <LoadingState label="正在同步实例…" /> : instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="instance-list">{instances.map(instance => <InstanceCard key={instance.id} instance={instance} quotas={quotas[instance.id] ?? []} instanceBusy={instanceBusy} onAction={onAction} onDelete={onDelete} onConfigure={onConfigure} />)}</div>}
    </section>
    {versions.length > 0 && <section className="overview-version-preview"><VersionPanel versions={versions} instances={instances} upgradeState={upgradeState} busy={busy} onInstall={onInstall} onUpgrade={onUpgrade} onRecover={onRecover} onUninstall={onUninstall} /></section>}
  </>
}

function InstanceManagement({ instances, quotas, loading, instanceBusy, onCreate, onRefresh, onAction, onDelete, onConfigure }: { instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; loading: boolean; instanceBusy: Record<string, string>; onCreate: () => void; onRefresh: () => void; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas' | 'lock' | 'unlock' | 'backup') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void }) {
  return <section className="module-pane instances-module"><section className="section-heading module-heading"><div><div className="eyebrow">CLIPROXYAPI INSTANCES</div><h1>CLIProxyAPI 实例管理</h1><p>创建、停止、重启和配置独立的 CLIProxyAPI 子实例。</p></div><div className="section-actions"><button className="button primary" onClick={onCreate}>+ 创建实例</button><button className="button ghost" onClick={onRefresh}>重新同步</button></div></section>{loading && instances.length === 0 ? <LoadingState label="正在同步实例…" /> : instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="instance-list">{instances.map(instance => <InstanceCard key={instance.id} instance={instance} quotas={quotas[instance.id] ?? []} instanceBusy={instanceBusy} onAction={onAction} onDelete={onDelete} onConfigure={onConfigure} />)}</div>}</section>
}

function QuotaObservation({ instances, quotas, busy, instanceBusy, onRefreshAll, onRefreshInstance, onCreate, onNavigate }: { instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; busy: string | null; instanceBusy: Record<string, string>; onRefreshAll: () => void; onRefreshInstance: (instance: Instance) => void; onCreate: () => void; onNavigate: (module: Module) => void }) {
  const snapshots = Object.values(quotas).flat()
  const successful = snapshots.filter(quota => quota.status === 'ok').length
  const stale = snapshots.filter(quota => quota.status === 'stale').length
  const accountCount = snapshots.filter(quota => quota.account_id !== '__discovery__').length
  return <section className="module-pane quotas-module"><section className="section-heading module-heading"><div><div className="eyebrow">QUOTA OBSERVATION</div><h1>额度观察</h1><p>从子实例读取 OAuth 配额，按实例配置的周期刷新。</p></div><div className="section-actions quota-toolbar"><button className="button primary" disabled={!!busy} onClick={onRefreshAll}>手动查看配额</button><button className="button ghost" onClick={() => onNavigate('quota-notifications')}>定时额度通知 →</button></div></section><div className="quota-overview-card"><div><span>成功快照</span><strong>{successful}</strong></div><div><span>OAuth 账户</span><strong>{accountCount}</strong></div><div><span>已过期</span><strong className={stale ? 'warn-text' : ''}>{stale}</strong></div><div><span>自动获取</span><strong>{instances.length ? '按实例配置' : '—'}</strong></div></div>{instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="quota-instance-list">{instances.map(instance => { const instanceQuotas = quotas[instance.id] ?? []; const instanceAction = instanceBusy[instance.id]; return <article className="quota-instance-card" key={instance.id}><div className="quota-instance-head"><div><div className="eyebrow">INSTANCE QUOTA</div><h2>{instance.name}</h2><p>{instance.id} · 端口 {instance.port}</p></div><button className="button ghost" disabled={!!busy || !!instanceAction} onClick={() => onRefreshInstance(instance)}>{instanceAction ? '读取中…' : '手动查看'}</button></div>{instanceQuotas.length ? <QuotaDetailPanel quotas={instanceQuotas} /> : <div className="quota-empty-message">尚未采集配额；点击“手动查看”从子实例读取。</div>}</article> })}</div>}</section>
}

function QuotaNotificationModule({ instances, settings, settingsLoaded, settingsLoading, settingsError, notificationSettings, notificationSettingsLoaded, notificationSettingsLoading, notificationSettingsError, onSettingsSaved, onSettingsError, onNotificationSaved, onNotificationError, onRefresh }: { instances: Instance[]; settings: QuotaSettings; settingsLoaded: boolean; settingsLoading: boolean; settingsError: string; notificationSettings: QuotaNotificationSettings[]; notificationSettingsLoaded: boolean; notificationSettingsLoading: boolean; notificationSettingsError: string; onSettingsSaved: (settings: QuotaSettings) => void; onSettingsError: (message: string) => void; onNotificationSaved: (settings: QuotaNotificationSettings) => void; onNotificationError: (message: string) => void; onRefresh: () => void }) {
  const [dialogInstanceId, setDialogInstanceId] = useState<string | null>(null)
  const [testingTarget, setTestingTarget] = useState<string | null>(null)
  const [testFeedback, setTestFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const sendTestMessage = async (instanceId = '') => {
    setTestingTarget(instanceId || 'global'); setTestFeedback(null)
    try {
      await api.post(instanceId ? `/quota/notifications/${encodeURIComponent(instanceId)}/test` : '/quota/settings/test', {})
      setTestFeedback({ tone: 'ok', text: '测试消息已发送，请到钉钉群确认是否收到。' })
    } catch (cause) {
      setTestFeedback({ tone: 'error', text: cause instanceof Error ? cause.message : '测试消息发送失败' })
    } finally { setTestingTarget(null) }
  }
  const allSettings = instances.map(instance => notificationSettings.find(item => item.instance_id === instance.id) ?? ({ ...settings, instance_id: instance.id, instance_name: instance.name, instance_port: instance.port, configured: false, timezone: 'UTC+8', work_windows: [{ start: '09:00', end: '12:00' }, { start: '13:30', end: '18:00' }] } as QuotaNotificationSettings))
  const configuredSettings = allSettings.filter(item => item.configured)
  const availableSettings = allSettings.filter(item => !item.configured)
  const configuredIds = configuredSettings.map(item => item.instance_id)
  const dialogSettings = dialogInstanceId === 'new' ? availableSettings : allSettings.filter(item => item.instance_id === dialogInstanceId)
  return <section className="module-pane quota-notifications-module">
    <section className="section-heading module-heading"><div><div className="eyebrow">SCHEDULED QUOTA NOTIFICATION</div><h1>定时额度通知</h1><p>先在全局配置的下拉框中选择需要下发规则的 CPA 实例，再为个别实例建立单独配置。</p></div><div className="section-actions"><button className="button ghost" disabled={settingsLoading || notificationSettingsLoading} onClick={onRefresh}>刷新配置</button></div></section>
    <div className="notification-work-hours" role="note"><strong>通知工作时间（UTC+8）</strong><span>09:00–12:00、13:30–18:00</span><small>工作时间外继续采集配额，但不发送 Webhook 通知。</small></div>
    {settingsError && <div className="settings-inline-error" role="alert">{settingsError}</div>}{notificationSettingsError && <div className="settings-inline-error" role="alert">{notificationSettingsError}</div>}
    {testFeedback && <div className={testFeedback.tone === 'ok' ? 'settings-inline-notice' : 'settings-inline-error'} role="status">{testFeedback.text}</div>}
    <div className="quota-notification-columns">
      <QuotaSettingsPanel title="全局额度观察配置" instances={instances} configuredInstanceIds={configuredIds} settings={settings} loading={settingsLoading} loaded={settingsLoaded} onSaved={onSettingsSaved} onError={onSettingsError} onTest={() => sendTestMessage()} testing={testingTarget === 'global'} />
      <section className="notification-instance-section">
        <div className="notification-instance-toolbar"><div><div className="eyebrow">INSTANCE OVERRIDES</div><h2>单独配置</h2><p>这里只展示已建立的实例配置，单独配置会覆盖该实例的全局规则。</p></div><button type="button" className="button primary" disabled={!availableSettings.length || notificationSettingsLoading} onClick={() => setDialogInstanceId('new')}>+ 新增实例配置</button></div>
        {notificationSettingsLoading && !notificationSettingsLoaded ? <LoadingState label="正在读取实例配置…" /> : !instances.length ? <div className="quota-empty-message">暂无 CPA 实例，请先创建实例。</div> : !configuredSettings.length ? <div className="quota-empty-message">当前没有单独配置。需要特殊周期或 Webhook 的实例，可点击“新增实例配置”。</div> : <div className="notification-config-list">{configuredSettings.map(item => <QuotaNotificationSummary key={item.instance_id} settings={item} onEdit={() => setDialogInstanceId(item.instance_id)} onTest={() => sendTestMessage(item.instance_id)} testing={testingTarget === item.instance_id} />)}</div>}
      </section>
    </div>
    {dialogInstanceId && createPortal(<QuotaInstanceConfigDialog settingsOptions={dialogSettings} editing={dialogInstanceId !== 'new'} onClose={() => setDialogInstanceId(null)} onSaved={saved => { onNotificationSaved(saved); setDialogInstanceId(null); onRefresh() }} onRemoved={saved => { onNotificationSaved(saved); setDialogInstanceId(null); onRefresh() }} onError={onNotificationError} />, document.body)}
  </section>
}

function QuotaNotificationSummary({ settings, onEdit, onTest, testing }: { settings: QuotaNotificationSettings; onEdit: () => void; onTest: () => void; testing: boolean }) {
  return <article className="notification-config-row"><div className="notification-config-identity"><strong title={settings.instance_name}>{settings.instance_name}</strong><span>{settings.instance_id} · 端口 {settings.instance_port}</span></div><div><span>采集周期</span><strong>{settings.refresh_interval_minutes} 分钟</strong></div><div><span>告警阈值</span><strong>{settings.alert_threshold_percent}%</strong></div><div><span>钉钉通知</span><strong className={settings.webhook_enabled ? 'state-on' : 'state-off'}>{settings.webhook_enabled ? '已启用' : '未启用'}</strong></div><div className="notification-config-actions"><button type="button" className="button ghost" disabled={testing} onClick={onTest} title="按该实例已保存的配置发送一条测试消息">{testing ? '发送中…' : '发送测试消息'}</button><button type="button" className="button ghost" onClick={onEdit}>编辑配置</button></div></article>
}

function QuotaInstanceConfigDialog({ settingsOptions, editing, onClose, onSaved, onRemoved, onError }: { settingsOptions: QuotaNotificationSettings[]; editing: boolean; onClose: () => void; onSaved: (settings: QuotaNotificationSettings) => void; onRemoved: (settings: QuotaNotificationSettings) => void; onError: (message: string) => void }) {
  const [instanceId, setInstanceId] = useState(settingsOptions[0]?.instance_id || '')
  const selected = settingsOptions.find(item => item.instance_id === instanceId) ?? settingsOptions[0]
  const [draft, setDraft] = useState<QuotaNotificationSettings | null>(selected ?? null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (selected) setDraft({ ...selected, webhook_url: '', webhook_secret: '' }) }, [selected?.instance_id])
  if (!draft) return <dialog open className="modal-backdrop"><div className="dialog quota-instance-config-dialog"><button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button><h2>没有可配置的 CPA 实例</h2><p>所有实例都已经建立单独配置。</p><div className="dialog-actions"><button type="button" className="button primary" onClick={onClose}>关闭</button></div></div></dialog>
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true)
    try {
      const { instance_id, instance_name, instance_port, configured, timezone, work_windows, webhook_secret, webhook_url, ...settingsPayload } = draft
      const payload = { ...settingsPayload, ...(webhook_url ? { webhook_url } : {}), ...(webhook_secret ? { webhook_secret } : {}) }
      const response = await api.patch('/quota/notifications/' + encodeURIComponent(instance_id), payload)
      onSaved({ ...draft, ...response, webhook_url: '', webhook_secret: '' } as QuotaNotificationSettings)
    } catch (cause) { onError(cause instanceof Error ? cause.message : '实例配额配置保存失败') } finally { setSaving(false) }
  }
  const remove = async () => {
    setSaving(true)
    try { onRemoved(await api.delete('/quota/notifications/' + encodeURIComponent(draft.instance_id)) as QuotaNotificationSettings) }
    catch (cause) { onError(cause instanceof Error ? cause.message : '移除实例配额配置失败') }
    finally { setSaving(false) }
  }
  return <dialog open className="modal-backdrop" aria-labelledby="quota-instance-dialog-title"><div className="dialog quota-instance-config-dialog"><button type="button" className="dialog-close" disabled={saving} onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">INSTANCE QUOTA OVERRIDE</div><h2 id="quota-instance-dialog-title">{editing ? `编辑 ${draft.instance_name}` : '新增实例配置'}</h2><p>{editing ? '修改该实例独立使用的采集周期、阈值和通知方式。' : '先选择 CPA 实例，再设置它独立使用的额度观察规则。'}</p><form onSubmit={save}>
    {!editing && <label className="quota-field quota-instance-selector-field"><span className="quota-field-label">CPA 实例</span><Dropdown id="quota-instance-dialog-selector" label="选择 CPA 实例" options={settingsOptions.map(item => ({ value: item.instance_id, label: `${item.instance_name} · 端口 ${item.instance_port}` }))} value={draft.instance_id} onChange={setInstanceId} /><small>仅列出尚未建立单独配置的实例。</small></label>}
    {editing && <div className="quota-instance-identity"><div><span className="quota-field-label">CPA 实例</span><strong>{draft.instance_name}</strong></div><span className="quota-instance-meta">{draft.instance_id} · 端口 {draft.instance_port}</span></div>}
    <div className="quota-rules-grid quota-instance-rules"><label>自动采集周期（分钟）<input aria-label={`${draft.instance_name} 自动采集周期（分钟）`} type="number" min="1" max="10080" value={draft.refresh_interval_minutes} onChange={event => setDraft({ ...draft, refresh_interval_minutes: Number(event.target.value) })} required /><small>仅影响当前实例。</small></label><label>告警阈值（%）<input aria-label={`${draft.instance_name} 告警阈值（%）`} type="number" min="0" max="100" step="0.01" value={draft.alert_threshold_percent} onChange={event => setDraft({ ...draft, alert_threshold_percent: Number(event.target.value) })} required /><small>剩余配额低于此值时发送通知。</small></label></div>
    <div className="quota-webhook-section"><div className="quota-section-head"><div><div className="eyebrow">WEBHOOK NOTIFICATION</div><h3>钉钉机器人通知</h3><p>仅覆盖当前实例的通知规则。</p></div><label className="checkbox-label quota-enable-toggle"><input type="checkbox" checked={draft.webhook_enabled} onChange={event => setDraft({ ...draft, webhook_enabled: event.target.checked })} />启用通知</label></div><div className="quota-webhook-fields"><label className="quota-field quota-webhook-url"><span className="quota-field-label">钉钉机器人 Webhook URL</span><input aria-label={`${draft.instance_name} 钉钉机器人 Webhook URL`} type="url" value={draft.webhook_url} onChange={event => setDraft({ ...draft, webhook_url: event.target.value })} placeholder={draft.webhook_url_configured ? '已配置；留空保持当前地址' : 'https://oapi.dingtalk.com/robot/send?access_token=…'} /><small>{draft.webhook_url_configured ? '地址已加密保存；输入新地址才会替换。' : '仅支持钉钉 HTTPS 机器人地址。'}</small></label><div className="quota-field quota-signing-switch"><span className="quota-field-label">加签校验</span><label className="checkbox-label"><input type="checkbox" checked={draft.webhook_signing_enabled} onChange={event => setDraft({ ...draft, webhook_signing_enabled: event.target.checked })} />启用 Webhook 加签</label><small>开启后按钉钉加签规则计算签名。</small></div><label className="quota-field"><span className="quota-field-label">加签密钥</span><PasswordInput aria-label={`${draft.instance_name} 钉钉机器人加签密钥`} value={draft.webhook_secret ?? ''} onChange={event => setDraft({ ...draft, webhook_secret: event.target.value })} autoComplete="new-password" placeholder={draft.webhook_secret_configured ? '留空保持当前密钥' : '请输入加签密钥'} /><small>{draft.webhook_secret_configured ? '已配置密钥；留空保持当前密钥。' : '启用加签时必须配置密钥。'}</small></label></div></div>
    <div className="dialog-actions quota-instance-dialog-actions">{editing && <button type="button" className="button ghost danger-outline" disabled={saving} onClick={remove}>移除单独配置</button>}<span /><button type="button" className="button ghost" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving ? '处理中…' : '保存实例配置'}</button></div>
  </form></div></dialog>
}

function QuotaSettingsPanel({ title = '配额周期与通知', instances, configuredInstanceIds, settings, loading, loaded, onSaved, onError, onTest, testing }: { title?: string; instances: Instance[]; configuredInstanceIds: string[]; settings: QuotaSettings; loading: boolean; loaded: boolean; onSaved: (settings: QuotaSettings) => void; onError: (message: string) => void; onTest: () => void; testing: boolean }) {
  const [draft, setDraft] = useState<QuotaSettings>(settings)
  const [saving, setSaving] = useState(false)
  const configuredKey = configuredInstanceIds.join('|')
  useEffect(() => setDraft({ ...settings, instance_ids: (settings.instance_ids || []).filter(id => !configuredInstanceIds.includes(id)) }), [settings, configuredKey])
  const selectableIds = instances.filter(instance => !configuredInstanceIds.includes(instance.id)).map(instance => instance.id)
  const selectedInstances = instances.filter(instance => draft.instance_ids.includes(instance.id))
  const toggleInstance = (instanceId: string) => setDraft(current => ({ ...current, instance_ids: current.instance_ids.includes(instanceId) ? current.instance_ids.filter(id => id !== instanceId) : [...current.instance_ids, instanceId] }))
  return <section className="quota-settings-panel" aria-label={`${title}设置`}>
    <div className="settings-panel-head"><div><div className="eyebrow">GLOBAL QUOTA POLICY</div><h2>{title}</h2><p>{loaded ? '下拉框中选中的 CPA 实例会使用下面的统一采集和通知规则。' : loading ? '正在读取当前配置…' : '保存后开始按全局规则观察配额。'}</p></div></div>
    <form onSubmit={async event => { event.preventDefault(); setSaving(true); try { const { webhook_secret, webhook_url, ...settingsPayload } = draft; const payload = { ...settingsPayload, ...(webhook_url ? { webhook_url } : {}), ...(webhook_secret ? { webhook_secret } : {}) }; const response = await api.patch('/quota/settings', payload); onSaved({ ...draft, ...response, webhook_url: '', webhook_secret: '' } as QuotaSettings) } catch (cause) { onError(cause instanceof Error ? cause.message : '保存配额设置失败') } finally { setSaving(false) } }}>
      <div className="quota-target-section">
        <div className="quota-section-head">
          <div><h3>下发到 CPA 实例</h3><p>选中的实例按全局规则自动采集配额；已建立单独配置的实例不再跟随全局规则。</p></div>
          <span className="quota-count-pill">{selectedInstances.length} / {selectableIds.length} 已选择</span>
        </div>
        {!instances.length ? <div className="quota-target-empty">暂无 CPA 实例，请先在实例管理中创建。</div> : <div className="quota-target-picker">
          <MultiSelect
            id="quota-target-instances"
            label="选择下发到 CPA 实例"
            summaryPlaceholder={`已选择 ${selectedInstances.length} 个实例`}
            placeholder="选择一个或多个 CPA 实例"
            disabled={saving}
            values={draft.instance_ids}
            onChange={instanceIds => setDraft(current => ({ ...current, instance_ids: instanceIds }))}
            options={instances.map(instance => ({ value: instance.id, label: `${instance.name} · 端口 ${instance.port}`, hint: configuredInstanceIds.includes(instance.id) ? '已单独配置' : undefined, disabled: configuredInstanceIds.includes(instance.id) }))}
          />
          {selectedInstances.length > 0 && <div className="quota-selection-chips" role="list" aria-label="已下发实例">{selectedInstances.map(instance => <span className="quota-selection-chip" role="listitem" key={instance.id}><strong title={instance.name}>{instance.name}</strong><small>端口 {instance.port}</small><button type="button" disabled={saving} aria-label={`取消下发 ${instance.name}`} onClick={() => toggleInstance(instance.id)}>×</button></span>)}</div>}
          <small className="quota-target-hint">下拉框内可多选，也可在底部一键全选、清空。</small>
        </div>}
      </div>
      <div className="quota-rules-grid">
        <label>自动获取周期（分钟）<input aria-label="自动获取周期（分钟）" type="number" min="1" max="10080" value={draft.refresh_interval_minutes} onChange={event => setDraft({ ...draft, refresh_interval_minutes: Number(event.target.value) })} required /><small>默认 360 分钟，可手动查看即时刷新。</small></label>
        <label>告警阈值（%）<input aria-label="告警阈值（%）" type="number" min="0" max="100" step="0.01" value={draft.alert_threshold_percent} onChange={event => setDraft({ ...draft, alert_threshold_percent: Number(event.target.value) })} required /><small>全局默认低于此百分比时发送通知；同一实例、账户和配额窗口 5 小时内只发送一次。</small></label>
      </div>
      <div className="quota-webhook-section">
        <div className="quota-section-head">
          <div><div className="eyebrow">WEBHOOK NOTIFICATION</div><h3>钉钉机器人通知</h3><p>配额低于阈值时向钉钉群推送提醒。</p></div>
          <label className="checkbox-label quota-enable-toggle"><input type="checkbox" checked={draft.webhook_enabled} onChange={event => setDraft({ ...draft, webhook_enabled: event.target.checked })} />启用钉钉机器人通知</label>
        </div>
        <div className="quota-webhook-fields">
          <label className="quota-field quota-webhook-url"><span className="quota-field-label">钉钉机器人 Webhook URL</span><input aria-label="钉钉机器人 Webhook URL" type="url" value={draft.webhook_url} onChange={event => setDraft({ ...draft, webhook_url: event.target.value })} placeholder={draft.webhook_url_configured ? '已配置；留空保持当前地址' : 'https://oapi.dingtalk.com/robot/send?access_token=…'} /><small>{draft.webhook_url_configured ? 'Webhook 地址已加密保存；输入新地址才会替换。' : '仅支持钉钉 HTTPS 机器人地址。'}</small></label>
          <div className="quota-field quota-signing-switch"><span className="quota-field-label">加签校验</span><label className="checkbox-label"><input type="checkbox" checked={draft.webhook_signing_enabled} onChange={event => setDraft({ ...draft, webhook_signing_enabled: event.target.checked })} />启用 Webhook 加签</label><small>开启后按钉钉加签规则计算签名。</small></div>
          <label className="quota-field"><span className="quota-field-label">加签密钥</span><PasswordInput aria-label="钉钉机器人加签密钥" value={draft.webhook_secret ?? ''} onChange={event => setDraft({ ...draft, webhook_secret: event.target.value })} autoComplete="new-password" placeholder={draft.webhook_secret_configured ? '留空保持当前密钥' : '请输入钉钉机器人加签密钥'} /><small>{draft.webhook_secret_configured ? '已配置密钥；留空保持当前密钥。' : '启用加签时必须配置密钥。'}</small></label>
        </div>
      </div>
      <div className="dialog-actions settings-actions"><button type="button" className="button ghost" disabled={saving || testing} onClick={onTest} title="按已保存的全局配置发送一条测试消息">{testing ? '发送中…' : '发送测试消息'}</button><button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存并下发全局配置'}</button></div>
    </form>
  </section>
}

function LogPage({ kind, instances }: { kind: 'runtime' | 'audit'; instances: Instance[] }) {
  const [items, setItems] = useState<Array<RuntimeLog | AuditLog>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState('all')
  const instanceNames = useMemo(() => Object.fromEntries(instances.map(instance => [instance.id, instance.name])), [instances])
  const refresh = async () => { setLoading(true); setError(''); try { const response = await api.get(`/logs/${kind}?limit=500`); setItems(response.items ?? []) } catch (cause) { setError(cause instanceof Error ? cause.message : '日志加载失败') } finally { setLoading(false) } }
  useEffect(() => { void refresh() }, [kind])
  const filtered = items.filter(item => {
    const state = kind === 'runtime' ? (item as RuntimeLog).level : (item as AuditLog).outcome
    if (stateFilter !== 'all' && state !== stateFilter) return false
    if (!query.trim()) return true
    return JSON.stringify(item).toLowerCase().includes(query.trim().toLowerCase())
  })
  const runtime = kind === 'runtime'
  const problemCount = items.filter(item => runtime ? (item as RuntimeLog).level === 'error' : (item as AuditLog).outcome === 'failed').length
  const stateOptions: DropdownOption[] = [
    { value: 'all', label: '全部' },
    ...(runtime
      ? [{ value: 'info', label: '信息' }, { value: 'warn', label: '警告' }, { value: 'error', label: '错误' }]
      : [{ value: 'success', label: '成功' }, { value: 'failed', label: '失败' }])
  ]
  return <section className="module-pane logs-module"><section className="section-heading module-heading"><div><div className="eyebrow">{runtime ? 'RUNTIME TIMELINE' : 'AUDIT TRAIL'}</div><h1>{runtime ? '运行日志' : '审计日志'}</h1><p>{runtime ? '追踪总控、实例生命周期和后台任务的运行事件。' : '记录管理员登录、配置变更与实例操作的执行结果。'}</p></div><div className="section-actions"><button className="button ghost" disabled={loading} onClick={refresh}>{loading ? '刷新中…' : '刷新日志'}</button></div></section>
    <div className="log-summary" aria-label="日志摘要"><div><span>当前记录</span><strong>{items.length}</strong></div><div><span>{runtime ? '错误事件' : '失败操作'}</span><strong className={problemCount ? 'warn-text' : ''}>{problemCount}</strong></div><div><span>展示范围</span><strong>最近 500</strong></div></div>
    <div className="log-workbench"><div className="log-toolbar"><label className="log-search">搜索日志<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={runtime ? '消息、来源或实例 ID' : '操作者、动作或资源 ID'} /></label><div className="log-filter-field"><span>状态</span><Dropdown id={`log-${kind}-state`} label="状态" className="log-filter-dropdown" options={stateOptions} value={stateFilter} onChange={setStateFilter} /></div><span className="log-result-count">显示 {filtered.length} 条</span></div>
      {error ? <div className="settings-inline-error" role="alert">{error}</div> : loading && !items.length ? <div className="log-empty">正在读取日志…</div> : !filtered.length ? <div className="log-empty">没有符合当前筛选条件的日志。</div> : <div className="log-table-wrap"><table className="log-table"><thead><tr><th>时间</th><th>状态</th>{runtime ? <><th>来源</th><th>实例</th><th>消息</th></> : <><th>操作者</th><th>动作</th><th>资源</th><th>来源地址</th><th>详情</th></>}</tr></thead><tbody>{filtered.map(item => runtime ? <RuntimeLogRow key={item.id} item={item as RuntimeLog} instanceNames={instanceNames} /> : <AuditLogRow key={item.id} item={item as AuditLog} />)}</tbody></table></div>}
    </div>
  </section>
}

function RuntimeLogRow({ item, instanceNames }: { item: RuntimeLog; instanceNames: Record<string, string> }) {
  return <tr><td className="log-time">{formatLogTime(item.created_at)}</td><td><span className={`log-badge ${item.level}`}>{runtimeLevelLabel(item.level)}</span></td><td>{sourceLabel(item.source)}</td><td className="log-resource">{item.instance_id ? (instanceNames[item.instance_id] || item.instance_id) : '—'}</td><td className="log-message">{item.message}</td></tr>
}

function AuditLogRow({ item }: { item: AuditLog }) {
  return <tr><td className="log-time">{formatLogTime(item.created_at)}</td><td><span className={`log-badge ${item.outcome}`}>{item.outcome === 'success' ? '成功' : '失败'}</span></td><td>{item.actor}</td><td className="log-action">{auditActionLabel(item.action)}</td><td className="log-resource">{item.resource_id || item.resource_type || '—'}</td><td className="log-address">{item.client_address || '—'}</td><td className="log-message">{item.detail || '—'}</td></tr>
}

function formatLogTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }) }
function runtimeLevelLabel(level: string) { return ({ info: '信息', warn: '警告', error: '错误' } as Record<string, string>)[level] ?? level }
function sourceLabel(source: string) { return ({ controller: '总控', instance: '实例', http: 'HTTP' } as Record<string, string>)[source] ?? source }
function auditActionLabel(action: string) { return ({ 'auth.login': '管理员登录', 'auth.logout': '管理员退出', 'auth.password.change': '修改管理员密码', 'instance.lock': '锁定实例', 'instance.unlock': '解锁实例', 'instance.backup': '备份实例', 'instance.create': '创建实例', 'instance.update': '更新实例', 'instance.start': '启动实例', 'instance.stop': '停止实例', 'instance.restart': '重启实例', 'instance.quotas': '刷新实例配额', 'instance.delete.prepare': '准备删除实例', 'instance.delete': '删除实例', 'quota.settings.update': '更新配额设置', 'quota.notification.update': '更新实例配额配置', 'quota.notification.delete': '移除实例配额配置', 'branding.update': '更新品牌设置', 'version.install': '下载版本', 'version.upgrade': '统一升级', 'version.uninstall': '卸载版本', 'version.recover': '恢复升级' } as Record<string, string>)[action] ?? action }

const LOGIN_COPY = {
  zh: {
    language: '界面语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    controlCenter: '总控',
    lead: '登录以查看实例健康度与 OAuth 配额。',
    address: '当前地址',
    addressHint: '总控服务使用当前页面地址建立连接',
    currentPageAddress: '当前页面地址',
    defaultPageDescription: 'CPA 总控 · Local Control Plane',
    username: '用户名',
    password: '管理员密码',
    passwordPlaceholder: '请输入管理员密码',
    verifying: '验证中…',
    signIn: '进入总控',
    security: '仅限局域网访问 · 会话由总控服务保护',
    loginFailed: '登录失败'
  },
  en: {
    language: 'Interface language',
    languageChinese: '中文',
    languageEnglish: 'English',
    controlCenter: 'Control Center',
    lead: 'Sign in to view instance health and OAuth quotas.',
    address: 'Current address',
    addressHint: 'The control service connects using this page address.',
    currentPageAddress: 'Current page address',
    defaultPageDescription: 'CPA Management · Local Control Plane',
    username: 'Username',
    password: 'Administrator password',
    passwordPlaceholder: 'Enter the administrator password',
    verifying: 'Signing in…',
    signIn: 'Open control center',
    security: 'Local network access only · Session protected by the control service',
    loginFailed: 'Sign in failed'
  }
} as const

const LOGIN_LANGUAGE_OPTIONS = [
  { value: 'zh', label: LOGIN_COPY.zh.languageChinese },
  { value: 'en', label: LOGIN_COPY.en.languageEnglish }
] as const

function Login({ branding, onLoggedIn }: { branding: BrandingSettings; onLoggedIn: (name: string) => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [language, setLanguage] = useState<keyof typeof LOGIN_COPY>('zh')
  const copy = LOGIN_COPY[language]
  const currentAddress = typeof window !== 'undefined' ? window.location.origin : copy.currentPageAddress
  const pageDescription = language === 'en' && branding.page_description === DEFAULT_BRANDING.page_description
    ? copy.defaultPageDescription
    : branding.page_description

  return <main className="login-wrap" lang={language === 'en' ? 'en' : 'zh-CN'}>
    <section className="login-brand" aria-hidden="true">
      <div className="brand-wordmark"><span>{branding.brand_name}</span></div>
    </section>
    <section className="login-stage">
      <div className="login-panel">
        <div className="login-logo"><BrandIcon branding={branding} variant="large" /></div>
        <div className="login-heading">
          <div className="eyebrow">{branding.brand_subtitle || 'MANAGEMENT CENTER'}</div>
          <h1 aria-label={`${branding.brand_name} ${copy.controlCenter}`}>{branding.page_title}</h1>
          <p>{pageDescription}</p>
        </div>
        <Dropdown
          id="login-language"
          label={copy.language}
          className="language-picker"
          options={LOGIN_LANGUAGE_OPTIONS}
          value={language}
          onChange={value => setLanguage(value as keyof typeof LOGIN_COPY)}
        />
        <p className="lead">{copy.lead}</p>
        <div className="address-card">
          <span>{copy.address}</span>
          <strong>{currentAddress}</strong>
          <small>{copy.addressHint}</small>
        </div>
        <form onSubmit={async event => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            const result = await api.post('/auth/login', { username, password })
            onLoggedIn(result.username)
          } catch (cause) {
            setError(cause instanceof Error && cause.message ? cause.message : copy.loginFailed)
          } finally {
            setBusy(false)
          }
        }}>
          <label>{copy.username}<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label>
          <label>{copy.password}<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required placeholder={copy.passwordPlaceholder} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary wide" disabled={busy}>{busy ? copy.verifying : copy.signIn}</button>
        </form>
        <p className="login-security">{copy.security}</p>
        <footer className="login-note">
          {branding.copyright && <span>{branding.copyright}</span>}
          <span>v{APP_VERSION}</span>
        </footer>
      </div>
    </section>
  </main>
}

function AdminSettingsDialog({ branding, onClose, onSaved, onBrandingSaved }: { branding: BrandingSettings; onClose: () => void; onSaved: () => void; onBrandingSaved: (settings: BrandingSettings) => void }) {
  const [draft, setDraft] = useState(branding)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [brandingError, setBrandingError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [brandingBusy, setBrandingBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const logoInput = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(branding), [branding])
  const update = (field: keyof BrandingSettings, value: string) => setDraft(previous => ({ ...previous, [field]: value }))
  const readLogo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!file.type || !LOGO_ACCEPT.split(',').includes(file.type)) { setBrandingError('Logo 仅支持 PNG、JPEG、WebP 或 GIF 图片'); return }
    if (file.size > MAX_LOGO_BYTES) { setBrandingError('Logo 文件不能超过 256 KB'); return }
    try { update('logo', await readFileAsDataUrl(file)); setBrandingError('') } catch { setBrandingError('Logo 读取失败，请重试') }
  }
  return <dialog open className="modal-backdrop"><div className="dialog settings-dialog"><button type="button" className="dialog-close" disabled={brandingBusy || passwordBusy} onClick={onClose} aria-label="关闭">×</button><div className="settings-icon" aria-hidden="true"><SettingsIcon /></div><div className="eyebrow">CONTROL CENTER SETTINGS</div><h2>管理员设置</h2><p>在这里管理总控身份和管理员安全设置。品牌修改会同步到登录页、总览横幅、网页标题与浏览器图标。</p><section className="settings-block"><div className="settings-block-heading"><div><h3>品牌与网页信息</h3><p>控制台所有可见的品牌文案都从这里读取。</p></div><BrandIcon branding={draft} /></div><div className="logo-setting"><div><strong>品牌 Logo</strong><p>上传后会替换侧栏、登录页和浏览器标签中的图标。</p></div><div className="logo-setting-actions"><input ref={logoInput} className="visually-hidden" aria-label="上传品牌 Logo" type="file" accept={LOGO_ACCEPT} onChange={readLogo} /><button type="button" className="button ghost" disabled={brandingBusy || passwordBusy} onClick={() => logoInput.current?.click()}>{draft.logo ? '更换 Logo' : '上传 Logo'}</button>{draft.logo && <button type="button" className="button ghost danger-outline" disabled={brandingBusy || passwordBusy} onClick={() => update('logo', '')}>移除 Logo</button>}</div></div><p className="settings-hint logo-hint">支持 PNG、JPEG、WebP 或 GIF，建议使用正方形图片，文件大小不超过 256 KB。</p><form onSubmit={async event => { event.preventDefault(); setBrandingError(''); setBrandingBusy(true); try { const saved = await api.patch('/branding', draft) as BrandingSettings; onBrandingSaved({ ...DEFAULT_BRANDING, ...saved }) } catch (cause) { setBrandingError(cause instanceof Error ? cause.message : '品牌设置保存失败') } finally { setBrandingBusy(false) } }}><div className="settings-grid"><label>品牌名称<input aria-label="品牌名称" value={draft.brand_name} onChange={event => update('brand_name', event.target.value)} maxLength={48} required /></label><label>品牌副标题<input aria-label="品牌副标题" value={draft.brand_subtitle} onChange={event => update('brand_subtitle', event.target.value)} maxLength={64} placeholder="例如 CONTROL CENTER" /></label><label>登录页横幅标题<input aria-label="登录页横幅标题" value={draft.banner_title} onChange={event => update('banner_title', event.target.value)} maxLength={80} required /></label><label>网页标题<input aria-label="网页标题" value={draft.page_title} onChange={event => update('page_title', event.target.value)} maxLength={80} required /></label><label className="settings-wide">横幅描述<input aria-label="横幅描述" value={draft.banner_description} onChange={event => update('banner_description', event.target.value)} maxLength={180} required /></label><label className="settings-wide">网页描述<input aria-label="网页描述" value={draft.page_description} onChange={event => update('page_description', event.target.value)} maxLength={180} required /></label><label className="settings-wide">Copyright<input aria-label="Copyright" value={draft.copyright} onChange={event => update('copyright', event.target.value)} maxLength={160} placeholder="留空隐藏版权信息" /></label></div><p className="settings-hint">图标统一复用品牌 Logo；当前版本号显示为 v{APP_VERSION}。</p>{brandingError && <p className="form-error" role="alert">{brandingError}</p>}<div className="dialog-actions"><button type="button" className="button ghost" disabled={brandingBusy || passwordBusy} onClick={onClose}>取消</button><button className="button primary" disabled={brandingBusy || passwordBusy}>{brandingBusy ? '保存中…' : '保存品牌设置'}</button></div></form></section><InstanceLimitsSettings /><section className="settings-block settings-security"><div className="settings-block-heading"><div><h3>管理员密码</h3><p>修改后当前会话保持有效，新密码立即生效。</p></div></div><form onSubmit={async event => { event.preventDefault(); setPasswordError(''); if (newPassword !== confirmPassword) { setPasswordError('两次输入的新密码不一致'); return } setPasswordBusy(true); try { await api.patch('/auth/password', { current_password: currentPassword, new_password: newPassword }); onSaved() } catch (cause) { setPasswordError(cause instanceof Error ? cause.message : '密码修改失败') } finally { setPasswordBusy(false) } }}><label>当前管理员密码<PasswordInput aria-label="当前管理员密码" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required placeholder="请输入当前密码" /></label><label>新管理员密码<PasswordInput aria-label="新管理员密码" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required placeholder="请输入新密码" /></label><label>确认新管理员密码<PasswordInput aria-label="确认新管理员密码" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" required placeholder="再次输入新密码" /></label>{passwordError && <p className="form-error" role="alert">{passwordError}</p>}<div className="dialog-actions"><button type="button" className="button ghost" disabled={brandingBusy || passwordBusy} onClick={onClose}>取消</button><button className="button primary" disabled={brandingBusy || passwordBusy}>{passwordBusy ? '保存中…' : '保存新密码'}</button></div></form></section></div></dialog>
}

function BrandIcon({ branding, variant = '' }: { branding: BrandingSettings; variant?: string }) {
  const logo = branding.logo?.trim()
  if (logo) return <span className={'brand-logo ' + variant} aria-hidden="true"><img src={logo} alt="" /></span>
  const value = branding.icon.trim()
  if (value) return <span className={'brand-icon ' + variant} aria-hidden="true">{value}</span>
  return <span className={'brand-mark ' + variant} aria-hidden="true"><span /><span /><span /></span>
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('invalid file result'))
    reader.onerror = () => reject(reader.error || new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

function escapeXml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function applyDocumentBranding(branding: BrandingSettings) {
  if (typeof document === 'undefined') return
  document.title = branding.page_title
  let description = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
  if (!description) {
    description = document.createElement('meta')
    description.name = 'description'
    document.head.append(description)
  }
  description.content = branding.page_description
  let favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.rel = 'icon'
    document.head.append(favicon)
  }
  if (branding.logo) {
    favicon.href = branding.logo
    return
  }
  const mark = (branding.icon || branding.brand_name.slice(0, 1) || 'C').slice(0, 2)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#27356d"/><text x="32" y="42" fill="#72d5d4" font-size="28" font-family="sans-serif" font-weight="700" text-anchor="middle">' + escapeXml(mark) + '</text></svg>'
  favicon.href = 'data:image/svg+xml,' + encodeURIComponent(svg)
}

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return <span className="password-field"><input {...props} type={visible ? 'text' : 'password'} /><button type="button" className="password-toggle" aria-label={visible ? '隐藏密码' : '显示密码'} title={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button></span>
}

function EyeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
}

function EyeOffIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 6.2A10.6 10.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-3.1 3.9M6.1 6.9C3.8 8.3 2.5 12 2.5 12s3.5 6 9.5 6c1.1 0 2.1-.2 3-.5" /></svg>
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0L6.2 6.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>
}

function LoadingState({ label }: { label: string }) {
  return <main className="loading-state" aria-live="polite"><span className="loading-spinner" />{label}</main>
}

function VersionPanel({ versions, instances, upgradeState, busy, onInstall, onUpgrade, onRecover, onUninstall }: { versions: VersionInstall[]; instances: Instance[]; upgradeState: UpgradeState; busy: string | null; onInstall: (tag: string) => void; onUpgrade: (tag: string) => void; onRecover: () => void; onUninstall: (version: VersionInstall) => void }) {
  const [tag, setTag] = useState('')
  const blocked = upgradeState.state === 'blocked'
  const upgradeInProgress = upgradeState.state !== 'idle' && upgradeState.state !== 'committed' && upgradeState.state !== 'rolled-back' && !blocked
  const lockedCount = instances.filter(instance => instance.locked).length
  const allInstancesLocked = instances.length > 0 && lockedCount === instances.length
  const partiallyLocked = lockedCount > 0 && !allInstancesLocked
  const upgradeDisabled = busy !== null || upgradeInProgress || allInstancesLocked
  const upgradeTitle = allInstancesLocked ? '所有实例均已锁定，请先解锁至少一个实例' : partiallyLocked ? '仅升级未锁定实例，已锁定实例保持不变' : undefined
  return <section className="version-panel" aria-label="版本管理"><div className="version-heading"><div><div className="eyebrow">VERSION CONTROL</div><h2>版本管理</h2><p>升级前自动创建备份子实例，再切换未锁定的 CPA 实例。备份自动分配端口、默认停止并锁定；名额不足或备份失败时中止升级。</p>{allInstancesLocked && <p className="version-lock-hint" role="status">所有实例均已锁定，无法统一升级。请先解锁至少一个实例。</p>}{partiallyLocked && <p className="version-lock-hint" role="status">本次只会升级未锁定实例，已锁定实例保持不变。</p>}</div><form className="version-install" onSubmit={event => { event.preventDefault(); onInstall(tag.trim()) }}><input value={tag} onChange={event => setTag(event.target.value)} placeholder="留空下载 latest" aria-label="版本标签" /><button className="button ghost" disabled={busy !== null || upgradeInProgress}>{busy === 'version:install' ? '下载中…' : '下载版本'}</button></form></div>{upgradeState.state !== 'idle' && <div className={'upgrade-banner ' + (blocked ? 'blocked' : '')}><span>升级状态：{upgradeStateLabel(upgradeState.state)}</span>{upgradeState.old_version && upgradeState.new_version && <small>{upgradeState.old_version} → {upgradeState.new_version}</small>}{upgradeState.message && <p>{upgradeState.message}</p>}{blocked && <button className="button ghost" disabled={busy !== null} onClick={onRecover}>{busy === 'version:recover' ? '恢复中…' : '重试回滚'}</button>}</div>}{versions.length === 0 ? <p className="version-empty">尚未下载 CPA 版本。Linux 首次启动会尝试准备 latest，也可以在这里重试。</p> : <div className="version-list">{versions.map(version => { const isCurrent = instances.some(instance => instance.version === version.tag); const needsUpgrade = instances.some(instance => instance.version !== version.tag); const hasUnlockedUpgrade = instances.some(instance => !instance.locked && instance.version !== version.tag); const upgradeBusy = busy === 'version:upgrade:' + version.tag; const uninstallBusy = busy === 'version:uninstall:' + version.tag; return <div className="version-row" key={version.tag}><div><strong>{version.tag}</strong><small>{version.asset || '本地版本'} · {version.installed_at ? new Date(version.installed_at).toLocaleString('zh-CN') : '安装时间未知'}</small></div><div className="version-row-actions"><span className={'version-state ' + (isCurrent ? 'current' : version.usable ? 'ready' : 'bad')}>{isCurrent ? '当前运行' : version.usable ? '已安装' : '不可用'}</span>{version.usable && needsUpgrade && <button className="button ghost" disabled={upgradeDisabled || !hasUnlockedUpgrade} title={upgradeTitle || (!hasUnlockedUpgrade ? '需要升级的实例均已锁定，请先解锁' : undefined)} onClick={() => onUpgrade(version.tag)}>{upgradeBusy ? '升级中…' : '统一升级'}</button>}{!isCurrent && <button className="button ghost danger-outline version-uninstall" aria-label={'卸载版本 ' + version.tag} disabled={busy !== null || upgradeInProgress} onClick={() => onUninstall(version)}>{uninstallBusy ? '卸载中…' : '卸载版本'}</button>}</div></div> })}</div>}</section>
}

function upgradeStateLabel(state: string) {
  return ({ prepared: '准备中', 'stopping-old': '停止旧版本', 'old-stopped': '旧版本已停止', 'starting-new': '启动新版本', committed: '已完成', 'restoring-old': '正在回滚', 'rolled-back': '已回滚', blocked: '回滚受阻' } as Record<string, string>)[state] ?? state
}

function InstanceCard({ instance, quotas, instanceBusy, onAction, onDelete, onConfigure }: { instance: Instance; quotas: QuotaSnapshot[]; instanceBusy: Record<string, string>; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas' | 'lock' | 'unlock' | 'backup') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void }) {
  const running = instance.status?.ready
  const actualState = instance.status?.state ?? 'unknown'
  const actualActive = ['running', 'starting', 'stopping'].includes(actualState)
  const busy = instanceBusy[instance.id] || null
  const actionBusy = Boolean(busy)
  const thisActionBusy = actionBusy
  const managementUrl = instance.management_url
  const quotaLabel = useMemo(() => {
    if (!quotas.length) return '尚未采集'
    if (quotas.length === 1 && quotas[0].account_id === '__discovery__' && quotas[0].status === 'empty') return '0 个账户'
    if (quotas.some(q => q.status === 'failed')) return '查询失败'
    if (quotas.some(q => q.status === 'stale')) return '缓存已过期'
    if (quotas.some(q => q.status === 'unsupported')) return '部分不支持'
    const accountCount = quotas.filter(q => q.account_id !== '__discovery__').length
    const latest = quotas.reduce((value, q) => q.collected_at > value ? q.collected_at : value, '')
    return latest ? accountCount + ' 个账户 · ' + relativeTime(latest) : '无成功快照'
  }, [quotas])
  return <article className={'instance-card ' + (running ? 'is-running' : '')}>
    <div className="card-top">
      <div className="instance-title">
        <span className={'status-orb ' + (running ? 'live' : '')} />
        <div className="instance-title-copy">
          <h3>{instance.name}{instance.locked && <span className="state-pill">已锁定</span>}</h3>
          <p className="instance-endpoint"><span className="instance-port">端口 {instance.port}</span><span className="instance-id">实例 ID {instance.id}</span></p>
        </div>
      </div>
      <div className="card-top-actions" aria-label={`${instance.name} 快捷操作`}>
        <button type="button" className="button ghost card-lock" disabled={actionBusy} onClick={() => onAction(instance, instance.locked ? 'unlock' : 'lock')}>{instance.locked ? '解锁实例' : '锁定实例'}</button>
        {managementUrl && <button type="button" className="button primary management-link" onClick={() => window.open(managementUrl, '_blank', 'noopener,noreferrer')}>CPA 管理 ↗</button>}
        <button type="button" className="button ghost card-refresh" disabled={actionBusy} onClick={() => onAction(instance, 'quotas')}>{busy === 'quotas' ? '读取中…' : '刷新'}</button>
      </div>
    </div>
    <div className="card-actions" aria-label={`${instance.name} 操作`}>
      <button type="button" className="button ghost" disabled={actionBusy || instance.locked} onClick={() => onConfigure(instance)}>配置</button>
      <button type="button" className="button ghost" disabled={actionBusy || instance.locked} onClick={() => onAction(instance, 'backup')}>备份</button>
      <button type="button" className="button primary" disabled={actionBusy || (running && instance.locked)} onClick={() => onAction(instance, running ? 'restart' : 'start')}>{thisActionBusy ? '处理中…' : running ? '重启服务' : '启动实例'}</button>
      <button type="button" className="button danger" disabled={actionBusy || !running || instance.locked} onClick={() => onAction(instance, 'stop')}>停止</button>
      <button type="button" className="button danger delete-instance" disabled={actionBusy || instance.locked} onClick={() => onDelete(instance)}>删除</button>
    </div>
    <div className="current-state" aria-label={`${instance.name} 当前状态`}><span className={'current-state-indicator ' + (actualActive ? 'active' : '')} /><span className="current-state-label">当前状态</span><b>{stateLabel(actualState)}</b></div>
    <div className="card-meta"><div><span>版本</span><strong>{instance.version || '未安装'}</strong></div><div><span>额度观察</span><strong className={quotas.some(q => q.status === 'failed' || q.status === 'stale') ? 'warn-text' : ''}>{quotaLabel}</strong></div></div>
    <div className="card-status"><span className={instance.status?.management_ready ? 'ready-text' : 'muted-text'}>{instance.status?.management_ready ? '管理接口已就绪' : running ? (instance.status?.management_message || '管理接口未验证') : '实例未运行'}</span></div>
    {instance.backup && <div className="card-status"><span className="muted-text">{instance.backup.automatic ? '升级前自动备份' : '手动备份'} · 来源：{instance.backup.source_name}{instance.backup.reason && ` · ${instance.backup.reason}`} · {new Date(instance.backup.created_at).toLocaleString('zh-CN', { hour12: false })}</span></div>}
    <QuotaDetails quotas={quotas} />
  </article>
}

function QuotaDetails({ quotas }: { quotas: QuotaSnapshot[] }) {
  const [showDetails, setShowDetails] = useState(false)
  const summary = useRef<HTMLElement>(null)
  const closeDetails = () => { setShowDetails(false); queueMicrotask(() => summary.current?.querySelector('button')?.focus()) }
  if (!quotas.length) return null
  const accounts = quotas.filter(quota => quota.account_id !== '__discovery__')
  const windowColumns = [
    { name: '5 小时限额', title: '5h额度', label: '5 小时额度剩余' },
    { name: '周限额', title: '周额度', label: '周额度剩余' },
    { name: '月限额', title: '月额度', label: '月额度剩余' },
  ]
  const availableColumns = windowColumns.filter(column => quotas.some(quota => quota.values?.some(value => value.name === column.name)))
  const columns = availableColumns.length ? availableColumns : windowColumns.slice(0, 2)
  const gridStyle = { gridTemplateColumns: columns.length > 2 ? `repeat(${columns.length}, minmax(0, 1fr))` : `minmax(0, 1fr) repeat(${columns.length}, 88px)` }
  return <section ref={summary} className={'quota-summary' + (columns.length > 2 ? ' has-many-windows' : '')}>
    <div className="quota-summary-heading"><strong>OAuth 配额（{accounts.length} 个账户）</strong><button type="button" className="button ghost" onClick={() => setShowDetails(true)}>额度详情</button></div>
    <div className="quota-summary-columns" style={gridStyle}><span>账户</span>{columns.map(column => <span key={column.name}>{column.title}</span>)}</div>
    {quotas.map(quota => {
      const label = quota.account_id === '__discovery__' ? 'OAuth 账户' : quota.account_id
      return <div className="quota-summary-row" style={gridStyle} key={quota.account_id}>
        <div className="quota-summary-account"><strong title={label}>{label}</strong><small className={'quota-state ' + quota.status}>{quota.provider ? `${quota.provider} · ` : ''}{quotaStatusLabel(quota.status)}{quota.status !== 'ok' && columns.some(column => quota.values?.some(value => value.name === column.name)) ? ' · 缓存' : ''}</small></div>
        {columns.map(column => <QuotaSummaryValue key={column.name} value={quota.values?.find(value => value.name === column.name)} status={quota.status} label={`${label} ${column.label}`} />)}
      </div>
    })}
    {showDetails && createPortal(<QuotaDetailDialog quotas={quotas} onClose={closeDetails} />, document.body)}
  </section>
}

function QuotaSummaryValue({ value, status, label }: { value?: QuotaValue; status: QuotaSnapshot['status']; label: string }) {
  const percent = value ? quotaPercent(value) : null
  return <div className="quota-summary-value"><strong>{value ? formatQuotaValue(value) : status === 'empty' ? '—' : status === 'failed' ? '查询失败' : '未提供'}</strong>{percent !== null && <div className={'quota-progress' + (percent <= 20 ? ' low' : percent < 60 ? ' warning' : '')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>}{value && <QuotaResetTime resetAt={value.reset_at} compact />}</div>
}

function QuotaResetTime({ resetAt, compact = false }: { resetAt?: string; compact?: boolean }) {
  const known = validTimestamp(resetAt)
  const formatted = known ? formatQuotaReset(resetAt!) : ''
  return <span className={compact ? 'quota-summary-reset' : 'quota-reset-time'}>
    {compact && <small>重置时间</small>}
    {known ? <time dateTime={resetAt} title={new Date(resetAt!).toLocaleString('zh-CN', { hour12: false })}>{compact ? formatted.split(' ').map((part, index) => <span key={index}>{part}</span>) : formatted}</time> : <span className="quota-reset-unknown">未提供重置时间</span>}
    {!compact && known && <small>{quotaResetRelative(resetAt!)}重置</small>}
  </span>
}

function QuotaDetailDialog({ quotas, onClose }: { quotas: QuotaSnapshot[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const accounts = quotas.filter(quota => quota.account_id !== '__discovery__')
  const discovery = quotas.find(quota => quota.account_id === '__discovery__')
  const defaultQuotas = accounts.length ? accounts.slice(0, 2) : discovery ? [discovery] : []
  const [additionalAccountId, setAdditionalAccountId] = useState('')
  const additional = accounts.find(quota => quota.account_id === additionalAccountId)
  useEffect(() => {
    const element = dialog.current!
    const previousOverflow = document.body.style.overflow
    element.showModal()
    document.body.style.overflow = 'hidden'
    return () => { element.close(); document.body.style.overflow = previousOverflow }
  }, [])
  return <dialog ref={dialog} className="quota-detail-dialog" aria-label="OAuth 额度详情" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}>
    <header><div><h2>OAuth 额度详情</h2><p>查看各账户的全部额度窗口与重置时间</p></div><button type="button" className="button ghost" onClick={onClose} autoFocus>关闭</button></header>
    {accounts.length > 2 && <label className="quota-account-selector">其他 OAuth 账户<Dropdown
      id="quota-additional-account"
      label="选择其他 OAuth 账户"
      className="quota-account-dropdown"
      placeholder="选择要查看的账户"
      options={[{ value: '', label: '选择要查看的账户' }, ...accounts.slice(2).map(quota => ({ value: quota.account_id, label: `${quota.provider || 'OAuth'} · ${quota.account_id}` }))]}
      value={additionalAccountId}
      onChange={setAdditionalAccountId}
    /></label>}
    {!!defaultQuotas.length && <QuotaDetailPanel quotas={defaultQuotas} />}
    {additional && <div className="quota-detail-additional"><QuotaDetailPanel quotas={[additional]} /></div>}
  </dialog>
}

function QuotaDetailPanel({ quotas }: { quotas: QuotaSnapshot[] }) {
  return <div className="quota-detail-panel"><QuotaFullDetails quotas={quotas} />{quotas.map(quota => quota.message && !!quota.values?.length && <p className="quota-message" key={quota.account_id + '-message'}>{quota.message}</p>)}</div>
}

function QuotaFullDetails({ quotas }: { quotas: QuotaSnapshot[] }) {
  if (!quotas.length) return null
  const accountCount = quotas.filter(quota => quota.account_id !== '__discovery__').length
  return <section className="quota-details"><div className="quota-heading">OAuth 配额（{accountCount} 个账户）</div><div className="quota-rows">{quotas.map(quota => { const accountLabel = quota.account_id === '__discovery__' ? 'OAuth 账户' : (quota.provider || 'OAuth') + ' · ' + quota.account_id; return <div className="quota-row" key={quota.account_id}><div className="quota-row-head"><strong title={accountLabel}>{accountLabel}</strong><span className={'quota-state ' + quota.status}>{quotaStatusLabel(quota.status)}</span></div>{quota.values?.length ? <div className="quota-values">{quota.values.map((value, index) => <QuotaWindow key={value.name + '-' + index} value={value} />)}</div> : <p className="quota-message">{quota.message || '子实例未返回可展示的配额窗口。'}</p>}{validTimestamp(quota.collected_at) && <small className="quota-timestamp">最近成功采集于 {new Date(quota.collected_at).toLocaleString('zh-CN')}</small>}{validTimestamp(quota.attempted_at) && quota.status !== 'ok' && <small className="quota-timestamp">最近尝试于 {new Date(quota.attempted_at).toLocaleString('zh-CN')}</small>}</div> })}</div></section>
}

function QuotaWindow({ value }: { value: QuotaValue }) {
  const percent = quotaPercent(value)
  const tone = percent === null ? '' : percent <= 20 ? ' low' : percent < 60 ? ' warning' : ' healthy'
  const label = value.name || '默认窗口'
  return <div className="quota-window"><div className="quota-window-title">{label}</div><div className="quota-window-meta"><strong>{formatQuotaValue(value)}</strong><QuotaResetTime resetAt={value.reset_at} /></div>{percent !== null && <div className={'quota-progress' + tone} role="progressbar" aria-label={`${label} 剩余配额`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>}</div>
}

function quotaStatusLabel(status: string) {
  return ({ ok: '已更新', empty: '无账户', unsupported: '不支持', failed: '查询失败', stale: '已过期' } as Record<string, string>)[status] ?? status
}

function formatQuotaValue(value: QuotaValue) {
  const number = (item: number | undefined) => item === undefined ? '' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(item)
  const unit = value.unit ? ' ' + value.unit : ''
  if (value.unit === '%' && value.remaining !== undefined) return number(value.remaining) + '%'
  if (value.remaining !== undefined && value.total !== undefined) return ' ' + number(value.remaining) + ' / ' + number(value.total) + unit
  if (value.remaining !== undefined) return ' 剩余 ' + number(value.remaining) + unit
  if (value.total !== undefined) return ' 总量 ' + number(value.total) + unit
  return ' 未提供数值'
}

function formatQuotaReset(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

function quotaResetRelative(value: string) {
  const delta = Date.parse(value) - Date.now()
  if (!Number.isFinite(delta)) return '时间未知'
  if (delta <= 0) return '已到期'
  const minutes = Math.max(1, Math.round(delta / 60000))
  if (minutes < 60) return `${minutes}分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}小时后`
  return `${Math.round(hours / 24)}天后`
}

function CreateDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (error: string) => void }) {
  const [name, setName] = useState('')
  const [port, setPort] = useState('8317')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">NEW INSTANCE</div><h2>创建 CPA 实例</h2><p>总控会为实例创建独立目录；账户和 API Key 在子实例管理页配置。</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api.post('/instances', { name, port: Number(port), ...(password ? { management_password: password } : {}) }); onCreated() } catch (cause) { onError(cause instanceof Error ? cause.message : '创建失败') } finally { setBusy(false) } }}><label>实例名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如 claude-work" required /></label><label>监听端口<input type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} required /></label><label>子实例管理密码（可选）<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="留空使用默认密码 admin" /></label><div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '创建中…' : '创建实例'}</button></div></form></div></dialog>
}

function BackupDialog({ instance, instances, onClose, onSaved }: { instance: Instance; instances: Instance[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(`${instance.name.slice(0, 48)}-backup`)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const conflict = instances.some(item => item.port === Number(port))
  return <dialog open className="modal-backdrop" aria-labelledby="backup-title"><div className="dialog"><button className="dialog-close" disabled={busy} onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">BACKUP INSTANCE</div><h2 id="backup-title">备份 {instance.name}</h2><p>复制当前 CPA 版本、配置、认证和插件数据，保存为独立实例。新实例默认停止，管理密码保持一致。</p><p>运行中的源实例会短暂停止，复制结束后恢复。历史日志不复制，备份占用独立的备份名额，不占普通实例名额。</p><form onSubmit={async event => { event.preventDefault(); if (busy || conflict) return; setBusy(true); setError(''); try { await api.post('/instances/' + instance.id + '/backup', { name: name.trim(), port: Number(port) }); onSaved() } catch (cause) { setError(cause instanceof Error ? cause.message : '备份失败') } finally { setBusy(false) } }}><label>备份实例名称<input value={name} disabled={busy} maxLength={64} onChange={event => setName(event.target.value)} required /></label><label>新的监听端口<input type="number" min="1024" max="65535" disabled={busy} value={port} onChange={event => setPort(event.target.value)} placeholder="填写未使用的端口" autoFocus required /></label>{(error || conflict) && <p className="settings-inline-error" role="alert">{error || '该端口已被现有实例使用，请填写新端口。'}</p>}<div className="dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !port || !name.trim() || conflict}>{busy ? '备份中…' : '保存备份实例'}</button></div></form></div></dialog>
}

function EditDialog({ instance, onClose, onSaved, onError }: { instance: Instance; onClose: () => void; onSaved: () => void; onError: (error: string) => void }) {
  const [name, setName] = useState(instance.name)
  const [port, setPort] = useState(String(instance.port))
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">INSTANCE CONFIG</div><h2>配置 {instance.name}</h2><p>留空子实例管理密码则保持当前密码不变；账户与 API Key 继续在子实例管理页维护。</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api.patch('/instances/' + instance.id, { name, port: Number(port), ...(password ? { management_password: password } : {}), expected_revision: instance.revision }); onSaved() } catch (cause) { onError(cause instanceof Error ? cause.message : '配置失败') } finally { setBusy(false) } }}><label>实例名称<input value={name} onChange={event => setName(event.target.value)} required /></label><label>监听端口<input type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} required /></label><label>新的子实例管理密码（可选）<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="留空保持当前密码" /></label><div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存配置'}</button></div></form></div></dialog>
}

function DeleteDialog({ instance, challenge, onClose, onDeleted, onError }: { instance: Instance; challenge: string | null; onClose: () => void; onDeleted: () => void; onError: (error: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog danger-dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="danger-mark">!</div><div className="eyebrow">IRREVERSIBLE ACTION</div><h2>删除 {instance.name}？</h2><p>这会停止实例并清除它的配置、OAuth 认证数据、日志和注册信息，同时自动清理该实例的 API Key 绑定，无需先启动或手动解绑。Key 本身、其他实例的绑定和版本安装缓存会保留。</p><label>输入总控管理员密码确认<PasswordInput aria-label="输入总控管理员密码确认删除" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" autoFocus required /></label><div className="dialog-actions"><button className="button ghost" onClick={onClose}>保留实例</button><button className="button danger" disabled={!challenge || !password || busy} onClick={async () => { setBusy(true); try { await api.post('/instances/' + instance.id + '/delete', { challenge_id: challenge, admin_password: password }); onDeleted() } catch (cause) { onError(cause instanceof Error ? cause.message : '删除失败') } finally { setBusy(false) } }}>{busy ? '删除中…' : '确认删除'}</button></div></div></dialog>
}

function UnlockDialog({ instance, onClose, onUnlocked, onError }: { instance: Instance; onClose: () => void; onUnlocked: () => void; onError: (error: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog security-dialog"><button className="dialog-close" disabled={busy} onClick={onClose} aria-label="关闭">×</button><div className="settings-icon" aria-hidden="true">⌁</div><div className="eyebrow">UNLOCK INSTANCE</div><h2>解锁 {instance.name}</h2><p>解锁会恢复该子实例的配置、停止、重启和删除操作。请输入总控管理员密码确认。</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api.post('/instances/' + instance.id + '/unlock', { admin_password: password }); onUnlocked() } catch (cause) { onError(cause instanceof Error ? cause.message : '解锁失败') } finally { setBusy(false) } }}><label>总控管理员密码<PasswordInput aria-label="输入总控管理员密码确认解锁" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" autoFocus required /></label><div className="dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!password || busy}>{busy ? '解锁中…' : '确认解锁'}</button></div></form></div></dialog>
}

function UninstallVersionDialog({ version, busy, onClose, onConfirm }: { version: VersionInstall; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <dialog open className="modal-backdrop"><div className="dialog danger-dialog"><button className="dialog-close" disabled={busy} onClick={onClose} aria-label="关闭">×</button><div className="danger-mark">!</div><div className="eyebrow">VERSION CLEANUP</div><h2>卸载 {version.tag}？</h2><p>将删除该版本的安装缓存。当前运行版本不会受影响；如果之后需要回滚到 {version.tag}，需要重新安装。</p><div className="dialog-actions"><button className="button ghost" disabled={busy} onClick={onClose}>保留版本</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? '卸载中…' : '确认卸载'}</button></div></div></dialog>
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-mark"><span /><span /><span /></div><h3>还没有运行轨</h3><p>创建第一个实例后，端口、版本、状态和配额会在这里汇合。</p><button className="button primary" onClick={onCreate}>创建第一个实例</button></div>
}

function quotaPercent(value: QuotaValue) {
  const remaining = Number(value.remaining)
  const total = Number(value.total)
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, remaining / total * 100))
}

function stateLabel(state?: string) {
  return ({ running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '失败', unknown: '未知' } as Record<string, string>)[state ?? 'unknown'] ?? '未知'
}

function relativeTime(value: string) {
  const age = Date.now() - Date.parse(value)
  if (!Number.isFinite(age)) return '时间未知'
  const minutes = Math.floor(age / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  return Math.floor(minutes / 60) + ' 小时前'
}

function validTimestamp(value?: string) {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed > 0
}

export { App }

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)




function InstanceLimitsSettings() {
  const [limits, setLimits] = useState<{ max_instances: number; max_backups: number; instances_used: number; backups_used: number } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => { setError(''); void api.get('/instance-limits').then(value => setLimits(value as NonNullable<typeof limits>)).catch(cause => setError(cause instanceof Error ? cause.message : '读取实例上限失败')) }
  useEffect(load, [])
  return <section className="settings-block" aria-label="实例名额设置"><h3>实例名额</h3><p>普通实例与备份分别计数。启动或解锁备份仍占备份名额。达到备份上限时中止升级，已有备份会保留。</p>{!limits && <button type="button" className="button ghost" onClick={load}>重新读取实例上限</button>}{limits && <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); setNotice(''); try { const result = await api.patch('/instance-limits', { max_instances: limits.max_instances, max_backups: limits.max_backups }); setLimits(result as NonNullable<typeof limits>); setNotice('实例上限已保存，立即生效') } catch (cause) { setError(cause instanceof Error ? cause.message : '保存实例上限失败') } finally { setBusy(false) } }}><div className="settings-grid"><label>普通实例上限<input type="number" aria-label="普通实例上限" min="1" max="1000" step="1" required disabled={busy} value={limits.max_instances} onChange={event => setLimits({ ...limits, max_instances: Number(event.target.value) })} /><small>已使用 {limits.instances_used} 个，默认 5 个。</small></label><label>备份实例上限<input type="number" aria-label="备份实例上限" min="1" max="1000" step="1" required disabled={busy} value={limits.max_backups} onChange={event => setLimits({ ...limits, max_backups: Number(event.target.value) })} /><small>已使用 {limits.backups_used} 个，默认 10 个。</small></label></div><div className="dialog-actions"><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存实例上限'}</button></div></form>}{error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
}
