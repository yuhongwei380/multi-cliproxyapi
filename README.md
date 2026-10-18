# Multi CLIProxyAPI Controller

Multi CLIProxyAPI Controller 是一个运行在 Linux amd64 上的总控服务，用于管理同一台主机上的多个 CLIProxyAPI（CPA）实例。每个实例拥有独立的目录、CPA 二进制、配置、认证文件、日志和端口；总控重启或崩溃不会停止已经运行的子实例。

本项目基于https://github.com/router-for-me/CLIProxyAPI 作为下游进行开发，不涉及修改 cliproxyapi的任何代码。

项目提供管理 Web 页面和 HTTP API。管理员默认账号是 `admin`，首次密码也是 `admin`；登录后请立即修改密码。

实例卡片支持“锁定实例 / 解锁实例”，锁定状态在总控重启后保留。锁定后禁止重启、停止、修改配置、备份和删除；统一升级时只处理未锁定实例，已锁定实例保持不变；如果所有实例都已锁定，统一升级会拒绝执行，请先解锁至少一个实例。查看状态、刷新配额和启动已停止实例仍可使用。对应接口为 `POST /api/instances/:id/lock` 和 `POST /api/instances/:id/unlock`，两者都需要管理员登录；锁定无需额外密码，解锁必须在请求体中提供总控管理员密码 `admin_password`。两种操作都会记录到审计日志。

CPA 统一升级以及统一安装 / 升级插件前，总控会先为每个实际操作的实例创建独立备份子实例。自动分配空闲端口，保留升级前的 CPA 版本、配置、认证和插件数据，管理密码保持一致；备份默认停止并锁定，因此不会被本次或后续统一升级选中。所有备份成功后才开始升级，名额不足或任一备份失败会中止升级，已成功的备份保留。普通实例与备份分别计数，默认上限分别为 5 和 10，可在管理员设置的“实例名额”中修改（1–1000，不能低于已使用数量，保存后立即生效）。启动、解锁或改名后的备份仍计入备份名额；旧备份会自动迁移识别。通过服务验证后会自动清理本次备份；升级或验证失败时保留备份，可以解锁后进行测试、修改端口或按现有删除流程清理。下载版本和卸载未使用的版本不会触发备份。

统一升级会为原本运行的实例生成独立的随机临时测试 Key，写入后调用 `/v1/models` 验证服务。CPA 保存配置与运行时鉴权刷新之间可能存在延迟；新 Key 返回 HTTP 401 时，总控最多探测 20 次、间隔 500 毫秒，整个验证阶段限时 30 秒。持续拒绝、HTTP 403 或其他异常仍视为升级失败并回滚。验证结束或取消后会移除本次临时 Key 并重新读取确认，保留其他 Key。此等待依据 [CPA 管理配置保存后异步重载的实现](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.23/internal/api/handlers/management/handler.go)。

实例卡片也提供“备份”，可填写新名称和新端口手动保存为子实例：`POST /api/instances/:id/backup`，请求体为 `{"name":"cpa-backup","port":18322}`。运行中的源实例会在复制期间短暂停止，复制完成或失败后恢复运行；停止的源实例保持停止。复制实例目录中的独立文件，重新设置监听端口和配置中的实例内路径；历史日志、进程 PID 和旧插件回滚目录不复制。实例目录外的配置数据路径、符号链接和特殊文件不支持复制，遇到时中止。备份来源及触发原因在实例列表显示，插件部署记录还显示对应备份的名称和端口。

## 生产部署

发布脚本仅支持系统服务模式。安装、启动、停止和卸载均使用 `sudo bash 对应脚本.sh`（root 用户可直接执行）。

生产环境使用 `release/` 中的单文件二进制和脚本，不需要额外安装 Node.js。目标系统需要 Linux amd64、systemd 和 polkit。

```sh
cd release
sudo bash install.sh
sudo bash start.sh
```

安装脚本会注册以下服务：

- `multi-cliproxyapi.service`：总控服务，默认监听 `0.0.0.0:8787`。
- `multi-cpa@<instance-id>.service`：每个 CPA 子实例独立运行。

