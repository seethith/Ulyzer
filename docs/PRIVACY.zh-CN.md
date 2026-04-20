# 隐私说明

[中文](PRIVACY.zh-CN.md) | [English](PRIVACY.en.md)

Ulyzer 默认将应用数据存储在本地，但部分功能会调用你配置的第三方服务。

## 本地数据

在 macOS 上，Ulyzer 的数据通常位于：

- `~/Library/Application Support/Ulyzer/ulyzer.db`
- `~/Library/Application Support/Ulyzer/ulyzer-content/`

SQLite 数据库包含课程、DAG 节点、对话历史、设置和 token 用量元数据。内容文件夹包含生成的或用户创建的学习文件。

## API Key

模型服务商 Key 通过 `keytar` 存储在操作系统 Keychain 中。它们不应被写入项目文件、生成的学习文件或日志。

## 第三方请求

当你使用云端模型服务商时，Ulyzer 会把相关提示词、对话上下文和受支持的附件发送给你选择的服务商。当启用搜索功能时，搜索查询可能会发送给 Tavily、Exa 或 YouTube Data API。

如果希望减少第三方数据传输，可以使用 Ollama 等本地模型，并不配置搜索 API Key。

## 附件

文本/代码附件可能会被加入提示词。图片只会发送给支持视觉输入的模型。PDF 当前主要面向支持 PDF/document 输入的服务商。

如果附件可能包含私人或敏感信息，请在发送前自行检查。
