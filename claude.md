# Ulyzer 项目说明

## 项目概述
Electron + React + TypeScript 桌面学习应用。

## 技术栈
- 构建工具：electron-vite
- 前端：React 19 + TypeScript + Tailwind CSS 4
- 状态：Zustand + Immer
- 数据库：better-sqlite3（主进程）+ SQLite FTS5（全文检索）
- LLM：统一 LLMAdapter 层，支持 Claude / OpenAI / DeepSeek / Gemini / Grok / Qwen / Ollama 等

## 强制规则（违反则重做）
1. 所有 IPC channel 名称必须从 `shared/ipc-channels.ts` 导入，禁止硬编码字符串
2. LLM 调用必须全部经过 `src/main/services/llm/adapter.ts`，禁止在其他地方直接调用 SDK
3. API Key 只能通过 `keytar` 存取，禁止出现在任何文件或日志中
4. 数据库操作只能在主进程 Repository 层，渲染进程只能通过 IPC 访问
5. TypeScript 严格模式，所有类型必须定义，禁止使用 `any`
6. 文件夹 key 必须使用英文标识符（`theory`/`practice`/`answer`/`notes`/`feynman`/`outline`），通过 `getFolderPath()` 解析路径，禁止直接传中文文件夹名

## 常用命令
- 开发：`npm run dev`
- 构建：`npm run build`
- 打包（Mac）：`npm run build:mac`
- 类型检查：`npx tsc --noEmit`