生产数据默认保存在 `/opt/mutli-cliproxycpa-data`，包括 `control.db`、`secrets.key`、`versions/` 和 `instances/`。可在安装时覆盖：

```sh
sudo env MULTI_CPA_DATA_DIR=/srv/multi-cliproxycpa-data ./install.sh
```

`start.sh` 和 `stop.sh` 只操作总控，子实例保持独立。`uninstall.sh` 会先检查所有 CPA 子服务和进程；只要有实例运行、正在启停或无法确认状态，就拒绝卸载。确认卸载服务和二进制后，还必须再次输入完整数据目录才能删除数据。

如需安装时保留 14 天日志，可执行 `sudo env MULTI_CPA_LOG_RETENTION_DAYS=14 ./install.sh`；默认配置为 7 天。

请在防火墙或 HTTPS 反向代理中限制 `8787` 和子实例端口的访问，并在使用局域网访问时修改总控和 CPA 的默认管理密码。需要 HTTPS Cookie 时设置 `MULTI_CPA_SECURE_COOKIES=true`。

## 源码开发

源码运行需要 Node.js 22.5 或更新版本，并且运行时提供 `node:sqlite`。Windows 只用于通过 WSL 测试，生产服务仍运行在 Linux amd64。

```sh
npm ci
npm ci --prefix web
npm test
npm run test:web
npm run build
```

在 WSL 或其他没有 systemd 的 Linux 环境中，可用根目录脚本启动测试服务：

```sh
./start.sh
./stop.sh
```

源码测试服务默认使用项目目录下的 `.local-data`。可用以下变量覆盖数据目录、监听地址、日志路径和日志等级：

```sh
MULTI_CPA_DATA_DIR=/tmp/multi-cpa-data MULTI_CPA_LISTEN=127.0.0.1:8787 ./start.sh
```

systemd 安装默认将控制器日志双写到 journal 和 `/var/log/multi-cpa.log`，默认等级为 `info`。安装脚本会生成 `/etc/logrotate.d/multi-cpa`，默认保留 7 天；执行安装时设置 `MULTI_CPA_LOG_RETENTION_DAYS=14` 可改为保留 14 天，也可以直接编辑该配置文件。`MULTI_CPA_LOG_LEVEL` 支持 `debug`、`info`、`warn`、`error`。

## 构建发布包

在 Node.js 24 或更新版本的 Ubuntu WSL 中执行：

```sh
npm run package:linux
```

构建会生成：

- `release/multi-cliproxyapi-linux-x64`：内嵌总控和 Web 页面的 Linux amd64 单文件二进制。
- `release/multi-cliproxyapi-linux-x64.sha256`：二进制校验文件。
- `release/install.sh`、`start.sh`、`stop.sh`、`uninstall.sh`：部署和生命周期脚本。

构建过程会重新生成 `web/dist`，并清理打包 staging 和前端依赖目录。`web/dist` 和二进制等编译产物不纳入 Git；源码运行前需先执行 `npm run build`。
推送形如 `v26.10.0` 的 Git tag 后，GitHub Actions 会在 Linux amd64 runner 上运行测试、构建同样的发布包，并把包含二进制、校验文件和四个部署脚本的 `.tar.gz` 上传到 GitHub Release。

## 版本规则

应用版本采用 `YY.MM.PATCH` 的日历版本规则。当前版本为 `26.10.8`；同一个月内的修复和小改动递增最后一位，例如从 `26.10.0` 更新到 `26.10.8`。Git tag 使用 `v` 前缀，例如 `v26.10.8`。

这个规则比无语义的 `0.x` 更容易判断发布时间，同时仍符合 SemVer 的三个数字段，现有 npm、构建和发布工具可以继续使用。两位年份在 2099 年之后会产生歧义；如果项目需要长期维护，应在进入 2100 年前切换为 `YYYY.MM.PATCH`，当前阶段保留 `YY.MM.PATCH` 更简洁。

## 功能说明

### 总控 API Key 管理

