# Henna 安全模型

**[English](security.md) | [简体中文](security.zh-CN.md)**

本文说明 Henna 防什么、怎么防，以及同样重要的 —— 它不防什么。

---

## 威胁模型

### 资产

| 资产 | 存放位置 | 为什么重要 |
| --- | --- | --- |
| 邮件内容 | 浏览器内存、本地 IndexedDB、上游服务器 | 全部意义所在 |
| 上游邮件凭证 | PostgreSQL，AES-256-GCM 加密 | 邮箱的读权限 |
| TOTP 密钥 | PostgreSQL，AES-256-GCM 加密 | 绕过第二因素 |
| 恢复码 | PostgreSQL，仅存摘要 | 绕过第二因素 |
| 存储桶凭证 | PostgreSQL，AES-256-GCM 加密 | 附件的读写权限 |
| `HENNA_CREDENTIAL_KEY` | 环境变量 / Workers Secret | 解开上面这些 |
| `jwt_secret` | 环境变量 / Workers Secret | 伪造会话 |
| 审计日志 | PostgreSQL，只追加 | 发现与还原事件 |

### 对手

1. **无凭证的远程攻击者** —— 试探登录面、尝试枚举账号、伪造 CSRF、向渲染的
   邮件里注入内容。
2. **拿到会话的人** —— 试图提权成管理员、访问他人设置、关掉第二因素。
3. **被攻陷的管理员账号** —— 试图读取他人的邮件。
4. **服务器整体沦陷** —— 同时掌握主机、环境变量与数据库的攻击者。
5. **恶意发件人** —— 试图执行脚本、追踪收件人、冒充身份。

### 哪些成立，哪些不成立

对 (1)、(2)、(5)，Henna 的控制是强的，见下方清单。

对 (3)，设计上是明确的：**管理员无法通过 Henna 读取他人的邮件。** 凭证解密要求
归属关系而不是管理员角色，邮件本身根本不经过服务端。管理员*能*改实例设置、能
锁定用户，因此每一个管理操作都会进审计。

对 (4)，要诚实：拿到主机的攻击者就拿到了 `HENNA_CREDENTIAL_KEY`，也就能够解密
存储的上游凭证。但他仍然无法从 Henna 的数据库里读到邮件，因为邮件不在那里。
他必须拿着凭证去打上游服务器，这会在上游留下痕迹，并且需要持续持有 Henna 的
运行环境。这是"凭证协调者"架构能给出的最好结果，其爆炸半径确实远小于
"存储邮件的服务器"。

---

## 控制清单

### 授权

- [x] DAL 是唯一的执行点。Route Handler、Server Action、Server Component 都调用
      `requirePrincipal()`、`requireAdmin()` 或 `requireOwnershipOrAdmin()`。
- [x] `requireMfaIfRequired()` 按实例策略与用户状态，决定会话在第二因素完成前
      能否使用。
- [x] Middleware 只做乐观重定向。在 Cloudflare Workers 上它根本不执行，没有任何
      东西依赖它。
- [x] 拒绝发生在判定点，并带原因写入审计。
- [x] `github_user_id` 有唯一约束，一个 GitHub 身份不能绑定两个 Henna 账号。
- [x] 管理员无法访问他人的上游凭证。

### 认证

- [x] 只有三种方式：密码（scrypt）、GitHub OAuth、邮箱验证码。代码库里不存在
      其他 OAuth/OIDC 提供方。
- [x] 口令：最少 12、最多 128，绝不静默截断，哈希前先过弱口令名单。
- [x] 邮箱验证码：6 位、10 分钟、一次性、只存哈希、最多 5 次、发送与校验都限流。
- [x] GitHub：授权码流程；`state` 恒定时间比较；`redirect_uri` 精确匹配；必须
      primary 且 verified 的邮箱；`github_user_id` 作为绑定键。
- [x] 邮箱命中已有账号时不静默接管 —— 用户必须先用现有方式登录再显式绑定。
- [x] "账号不存在"与"密码错误"返回完全一致的响应。
- [x] 限流按两个独立维度（来源 IP 与账号）。

### 会话

- [x] 访问令牌最长 15 分钟。
- [x] 刷新令牌每次使用都轮换，旧令牌立即失效。
- [x] 刷新令牌重用会吊销整条轮换链。
- [x] MFA 通过时更换会话标识，验证前的令牌无法重放。
- [x] Cookie 为 `HttpOnly`，生产环境 `Secure`，`SameSite=Lax`（CSRF Cookie 用 `Strict`）。
- [x] 密码重置会吊销该用户所有会话。

### 请求伪造

- [x] Server Action 保留 Next.js 内置 CSRF 保护，没有任何地方禁用它。
- [x] 自定义 Route Handler 校验双提交令牌：Cookie 与 `x-csrf-token` 恒定时间比较，
      并绑定会话 ID。
- [x] 缺失或不匹配 → `403`，并写入审计。

### 输入与注入

- [x] 所有服务端输入 —— Server Action 参数、请求体、查询参数、自定义请求头 ——
      都先经 Zod 解析。
