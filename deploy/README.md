# Linux amd64 部署

生产目标是 Linux amd64。总控是 Node.js 服务，每个 CPA 子实例是独立的 systemd 服务；总控退出或崩溃不会传播到已经运行的实例。源码树在 WSL 中由 `start.sh` 启动时会使用脱离的 Linux 本地进程运行时，生产安装仍必须使用下方的 systemd 部署。

目标机需要 Node.js 22.5 或更新版本，并且 `node:sqlite` 可用。准备包含 `server/`、`web/dist/`、`package.json` 的发布目录后，以 root 身份执行：

```sh
cp deploy/controller.env.example /tmp/controller.env
# 可选：编辑 /tmp/controller.env，覆盖默认的 MULTI_CPA_ADMIN_PASSWORD=admin
install -d -m 0755 /etc/multi-cliproxyapi
install -m 0600 /tmp/controller.env /etc/multi-cliproxyapi/controller.env
./deploy/install.sh /path/to/multi-cliproxyapi
```

`release/` 中的单文件二进制发布包同时提供 `install.sh`、`start.sh`、`stop.sh` 和 `uninstall.sh`。这组脚本不要求目标机另行安装 Node.js：`install.sh` 会安装二进制，注册总控 systemd 服务、`multi-cpa@.service` 模板和 polkit 规则，并通过 `--runtime systemd` 启动总控；数据默认保存在 `/opt/mutli-cliproxycpa-data`，可用 `MULTI_CPA_DATA_DIR` 覆盖。`start.sh` 与 `stop.sh` 只操作总控，已运行的子实例保持独立。`uninstall.sh` 会先确认停止并移除服务和二进制，再要求输入完整数据路径确认永久删除数据；拒绝第二次确认时会保留数据。直接复制二进制并使用 `nohup` 时，二进制默认采用脱离的本地子进程运行时，并将数据保存在 `/opt/mutli-cliproxycpa-data`；只有在已完成 systemd 注册后才设置 `MULTI_CPA_RUNTIME=systemd` 或传入 `--runtime systemd`。

上面这一段针对 `release/` 单文件包；源码树中的 `deploy/install.sh /path/to/release` 也默认把数据放到 `/opt/mutli-cliproxycpa-data`，并支持用 `MULTI_CPA_DATA_DIR` 指定绝对路径。

安装前后的源码测试也可以使用项目根目录的 `./start.sh` 和 `./stop.sh`；生产环境优先使用这两个脚本自动发现的 `multi-cliproxyapi.service`。

安装脚本更新服务代码、Node.js 运行时副本和 systemd 单元，不删除既有实例数据。运行时复制到 `${PREFIX:-/usr/local}/lib/multi-cliproxyapi/runtime/node`，单元根据 PREFIX 生成路径；不依赖 `/usr/bin/node` 或登录 shell 的 PATH，避免 NVM 等用户目录被 `ProtectHome=true` 隔离后无法启动。更新 Node.js 后重新运行安装脚本即可更新该副本。首次登录用户名固定为 `admin`；未设置环境变量时默认密码为 `admin`，登录后点击管理员头像进入“管理员设置”即可修改。之后修改环境变量不会覆盖数据库中的密码。

控制器默认监听 `0.0.0.0:8787`，请在局域网防火墙或反向代理中限制来源。生产部署应在反向代理启用 HTTPS，并在环境文件设置 `MULTI_CPA_SECURE_COOKIES=true`。

CPA 版本由总控 Web 页面下载、校验并存入数据目录的 `versions/<tag>`；第一次启动且没有可用版本时会尝试下载 latest，网络失败不会阻止总控启动，之后可从版本页重试。创建或启动实例时，总控会把对应版本复制到数据目录的 `instances/<id>/bin/cli-proxy-api`，每个实例执行自己的普通文件副本，不使用符号链接或共享可执行文件。升级和回滚会为每个实例准备目标版本副本后再启动；`versions/current` 只保留作版本激活兼容指针。实例服务使用 `multi-cpa@<id>.service`，实例目录为数据目录的 `instances/<id>`。删除实例会停止进程、注销服务并清理该目录，但不会删除版本安装缓存。

开机时总控先恢复未完成的升级状态；没有升级屏障时，只启动数据库中期望状态为 `running` 的实例。手动停止的实例不会被自动启动。不要直接 enable 具体的 `multi-cpa@` 实例，实例期望状态由总控保存。

控制器和 CPA 子服务均使用 `multi-cpa` 受限账号。polkit 规则只允许控制器对 `multi-cpa@<id>.service` 执行 start、stop、restart、status，不开放任意系统命令。

Codex 和 Claude 配额默认通过子实例的 `/v0/management/api-call` 获取，使用管理 API 返回的 `auth_index` 选择账户，由 CPA 在内部替换 `$TOKEN$`。总控不读取认证目录，不保存 OAuth Token，也不调用任何额度重置接口。其他提供商标记为不支持；如目标 CPA 提供经过验证的统一配额接口，可以设置 `MULTI_CPA_QUOTA_PATH` 覆盖默认适配器，该接口应返回 `values` / `quotas` 或 `remaining` / `total` 格式。请求协议依据官方管理页面校验，真实 OAuth 账户验收状态见 `test-doc/functional-test-status.md`。

控制器日志写入 systemd journal，CPA 日志位于实例目录的 `logs/` 下。建议启用 journal 保留策略，并为数据目录下 `instances/*/logs/*.log` 配置 logrotate。

备份前先停止总控以保持 SQLite 快照一致；这不会停止已运行的 CPA 子实例：

```sh
systemctl stop multi-cliproxyapi.service
DATA_DIR=/path/to/release/.multi-cliproxyapi
tar --xattrs --acls --numeric-owner -C "$(dirname "$DATA_DIR")" -czf /var/backups/multi-cliproxyapi-$(date +%Y%m%d%H%M%S).tar.gz "$(basename "$DATA_DIR")"
systemctl start multi-cliproxyapi.service
```

恢复时先停止总控，确认备份来源可信后解压回数据目录的父目录，检查 `multi-cpa` 用户权限、`versions/current` 指针和 `control.db`，再启动总控。卸载服务时移除 `/usr/local/lib/multi-cliproxyapi`、systemd 单元、polkit 规则和环境文件，保留 `.multi-cliproxyapi` 即可保留实例数据。

目标发行版上的 systemd、polkit、主机重启和 CPA 配额接口仍需集成验收；单元测试不替代真实主机验收。

卸载前会检查所有 CPA 子服务和进程（包括旧目录的实例）；存在运行中或启停中的实例、或无法确认状态时拒绝卸载。请先显式停止实例，卸载脚本不会自动停止子实例。
