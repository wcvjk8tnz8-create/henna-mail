# 附件存储（R2 与 S3 兼容）

**[English](storage.md) | [简体中文](storage.zh-CN.md)**

Henna 用对象存储保存附件。默认推荐 **Cloudflare R2**，也支持 **任意 S3 兼容服务**。
两者走的是同一套预签名 SigV4 协议，所以一份实现同时覆盖两者。

---

## 这套设计要守住的底线

> Henna 服务端从不接触附件。它只负责签名，字节由浏览器自己搬运。

这不是一句口号，而是代码的结构：没有任何函数接收文件正文，没有任何缓冲区持有它，
也没有任何字段能装下它。服务端看到的只有一个文件名和一个大小。

```
浏览器 ──PUT（预签名）──► R2 / S3 存储桶        ← 附件字节
   │
   └──Server Action──► Henna 服务端 ──► 签名 URL、写审计
                            │
                            └──► PostgreSQL（键名、大小、类型 —— 没有内容）
```

## 支持的服务

| 服务 | 端点 | 区域 | 路径风格 |
| --- | --- | --- | --- |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | 是 |
| AWS S3 | `https://s3.<region>.amazonaws.com` | 真实区域 | 否（虚拟主机） |
| MinIO | `https://minio.example.com` | 通常 `us-east-1` | 是 |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | 真实区域 | 是 |
| Hetzner / Wasabi / Ceph | 按服务商提供 | 按服务商提供 | 通常是 |

"路径风格"指存储桶出现在 URL 路径里（`/bucket/key`）而不是主机名里。
R2 和 MinIO 必须用路径风格，AWS S3 偏好虚拟主机风格。

## 上传是怎么走完的

1. 浏览器调用 Server Action，**只传文件名和大小**。
2. `requirePrincipal()` 完成身份认证。
3. DAL 校验大小是否超过实例上限，并做限流。
4. 服务端生成键名：`users/<userId>/attachment/<uuid>/<安全文件名>`。
   键名由服务端决定，调用方无法指定，所以文件名不可能把写入引到别人的命名空间。
5. 签出一个 PUT URL，有效期很短（默认 300 秒）。
6. 浏览器带着指定请求头，把文件 PUT 到存储桶。
7. 写审计：谁、多大、什么类型、什么时候。

下载是同一个流程反过来：DAL 查出记录，确认键名在该用户前缀下，再签一个短时效 GET。


## 三种令牌分别是什么，各自能做什么

一次 Henna 部署里会用到三种令牌。它们在不同地方创建，不能互相替代。

| 令牌 | 创建位置 | 交给谁 | 最小权限 |
| --- | --- | --- | --- |
| Cloudflare API 令牌 | *我的个人资料 → API 令牌* | GitHub Actions（`CLOUDFLARE_API_TOKEN`） | `Workers Scripts:Edit`、`D1:Edit`、`Workers R2 Storage:Edit`、`Workers Observability:Edit`、`Account Settings:Read`、`User Details:Read` |
| R2 S3 令牌 | *R2 → 管理 R2 API 令牌* | `/admin/settings → Object storage` | `Object Read & Write`，限定单个桶 |
| JMAP API 令牌 | 你自己的邮件服务器 | `/settings → Mail accounts` | 单个账户的读信 + 发信 |

### R2 令牌详解

| 设置 | 值 | 为什么 |
| --- | --- | --- |
| 权限 | `Object Read & Write` | 预签名只需要对对象做写入、读取、删除 |
| ——不要—— | `Admin Read & Write` | 那等于允许创建和删除桶 |
| 桶范围 | 仅一个桶 | 限定到单桶后碰不到别的桶 |

授予之前值得知道 `Object Read & Write` 的边界：

- **能**：在该桶内 `PutObject`、`GetObject`、`DeleteObject`、`HeadObject`、`ListObjects`。
- **不能**：列举桶、创建或删除桶、读写其他桶、修改桶配置。

这正好覆盖 Henna 预签名流程用到的全部操作。如果你的服务商只能给全桶令牌，
那就为 Henna 单独建一个桶，并且不要把那把钥匙用在别处。

### JMAP 令牌

这个不由 Henna 定义，由你的邮件服务器决定 —— 但值得去看一眼它到底给了什么。
Henna 需要 `core`、`mail`、`submission` 三个 capability，其余都不需要：

- **读取**邮箱与邮件（用于收件箱与本地索引）。
- **提交**邮件（用于发信）。
- **不需要**账户管理、不需要他人邮件、不需要 sieve 或自动回复管理。

请签发**单账户**令牌而不是服务器级令牌。吊销时在 `/settings` 里删掉该凭证即可，
上游令牌随之失效。

## 配置 Cloudflare R2