- [x] SQL 只走 Drizzle 参数化查询，不做拼接。
- [x] 重定向目标必须是单斜杠开头的本地路径，协议相对 URL 一律拒绝。
- [x] SSRF：端点发现只探测实例白名单里的主机。

### 邮件渲染

- [x] 邮件 HTML 按标签与属性白名单净化。
- [x] 在 `sandbox="allow-popups allow-popups-to-escape-sandbox"` 的 iframe 里渲染，
      绝不同时启用 `allow-scripts` 与 `allow-same-origin`。
- [x] 远程图片默认阻止，按邮件单独放行。
- [x] 附件下载前校验 MIME 类型与文件头魔数是否一致。
- [x] 邮件 HTML 从不在服务端渲染进页面。

### 对象存储附件

- [x] 附件字节不经过服务端：浏览器用预签名 URL 直连存储桶。
- [x] 键名由服务端生成，强制位于 `users/<userId>/` 前缀下，下载前二次校验。
- [x] 拒绝路径穿越与绝对路径；文件名净化；内容类型按严格文法校验（防请求头注入）。
- [x] 签发 URL 限流，每次签发与拒绝都写审计。
- [x] 存储桶凭证与邮件凭证同级加密存储。

### 响应头

- [x] `Content-Security-Policy` —— `default-src 'self'`，无 nonce 的内联脚本一律禁止，
      `object-src 'none'`，`base-uri 'none'`，`frame-ancestors 'none'`，
      `form-action 'self' https://github.com`。
- [x] `connect-src` 与 `frame-src` 只对白名单内的上游源放开。
- [x] 生产环境下发 `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`。
- [x] `X-Content-Type-Options: nosniff`、
      `Referrer-Policy: strict-origin-when-cross-origin`、最小化的 `Permissions-Policy`。

### 密码学

- [x] 存储的密钥用 AES-256-GCM，输出为 `iv:authTag:ciphertext`。
- [x] 返回明文前先校验 authTag；失败即审计，不做猜测。
- [x] 口令用 scrypt，参数与哈希一起存储以便日后提高；默认 N = 2^15, r = 8, p = 1。
- [x] 所有随机数来自 `node:crypto`，安全路径上没有 `Math.random()`。
- [x] 所有机密比较都是恒定时间。
- [x] 密钥可轮换，界面提供进度报告。

### 审计

- [x] 只追加，由数据库触发器强制，不靠约定。
- [x] 覆盖登录成功/失败、拒绝、验证码发送与校验、密码重置、TOTP 全生命周期、
      恢复码、凭证解密、存储 URL 签发、管理操作、密钥轮换。
- [x] 从不记录口令、验证码、TOTP 值或解密后的凭证。`writeAudit` 还会拦截一份
      字段名黑名单作为兜底。
- [x] IP 与 User-Agent 只存哈希。
- [x] 应用里不存在删除路径。

---

## 已知限制

1. **服务器沦陷会暴露凭证，但不会暴露邮件。** 如上所述。若你的威胁模型要求
   服务器完全沦陷也一无所获，那需要一种服务端永不持有解密密钥的架构 —— Henna
   不是那种架构，因为它必须解密凭证才能使用。
2. **IMAP/SMTP 在 Cloudflare Workers 上不可用。** Workers 没有裸 TCP。降级路径
   仅限自托管 Node.js，界面会明确说明。
3. **元数据仍然经过上游服务器。** Henna 不改变你的邮件服务商能看到什么。
4. **S/MIME 私钥是个难题。** 验签直截了当；解密需要密钥托管，本版本不试图解决。
   私钥应留在浏览器的 WebCrypto 里。
5. **限流计数存在 PostgreSQL 里。** 这对多实例正确性是对的，但也意味着数据库故障
   会同时让限流不可用。Henna 选择失败即拒绝：计数器读不到，请求就被拒。
6. **附件大小上限在协议层面是建议性的。** 查询串预签名 URL 无法携带
   `content-length-range`；见 [storage.zh-CN.md](storage.zh-CN.md#已知限制)。
7. **`jwt_secret` 轮换会让所有人登出。** 这是有意为之，请提前安排。
8. **尚无 WebAuthn / 通行密钥。** 目前上限是 GitHub OAuth 加 TOTP。

---

## 报告漏洞

**请不要**为仍在生效的漏洞开公开 issue。

1. 发邮件到 **security@henna.example**（换成你实例的真实地址，或使用仓库的
   GitHub 私有安全公告）。
2. 请包含：你发现了什么、如何复现、受影响的版本或 commit，以及你认为的影响。
3. 我们会在 72 小时内确认，并在 7 天内给出评估与修复方案。
4. 除你另有要求，我们会在发布说明中致谢。
5. 请给我们合理的时间窗口发布修复，再公开披露。

对于善意行事、不侵犯隐私、不破坏服务的研究者，我们不会追究法律责任。

## 自己验证这些控制

```bash
npm run typecheck     # 类型本身也是安全姿态的一部分
npm run lint          # Biome，no-explicit-any 视为错误
npm test              # crypto、DAL、TOTP、校验、存储的单元测试
npm run test:e2e      # Playwright：认证、授权、CSRF、MFA
```

以上每一项都在 CI 中运行，任一失败即阻止合并。
