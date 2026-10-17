# Henna

**[English](README.md) | [简体中文](README.zh-CN.md)**

Henna 是一个安全优先、可自托管的 Webmail 前端。它是邮件**客户端**与一层很薄的
凭证协调层 —— 不是邮件仓库。你的邮件正文、附件与搜索索引永远不会落到 Henna 的服务端上。

基于 Next.js（App Router）、TypeScript strict 模式、Tailwind CSS、PostgreSQL +
Drizzle ORM 与 Auth.js v5 构建。可通过 OpenNext 部署到 Cloudflare Workers，也能跑在
任意 Node.js 主机上。许可证 AGPL-3.0。

---

## 为什么做 Henna

多数自托管 Webmail 方案都把一台服务器摆在邮件中间：它抓取、存储、索引并投递每一封
邮件。这台服务器于是成为你基础设施里最有价值的目标，并且它持有全部内容的副本。

Henna 走反方向。服务端只处理身份、加密凭证、设置与审计。邮件在你的浏览器与上游
邮件服务器之间流动 —— 优先 JMAP，IMAP/SMTP 作为降级 —— 中间没有任何一环留下副本。

## 特性

**三种登录方式，且只有三种**

- 密码 —— scrypt 哈希，最少 12 位，绝不静默截断。
- GitHub OAuth —— Henna 唯一会支持的 OAuth 提供方。
- 邮箱验证码 —— 6 位，10 分钟有效，一次性，只存哈希。

**有实际意义的第二因素**

- TOTP，±1 个 30 秒步长，防重放。
- 一次性恢复码，只存摘要。
- 管理员**必须**启用，无论实例策略怎么设。
- 关闭它必须先证明一个当前有效的验证码。

**附件不经过服务端**

- 默认 Cloudflare R2，也支持任意 S3 兼容服务。
- 浏览器用短时效预签名 URL 直连存储桶：Henna 只签名，字节不经过它。
- 每个 URL 都限定在单个用户的键名前缀下，并且限流、写审计。

**凭证处理是认真的**

- AES-256-GCM，密钥环可轮换。
- 每次解密都限流并写入审计。
- 轮换是能真正做完的：加新密钥 → 重加密 → 移除旧密钥。

**审计日志是真的**

- 只追加，由数据库触发器强制，不靠约定。
- 覆盖登录、拒绝、密码重置、TOTP 事件、凭证解密、附件 URL 签发与管理操作。
- 绝不包含口令、验证码或解密后的凭证。

**邮件始终是你的**

- JMAP 优先；IMAP/SMTP 只作为有文档说明的降级。
- 邮件 HTML 在禁止脚本的沙盒 iframe 里渲染。
- 远程图片默认阻止，按你的允许才加载。
- 搜索在本地执行，查询不离开你的设备。

## 架构一瞥

```
浏览器 ──JMAP────────────────► 上游邮件服务器
   │                              （邮件内容，直连）
   │
   ├── HTTPS ──► Henna 服务端 ──► PostgreSQL
                 （身份、加密凭证、设置、审计）

浏览器 ──预签名 URL──► R2 / S3 存储桶（附件字节，直连）
```

邮件只在第一条线上，Henna 服务端只在第二条线上，两者不相交。详见
[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md)。

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wcvjk8tnz8-create/henna)

Cloudflare 会 fork 本仓库，并**自动**为你创建 D1 数据库与 R2 存储桶，然后只要求填
**三个值**。这就是全部配置 —— 不需要改 `wrangler.jsonc`，不需要跑迁移。

| 字段 | 填什么 |
| --- | --- |
| `DOMAIN` | 你要服务的邮件域名，JSON 数组，如 `["example.com"]` |
| `ADMIN` | 你的邮箱，它会成为第一个管理员 |
| `jwt_secret` | 任意随机字母与数字，不含标点 |

```bash
openssl rand -hex 24    # 输出作为 jwt_secret
```

