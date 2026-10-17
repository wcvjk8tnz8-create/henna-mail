# 部署 Henna 到 Cloudflare Workers

**[English](cloudflare-deployment.md) | [简体中文](cloudflare-deployment.zh-CN.md)**

Henna 通过 [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) 部署到
Workers。本文覆盖适配器、Hyperdrive、Workers Secrets、Resend DNS 与 GitHub Actions
流水线。

---

## 界面部署（全程不用命令行）

这条路只需要浏览器。做法参照 Cloud Mail，也应该是大多数人走的那条。

### 1. 把仓库弄进你的 GitHub

Fork `https://github.com/wcvjk8tnz8-create/henna`。Cloudflare 从**你的 fork** 构建，
所以要指向它。

### 2. 创建 Worker

*Cloudflare 控制台 → 计算（Workers）→ Workers 和 Pages → 创建 → 连接到 Git*，
选中刚才的 fork。

全部保持默认。**不要设置根目录** —— Henna 是仓库根部的单一 Next.js 项目，
不像 Cloud Mail 那样 Worker 藏在子目录里。

点 **部署**。

### 3. 添加三个变量

*Worker → 设置 → 变量和机密 → 添加*

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `DOMAIN` | JSON | `["example.com"]` —— 即使只有一个域名也要写成数组 |
| `ADMIN` | 文本 | 你的邮箱，它会成为第一个管理员 |
| `jwt_secret` | 机密 | 任意随机字母与数字，不含标点 |

```bash
openssl rand -hex 24    # 输出作为 jwt_secret
```

`DOMAIN` 必须是 **JSON** 而不是文本：写成裸的 `example.com` 会在启动时被拒。
`jwt_secret` 只接受字母和数字 —— 不带标点，因为这个值会经过 CI 密钥存储和
shell 脚本。

然后**重新部署**一次，让 Worker 读到新值。

### 4. 数据库和附件已经好了

这是 Henna 与 Cloud Mail 唯一实质性的差别，值得单独说清楚，因为 Cloud Mail 的
教程会让你手动创建并绑定 D1：

| | Cloud Mail | Henna |
| --- | --- | --- |
| D1 数据库 | 控制台创建、复制 id、绑定为 `db` | `wrangler.jsonc` 里按**名字**声明，首次部署自动创建 |
| KV 命名空间 | 创建并绑定为 `kv` | 不使用 |
| R2 桶 | 创建、绑定为 `r2`、设自定义域 | 按名字声明，首次部署自动创建 |
| 表结构 | 访问 `/api/init/<jwt_secret>` | 首次请求自动创建 |
| 变量 | 3 个（控制台填） | 3 个（控制台填） |

没有 id 要复制，也没有 `/api/init/…` 要访问。`db/index.ts` 的 `ensureSchema()`
在首次请求时执行，且全部语句都是 `IF NOT EXISTS`，所以是幂等的。

### 5. 登录

1. 打开 `*.workers.dev` 地址（绑了自定义域名就打开它）。
2. 用 `ADMIN` 邮箱请求验证码。
3. 此时还没配邮件服务，所以验证码会打印到日志 —— 用 `npx wrangler tail` 查看，
   或在 *Workers → 日志* 里看。
4. 设置密码并启用 TOTP。管理员必须启用。
5. 到 `/admin/settings` 配置 Resend、GitHub OAuth 与对象存储。

如果完全不想碰终端，日志在控制台里也有：进入该 Worker 的 **日志** 标签页即可。

### 6. 可选：自定义域名

*Worker → 设置 → 域和路由 → 添加 → 自定义域*。Cloudflare 自动签发证书，
不用买，也不用手写 DNS 记录。

---

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wcvjk8tnz8-create/henna)

大多数人应该走这条路。Cloudflare 会 fork 本仓库，**自动**创建 D1 数据库与 R2 存储桶，
然后只要求填三个值。不需要改 `wrangler.jsonc`，不需要跑迁移。

| 字段 | 填什么 |
| --- | --- |
| `DOMAIN` | 你要服务的邮件域名，JSON 数组，如 `["example.com"]` |
| `ADMIN` | 你的邮箱，它会成为第一个管理员 |
| `jwt_secret` | 任意随机字母与数字，不含标点 |