侧栏“API Key 管理”支持填写备注、手动输入或安全随机生成 `sk-` Key、编辑备注、复制和临时显示完整 Key。备注持久保存在总控 SQLite 数据库，Key 使用现有 AES-256-GCM 密钥库加密；列表默认脱敏，审计日志不记录完整密钥。

随机生成规则与 CPA 一致：`sk-` 加 48 位大小写字母和数字，总长 51 个字符，使用密码学安全随机字节和拒绝采样避免取模偏差。总控前端按钮与服务端创建入口共用 `shared/api-key.js`；手动输入继续兼容 8–512 个无空白字符。

一个 Key 可绑定多个 CPA 实例，绑定不立即写入实例。点击“下发 Key”后逐实例读取客户端 Key 列表：相同 Key 已存在时不重复写入，否则追加，保留其他 Key，并重新读取确认。优先使用 CPA v8 的 `/v8/management/config/access/api-keys`，该路径返回 404 时兼容旧 `/v0/management/api-keys`。实例须运行且未锁定；操作与实例生命周期、升级和插件部署共用操作锁。CPA 原生面板的并发改动无法通过总控操作锁完全排除，请避免同时修改同一实例的 Key 列表。

“解绑并撤销”会从指定 CPA 移除完全匹配的 Key，重新读取确认已不存在后才解除绑定；其他实例不受影响。“删除”逐个撤销所有绑定实例，全部成功后才删除总控记录。失败时保留 Key、剩余绑定及错误状态，可点击“重试删除”；待删除 Key 禁止新增绑定和再次下发。下发失败项可点击“关闭报错”，保留绑定并恢复为待下发状态，之后可处理实例再重试。停止、锁定、无法连接的实例须先处理，再重试撤销。已不存在的 Key 视为撤销成功。仍有总控 Key 绑定的实例禁止直接删除，避免遗留绑定。

CPA 的空客户端 Key 列表会注销配置 Key 鉴权提供器，没有其他鉴权提供器时会放行请求。撤销后列表为空时，总控写入一个 `sk-controller-guard-` 前缀的 256 位随机保护 Key，验证后再解绑。该 Key 不向用户发放、不作为普通总控 Key 展示；它只保留实例的鉴权要求，避免旧 Key 删除后因匿名访问而继续可用。后续下发会保留该保护 Key。此行为依据 [CPA 配置鉴权提供器](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/access/config_access/provider.go) 和 [鉴权管理器](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/access/manager.go)；有自定义鉴权插件的实例需要另行验证插件策略。

Key 锁定状态持久保存。锁定后禁止编辑备注、绑定、解绑和删除，复制、查看及下发仍可使用；解锁需要总控管理员密码。实例备份会继承来源的总控 Key 绑定，防止复制配置后遗漏撤销；备份默认停止，自动备份还会锁定，删除 Key 前需要启动并解锁这些绑定备份，再执行撤销。未绑定到总控的独立 Key 或历史副本不在撤销范围内。

管理接口均需要管理员会话：`GET /api/keys`、`POST /api/keys`，以及 `POST /api/keys/:id/{note,bind,deploy,revoke,delete,lock,unlock,reveal,dismiss-failure}`。创建体为 `{ "note": "测试", "key": "sk-example123" }`，省略 `key` 由服务器生成；绑定、单实例撤销和关闭下发错误使用 `{ "instance_id": "实例ID" }`（绑定使用 `instances` 数组）；解锁体为 `{ "admin_password": "总控管理员密码" }`。下发、撤销和删除返回逐实例 `results`，删除必须检查 `deleted`，HTTP 200 不代表所有实例均成功。

真实 CPA 8.0.23 服务器验收完成创建、下发、查重、单实例撤销、部分删除失败重试、鉴权保护、备份副本撤销及总控重启持久化，15 项检查通过。该版本使用旧管理接口回退，空 Key 列表的 `null` 响应已兼容。详见 [验收报告](test-doc/test-evidence/2026-10-12/key-management-real.md)；复现脚本为 `scripts/verify-key-management.mjs`，只使用显式提供的 CPA 二进制及临时数据。

