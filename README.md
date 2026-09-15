# Multi CLIProxyAPI Controller

Multi CLIProxyAPI Controller 是一个运行在 Linux amd64 上的总控服务，用于管理同一台主机上的多个 CLIProxyAPI（CPA）实例。每个实例拥有独立的目录、CPA 二进制、配置、认证文件、日志和端口；总控重启或崩溃不会停止已经运行的子实例。

项目提供管理 Web 页面和 HTTP API。管理员默认账号是 `admin`，首次密码也是 `admin`；登录后请立即修改密码。

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

源码测试服务默认使用项目目录下的 `.local-data`。可用以下变量覆盖数据目录、监听地址和日志路径：

```sh
MULTI_CPA_DATA_DIR=/tmp/multi-cpa-data MULTI_CPA_LISTEN=127.0.0.1:8787 ./start.sh
```

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
推送形如 `v0.1.0` 的 Git tag 后，GitHub Actions 会在 Linux amd64 runner 上运行测试、构建同样的发布包，并把包含二进制、校验文件和四个部署脚本的 `.tar.gz` 上传到 GitHub Release。

## 功能说明

- 新建实例默认开启 `plugins.enabled: true`。
- 总控通过 CPA 本机管理 API 获取 Codex 和 Claude OAuth 配额，默认每 6 小时刷新；总控不读取认证目录、不保存 OAuth Token，也不调用额度重置接口。
- 配额页面显示周限额、模型窗口、百分比、进度条和重置时间；查询失败会保留上一次成功快照并显示失败状态。
- 每个实例使用自己的 CPA 二进制副本。升级、回滚和总控重启会保留实例的期望状态；手动停止的实例不会被自动启动。
- 运行日志和审计日志保存在控制数据库中，审计记录不会保存密码、Webhook Token 或 OAuth Token。

详细部署说明见 [`deploy/README.md`](deploy/README.md)。功能验收记录和兼容性说明见 [`test-doc/functional-test-status.md`](test-doc/functional-test-status.md) 与 [`test-doc/cpa-compatibility.md`](test-doc/cpa-compatibility.md)。
