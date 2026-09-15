# Windows / WSL 实际功能验收记录

更新：2026-09-15。此记录区分真实进程/浏览器证据和故障注入测试，不能把单测通过当成全部实际验收通过。

## 当前结论

2026-09-15 重新构建：最新总控恢复修复、独立运行时选择、`plugins.enabled: true` 默认配置和“当前目录 `.multi-cliproxyapi`”数据目录默认值已包含在 `release/multi-cliproxyapi-linux-x64`，SHA-256 为 `41fbf445ab3c129e88611ae99d5d6969c0ef2c83ec41a92f0d570869728a2cff`。同时修正发布安装脚本生成 systemd unit 时对 `WorkingDirectory` 等路径字段错误加引号的问题。新包实际验证 7 项全部通过：内嵌前端、四个部署脚本、新实例插件默认开启、真实子实例启动、总控崩溃后子实例可用、恢复后 PID/登录会话保持、隔离实例删除；直接运行二进制的当前目录默认也已实测。下文旧包摘要仅作为历史记录。

后续修正：总控启动恢复不再迁移运行中子实例的配置/二进制，也不再因迁移或期望状态不一致而重启/停止存活子实例。仅在期望运行且进程已停止时恢复启动。Windows 后端回归 75 通过、7 跳过；隔离 systemd 实测总控重启保持 CPA PID/会话，手动停止实例仍停止；这些修正已包含在本次最新 SEA 包中。下文旧 SHA-256 仅作为历史记录。

主要本地功能链路、两个真实 CPA 版本的切换/回退、真实 Codex OAuth 配额、WSL 重启恢复、正式安装脚本重复安装、systemd/polkit 协作和最终 Linux SEA 单文件包已获得实际证据。用户明确表示钉钉 Webhook 实际发送由其自行测试，已从本次实际验收范围排除。前端全量 Vitest 在 WSL 挂载目录偶发宿主通信错误，已用 Linux 文件系统完成关键目标测试。

项目生产目标仍为 Linux amd64；Windows 通过 WSL Ubuntu 执行服务，通过 Windows 内嵌浏览器操作页面，不增加 Windows 原生服务兼容层。

## 环境与隔离

- Node.js 24.18.0，Windows PowerShell + Ubuntu WSL。
- 专用数据目录：`.functional-test-C63oH0`；总控端口 18787；测试 CPA 端口 18317、18318–18328。
- 保留用户原有 8317、8318、8319 实例，未修改或删除它们的配置、认证文件和进程。
- 仅通过管理 API 只读检查上述三个实例的账户数量，均为 0；未读取认证目录。
- systemd/polkit 的临时单元、规则和 `/var/lib` 临时测试目录均在脚本结束时清理。
- `.functional-test-*` 已加入 gitignore，避免提交数据库、密钥和 CPA 二进制缓存。

## 实际验收矩阵

| 功能 | 已取得证据 | 剩余范围 |
|---|---|---|
| 登录/退出 | Windows 浏览器错误密码反馈、默认密码登录、退出回到登录页；真实 API Cookie 标记、退出撤销会话 | 过期会话通过可控时钟测试，不等待真实 12 小时 |
| 管理员密码 | 独立测试 API 修改密码、旧密码拒绝、新密码登录、恢复默认测试密码 | 浏览器改密未提交；无生产密码变更 |
| 创建实例 | 从空白环境通过浏览器创建；真实 API 默认/自定义密码、5 个上限、重名与端口冲突、独立二进制文件 | 已验证范围通过 |
| 启停/重启 | 浏览器启动后显示运行与管理就绪；真实进程重启 PID 改变；停止确认 | 强制停止不退出路径采用故障注入 |
| 配置 | 真实 API 运行中改端口/名称、留空保持密码、旧 revision 冲突 | 新配置启动失败后的恢复采用故障注入 |
| CPA 管理页 | 官方管理 HTML 实际下载；Windows 点击入口打开新标签；默认密码登录成功；systemd/发布包返回真实 HTML | 下载失败及离线缓存通过故障注入/缓存测试 |
| 删除 | 浏览器展示影响范围、取消保留实例；真实 API 错误密码、过期 revision、运行中删除、目录隔离 | 时间过期通过可控时钟测试；不删除用户实例 |
| 配额 | 真实 Codex OAuth 账户发现和上游额度 200；WSL 重启后自动恢复；页面显示周限额及模型 5 小时/周窗口、百分比进度条和重置时间；停止实例明确显示查询失败 | Claude 真实上游账户、实际钉钉发送不在本轮范围 |
| 版本 | 官方 v7.2.158 下载及 SHA-256 校验，重复安装明确 409 | 网络/归档/摘要异常采用故障注入 |
| 升级/回退 | 7.2.159 → v7.2.158 → 7.2.159，保持停止意图、运行 PID 变化、升级后创建选择正确版本 | 故障阻断和中断回滚采用运行时注入；非真实主机断电 |
| 日志 | 真实操作审计成功/失败记录、敏感值排除；Windows 搜索和状态组合筛选、空结果、定位安装失败 | 已验证范围通过 |
| 独立存活 | WSL 整体重启后总控 18787 自动恢复，期望运行的 18317 子实例自动恢复并再次取得 OAuth 快照；总控退出和发布包崩溃保活也已验证 | 不模拟物理主机断电 |
| systemd/polkit | Ubuntu 正式安装路径实际创建并启动总控；受限账号创建/启停/删除 CPA、重复安装保持子实例 PID 和数据、停止意图均通过；非允许单元拒绝访问 | Ubuntu-22.04 缺少 polkit JavaScript 后端时安装器会明确提前失败，需补齐系统依赖 |
| 发布包 | 去符号后完成 postject 注入；最终二进制实际提供嵌入 HTML/JS、相对数据目录、真实 CPA 创建启动、崩溃保活、恢复、删除；摘要已更新 | 已验证范围通过 |
| 钉钉 Webhook | 加签、保存/清除、失败处理与脱敏日志回归通过 | 实际发送由用户自行测试 |