```bash
openssl rand -hex 24    # 输出作为 jwt_secret
```

### 为什么只要三个

其余都有可用默认值。不填 `HENNA_CREDENTIAL_KEY` 时，会用 HKDF 从 `jwt_secret` 派生。
D1 数据库与 R2 桶在 `wrangler.jsonc` 里是按**名字**声明的，所以 Cloudflare 首次部署
时自动创建 —— 这就是为什么全文没有出现任何 id 或连接串。表结构在首次请求时创建
（`db/index.ts` 的 `ensureSchema()`，全部 `IF NOT EXISTS`）。

### 点击之前要知道的两件事

**fork 之后的 GitHub Actions 会失败。** 它需要 `CLOUDFLARE_API_TOKEN` 与
`CLOUDFLARE_ACCOUNT_ID`，而一键部署流程不会设置这两个。那条流水线是给下面 §8 的
CI/CD 路径用的；一键部署走的是 Cloudflare 自己的构建系统，不依赖它。可以直接忽略
那个红叉，或在 fork 里关掉 Actions（*Settings → Actions → Disable*）。

**如果 Cloudflare 没识别出构建命令**，手动填：

| 设置 | 值 |
| --- | --- |
| Build command | `npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |

### 首次登录

此时还没配邮件服务，所以验证码发不到你邮箱。Henna 会改为把验证码打印到服务端日志，
**仅此一次**，且只在实例仍处于「全新」状态时：

```bash
npx wrangler tail
# [henna] BOOTSTRAP sign-in code for you@example.com: 123456 (single use, expires in 10 minutes)
```

这是对「绝不记录验证码」的一次刻意、范围严格受限的例外。它只对 `ADMIN` 地址生效，
且只在没有任何用户完成邮箱验证时生效 —— 你一登录，它就永久关闭，此后必须正常配置
邮件服务。验证码本身仍然是一次性、10 分钟有效、受限流保护。

首次登录之后：设置密码、启用 TOTP（管理员必须），然后到 `/admin/settings` 配置
Resend、GitHub OAuth 与对象存储。

---

## 1. Workers 上什么能跑，什么不能

| 组件 | Workers | 说明 |
| --- | --- | --- |
| Next.js App Router（SSR、Server Actions、Route Handlers） | 可以 | 通过 OpenNext |
| `node:crypto`（scrypt、AES-256-GCM、HMAC） | 可以 | 需要 `nodejs_compat` |
| TOTP（`otpauth`） | 可以 | 纯 TypeScript，无原生代码 |
| PostgreSQL via Hyperdrive | 可以 | 见第 3 节 |
| 浏览器直连 JMAP | 可以 | 浏览器直连上游 |
| 对象存储附件（预签名 URL） | 可以 | 浏览器直连 R2 / S3 |
| 服务端 IMAP/SMTP | **不行** | Workers 没有裸 TCP |
| Node.js Middleware | **不行** | 见第 2 节 —— 它本来就不是安全边界 |

**关于 IMAP/SMTP 的取舍，直接说明。** Workers 无法开启 TCP 连接，所以
`imapflow` 与 `nodemailer` 在那里跑不起来。Henna 没有假装支持，而是诚实地划分范围：

- **Workers**：只支持 JMAP。IMAP/SMTP 选项会隐藏，界面会说明原因。
- **自托管 Node.js**：两条路都可用，SMTP 限制在 587/465，25 端口直接拒用。

`lib/mail/protocol.ts` 用 `supportsImapFallback(runtime)` 把这处判断收在一处。

## 2. 为什么 Middleware 不是闸门

Next.js 的 Node.js middleware 在 Workers 上不执行。Henna 从未依赖它做安全判定，
所以这不是需要迁移的问题，而是本就如此：

- 每个受保护的 Server Action、Route Handler 与 Server Component 都调用 DAL 守卫
  （`requirePrincipal`、`requireAdmin`、`requireOwnershipOrAdmin`）。
- `middleware.ts` 只做乐观重定向 —— 省掉已登录用户的一次无谓渲染。删掉它，
  安全性不变。

值得对所有审代码的人重复一遍：**如果你发现某个访问控制只存在于 middleware，
那是 bug。**

## 3. Hyperdrive

Workers 无法像 Node.js 那样使用长连接的 `pg` 连接池，因此 Henna 通过 Hyperdrive 连接。

```bash
npx wrangler hyperdrive create henna-db \
  --connection-string="postgres://user:pass@db.example.com:5432/henna"
