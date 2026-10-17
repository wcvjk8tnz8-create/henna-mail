# 自托管 Henna

**[English](self-hosting.md) | [简体中文](self-hosting.zh-CN.md)**

本文讲在自有 Node.js 主机上运行 Henna。Cloudflare Workers 部署见
[cloudflare-deployment.zh-CN.md](cloudflare-deployment.zh-CN.md)。

---

## 1. 准备工作

- Node.js 20.9 或更高。
- PostgreSQL 14 或更高。
- Henna 前置的 TLS 证书（Caddy、nginx 或平台 ingress）。生产环境会下发
  `Secure` Cookie 与 HSTS，因此必须是 HTTPS。
- 到上游邮件服务器的出网连接（JMAP 走 HTTPS，或 IMAP/SMTP 的 993/587/465）。
- 可选：Resend 账号，用于邮箱验证码与密码重置。
- 可选：对象存储，用于附件。见 [storage.zh-CN.md](storage.zh-CN.md)。

## 2. 两层配置

Henna 有意把配置分成两层。

**根配置 —— 仅环境变量，界面里永远改不了。**
这四项定义实例本身。缺失或格式错误时，Henna 拒绝启动并明确告诉你哪一项有问题。

| 变量 | 格式 | 为什么只能放环境变量 |
| --- | --- | --- |
| `DOMAIN` | JSON 数组，如 `["example.com","example2.com"]` | 决定本实例服务哪些域名 |
| `ADMIN` | 邮箱地址 | 引导第一个管理员 |
| `jwt_secret` | 仅字母和数字，不含标点 | 会话令牌签名；未设 `HENNA_CREDENTIAL_KEY` 时也作为凭证密钥的种子。建议 `openssl rand -hex 24`，但不强制。 |
| `HENNA_CREDENTIAL_KEY` | 32 随机字节的 base64（轮换时用逗号分隔多个） | 加密存储的密钥 |

**实例配置 —— 存数据库，管理员可在 `/admin/settings` 修改。**
认证开关、GitHub OAuth 凭证、Resend、TOTP 策略、注册控制、口令规则、验证码
有效期、过渡动画，以及对象存储配置。其中的密钥在写入前用 AES-256-GCM 加密，
存放在独立字段里。

分层的意义在于：根配置无法被拿到管理员会话的人改动，因为改动它需要重新部署。

## 3. 环境变量

```env
# --- 根配置（必需） --------------------------------------------------------
DOMAIN=["example.com"]
ADMIN=root@example.com
jwt_secret=anyRandomLettersAndDigits
HENNA_CREDENTIAL_KEY=base64-of-32-random-bytes

# --- 数据库 ---------------------------------------------------------------
DATABASE_URL=postgresql://henna:henna@localhost:5432/henna

# --- 对外源 ---------------------------------------------------------------
AUTH_URL=https://mail.example.com
AUTH_SECRET=a-long-random-string-for-authjs

# --- 可选：这里配，或稍后在 /admin/settings 里配 --------------------------
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
RESEND_API_KEY=
HENNA_EMAIL_FROM=Henna <no-reply@example.com>
HENNA_REGISTRATION_MODE=closed
HENNA_TOTP_POLICY=admin-only

# --- 对象存储（附件） ------------------------------------------------------
HENNA_R2_ACCOUNT_ID=
HENNA_STORAGE_ORIGINS=https://<account>.r2.cloudflarestorage.com
```

以下规则是强制的，不只是建议：

- `jwt_secret` 只接受字母和数字。特殊字符会破坏 CI 密钥存储与 shell 引号，
  直接拒掉能消除这一整类问题。
- 任何 `NEXT_PUBLIC_*` 变量都不得包含密钥。Henna 启动时会检查，发现即拒绝启动。
- `DATABASE_URL`、`jwt_secret`、`GITHUB_CLIENT_SECRET`、`HENNA_CREDENTIAL_KEY`
  只在服务端读取。

## 4. 哪些值是机密

| 值 | 机密？ | 泄露后果 |
| --- | --- | --- |
| `jwt_secret` | **是** | 可伪造会话。立即轮换，所有会话失效。 |
| `HENNA_CREDENTIAL_KEY` | **是** | 存储的凭证可被解密。轮换并重新加密。 |
| `GITHUB_CLIENT_SECRET` | **是** | OAuth 身份冒用。在 GitHub 轮换后更新设置。 |
| `RESEND_API_KEY` | **是** | 被滥发邮件。在 Resend 轮换。 |
| 存储桶密钥 | **是** | 附件可被读写。在 R2 / S3 服务商轮换。 |
| `DATABASE_URL` | **是** | 可读取全部账号与审计日志。 |
| `ADMIN` | 否 | 只是一个地址。 |
| `DOMAIN` | 否 | 公开信息。 |
| `GITHUB_CLIENT_ID` | 否 | 设计上就是公开的。 |

