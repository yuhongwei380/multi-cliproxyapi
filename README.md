# Multi CLIProxyAPI Controller

Multi CLIProxyAPI Controller 是一个运行在 Linux amd64 上的总控服务，用于管理同一台主机上的多个 CLIProxyAPI（CPA）实例。每个实例拥有独立的目录、CPA 二进制、配置、认证文件、日志和端口；总控重启或崩溃不会停止已经运行的子实例。

本项目基于https://github.com/router-for-me/CLIProxyAPI 作为下游进行开发，不涉及修改 cliproxyapi的任何代码。

项目提供管理 Web 页面和 HTTP API。管理员默认账号是 `admin`，首次密码也是 `admin`；登录后请立即修改密码。

实例卡片支持“锁定实例 / 解锁实例”，锁定状态在总控重启后保留。锁定后禁止重启、停止、修改配置和删除；统一升级时只处理未锁定实例，已锁定实例保持不变；如果所有实例都已锁定，统一升级会拒绝执行，请先解锁至少一个实例。查看状态、刷新配额和启动已停止实例仍可使用。对应接口为 `POST /api/instances/:id/lock` 和 `POST /api/instances/:id/unlock`，两者都需要管理员登录；锁定无需额外密码，解锁必须在请求体中提供总控管理员密码 `admin_password`。两种操作都会记录到审计日志。

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

构建过程会重新生成 `web/dist`，并清理打包 staging 和前端依赖目录。
推送形如 `v26.10.0` 的 Git tag 后，GitHub Actions 会在 Linux amd64 runner 上运行测试、构建同样的发布包，并把包含二进制、校验文件和四个部署脚本的 `.tar.gz` 上传到 GitHub Release。

## 版本规则

应用版本采用 `YY.MM.PATCH` 的日历版本规则。当前版本为 `26.10.1`；同一个月内的修复和小改动递增最后一位，例如从 `26.10.0` 更新到 `26.10.1`。Git tag 使用 `v` 前缀，例如 `v26.10.1`。

这个规则比无语义的 `0.x` 更容易判断发布时间，同时仍符合 SemVer 的三个数字段，现有 npm、构建和发布工具可以继续使用。两位年份在 2099 年之后会产生歧义；如果项目需要长期维护，应在进入 2100 年前切换为 `YYYY.MM.PATCH`，当前阶段保留 `YY.MM.PATCH` 更简洁。

## 功能说明

插件管理页面支持选择插件版本和多个实例统一安装或升级，当前内置 `cpa-key-billing`（Key Billing）。留空版本会解析 GitHub Release 的最新标签，直接下载发布包及 `checksums.txt`，不调用匿名 GitHub API，也不执行第三方安装脚本。校验通过后缓存一次，各实例持有独立的插件文件。

已锁定实例会跳过；运行中的实例逐个短暂重启并验证插件注册、版本与启用状态；停止中的实例保留停止状态，标记为待启动验证。默认保留原配置，勾选“安装后启用”才写入该插件的启用配置。首个失败会回滚当前实例并取消后续部署，已经成功的实例保留新版本。总控重启时会恢复未完成的切换，回滚失败时页面提供“重试回滚”。回滚只恢复插件文件和 CPA 配置，不能逆转插件自身的数据迁移。

通用部署代码位于 `server/plugins.js`。其他采用同一 CPA 插件协议的 Linux amd64 `.so` 插件可通过经过审核的插件描述接入，描述提供插件 ID、GitHub 仓库、发布包名称和库文件名。当前适配顶层 `.so` 的 tar.gz 发布包及 SHA256 校验清单；不同包布局、配置协议或兼容性要求需要补充适配，并完成真实加载验证。当前真实验证环境为 CPA 8.0.23、Key Billing 1.3.19 / 1.3.20。

管理接口（均需总控管理员会话）：`GET /api/plugins`、`GET /api/plugins/jobs`、`POST /api/plugins/deploy`、`POST /api/plugins/recover`、`DELETE /api/plugins/jobs/:id`。部署请求示例：

```json
{"plugin":"cpa-key-billing","version":"1.3.20","instances":["cpa-实例ID"],"enable":false}
```

部署接口返回 202 和任务 ID，可查询任务记录跟踪进度。缓存保存在数据目录的 `plugin-cache/`，各实例的 `.plugin-backups/` 保留配置及旧库备份；备份包含管理配置，应按私有数据保护。管理页面只展示任务结果，不返回备份内容。

部署记录支持查看创建时间、状态和逐实例详情；完成或失败的记录可在确认后删除。排队、执行中和等待恢复的记录禁止删除（接口返回 409）。删除只移除数据库中的任务记录，保留已安装插件、实例配置和备份；操作写入审计日志。

- 新建实例默认开启 `plugins.enabled: true`。
- 总控通过 CPA 本机管理 API 获取 Codex、Claude 和 Kimi OAuth 配额，默认每 6 小时刷新；Kimi 支持周限额、滚动窗口和接口提供的月限额。总控不读取认证目录、不保存 OAuth Token，也不调用额度重置接口。
- 配额页面显示周限额、模型窗口、百分比、进度条和重置时间；查询失败会保留上一次成功快照并显示失败状态。
- 每个实例使用自己的 CPA 二进制副本。升级、回滚和总控重启会保留实例的期望状态；手动停止的实例不会被自动启动。
- 运行日志和审计日志保存在控制数据库中，审计记录不会保存密码、Webhook Token 或 OAuth Token。

详细部署说明见 [`deploy/README.md`](deploy/README.md)。功能验收记录和兼容性说明见 [`test-doc/functional-test-status.md`](test-doc/functional-test-status.md) 与 [`test-doc/cpa-compatibility.md`](test-doc/cpa-compatibility.md)。
