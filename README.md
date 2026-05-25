# Ulyzer

[中文](README.md) | [English](README.en.md)

**AI 驱动的个人知识图谱学习工具。** 把任意学习目标拆解为知识图谱（DAG），由 AI 导师陪你逐节点完成学习、练习与复盘。

> 🚧 开发中 · macOS 优先 · 欢迎 Star 和反馈

![Ulyzer 截图](docs/assets/ulyzer-screenshot.png)

---

## 核心功能

- **课程路线图（DAG）** — AI 根据你的目标、基础和时间自动生成学习路线图，节点间依赖关系清晰可视
- **知识纲要系统** — 每个节点生成 v1→v2→v3 三个深度的 KC 知识纲要，从入门到综述论文级别
- **AI 导师对话** — 主导师负责规划调整，副导师驻扎每个节点，生成讲解资料、练习题和参考答案
- **费曼复盘** — 学完节点后生成深度复盘清单，帮助检验真实掌握程度
- **本地文件优先** — 所有生成内容以 Markdown 文件存储在本地，可自由编辑，支持 Mermaid 图表渲染
- **RAG 检索** — 基于已有资料进行语义检索，避免重复生成
- **多模型支持** — 支持切换不同 AI 提供商和模型

---

## 支持的 AI 提供商

Anthropic · OpenAI · DeepSeek · Google Gemini · xAI Grok · 阿里云通义千问 · MiniMax · OpenRouter · Ollama（本地）· 任意 OpenAI 兼容接口

---

## 本地运行

### 环境要求

- Node.js 18+
- macOS（Windows/Linux 理论可用，未完整测试）

### 安装和启动

```bash
git clone https://github.com/seethith/Ulyzer.git
cd Ulyzer
npm install
npm run dev
```

### 打包

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

---

## 发布版本（维护者）

应用内置**半自动更新**：启动时（及设置页「检查更新」）会读取本仓库 GitHub Releases 的最新版本号，与当前版本比对，发现新版就在顶部横幅提示「发现新版本，是否下载」，点击后用系统浏览器打开 Release 页（不自动下载/安装，因此无需代码签名）。

每次发版步骤：

1. **升版本号** — 修改 `package.json` 的 `version`（如 `0.1.0-alpha → 0.2.0`，遵循 [semver](https://semver.org)）。
2. **构建产物** — `npm run build:mac` / `build:win` / `build:linux`，产物在 `release/`。
3. **建 GitHub Release** — tag 用 `v0.2.0`（带 `v` 前缀），附上 `.dmg`/`.exe` 等安装包，写更新说明；alpha/beta 版勾选 **pre-release**。
   - 偷懒方式：配置好 `GH_TOKEN` 环境变量后执行 `npx electron-builder --publish always`，自动建 Release 并上传产物（仓库已在 `electron-builder.yml` 配好 `publish: github`）。

> 更新器默认接收预发布版本（应用处于 alpha 阶段），用户可在「设置 → 关于」里关闭。

---

## 配置 API Key

启动后进入 **设置 → 模型设置**，为你使用的提供商填入对应的 API Key。

Key 通过系统 Keychain 安全存储，不会出现在任何文件或日志中。

如果你只想本地运行不花钱，可以配置 [Ollama](https://ollama.com) 使用本地模型。

---

## 文档

- [隐私说明](docs/PRIVACY.zh-CN.md)
- [贡献指南](CONTRIBUTING.md)
- [安全报告](SECURITY.md)

---

## 数据存储

应用数据默认存储在本地：

- **数据库**：`~/Library/Application Support/Ulyzer/ulyzer.db`（SQLite）
- **学习文件**：`~/Library/Application Support/Ulyzer/ulyzer-content/`（Markdown 文件）

使用云端模型或联网搜索时，相关提示词、附件片段和查询内容会发送给你配置的第三方服务商。若希望尽量减少外部数据传输，可以使用 Ollama 等本地模型，并不配置 Tavily / Exa / YouTube 搜索 API Key。

---

## 技术栈

站在这些优秀开源项目的肩膀上：

- **桌面框架**：Electron · electron-vite
- **前端**：React · TypeScript · Tailwind CSS · Zustand · React Router
- **编辑器 / 画布**：CodeMirror · Monaco Editor · React Flow
- **内容渲染**：marked · highlight.js · KaTeX · Mermaid · DOMPurify
- **文档抽取**：Mozilla Readability · mammoth · pdf-parse
- **数据 / 存储**：better-sqlite3（SQLite FTS5 全文检索）· keytar
- **模型 / 国际化**：Anthropic SDK · OpenAI SDK · tiktoken · i18next

界面字体使用 [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)，图标来自 [Lucide](https://lucide.dev)。PDF/图片 OCR 等功能内置无需安装；视频字幕、本地语音转写等可选功能可在「设置 → 高级」一键安装（详见[外部工具说明](docs/EXTERNAL-TOOLS.md)）。

---

## 维护与支持

Ulyzer 是个人业余维护的开源项目，按精力尽力而为，不保证响应时间：

- **Bug 报告**：欢迎用 [Issues](https://github.com/seethith/Ulyzer/issues)，请附上系统、版本和复现步骤。
- **功能请求**：欢迎讨论，但不承诺实现或排期。
- **Pull Request**：欢迎，建议先开 issue 讨论方向；是否合并由维护者决定。
- **安全问题**：请**不要**公开提 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

---

## License

[MIT](LICENSE) © 2025 seethith
