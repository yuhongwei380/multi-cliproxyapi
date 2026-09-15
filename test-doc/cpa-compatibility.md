# CPA 兼容性记录

本记录用于锁定总控对 CPA 的调用边界。实际部署前必须将 `CPA_VERSION` 固定为已验证的 release tag；不能依赖 GitHub 的 `latest` 运行。

## 已锁定的基础契约

- 目标生产资产：Linux amd64。
- 配置文件通过 `--config /absolute/path/config.yaml` 指定。
- 管理基路径：`/v0/management`。
- 管理请求通过 `Authorization: Bearer <management-key>` 认证；子实例配置中的明文密钥由 CPA 在启动时处理/哈希化。
- 管理页面路径：`/management.html`。`remote-management.disable-control-panel` 必须为 `false`，首次安装时应预置或验证页面资源。
- 子实例默认监听 `0.0.0.0`，并将 `remote-management.allow-remote` 固定为 `true`；总控在实例启动和期望状态恢复时迁移旧配置。
- 账户发现：`GET /v0/management/auth-files`，总控只读取账户元数据，不读取 auth JSON，也不保存 OAuth token。

## 配额查询结论

CPA 管理 API 文档提供账户元数据、用量队列和经账户认证的 `/api-call`，但没有一个可对所有 OAuth 提供商统一返回“剩余配额”的标准端点。总控客户端因此将相对路径配额端点作为可配置适配器；默认 `/v0/management/quota` 只有在目标 CPA 版本和提供商实测返回合法快照后才能标记为支持。

`404`、`501` 或提供商明确表示不支持时，界面显示“不支持”；超时、认证失败和上游错误显示“查询失败”，并保留上次成功快照。请求用量统计不能推算剩余配额。

## 支持矩阵

| 能力 | 状态 | 证据/限制 |
|---|---|---|
| 账户列表及 `auth_index` | 已实现客户端与脱敏 fixture | CPA 管理 API `GET /auth-files`；需按目标 tag 实测 |
| 子实例管理认证 | 已实现客户端与单测 | Bearer 管理密钥；远程访问还受 CPA 配置限制 |
| 管理页面 | 已实现配置生成与静态资源检查入口 | 资源下载和版本绑定需部署时实测 |
| 统一 OAuth 剩余配额 | 未确认统一接口 | 需逐提供商/版本验证；默认端点不宣称已支持 |
| 请求用量统计 | 可读取但不作为剩余配额 | 只能展示为独立的请求统计功能 |

## 脱敏样例

`testdata/cpa/auth-files.json` 和 `testdata/cpa/quota.json` 只包含合成账户及数值。不得把真实邮箱、Token、管理密码或 auth 文件提交到仓库。