## 修复的问题

1. 本地进程 SIGKILL 后未确认退出就清除 PID，可能误报停止；现在保留跟踪并等待退出，失败明确报错。
2. 升级后创建实例仍选旧默认版本；改为优先使用已有实例的统一版本，并更新升级后的默认值。
3. blocked 升级可以被普通启动/重启/配置和期望状态恢复绕过；现在使用统一屏障，恢复操作串行化。
4. 回滚未确认新进程全部停止就替换二进制和版本记录；现在先 blocked，保留当前状态，确认停止后才能恢复旧版。
5. 新配置启动失败不恢复旧配置；现在确认新进程停止后恢复配置和数据库，使用递增 revision，再恢复旧进程。
6. 改刷新周期后仍等待旧的 6 小时定时器；现在唤醒并重新计算周期，及时清理 abort 监听。
7. 停止实例反复等待配额网络超时，占住生命周期锁；现在直接记录明确失败并返回 409。
8. 通知发送失败被吞掉、异常成功响应被当成送达；现在校验返回码并写入不含 Webhook URL/密钥的错误日志。失败快照和缺失数值不会触发伪零值告警。
9. UTF-8 分块解码每块新建 Decoder，中文账户名可能乱码；改用持续流式 Decoder。
10. 缺失稳定账户标识、非法配额响应可能被当成成功；加强校验，缺失值不伪装为零。JSON 解析错误不再暴露原始响应片段。
11. CPA 7.2.159 的 `/v0/management/quota` 实测 404；依据官方管理页接入 Codex/Claude 的 `/v0/management/api-call` 只读查询协议，未知提供商明确不支持。
12. 端口绑定失败后配额任务仍存活；现在先绑定端口，初始化阶段返回 503，失败释放资源。关闭幂等，取消采集、移除信号监听。
13. 相对 data-dir 未转为绝对路径，与独立可执行文件校验冲突；配置读取时规范化。
14. 安装器只检查 PATH 中的 Node，却固定执行 `/usr/bin/node`，且 PREFIX 不生效；现在复制已验证 Node 运行时并生成匹配 PREFIX 的单元路径，真实受限部署已验证。
15. 验收脚本强制占用 8787 并忽略端口设置；改为默认独立 18787。空实例但已有版本时的页面提示、删除缓存影响说明已更正。
16. CPA 7.2.159 没有统一 `/v0/management/quota`；总控默认改用 `/v0/management/api-call` 代理 Codex/Claude OAuth 只读端点，并带上账户索引和 Codex 账户标识。
17. 配置了磁盘上的 CPA 版本但 SQLite 没有版本元数据时，首次启动会误报版本不存在；现在校验可执行文件、计算摘要并登记版本。
18. 配额窗口原先只显示原始数值；现在按窗口堆叠显示百分比、重置时间、相对倒计时和颜色进度条，部分刷新失败仍保留成功实例快照。
19. `install.sh` 在没有 polkit JavaScript 规则后端的系统上会先给出明确依赖错误，避免安装成功但实例无法由受限账号控制；Ubuntu 正式环境已通过完整重复安装验收。

之前管理页资源准备、缓存复制和健康状态残留修复，也已纳入本次真实验证与回归。

## OAuth 配额协议证据与限制