```

把返回的 ID 填进 `wrangler.jsonc`：

```jsonc
"hyperdrive": [
  {
    "binding": "HYPERDRIVE",
    "id": "<HYPERDRIVE_CONFIG_ID>"
  }
]
```

Henna 读取 `env.HYPERDRIVE.connectionString`，并且**绝不调用 `pool.end()`** ——
连接生命周期由平台管理。`db/index.ts` 用一个工厂函数在 Hyperdrive 与
`DATABASE_URL` 之间切换。

## 4. `wrangler.jsonc`

```jsonc
{
  "name": "henna",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "vars": {
    "DOMAIN": "[\"example.com\"]",
    "ADMIN": "root@example.com",
    "HENNA_TRUST_PROXY": "1"
  },
  "r2_buckets": [
    { "binding": "ATTACHMENTS", "bucket_name": "henna-attachments" }
  ],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_CONFIG_ID>" }]
}
```

`compatibility_date` 必须 **2024-09-23 或之后**，`nodejs_compat` 必须开启 ——
否则 `node:crypto` 的 scrypt 不可用，所有口令操作都会失败。

## 5. Workers Secrets

普通变量放 `vars`，密钥绝不放：

```bash
npx wrangler secret put jwt_secret
npx wrangler secret put HENNA_CREDENTIAL_KEY
# 若改为在 /admin/settings 配置，以下可跳过：
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put HENNA_R2_ACCOUNT_ID
```

这里粘贴的值由 Cloudflare 加密并在运行时注入，不会进入仓库，也不会出现在构建产物里。

## 6. Resend 与 DNS

1. 在 Resend 添加发信域名。
2. 按它给出的记录添加 DNS：
   - **SPF** —— 授权 Resend 的 `TXT` 记录。
   - **DKIM** —— 指定选择器的 `CNAME`（或 `TXT`）记录。
   - **DMARC** —— `_dmarc` 上的 `TXT` 记录，先 `p=none`，确认正常邮件对齐后再收紧。
3. 等待验证（通常几分钟，偶尔几小时）。
4. 把 API Key 与 `From` 地址填到 `/admin/settings`。

Henna 会展示上游的 SPF/DKIM/DMARC 判定结果，并且不会淡化失败信号。展示质量取决于
你域名的记录 —— 没有 DMARC 策略，就没有策略可通过。

## 7. 附件存储（CSP 前提）

附件走预签名 URL，浏览器直连存储桶。因为 Workers 没有按请求中间件，CSP 是静态下发的，
所以存储桶的源必须在**构建时**已知：

```bash
# 在仓库 Secrets 里配置其一
HENNA_R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef
# 或
HENNA_STORAGE_ORIGINS=https://<account>.r2.cloudflarestorage.com
```

只通过 `/admin/settings` 配置存储桶而不设这两项，浏览器会被 CSP 拦住，上传失败。
完整说明见 [storage.zh-CN.md](storage.zh-CN.md)。

`r2_buckets` 绑定是可选的 —— Henna 不代理附件字节，给出它只是方便需要在 Worker
内直接访问存储桶的运维场景。

## 8. GitHub Actions 流水线

`.github/workflows/deploy.yml` 在每次推送到 `main` 时执行：

```
安装依赖 → tsc --noEmit → biome → 单元测试 → Playwright E2E
                                                  ↓（仅当全绿）
                                  opennextjs-cloudflare build → wrangler deploy
