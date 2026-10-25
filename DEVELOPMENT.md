# 开发文档

本文面向需要修改源码、接入管理 API、验证兼容性或构建发布包的开发者。安装和日常操作请先阅读 [使用文档](README.md)；源码的 systemd 部署见 [部署参考](deploy/README.md)。

## 代码结构

| 目录 | 用途 |
| --- | --- |
| `server/` | 总控 HTTP API、实例生命周期、存储、配额、插件和 Key 管理 |
| `web/` | React 管理页面及前端测试 |
| `shared/` | 前后端共享逻辑 |
| `scripts/` | 打包与集成验证脚本 |
| `deploy/` | systemd、polkit、源码安装和发布脚本模板 |
| `release/` | 单文件发布包的输出目录及部署脚本 |
| `test-doc/` | 功能验收记录与 CPA 兼容性说明 |

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

后端测试可在干净检出后直接运行 `npm test`，无需预先安装或构建前端。HTTP 静态路由测试使用独立的临时页面及资源，结束后自动清理；发布流水线保持先测试、再构建的顺序。
推送形如 `v26.10.0` 的 Git tag 后，GitHub Actions 会在 Linux amd64 runner 上运行测试、构建同样的发布包，并把包含二进制、校验文件和四个部署脚本的 `.tar.gz` 上传到 GitHub Release。

## 版本规则

应用版本采用 `YY.MM.PATCH` 的日历版本规则。当前版本为 `26.10.13`；同一个月内的修复和小改动递增最后一位。Git tag 使用 `v` 前缀，例如 `v26.10.13`。更新版本时，同步修改根目录与 `web/` 下的 `package.json`、`package-lock.json`（顶层及根包版本），以及文档中的当前版本。

版本保持三个数字段，与现有 npm、构建和发布工具兼容；若项目维护至 2100 年前，应提前规划迁移为 `YYYY.MM.PATCH`。

## 管理 API 与实现约束

以下记录实例、API Key 和插件集成中的接口及关键行为；管理接口均需要总控管理员会话。接口定义以 `server/http.js` 为准。

### 实例锁定、备份与升级验证

实例卡片支持“锁定实例 / 解锁实例”，锁定状态在总控重启后保留。锁定后禁止重启、停止、修改配置、备份和删除；统一升级时只处理未锁定实例，已锁定实例保持不变；如果所有实例都已锁定，统一升级会拒绝执行，请先解锁至少一个实例。查看状态、刷新配额和启动已停止实例仍可使用。对应接口为 `POST /api/instances/:id/lock` 和 `POST /api/instances/:id/unlock`，两者都需要管理员登录；锁定无需额外密码，解锁必须在请求体中提供总控管理员密码 `admin_password`。两种操作都会记录到审计日志。

统一升级会为原本运行的实例生成独立的随机临时测试 Key，写入后调用 `/v1/models` 验证服务。CPA 保存配置与运行时鉴权刷新之间可能存在延迟；新 Key 返回 HTTP 401 时，总控最多探测 20 次、间隔 500 毫秒，整个验证阶段限时 30 秒。持续拒绝、HTTP 403 或其他异常仍视为升级失败并回滚。验证结束或取消后会移除本次临时 Key 并重新读取确认，保留其他 Key。此等待依据 [CPA 管理配置保存后异步重载的实现](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.23/internal/api/handlers/management/handler.go)。

实例卡片也提供“备份”，可填写新名称和新端口手动保存为子实例：`POST /api/instances/:id/backup`，请求体为 `{"name":"cpa-backup","port":18322}`。运行中的源实例会在复制期间短暂停止，复制完成或失败后恢复运行；停止的源实例保持停止。复制实例目录中的独立文件，重新设置监听端口和配置中的实例内路径；历史日志、进程 PID 和旧插件回滚目录不复制。实例目录外的配置数据路径、符号链接和特殊文件不支持复制，遇到时中止。备份来源及触发原因在实例列表显示，插件部署记录还显示对应备份的名称和端口。

### API Key 与分组

随机生成规则与 CPA 一致：`sk-` 加 48 位大小写字母和数字，总长 51 个字符，使用密码学安全随机字节和拒绝采样避免取模偏差。总控前端按钮与服务端创建入口共用 `shared/api-key.js`；手动输入继续兼容 8–512 个无空白字符。

一个 Key 可绑定多个 CPA 实例，绑定不立即写入实例。点击“下发 Key”后逐实例读取客户端 Key 列表：相同 Key 已存在时不重复写入，否则追加，保留其他 Key，并重新读取确认。优先使用 CPA v8 的 `/v8/management/config/access/api-keys`，该路径返回 404 时兼容旧 `/v0/management/api-keys`。实例须运行且未锁定；操作与实例生命周期、升级和插件部署共用操作锁。CPA 原生面板的并发改动无法通过总控操作锁完全排除，请避免同时修改同一实例的 Key 列表。