更想走控制台而不是按钮？见
[docs/cloudflare-deployment.zh-CN.md](docs/cloudflare-deployment.zh-CN.md#界面部署全程不用命令行)
—— fork、创建 Worker、在 *设置 → 变量和机密* 里加同样的三个值、重新部署。

然后首次登录：

1. 打开你的 `*.workers.dev` 地址，用 `ADMIN` 邮箱请求验证码。
2. 此时还没配邮件服务，所以**验证码会打印到服务端日志**。用 `npx wrangler tail` 查看。
3. 输入验证码，设置密码，启用 TOTP —— 管理员必须启用。
4. 到 `/admin/settings` 配置 Resend、GitHub OAuth 与对象存储。

第 2 步是一次性的刻意例外：没有任何发信手段时，实例否则根本无法登录。它只在
「还没有任何人完成登录」时生效，且只对 `ADMIN` 地址生效。详见
[docs/cloudflare-deployment.zh-CN.md](docs/cloudflare-deployment.zh-CN.md#一键部署)。

## 快速开始（本地）

```bash
git clone https://github.com/your-org/henna.git
cd henna
npm install
cp .env.example .env          # 填入四项必需值
npm run db:migrate
npm run dev
```

生成两个密钥：

```bash
openssl rand -base64 32                    # HENNA_CREDENTIAL_KEY
openssl rand -hex 24 | tr -d '\n'          # jwt_secret（仅字母和数字）
```

打开 <http://localhost:3000>。`ADMIN` 里的地址会在首次启动时创建为第一个管理员；
用邮箱验证码登录，然后设置密码并启用 TOTP。

## 部署到 Cloudflare Workers

完整步骤见 [docs/cloudflare-deployment.zh-CN.md](docs/cloudflare-deployment.zh-CN.md)。
精简版：

1. 创建指向 PostgreSQL 的 Hyperdrive 配置。
2. 填好 `wrangler.jsonc`（名称、`compatibility_date`、Hyperdrive 绑定）。
3. 添加仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`DOMAIN`、
   `ADMIN`、`JWT_SECRET`、`HENNA_CREDENTIAL_KEY`。
4. 推送到 `main`。

流水线会运行类型检查、代码检查、单元测试与 Playwright E2E。任一步失败就不部署。

### GitHub Actions 逐步说明

1. **Fork 或创建仓库**，推送你的 `main` 分支。
2. **创建 Cloudflare API 令牌** —— *我的个人资料 → API 令牌 → 创建自定义令牌*。
   **不要**用 *编辑 Cloudflare Workers* 模板：它缺 D1 和 R2 权限，部署会在
   Worker 上传完之后失败。请授予 `Workers Scripts:Edit`、`D1:Edit`、
   `Workers R2 Storage:Edit`、`Workers Observability:Edit`、`Account Settings:Read`
   （账户级）与 `User Details:Read`（用户级）；仅当使用自定义域名时再加区域级的
   `Workers Routes:Edit`。详见
   [docs/cloudflare-deployment.zh-CN.md](docs/cloudflare-deployment.zh-CN.md)。
3. **找 Account ID**，在 Cloudflare 控制台侧边栏。
4. **添加仓库 Secrets**（*Settings → Secrets and variables → Actions*）：

   | Secret | 用途 |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | 部署凭证，仅 CI |
   | `CLOUDFLARE_ACCOUNT_ID` | 部署到哪个账户 |
   | `DOMAIN` | 邮件域名的 JSON 数组，如 `["example.com"]` |
   | `ADMIN` | 引导管理员邮箱 |
   | `JWT_SECRET` | 会话签名密钥，仅字母和数字 |
   | `HENNA_CREDENTIAL_KEY` | 32 随机字节的 base64 |
   | `HENNA_R2_ACCOUNT_ID` | 可选：附件存储的 CSP 放行 |
   | `GITHUB_CLIENT_SECRET`、`RESEND_API_KEY` | 可选：改在 `/admin/settings` 里配 |

5. **推送到 `main`。** `quality` job 会卡住 `deploy` job；检查不通过就不部署。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/self-hosting.zh-CN.md](docs/self-hosting.zh-CN.md) | 环境变量、TLS、迁移、备份、密钥轮换 |
| [docs/cloudflare-deployment.zh-CN.md](docs/cloudflare-deployment.zh-CN.md) | OpenNext、Hyperdrive、Workers Secrets、Resend DNS |
| [docs/storage.zh-CN.md](docs/storage.zh-CN.md) | R2 与 S3 兼容的附件存储 |
| [docs/security.zh-CN.md](docs/security.zh-CN.md) | 威胁模型、控制清单、已知限制、披露流程 |
| [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) | 数据流图与"邮件内容不过服务端"边界 |
| [docs/licenses.zh-CN.md](docs/licenses.zh-CN.md) | 依赖许可证与兼容性审查 |
| [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) | 编码规范与关键路径审查规则 |

文档索引见 [docs/README.md](docs/README.md)，每份文档顶部都有语言切换入口。

## 附件与对象存储

Henna 用对象存储保存附件，默认 **Cloudflare R2**，同时支持**任意 S3 兼容服务**
（AWS S3、MinIO、Backblaze B2、Hetzner、Wasabi）。两者走同一套预签名 SigV4 协议，
一份实现覆盖全部。

流程刻意做得很窄：

1. 浏览器向 Henna 请求上传 URL，只发文件名与大小。
2. DAL 校验大小，在 `users/<id>/…` 下生成键名，签出一个几分钟后过期的 PUT URL，
   并写入审计。
3. 浏览器把文件直接 PUT 到存储桶。

Henna 从不接收字节。桶的搭建、CORS 与 CSP 前提见 [docs/storage.zh-CN.md](docs/storage.zh-CN.md)。

## 安全

Henna 的设计目标是：服务端被攻陷也不会交出你的邮件 —— 它只持有加密的上游凭证、
存储桶凭证与审计日志，别的什么都没有。完整威胁模型、控制清单与已知限制见
[docs/security.zh-CN.md](docs/security.zh-CN.md)，其中包括那条诚实的限制：
只要攻击者还握着密钥环，他就能解密凭证。

报告漏洞请按 [docs/security.zh-CN.md](docs/security.zh-CN.md#报告漏洞) 的流程走。
请不要为仍在生效的漏洞开公开 issue。

## 许可证

AGPL-3.0-or-later。见 [LICENSE](LICENSE)。