- 实际 GET `/v0/management/quota`：404（CPA 7.2.159）。
- 官方管理页使用 POST `/v0/management/api-call`，请求字段 `authIndex`、`method`、`url`、`header`；CPA 内部替换 `Bearer $TOKEN$`。
- Codex 只读地址：`https://chatgpt.com/backend-api/wham/usage`；Claude：`https://api.anthropic.com/api/oauth/usage`。
- 不调用重置、消费额度等写入接口，不读取或保存 OAuth Token。
- 官方缓存 HTML SHA-256：`3323ba67365605094e8dba9cf6c46644b77e967bd8bd6d0cd5d4f17a62716744`。
- 本地 HTTP 合约测试验证真实请求字段、上游包装状态、100% 使用对应零剩余、未知值拒绝、账户索引隔离。
- 重启后的脱敏实测：`/v0/management/auth-files` 返回 1 个 Codex OAuth 账户；带 `Chatgpt-Account-Id` 的 `/v0/management/api-call` 返回包装状态 200、上游状态 200，并包含 `rate_limit` 和模型附加窗口。探针只打印字段名、布尔值和数值，不打印 Token、邮箱或账户标识。
- 浏览器实测显示 `31%` 的周限额，以及 `GPT-5.3-Codex-Spark` 的 5 小时和周窗口各 `100%`，进度条 `aria-valuenow` 与百分比一致。
- 未验证的其他提供商明确为 unsupported。`MULTI_CPA_QUOTA_PATH` 保留为经过验证的统一接口覆盖项。

## 可复查的证据与命令

2026-09-14 最后一轮 WSL 后端回归：81 项通过，0 失败，0 跳过。Windows 同一套测试：74 项通过，0 失败，7 项 Linux 专用测试跳过。新增的配置版本登记、真实 api-call 配额适配器和窗口解析均包含在回归中。

用户确认后执行了多次 `wsl --shutdown`。重启后的 Ubuntu 总控 18787 自动恢复，期望运行的测试 CPA 18317 自动恢复；脱敏 OAuth 探针再次取得账户和上游配额，浏览器页面显示新的窗口布局。原有用户实例目录和认证文件未被读取或修改。

Ubuntu 正式安装验收使用独立的 8787 数据目录：登录、创建并启动真实 systemd 子实例、重复执行 `deploy/install.sh` 后保持子实例 PID/数据、停止意图、删除挑战全部通过，随后已清理安装服务和测试数据。Ubuntu-22.04 因缺少 polkit JavaScript 规则后端而在安装前明确失败，避免留下不可控制的“假成功”安装。

前端 Vite/TypeScript 构建成功；Linux 文件系统中的 Vitest API、OAuth 窗口和部分刷新失败保留快照目标测试通过。对 WSL 挂载目录运行 Vitest 全量/多目标时，宿主偶发返回 `Wsl/Service/0x8007274c`，因此不把该次中断当作代码失败，也不宣称全量前端测试完成。

最终 SEA 文件 `release/multi-cliproxyapi-linux-x64` 的 SHA-256 为 `41fbf445ab3c129e88611ae99d5d6969c0ef2c83ec41a92f0d570869728a2cff`；`verify-functional-package.mjs` 的 7 个真实检查全部通过，其中包含发布目录四个部署脚本和插件默认配置。直接复制的 SEA 二进制未指定 `MULTI_CPA_DATA_DIR` 时，会在当前工作目录创建 `.multi-cliproxyapi/control.db`。

JSON 实际运行证据在 `test-doc/test-evidence/2026-09-14/`。证据中的时间与 PID 是对应运行的采样，不代表服务当前仍在运行。

```powershell
# Windows 后端检查；Linux 专用测试会明确跳过。
npm test

# WSL 全部回归与构建
wsl -d Ubuntu -- bash -lc 'cd /mnt/d/github/multi-cliproxyapi && npm ci && npm ci --prefix web && npm test && npm run test:web && npm run build'
```

真实验收脚本：

- `scripts/start-functional-test.mjs`：从本地真实版本缓存创建独立数据目录并监听 18787；需先有 `.local-data/versions/7.2.159`，或设置版本环境变量。
- `scripts/verify-functional-api.mjs <Windows测试目录>`：要求已通过浏览器创建名为 win-* 的初始实例；仅重建 accept-* 测试实例。
- `scripts/verify-functional-versions.mjs <Windows测试目录>`：真实下载/复用版本，切换、创建并回退；固定测试端口，拒绝不同数据目录。
- `scripts/verify-functional-package.mjs <WSL测试目录>`：发布包实际运行与崩溃恢复；需先 `npm run package:linux`。
- `scripts/verify-functional-systemd.mjs`、`verify-functional-polkit.mjs`、`verify-functional-deployment.mjs`：需在 WSL root 下执行，仅创建临时验收单元/规则，不覆盖已有同名配置；脚本结束清理。
- `scripts/verify-installed-service.mjs`：在 Ubuntu 正式安装路径验证 `install.sh` 重复安装和真实 systemd 子实例生命周期；脚本使用 19317 测试端口并在验收后清理。
- `scripts/probe-functional-quota.mjs`：对真实 CPA OAuth 账户执行脱敏账户/配额探针，不输出凭据或账户隐私字段。

当前范围内的逻辑、功能、重启后 OAuth 链路和最终 SEA 发布包已完成验收；DingTalk 实际发送按用户要求保留给用户自行测试。WSL 挂载目录的 Vitest 全量稳定运行仍受宿主通信限制，关键 UI/API 目标测试已通过。