CPA 的空客户端 Key 列表会注销配置 Key 鉴权提供器，没有其他鉴权提供器时会放行请求。撤销后列表为空时，总控写入一个 `sk-controller-guard-` 前缀的 256 位随机保护 Key，验证后再解绑。该 Key 不向用户发放、不作为普通总控 Key 展示；它只保留实例的鉴权要求，避免旧 Key 删除后因匿名访问而继续可用。后续下发会保留该保护 Key。此行为依据 [CPA 配置鉴权提供器](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/access/config_access/provider.go) 和 [鉴权管理器](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/access/manager.go)；有自定义鉴权插件的实例需要另行验证插件策略。

管理接口均需要管理员会话：`GET /api/keys`、`POST /api/keys`，以及 `POST /api/keys/:id/{note,bind,deploy,revoke,delete,lock,unlock,reveal,dismiss-failure}`。创建体为 `{ "note": "测试", "key": "sk-example123" }`，省略 `key` 由服务器生成；绑定使用 `{ "instances": ["实例ID"] }`，单实例撤销和关闭下发错误使用 `{ "instance_id": "实例ID" }`；解锁体为 `{ "admin_password": "总控管理员密码" }`。下发、撤销和删除返回逐实例 `results`，删除必须检查 `deleted`，HTTP 200 不代表所有实例均成功。

`GET /api/keys` 同时返回 `groups`，Key 记录包含 `group_id`（未分组为 `null`）。分组接口同样需要管理员会话：`GET /api/key-groups`、`POST /api/key-groups` 和 `POST /api/key-groups/:id/{update,deploy,revoke,delete}`。创建或更新组使用 `{ "name": "生产环境", "key_ids": ["Key ID"] }`；更新时省略 `key_ids` 保留原成员，传空数组清空组。批量下发和批量撤销均使用 `{ "instances": ["实例ID"] }`，返回的 `results` 包含 `key_id`、`instance_id` 和 `status`，应逐项检查失败。批量撤销会从所选实例移除组内已绑定的 Key，成功后解除对应绑定，保留总控 Key 和组归属；“未分组”的操作 ID 为 `ungrouped`。创建 Key 可附带 `group_id`，单个 Key 调组使用 `POST /api/keys/:id/group`，请求体为 `{ "group_id": "分组ID" }`，传 `null` 移回“未分组”。

### 插件集成

通用部署代码位于 `server/plugins.js`。其他采用同一 CPA 插件协议的 Linux amd64 `.so` 插件可通过经过审核的插件描述接入，描述提供插件 ID、GitHub 仓库、发布包名称和库文件名。当前适配顶层 `.so` 的 tar.gz 发布包及 SHA256 校验清单；不同包布局、配置协议或兼容性要求需要补充适配，并完成真实加载验证。当前真实验证环境为 CPA 8.0.23、Key Billing 1.3.19 / 1.3.20。

管理接口（均需总控管理员会话）：`GET /api/plugins`、`GET /api/plugins/jobs`、`POST /api/plugins/deploy`、`POST /api/plugins/recover`、`DELETE /api/plugins/jobs/:id`。部署请求示例：

```json
{"plugin":"cpa-key-billing","version":"1.3.20","instances":["cpa-实例ID"],"enable":false}
```

部署接口返回 202 和任务 ID，可查询任务记录跟踪进度。缓存保存在数据目录的 `plugin-cache/`，各实例的 `.plugin-backups/` 保留配置及旧库备份；备份包含管理配置，应按私有数据保护。管理页面只展示任务结果，不返回备份内容。

任务记录只允许删除已完成或失败的任务；排队、执行中和等待恢复的任务返回 HTTP 409。删除记录保留已安装插件、实例配置和备份，并写入审计日志。

## 验证与兼容性

真实 CPA 8.0.23 服务器验收完成创建、下发、查重、单实例撤销、部分删除失败重试、鉴权保护、备份副本撤销及总控重启持久化，15 项检查通过。该版本使用旧管理接口回退，空 Key 列表的 `null` 响应已兼容。详见 [验收报告](test-doc/test-evidence/2026-10-12/key-management-real.md)；复现脚本为 `scripts/verify-key-management.mjs`，只使用显式提供的 CPA 二进制及临时数据。

- [功能验收状态](test-doc/functional-test-status.md)
- [CPA 兼容性说明](test-doc/cpa-compatibility.md)

历史验收记录对应各自标注的版本和环境，不能替代当前变更的测试。systemd、polkit、重启恢复和真实 CPA 插件加载需要在 Linux 主机上验证。