1. *Cloudflare 控制台 → R2 → 创建存储桶*，记下桶名。
2. *R2 → 管理 R2 API 令牌 → 创建 API 令牌*。
3. 权限选 **对象读写**，并且只作用于这一个桶 —— 不要给管理员权限。
4. 复制 Access Key ID 与 Secret Access Key，它们只显示一次。
5. 打开 Henna 的 `/admin/settings → Object storage`：
   - Provider 选 **Cloudflare R2**
   - Account ID 填 32 位 Cloudflare 账户 ID（端点由此推导），或直接填端点
   - 填桶名、Access Key ID、Secret Access Key
   - **Path-style URLs** 保持勾选

### CORS

浏览器是跨域上传，所以存储桶需要一条 CORS 规则，放行 Henna 的源，方法用 `PUT` 和 `GET`：

```json
[
  {
    "AllowedOrigins": ["https://mail.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

这里 `AllowedHeaders: ["*"]` 是安全的：请求靠 URL 里的签名认证，不靠请求头。

## 配置 S3 兼容服务

Provider 选 **S3-compatible**，然后：

- **Endpoint** —— 只填源，不带路径，例如 `https://minio.example.com`。
- **Region** —— 按服务要求填。MinIO 默认 `us-east-1`；R2 恒为 `auto` 且忽略它。
- **路径风格** —— MinIO 和多数自建服务开启，AWS S3 关闭。
- **桶名与密钥** —— 按服务商提供的填。

## CSP 前置条件，以及它为什么存在

Henna 的 Content-Security-Policy 是**静态下发**的，因为 Cloudflare Workers
没有可用的按请求中间件来动态生成。所以 `connect-src` 必须在构建时就知道存储桶的源：

```env
# 直接列出源……
HENNA_STORAGE_ORIGINS=https://<account>.r2.cloudflarestorage.com

# ……或者给账户 ID，由 Henna 推导。
HENNA_R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef
```

如果你**只**在 `/admin/settings` 里配置存储，请务必设置其中一个并重新部署 ——
否则浏览器会被 CSP 拦住，上传失败并在控制台报 CSP 错误。这是存储配置唯一
与构建相关的环节，[cloudflare-deployment.zh-CN.md](cloudflare-deployment.zh-CN.md)
和 [self-hosting.zh-CN.md](self-hosting.zh-CN.md) 里都标注了这一点。

## 强制了哪些约束

| 约束 | 位置 |
| --- | --- |
| 归属：键名必须以 `users/<userId>/` 开头 | `keyBelongsToUser`，检查两遍 |
| 拒绝路径穿越与绝对路径 | `isValidObjectKey` |
| 文件名净化（分隔符、控制字符、前导点） | `sanitizeFilename` |
| 内容类型按严格文法校验 | `isSafeContentType` —— 换行会变成对签名请求的请求头注入 |
| 实例级大小上限 | `maxUploadBytes`，签名前检查 |
| 签发 URL 限流 | `RATE_LIMIT_RULES.storageUrl` |
| 每次签发与拒绝都写审计 | `storage.*` 审计动作 |
| 密钥静态加密 | AES-256-GCM，独立字段 |

## 密钥与轮换

Access Key ID 与 Secret Access Key 用与邮件凭证同一套 `HENNA_CREDENTIAL_KEY`
密钥环加密。轮换该密钥时会一并重新加密，参见
[self-hosting.zh-CN.md](self-hosting.zh-CN.md#9-轮换-henna_credential_key)。

**存储桶**密钥的轮换是独立的：在 R2 或你的 S3 服务商那里创建新令牌，粘贴到
`/admin/settings`，再吊销旧的。变更会被记录进审计（值本身不会）。

## 已知限制

1. **大小上限在协议层面是建议性的。** 查询串形式的预签名 URL 无法携带
   `content-length-range` 条件，要严格约束需要用预签名 POST 策略。上线前在签发
   URL 时和客户端都会检查，所以正常上传是有界的 —— 但拿着有效 URL 手工构造的
   请求可能超限，直到记录被对账。
2. **预签名 URL 本身就是一种凭证。** 拿到它的人在过期前都能用。默认有效期
   很短（300 秒），且从不写进日志。
3. **删除账号会删除元数据，并由 Henna 对对象发起 DELETE。** 若此刻存储桶
   不可达，记录仍会删除，审计会记下失败，因此可能残留孤儿对象。
4. **CORS 需要你自己配。** Henna 无法代你设置存储桶。

## 执行迁移

```bash
psql "$DATABASE_URL" -f db/migrations/0001_storage.sql
```

它会新增 `storage_config`（单行，密钥加密）与 `storage_objects`
（键名、大小、类型 —— 不含内容）。
