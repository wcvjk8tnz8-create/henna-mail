# Documentation / 文档

| 语言 / Language | 说明 |
| --- | --- |
| [English](README.md) | 默认语言 |
| [简体中文](README.zh-CN.md) | Simplified Chinese |

每份文档都有英文与简体中文两个版本。切换入口在各文档顶部的语言栏。

---

## 索引

### 入门与部署

| 主题 | English | 简体中文 |
| --- | --- | --- |
| 项目总览与快速开始 | [README](../README.md) | [README.zh-CN](../README.zh-CN.md) |
| 自托管（Node.js） | [self-hosting.md](self-hosting.md) | [self-hosting.zh-CN.md](self-hosting.zh-CN.md) |
| Cloudflare Workers 部署 | [cloudflare-deployment.md](cloudflare-deployment.md) | [cloudflare-deployment.zh-CN.md](cloudflare-deployment.zh-CN.md) |

### 设计与安全

| 主题 | English | 简体中文 |
| --- | --- | --- |
| 架构与数据流 | [architecture.md](architecture.md) | [architecture.zh-CN.md](architecture.zh-CN.md) |
| 安全模型与威胁分析 | [security.md](security.md) | [security.zh-CN.md](security.zh-CN.md) |
| 对象存储（R2 / S3） | [storage.md](storage.md) | [storage.zh-CN.md](storage.zh-CN.md) |

### 参与项目

| 主题 | English | 简体中文 |
| --- | --- | --- |
| 贡献指南 | [../CONTRIBUTING.md](../CONTRIBUTING.md) | [../CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) |
| 依赖许可证 | [licenses.md](licenses.md) | [licenses.zh-CN.md](licenses.zh-CN.md) |

---

## 一句话边界

> 邮件正文、附件内容与搜索索引都不经过 Henna 服务端落盘或写入日志。

附件走对象存储：浏览器用预签名 URL 直连 R2 或任意 S3 兼容服务，Henna 只负责签名，
不接触字节。详见 [storage.md](storage.md)。
