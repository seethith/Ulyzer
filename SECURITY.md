# Security Policy

> 中文说明见下方。English policy follows after the Chinese section.

## 中文

Ulyzer 是本地优先的 Electron 应用，但它可以访问本地学习文件，也会向用户配置的第三方模型服务商发送请求。请在公开 issue 前私下报告安全问题。

### 适合报告的问题

- 硬编码密钥或意外凭据泄露。
- IPC 路径允许读取、写入或删除 Ulyzer 内容工作区之外的文件。
- 不安全的 URL 打开、renderer 到 main 的权限提升。
- Prompt/tool 行为可以写出当前节点工作区。
- 日志、崩溃报告或生成文件泄露敏感数据。

### 如何报告

如果 GitHub 仓库开启了 private security advisory，请优先使用它；否则通过仓库 profile 中的维护者联系方式联系。请包含：

- 受影响版本或 commit。
- 复现步骤。
- 预期影响和实际影响。
- 你建议的缓解方式（如果有）。

在修复发布前，请不要公开漏洞细节。

---

## English

Ulyzer is a local-first Electron app, but it can access local learning files and send model requests to configured third-party providers. Please report security issues privately before opening public issues.

## What to report

- Hardcoded secrets or accidental credential exposure.
- IPC paths that allow reading, writing, or deleting files outside the Ulyzer content workspace.
- Unsafe URL opening or renderer-to-main privilege escalation.
- Prompt/tool behavior that can write outside the current node workspace.
- Sensitive data leaks through logs, crash reports, or generated files.

## How to report

Open a private security advisory on GitHub if available, or contact the maintainer through the repository profile. Include:

- Affected version or commit.
- Steps to reproduce.
- Expected and actual impact.
- Any suggested mitigation.

Please do not publish exploit details until a fix is available.