插件管理页面支持选择插件版本和多个实例统一安装或升级，当前内置 `cpa-key-billing`（Key Billing）。留空版本会解析 GitHub Release 的最新标签，直接下载发布包及 `checksums.txt`，不调用匿名 GitHub API，也不执行第三方安装脚本。校验通过后缓存一次，各实例持有独立的插件文件。

已锁定实例会跳过；自动备份全部完成后，运行中的实例逐个短暂重启并验证插件状态；停止中的实例保留停止状态，标记为待启动验证。默认保留原配置，勾选“安装后启用”才写入该插件的启用配置。配置为启用的插件要求注册、实际版本和启用状态验证通过；配置为未启用时验证文件发现、校验和及启用配置，允许没有注册或版本元数据，标记“已安装，未启用”。首个失败会回滚当前实例并取消后续部署，已经成功的实例保留新版本。总控重启时会恢复未完成的切换，回滚失败时页面提供“重试回滚”。回滚只恢复插件文件和 CPA 配置，不能逆转插件自身的数据迁移；完整旧数据仍保留在升级前创建的备份子实例中。

通用部署代码位于 `server/plugins.js`。其他采用同一 CPA 插件协议的 Linux amd64 `.so` 插件可通过经过审核的插件描述接入，描述提供插件 ID、GitHub 仓库、发布包名称和库文件名。当前适配顶层 `.so` 的 tar.gz 发布包及 SHA256 校验清单；不同包布局、配置协议或兼容性要求需要补充适配，并完成真实加载验证。当前真实验证环境为 CPA 8.0.23、Key Billing 1.3.19 / 1.3.20。

管理接口（均需总控管理员会话）：`GET /api/plugins`、`GET /api/plugins/jobs`、`POST /api/plugins/deploy`、`POST /api/plugins/recover`、`DELETE /api/plugins/jobs/:id`。部署请求示例：

```json
{"plugin":"cpa-key-billing","version":"1.3.20","instances":["cpa-实例ID"],"enable":false}
```

部署接口返回 202 和任务 ID，可查询任务记录跟踪进度。缓存保存在数据目录的 `plugin-cache/`，各实例的 `.plugin-backups/` 保留配置及旧库备份；备份包含管理配置，应按私有数据保护。管理页面只展示任务结果，不返回备份内容。

部署记录支持查看创建时间、状态和逐实例详情；完成或失败的记录可在确认后删除。排队、执行中和等待恢复的记录禁止删除（接口返回 409）。删除只移除数据库中的任务记录，保留已安装插件、实例配置和备份；操作写入审计日志。

- 新建实例默认开启 `plugins.enabled: true`。
- 总控通过 CPA 本机管理 API 获取 Codex、Claude 和 Kimi OAuth 配额，默认每 6 小时刷新；Kimi 支持周限额、滚动窗口和接口提供的月限额。总控不读取认证目录、不保存 OAuth Token，也不调用额度重置接口。
- 额度观察位于 CPA 实例管理下方，显示周限额、模型窗口、百分比和进度条；额度观察与实例额度详情中的账户重置时间使用醒目的深色大字，实例卡片同时按账户、窗口显示重置日期和时间。查询失败会保留上一次成功快照并显示失败状态。
- 定时额度通知按 CPA 实例、OAuth 账户和额度窗口附带额度刷新时间（UTC+8）；接口未提供有效时间时会明确标注未提供。
- “发送测试消息”会实时读取对应实例 OAuth 账户的周额度和重置时间，沿用正常告警格式，仅在抬头加上【测试消息】。全局测试使用已保存的全局目标实例；测试不受额度阈值、工作时间和告警冷却限制，也不会占用正常告警的冷却时间。
- 每个实例使用自己的 CPA 二进制副本。升级、回滚和总控重启会保留实例的期望状态；手动停止的实例不会被自动启动。
- 运行日志和审计日志保存在控制数据库中，审计记录不会保存密码、Webhook Token 或 OAuth Token。

详细部署说明见 [`deploy/README.md`](deploy/README.md)。功能验收记录和兼容性说明见 [`test-doc/functional-test-status.md`](test-doc/functional-test-status.md) 与 [`test-doc/cpa-compatibility.md`](test-doc/cpa-compatibility.md)。