## 5. 数据库

```bash
createdb henna
psql "$DATABASE_URL" -f db/migrations/0000_init.sql
psql "$DATABASE_URL" -f db/migrations/0001_storage.sql
# 或者应用能连上之后：
npm run db:migrate
```

然后给应用角色最小权限。审计日志是只追加的，数据库用触发器强制 —— 但角色本身
就不该有这个权限：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO henna_app;
REVOKE UPDATE, DELETE ON audit_log FROM henna_app;
```

首次启动会按 `ADMIN` 创建管理员账号（若不存在）。它永远不会改动已有账号的角色。

## 6. TLS

Henna 依赖前置平台提供 TLS。在反向代理之后：

- 转发 `X-Forwarded-For`。只有当你显式设置 `HENNA_TRUST_PROXY=1` 时 Henna 才会
  信任它 —— 否则客户端 IP 哈希会退化为 null，限流也降级为仅按账号。
- 尽量不要"TLS 终止后内部走明文 HTTP"。HSTS 与 `Secure` Cookie 只在
  `NODE_ENV=production` 时下发。

## 7. GitHub OAuth 应用

1. *GitHub → Settings → Developer settings → OAuth Apps → New OAuth App*。
2. **Homepage URL**：`https://mail.example.com`
3. **Authorization callback URL**：`https://mail.example.com/api/auth/callback/github`
   —— 必须完全一致，包含路径。GitHub 是逐字比较的。
4. 复制 Client ID，生成 Client Secret。
5. 填到 `/admin/settings`（推荐，静态加密）或环境变量。

Henna 使用授权码流程，发出 `state` 参数并在回调时以恒定时间比较。若你的部署
已验证端到端支持 PKCE，Henna 可以发送 `code_challenge` —— 它绝不会发一个自己
不去校验的参数，因为服务端忽略的 PKCE 参数比没有更糟。

## 8. Resend

1. 在 Resend 添加并验证发信域名（SPF、DKIM，以及 DMARC 记录）。
2. 创建 API Key。
3. 把 Key 与 `From` 地址填到 `/admin/settings`。

验证码在服务端发出，API Key 不会进入浏览器。

## 9. 对象存储

附件默认走对象存储，R2 或任意 S3 兼容服务。完整说明见
[storage.zh-CN.md](storage.zh-CN.md)。要点：

- 浏览器用短时效预签名 URL 直连存储桶，Henna 不接触字节。
- 若只在 `/admin/settings` 配置，还要设置 `HENNA_STORAGE_ORIGINS`（或
  `HENNA_R2_ACCOUNT_ID`）并重新部署，否则 CSP 会拦住浏览器。

## 10. 轮换 `HENNA_CREDENTIAL_KEY`

分三步，界面会告诉你什么时候算完成。

```bash
# 1. 把新密钥放在最前面，保留旧密钥用于解密。
#    第一个密钥用于加密，所有密钥都可用于解密。
NEW=$(openssl rand -base64 32)
HENNA_CREDENTIAL_KEY="$NEW,$OLD_KEY"
```

重新部署，打开 `/admin/settings → Key rotation`，点 **Re-encrypt**。报告会告诉
你迁移了多少行、多少行已经是当前密钥。

```bash
# 3. 确认旧密钥上没有残留后，移除它。
HENNA_CREDENTIAL_KEY="$NEW"
```

不要过早执行第 3 步：重加密之前删掉密钥会让那些行永久不可读，Henna 会报
`tampered` 而不是去猜。

`jwt_secret` 泄露时同样要轮换 —— 所有会话失效，这正是你想要的结果。

## 11. 备份

备份数据库就够了，这是全部状态：

```bash
pg_dump --format=custom --file=henna-$(date +%F).dump "$DATABASE_URL"
```

没有邮件需要备份，因为服务端根本没有邮件。

恢复：

```bash
createdb henna_restored
pg_restore --dbname=henna_restored henna-2026-01-01.dump
```

备份里含加密的凭证与 TOTP 密钥。没有匹配的 `HENNA_CREDENTIAL_KEY` 时恢复出来的
实例，所有凭证解密都会明确失败 —— 这是设计如此，不是故障。备份请加密存放。

## 12. 部署之后

1. 用邮箱验证码以 `ADMIN` 身份登录。
2. 设置密码并启用 TOTP。管理员必须启用。
3. 把恢复码存到与验证器不同的设备上。
4. 打开 `/admin/settings` 设置注册模式。默认是 `closed`，这是安全的那个。
5. 访问 `/api/health` —— 它会报告缺失的根配置，而不是直接崩溃。
