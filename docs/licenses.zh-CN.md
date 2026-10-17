# 依赖许可证

**[English](licenses.md) | [简体中文](licenses.zh-CN.md)**

Henna 采用 **AGPL-3.0-or-later**。下表每一项依赖都允许随 AGPL 软件一起分发。
本文记录这次审查的结论。

---

## 为什么有这个文件

AGPL-3.0 是强 copyleft。加入一个条款与之冲突的依赖不是文书问题 —— 它会改变
下游所有人能对 Henna 做什么。因此每个依赖的许可证在引入前都被检查过，并记录在此。

## 运行时依赖

| 包 | 许可证 | 说明 |
| --- | --- | --- |
| `next` | MIT | 框架，App Router |
| `react`、`react-dom` | MIT | UI 运行时 |
| `drizzle-orm` | Apache-2.0 | 数据库访问，仅参数化查询 |
| `pg` | MIT | PostgreSQL 驱动（Node.js 路径） |
| `zod` | MIT | 输入校验与类型推导 |
| `jose` | MIT | 会话令牌签发与校验 |
| `otpauth` | MIT | TOTP 生成与校验。纯 TypeScript，无原生代码，可在 Workers 运行 |
| `next-auth` | ISC | Auth.js v5 会话管道 |
| `resend` | MIT | 事务邮件发送 |
| `jmap-kit` | MIT | 浏览器路径使用的 JMAP 客户端 |
| `framer-motion` | MIT | 分层页面过渡 |

### 关于 SigV4 的一段说明

附件签名**没有**引入 AWS SDK。`@aws-sdk/s3-request-presigner` 会带进一棵重度依赖
Node.js 内建模块的依赖树，在 Cloudflare Workers 上很别扭，而且远超 Henna 所需。
查询串预签名的 SigV4 本质上就是 HMAC 与十六进制编码，约一百来行，而这两个原语在
Henna 的每个运行环境里都有：Node 20+ 的 `node:crypto` webcrypto，以及 Workers 上的
原生 `crypto` 全局。实现已与独立的 `aws4` 实现做交叉比对验证。

## 开发依赖

| 包 | 许可证 | 说明 |
| --- | --- | --- |
| `typescript` | Apache-2.0 | 语言与类型检查 |
| `vitest` | MIT | 单元测试运行器 |
| `@playwright/test` | Apache-2.0 | 端到端测试 |
| `@biomejs/biome` | MIT | 检查与格式化，取代已废弃的 `next lint` |
| `@opennextjs/cloudflare` | MIT | Workers 适配器 |
| `wrangler` | MIT（部分组件 Apache-2.0） | Workers CLI |
| `drizzle-kit` | Apache-2.0 | 迁移工具 |
| `tailwindcss`、`@tailwindcss/postcss` | MIT | 样式 |
| `@types/*` | MIT | 类型定义 |
| `@cloudflare/workers-types` | MIT | Workers 环境类型 |

## 新增依赖前

两项检查：

1. **许可证兼容。** MIT、Apache-2.0、ISC、BSD 都可以。与 AGPL-3.0 条款冲突的不可以。
   不确定就开 issue 问，别猜。
2. **Workers 兼容。** Cloudflare Workers 无法加载原生插件。这是 Henna 用
   `node:crypto` 的 **scrypt** 而非 Argon2id 的原因，也是 TOTP 选 `otpauth` 而非带
   原生绑定的包的原因。任何把 `.node` 文件带进产物的依赖，都会在本地构建成功、
   在生产环境失败。

## 重新生成这份审查

```bash
npx license-checker --production --summary
npx license-checker --development --summary
```

若输出与上表不符，请在与依赖变更同一个 PR 里更新本文件。

## Henna 自身的许可证

见仓库根目录的 [LICENSE](../LICENSE)。
