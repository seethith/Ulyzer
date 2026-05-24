# 外部工具说明 / External Tools

Ulyzer 的**核心学习功能**（学习路线图、AI 导师对话、Markdown 编辑、RAG 检索）开箱即用，不依赖任何外部工具。下面这些工具仅服务于**可选的多媒体 / 文档增强功能**，按获取方式分三类。

> The core features work out of the box. The tools below only power optional
> multimedia / document features and fall into three tiers.

---

## 1. 随软件内置，无需安装 · Bundled

- **Swift OCR / PDF 引擎**（仅 macOS）：PDF 文字识别、PDF 页面渲染、图片 OCR。
  基于 macOS 的 Vision / PDFKit 框架，在打包时预编译为原生二进制随应用一起分发，
  **下载即用，无需安装 Xcode 或命令行开发者工具**。

  *PDF/image OCR and PDF page rendering use macOS Vision/PDFKit, precompiled to
  native binaries and shipped with the app — no Xcode toolchain needed.*

---

## 2. 软件内一键安装 · One-click in Settings → Advanced

- **yt-dlp**（视频字幕 / 信息抓取）：在「设置 → 高级」点击安装。
  优先从 GitHub 下载，并**内置国内镜像回退**；也识别系统代理（`HTTPS_PROXY` 等环境变量）。
- **本地语音转写 mlx-whisper**（仅 Apple Silicon / M 系列 Mac）：在「设置 → 高级」一键安装，
  会自动创建 Python 虚拟环境并下载 mlx-whisper（需联网，约数百 MB）。

  *yt-dlp installs from GitHub with built-in mirror fallback; mlx-whisper sets up
  a Python venv on Apple Silicon Macs. Both are one-click in Settings → Advanced.*

---

## 3. 需自行安装 · Install yourself

- **ffmpeg**（音频处理，本地语音转写的前置）：因体积较大且采用 LGPL/GPL 许可证，
  不随软件分发。请自行安装：
  - macOS：`brew install ffmpeg`
  - 或从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载。
  - 安装后重启应用，即可在「设置 → 高级」看到检测状态。

  *ffmpeg is not bundled (size + LGPL/GPL licensing). Install via `brew install
  ffmpeg` or ffmpeg.org, then restart the app.*

---

## 说明 · Notes

- 这些工具缺失或失败时，**只影响对应的可选功能，不影响核心学习功能**。
- 「设置 → 高级」会显示每个工具的状态（已就绪 / 未安装）。
- 网络受限时：yt-dlp 自动走内置镜像；whisper / ffmpeg 可配置代理或手动安装。
