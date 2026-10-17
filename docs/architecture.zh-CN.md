# Henna 架构

**[English](architecture.md) | [简体中文](architecture.zh-CN.md)**

## 一句话边界

> **邮件内容绝不经过 Henna 服务端。** 正文、附件、列表查询、搜索索引都不例外。

下面所有内容都是这句话的展开。

---

## 数据流

```
                      ┌──────────────────────────────────────┐
                      │           浏览器（客户端）            │
                      │  • 持有 JMAP API Token                │
                      │  • 邮件在沙盒 iframe 里渲染           │
                      │  • 本地 IndexedDB 索引                │
                      │  • 搜索在本地执行                     │
                      └───┬──────────────────────────┬───────┘
                          │                          │
              (A) 邮件    │                          │  (B) 身份、
                  流量    │                          │      设置、审计
                          ▼                          ▼
        ┌─────────────────────────────┐   ┌──────────────────────────┐
        │      上游邮件服务器          │   │      Henna 服务端         │
        │   JMAP（RFC 8620/8621）     │   │  （Workers 或 Node.js）   │
        │   或 IMAP/SMTP 降级          │   │  • GitHub OAuth           │
        └─────────────────────────────┘   │  • 口令 / 邮箱验证码       │
                                          │  • TOTP 与恢复码           │
        ┌─────────────────────────────┐   │  • 凭证加密               │
        │   对象存储（R2 / S3 兼容）   │◄──┤  • 预签名 URL 签发         │
        │   附件字节                   │   │  • 设置 / 审计            │
        └─────────────────────────────┘   └────────────┬─────────────┘
                                                       │
                                                       ▼
                                            ┌──────────────────────┐
                                            │     PostgreSQL       │
                                            │  （CF 上用 Hyperdrive）│
                                            └──────────────────────┘
```

**(A)** 承载邮件。**(B)** 承载身份与配置。两者不相交。服务端与上游之间没有用于
消息数据的箭头，PostgreSQL 里也没有能装消息的字段。

### 为什么这不只是"约定"

它是结构性强制的：

- `db/schema.ts` 里没有消息、正文、附件或索引的表。加一张会是一次显眼的
  schema 变更，而不是一次重构。
- 服务端没有任何获取消息的代码路径，没有函数可调。
- CSP 的 `connect-src` 只为白名单里的上游源放开，是为了让浏览器能连邮件服务器，
  而不是为了让 Henna 连。

---

## JMAP 路径（主路径）

1. 用户添加 JMAP 账户：会话 URL 加 API Token。
2. Token 用 AES-256-GCM 加密存储。浏览器在会话期间也持有它。
3. 浏览器直接调用 JMAP 端点。Henna 服务端不在请求路径上，因此无东西可记。

```
浏览器 ──Bearer token──► https://jmap.example.com/jmap
```

降级发现使用 `/.well-known/jmap`，仅限实例白名单内的主机 —— Henna 不会去探测
用户随手填的主机名。

## IMAP/SMTP 路径（降级）

裸 socket 在 Cloudflare Workers 上不可能，所以这条路径被诚实地限定范围：

| 运行时 | IMAP/SMTP |
| --- | --- |
| Cloudflare Workers | 不可用。只走 JMAP，界面会说明。 |
| 自托管 Node.js | 可用。端口 993/587/465，25 端口拒绝。 |

在可用的地方，凭证只在单次连接期间于内存中解密，用完即弃。它从不落盘、从不入日志，
解密操作本身被限流并写入审计。

---

## 附件与对象存储

附件走预签名 URL，这是唯一让"附件不落地"与"用户需要附件"同时成立的方案。

```
浏览器 ──► Henna：请给我上传 URL（只有文件名 + 大小）
Henna  ──► DAL：校验大小、生成键名、签名、写审计
浏览器 ──► 存储桶：PUT 文件（Henna 不在路径上）
```

- 默认 **Cloudflare R2**，同时支持任意 **S3 兼容**服务（AWS S3、MinIO、
  Backblaze B2、Hetzner、Wasabi）。
- 签名用 AWS SigV4，基于 WebCrypto 实现，因此 Workers 与 Node.js 通用，
  也不需要引入 AWS SDK。
- 键名形如 `users/<userId>/attachment/<uuid>/<安全文件名>`，由服务端生成。
- 每次签发都限流并审计；归属在签发前与下载前各校验一次。

详见 [storage.zh-CN.md](storage.zh-CN.md)。

---

## 认证

### 三种方式，且只有三种

```
┌─────────────┐   ┌──────────────┐   ┌────────────────┐
│    密码      │   │ GitHub OAuth │   │   邮箱验证码    │
│   scrypt     │   │  授权码流程   │   │  6 位 / 10 分钟 │
└──────┬──────┘   └──────┬───────┘   └───────┬────────┘
       │                 │                   │
       └─────────────────┼───────────────────┘
                         ▼
              ┌───────────────────────┐
              │  requireMfaIfRequired │
              │  （策略 × 角色）       │
              └──────────┬────────────┘
                         ▼
              ┌───────────────────────┐
              │  会话（标识已轮换）     │
              └───────────────────────┘
```

**OAuth 只支持 GitHub，没有别的。** Henna 不会接入 Google、Microsoft、通用 OIDC
或邮箱服务商的 OAuth。这是设计决定而非疏漏：每多一个提供方，就多一套必须正确
建模的身份语义，而"已验证邮箱"在每一家含义都不同。

