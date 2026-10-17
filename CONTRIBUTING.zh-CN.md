# 参与 Henna

**[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)**

感谢你的帮助。Henna 是安全敏感的软件，所以本文大部分内容讲的是**不要做什么**。

---

## 搭环境

```bash
npm install
cp .env.example .env      # 填入 DOMAIN、ADMIN、jwt_secret、HENNA_CREDENTIAL_KEY
createdb henna
npm run db:migrate
npm test
npm run dev
```

提 PR 之前：

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

四项都在 CI 中运行，任一失败阻止合并。

## 编码规范

**TypeScript 是 strict 的，`any` 是错误。** 不是警告，是错误。第三方类型不对时，
用 Zod schema 收窄并从它推导类型。

**所有服务端输入先用 Zod 解析。** Server Action 参数、请求体、查询参数、自定义
请求头。原始输入进入业务逻辑是审查阻断项，即便你确信那个值是安全的。

**SQL 只走 Drizzle。** 仅参数化查询。不要模板字符串、不要拼接、不要把插值塞进
`sql.raw`。

**密钥统一从 `lib/config` 读取，不要直接碰 `process.env`。** 任何机密都不能出现在
`NEXT_PUBLIC_*` 变量里，启动检查会强制执行这一点。

**随机数用 `node:crypto`，不要用 `Math.random()`** —— 只要与安全相关。

**机密比较必须恒定时间。** 用 `lib/crypto/constant-time.ts` 里的 `safeEqual`。

---

## 最重要的一条规则

> **授权判定只写在 DAL 里。别处都不行。**

`lib/dal/` 是唯一可以决定"这个操作是否允许"的地方。Route Handler、Server Action
与 Server Component 调用守卫，然后使用它返回的结果。

这意味着：

- 不要在页面、组件或路由处理器里检查角色。
- 不要把 Cookie、JWT 声明或表单字段里的值当作身份凭证。DAL 会重新读取会话与用户行。
- 不要往 `middleware.ts` 里加访问控制。在 Cloudflare Workers 上 Node.js middleware
  根本不执行，任何依赖它的东西在生产环境是静默缺席的。

如果你在 `lib/dal/` 之外写下 `if (session.user.role === 'admin')`，停下，改成加一个
DAL 函数。

---

## 审查要求

改动涉及以下路径时，需要**两名 reviewer 批准**，其中至少一名是维护者：

- `lib/dal/` —— 授权
- `lib/crypto/` —— 加密、密钥管理、随机数
- `lib/auth/` —— 认证、会话、TOTP、验证码
- `lib/storage/` —— 对象存储签名与键名
- `middleware.ts` —— 请求过滤
- `lib/security/` —— CSRF、响应头、净化
- `db/schema.ts` 与 `db/migrations/` —— 数据模型
- 任何 GitHub OAuth 回调代码

审查这些路径时，请特别留意：

1. 有没有输入未经 Zod 就进入逻辑。
2. 有没有判定被放在 DAL 之外。
3. 有没有密钥可能进入日志、错误信息或浏览器产物。
4. 有没有控制只存在于 middleware 或只存在于界面。
5. 有没有比较不是恒定时间的。
6. 新增的认证、解密或存储路径是否漏了限流。

---

## Henna 不会接受的东西

别把时间花在这些上，它们会被拒掉。

- **GitHub 之外的任何 OAuth/OIDC 提供方。** Google、Microsoft、Apple、通用 OIDC、
  邮箱服务商 OAuth 都不行。这是明确的约束。
- **任何在服务端存储邮件内容的东西。** 不要消息表、不要附件表、不要服务端全文索引。
  这是架构本身。
- **把 Magic Link 作为主认证方式**，或绕过口令策略的用户名口令流程。
- **禁用或削弱 Next.js 的 Server Action CSRF 保护。**
- **在安全关键路径里使用 `any`、`@ts-ignore` 或 `eslint-disable`。**
- **把带原生插件的依赖引入 Workers 产物** —— Workers 需要 `nodejs_compat` 兼容的包。
  这正是用 scrypt 而不是 Argon2id 的原因。
- **只存在于客户端的控制。**

另外：附件字节不得经过服务端。任何让 Henna 接收或保存文件正文的实现都会被拒。

---

## 测试是改动的一部分

- **`lib/crypto/`、`lib/auth/`、`lib/dal/`、`lib/storage/`、`lib/validation/` 里的新
  逻辑必须带单元测试。** 纯规则被有意与碰数据库的代码分开，以便不连 PostgreSQL 也能
  测试 —— 请保持这个分离。
- **新增的认证、授权或 CSRF 面必须带 E2E 测试。** 要测"被拒绝"，而不只是顺利路径：
  有意思的断言是请求被拒。
- **修 bug 要带回归测试。** 如果一个测试本来抓不住这个 bug，那修复就还没完成。

## 提交与 PR 约定

- 约定式提交：`feat:`、`fix:`、`chore:`、`docs:`、`test:`、`refactor:`、
  `security:`（用于修复漏洞）。
- 描述**为什么**，而不只是**做了什么**。安全相关改动请写明威胁。
- PR 保持聚焦。200 行的安全改动会被认真审；2000 行的只会被扫一眼。
- 若触及受保护路径，请在描述里注明，以便正确路由审查。

## 报告安全问题

不要开公开 issue。见
[docs/security.zh-CN.md](docs/security.zh-CN.md#报告漏洞)。

## 许可证

提交贡献即表示你同意你的作品以 AGPL-3.0-or-later 授权，与项目许可证一致。