```

`deploy` job 声明了 `needs: quality`。类型检查、代码检查或测试任一失败，都不会部署。

**这里有两个完全不同的「API 令牌」，混淆是最常见的错误。** 一个用来部署应用
（Cloudflare API 令牌，存进 GitHub Secrets），另一个让 Henna 读写附件（R2 S3 令牌，
填在 `/admin/settings`）。它们在**不同页面创建**，需要的权限也不同。

#### a) Cloudflare API 令牌 —— 给 CI 里的 `wrangler deploy` 用

**不要**用 *编辑 Cloudflare Workers* 模板。它只覆盖 Workers Scripts，**不含 D1 和 R2**，
所以部署会半途失败：Worker 传上去了，但数据库和桶创建不了。

请创建**自定义令牌**（*我的个人资料 → API 令牌 → 创建自定义令牌*），权限如下：

| 作用范围 | 权限 | 为什么需要 |
| --- | --- | --- |
| 账户 | `Workers Scripts:Edit` | 上传 Worker 产物 |
| 账户 | `D1:Edit` | 创建 `henna-db` 并执行迁移 |
| 账户 | `Workers R2 Storage:Edit` | 创建 `henna-attachments` 桶 |
| 账户 | `Workers Observability:Edit` | `wrangler.jsonc` 里开了 observability |
| 账户 | `Account Settings:Read` | 部署时读取账户信息 |
| 用户 | `User Details:Read` | `wrangler` 验证令牌 |
| 区域 | `Workers Routes:Edit` | 仅当你绑定自定义域名 |

其余一律不开。特别是不要给 `D1:Delete`、不要给 `Workers R2 Storage:Delete`、
不要给账单权限 —— CI 令牌能删数据，这个代价换便利不划算。

> **你不需要手动跑 `wrangler d1 migrations apply`。** Henna 在首次请求时自建表结构
> （见 `db/index.ts` 的 `ensureSchema()`），且全部语句都是 `IF NOT EXISTS`。
> 在 CI 里显式跑迁移当然更好，但跳过它也不会得到一个坏掉的实例。

#### b) R2 令牌 —— Henna 运行时读写附件用

在 *R2 → 管理 R2 API 令牌* 创建，**不是**在「我的个人资料」里：

| 设置 | 值 | 为什么 |
| --- | --- | --- |
| 权限 | `Object Read & Write` | 只要 PUT 和 GET 对象，预签名需要的就是这些 |
| ——不要—— | `Admin Read & Write` | 那等于允许创建和删除桶 |
| 桶范围 | 仅 `henna-attachments` | 只作用于这一个桶，不碰账户里其他桶 |

`Object Read & Write` 能写入、读取、删除对象；不能列举桶，不能创建或删除桶，
也不能碰别的桶。这正好是 Henna 需要的全部，多一点都不给。

**仓库 Secrets**（*Settings → Secrets and variables → Actions*）：

| Secret | 必需 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | 部署凭证，仅 CI |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 目标账户 |
| `DOMAIN` | 是 | 邮件域名的 JSON 数组 |
| `ADMIN` | 是 | 引导管理员 |
| `JWT_SECRET` | 是 | 会话签名密钥 |
| `HENNA_CREDENTIAL_KEY` | 是 | 凭证加密密钥 |
| `HENNA_R2_ACCOUNT_ID` | 否 | 附件存储的 CSP 放行 |
| `HENNA_STORAGE_ORIGINS` | 否 | 同上，直接列源 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 否 | 改用 `/admin/settings` |
| `RESEND_API_KEY` / `HENNA_EMAIL_FROM` | 否 | 改用 `/admin/settings` |

部署步骤使用 `cloudflare/wrangler-action@v4`。

## 9. Workers 上首次启动

1. 访问 `https://your-worker.workers.dev/api/health`。返回 503 并带 `issues` 数组，
   会明确告诉你缺哪个根变量。
2. 修好、重新部署、刷新，直到看到 `"status": "ok"`。
3. 用邮箱验证码以 `ADMIN` 登录，设置密码，启用 TOTP。
4. 在 `/admin/settings` 配置 GitHub OAuth、Resend 与对象存储。
5. 把 `AUTH_URL` 设成真实源 —— GitHub 回调地址由此推导，必须与 OAuth 应用完全一致。

## 10. 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入
npm run preview                  # opennextjs-cloudflare build && wrangler dev
```

`wrangler dev` 在本地带上绑定运行 Worker，可以在部署前验证 Hyperdrive 路径。
纯界面开发用 `npm run dev`（原生 Next.js）更快。

## 11. 回滚

Workers 保留历史部署。回滚可以重跑某个较早提交的流水线，或直接部署已知可用的构建：

```bash
git checkout <known-good-sha>
npm run deploy
```

如果问题部署涉及凭证密钥变更，请记住：回滚**代码**不会回滚**密钥**。在确认不需要
回滚之前，把旧密钥保留在 `HENNA_CREDENTIAL_KEY` 里。