GitHub 相关的关键控制：

- 授权码流程。仅在端到端验证通过时才启用 PKCE —— Henna 不会发一个自己不去校验的
  `code_challenge`，那是安全表演。
- 替代补偿控制：一次性 `state` 恒定时间比较、`redirect_uri` 精确匹配、服务端
  保管 `client_secret`、授权码一次性交换。
- `github_user_id` 是绑定键。邮箱和 login 都能被主人改掉，都不能用来标识账号。
- 只接受 **primary 且 verified** 的邮箱，其余一律拒绝。
- 邮箱命中已有账号时**不**静默接管。

### 第二因素

| 策略 | 普通用户 | 管理员 |
| --- | --- | --- |
| `optional` | 可选 | **必须** |
| `admin-only`（默认） | 可选 | **必须** |
| `required` | **必须** | **必须** |

管理员无论设置如何，至少受 `admin-only` 约束，且不能关闭自己的 TOTP。

TOTP：±1 个 30 秒步长、防重放（记录上次使用的步长）、密钥加密存储、校验限流。

恢复码：一次 10 个，只显示一次，只存摘要，一次性使用，用掉过半后提示重新生成。

---

## 授权

决策只发生在 DAL。

```
Server Action ─┐
Route Handler ─┼──► requirePrincipal() ──► requireMfaIfRequired()
Server Component┘         │                        │
                          │                        │
                          ▼                        ▼
                   requireAdmin()          返回最小 DTO
                   requireOwnershipOrAdmin()
```

- 路由、页面和组件都不自行检查角色。
- DAL 函数返回最小 DTO —— 是 `UserDto` 而不是数据库行 —— 因此口令哈希或 TOTP
  密文不可能意外渲染到页面上。
- 拒绝发生在判定点并写入审计。

每次请求都会从 PostgreSQL 重新读取会话。仅凭 JWT 签名永远不够：吊销会话立即生效。

---

## 配置

两层，是有意为之。

| 层 | 值 | 谁改 |
| --- | --- | --- |
| 根（环境变量） | `DOMAIN`、`ADMIN`、`jwt_secret`、`HENNA_CREDENTIAL_KEY` | 重新部署 |
| 实例（数据库） | 认证开关、OAuth 凭证、Resend、存储桶、TOTP 策略、注册控制、口令规则、验证码有效期、过渡动画 | `/admin/settings` |

拿到管理员会话的攻击者改不了根配置，因为改它需要重新部署。所有应用代码统一通过
`lib/config` 读配置 —— 业务逻辑里不出现 `process.env`。

实例层的密钥（GitHub Client Secret、Resend Key、存储桶密钥）存在独立加密字段里，
不在 JSON 配置块中，因此导出那一行也泄露不出东西。

---

## 审计

只追加，数据库触发器会拒绝 `UPDATE` 与 `DELETE`，即使某个角色被误授权也一样。

记录范围：登录成功与失败、拒绝、非白名单尝试、验证码发送与校验、密码重置、
TOTP 全生命周期、恢复码、凭证解密、存储 URL 签发、管理操作、密钥轮换。

从不记录：口令、验证码、TOTP 值、解密后的凭证。IP 与 User-Agent 只存哈希。

---

## 渲染与 CSP

邮件 HTML 经过两道独立屏障：

1. **净化** —— 标签与属性白名单，剔除事件处理器、`javascript:` URL 与远程资源。
2. **沙盒** —— iframe 带 `sandbox="allow-popups allow-popups-to-escape-sandbox"`，
   CSP 为 `default-src 'none'` 加 `script-src 'none'`。

`allow-scripts` 与 `allow-same-origin` 绝不共存。两者同时存在会让邮件触及 Henna
自身的源；分开则都不能。

页面 CSP 独立且严格：`default-src 'self'`，无 per-request nonce 的内联脚本一律禁止，
`form-action 'self' https://github.com`，`connect-src` 只对白名单上游源与存储桶源放开。

---

## 页面过渡

- 简单路由切换用 **View Transitions API** —— App Router 原生支持，无额外依赖，
  适合淡入与轻量共享元素过渡。
- 需要编排的过渡（列表进入阅读器、模态层叠）用 **Framer Motion 的
  `AnimatePresence`**，等退出动画完成再进入，避免布局抖动。
- 150–300 ms，缓动自然。
- 尊重 `prefers-reduced-motion`：直接跳过动画，不是把时长压成一个象征值。
- 全在客户端执行。过渡不会阻塞表单提交、安全校验或服务端渲染。
- 实例级可开关，用户级也可关。

---

## 测试策略

| 层 | 工具 | 覆盖 |
| --- | --- | --- |
| 纯规则 | Vitest | 加密、scrypt、TOTP 窗口与重放、恢复码、验证码有效期、DAL 策略、Zod 边界、配置解析、SigV4 与键名 |
| 边界 | Playwright | 三种登录、密码重置、验证码过期/重放/超限、非白名单 GitHub 拒绝、CSRF 403、管理员强制 TOTP、凭证解密审计 |
| 类型 | `tsc --noEmit` | strict 模式，无 `any` |
| 风格 | Biome | 检查与格式化，`noExplicitAny` 视为错误 |

CI 四项全跑。任一失败阻止合并，在 `main` 上还会阻止部署。
