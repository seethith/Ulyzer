# Contributing

> 中文说明见下方。English guide follows after the Chinese section.

## 中文

Ulyzer 仍处于早期阶段，小而聚焦的贡献最容易被 review 和合并。

### 适合优先贡献的内容

- 修复可复现的 bug。
- 改进文档、截图或演示说明。
- 为现有行为补测试。
- 改善模型服务商兼容性，但不要顺手改无关流程。
- 优化 UI 细节，并附上修改前后的截图。

如果是较大的功能，请先开 issue 描述使用场景和大致方案。

### 本地检查

提交 PR 前请先运行：

```bash
npm run typecheck
npm test
npm run lint
```

### PR 注意事项

- 一个 PR 只解决一个问题。
- UI 改动请附截图或短录屏。
- 涉及模型服务商、文件系统、数据库、隐私影响时，请在 PR 描述中说明。
- 不要提交生成物，例如 `out/`、`dist/`、`.DS_Store` 或 `*.tsbuildinfo`。

---

## English

Ulyzer is still early-stage, so small focused contributions are easiest to review.

## Good first contributions

- Fix reproducible bugs.
- Improve documentation and screenshots.
- Add tests around existing behavior.
- Improve provider compatibility without changing unrelated flows.
- Polish UI details with before/after screenshots.

For larger features, please open an issue first and describe the use case.

## Local checks

Run these before opening a pull request:

```bash
npm run typecheck
npm test
npm run lint
```

## Pull request notes

- Keep PRs focused on one problem.
- Include screenshots or short recordings for UI changes.
- Mention any provider, filesystem, database, or privacy impact.
- Avoid committing generated files such as `out/`, `dist/`, `.DS_Store`, or `*.tsbuildinfo`.
