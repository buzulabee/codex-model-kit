# 开发与发布

[返回 README](../README.md) · [CI 与发布配置](../CI.md) · [验收记录](../ACCEPTANCE.md)

## 本地开发

项目由 Codex 插件、本地 STDIO MCP 后端和 React MCP App UI 组成，不另建桌面应用。开发需要 Node >=24 和 `zip`；分发包不含 Node，运行时不需要源码、npm 或 `node_modules`。

```sh
npm ci
npm run check
npm run release:package
```

`check` 覆盖 Prettier、严格 TypeScript、单元/STDIO/loopback 测试、构建和 preflight；未配置独立 lint。文档调整另运行 `npx prettier --check docs`。默认 CI 不下载 Codex CLI，也不跑真实 CLI 安装/更新/回退测试。

本机已有支持插件命令的 CLI 时，可选执行 `npm run test:package`，验证隔离安装、更新、回退、卸载、版本化 UI 资源和安全边界，不为测试下载 CLI。

浏览器 UI QA 需要现有 Playwright/Chrome：

```sh
MODEL_KIT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --import tsx scripts/ui-qa.ts
```

QA 使用虚构连接/模型/密钥及隔离目录，证据输出到忽略的 `.test-artifacts/`，不发送真实推理请求或自动重启 GUI，不代替日常插件入口。README 截图选取该脚本的 `order-ui-desktop.png` 与 `order-ui-preview.png`，作为文档资源保存在 `docs/screenshots/`；更新时先检查没有真实配置或凭据。

离线更新公开参数快照时，先取得注明来源的公开输入，不使用用户配置或凭据：

```sh
node scripts/update-reference-metadata.mjs <CC-Switch-v4.0.10-codexProviderPresets.ts> <models.dev-api.json>
npm run format
npm run check
```

新模型的官方参数补充单独维护在 `src/catalog/official-reference-metadata.json`，记录精确模型 ID、官方来源 URL 和核实日期。只添加目录支持且已核实的字段，不将最大输出长度当作上下文；该文件不会被上述快照生成脚本覆盖。同地址预设优先于官方补充，官方补充优先于旧原厂快照；供应商声明和本地设置的优先级保持不变。

## 为什么保留 .claude-plugin

当前 `.claude-plugin/marketplace.json` 是 Codex 使用的兼容 marketplace 清单，不表示本项目另有 Claude 插件功能：

- `scripts/build.mjs` 将它复制到 `dist/marketplace/.claude-plugin/marketplace.json`；清单将插件名映射到 `./plugins/codex-model-kit`。
- `scripts/release-version.mjs` 同步其中的版本，`scripts/preflight.mjs` 校验版本一致性。
- `scripts/install/installer.mjs` 读取稳定源中的该清单，安装事务和 Windows QA 也依赖此结构。

因此当前不能删除。未来若迁移 marketplace 格式，需要连同构建、安装、校验和回归测试一起迁移，不在文档清理中改动安装协议。

## 发布前检查清单

1. 功能分支准备提交时运行 `npm run version:release`，同步 `package.json`、`package-lock.json`、`.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`src/shared/security.ts` 五处版本。版本使用上海发布分钟，显示、标签和 ZIP 文件名采用 `vYYYY.MMDD.HHmm`，日期和时间均补足四位，零点为 `0000`；清单和协议 VERSION 遵循 SemVer，不带 `v`、不保留数字前导零。例如 1 月 5 日 09:03 显示为 `v2026.0105.0903`，清单为 `2026.105.903`；10 月 21 日 09:45 显示为 `v2026.1021.0945`，09:54 则为 `v2026.1021.0954`。使用共享 `releaseTag` 函数转换，不手工拼接版本。不同内容不能复用同一版本。
2. 确认 `UI_URI` 仍由 `VERSION` 生成，所有工具的 UI 元数据与资源读取均指向它。任何已分发 HTML/CSS/JS 变化都要新版本和新 URI；只改清单不够，复用 URI 可能使宿主显示缓存页面。
3. 运行 `npm run check` 和 `npm run release:package`，确保清单、`main.html`、`server.mjs` 来自同一次构建。文档/截图应在插件和 ZIP 中可读取，包内 README/验收/CI 是构建快照，不代表当前发布状态。
4. 按 [INSTALL.md](../INSTALL.md) 使用稳定源及官方安装器更新；不要直接注册工作区的 `dist/marketplace`，不要将默认 `node` 模板当作已检查的客户端运行时。
5. 在**新会话**打开插件，对照侧边栏版本、页面右上角版本及本次可见行为。安装不会热替换旧 MCP 实例；新会话仍旧时先检查版本、URI、稳定源及官方安装结果，关闭旧页重新打开，仍旧才考虑重启。不编辑托管缓存。
6. UI 变更运行 `scripts/ui-qa.ts`：未知参数应在排序前明确显示“未写入”，不生成写入计划、不弹成功提示；覆盖修正后排序、编辑、关闭弹框、失败不写入、宽窄屏问题行布局。新增弹框/提示复用图标关闭入口并保留可访问名称和悬停提示。
7. 安装器变更覆盖 name/root-only 元数据、跨版本 add-first 更新、核验同版本 no-op、回退与清理警告。条件允许时执行 Windows 原生隔离 QA，保留旧后端运行并真实持有 deny-delete 文件句柄；不修改真实安装、不杀用户进程。`cleanup_pending` 不等于安装失败。
8. 写入/备份/恢复变更，在 Windows 原生 Node >=24 的临时虚构目录运行 `tests/writer.test.ts` 和 `tests/catalog-write-protocol.test.ts`，覆盖已有/首次新建、冲突、回退和恢复；WSL/Linux 不替代 Windows 文件系统验证，不使用真实 `CODEX_HOME` 或业务目录做自动回归。
9. 在 [ACCEPTANCE.md](../ACCEPTANCE.md) 分别记录自动测试、CLI、原生宿主结果及未验证范围。构建、隔离测试或 CLI 成功不等于原生页面通过，macOS 不等于 Windows 通过；未实际验收须注明待确认。

纯文档修改不改插件版本、不发布，也不替换同版本线上 ZIP。需要将更新后的文档纳入正式安装包时，随下一次新版本发布，安装始终以最新正式 Release 为准。

## 文档与提交规范

- 提交信息、PR 标题和 Release 标题使用英文。
- `README.md` 为默认中文版，`README.en.md` 为对应英文版，两份文档保留相互切换入口。
- 用途、安装提示、操作流程和安全边界在两个 README 中保持一致。当前 UI 和详细指南使用中文，英文 README 明确标注，不声称应用已经支持英文界面。
- 两个 README 都必须进入构建产物和发布 ZIP，文档中的本地相对链接必须有效。

## 团队发布流程

默认流程：**GitHub 开发分支改代码并升版本 → 一个 PR 审核合并 → main 检查并构建 → 人工批准 release Environment 中的 Publish**。

- 仅向 canonical GitHub 仓库推送代码和发布新版本。公开提交前检查源文件、将推送的提交及截图中的凭据。
- PR 自动检查、构建及打包，不发布；普通开发分支和标签 push 不另开工作流。合并后检查实际 main 提交，main 保护与 Environment 审批须提前配置，见 [CI.md](../CI.md)。
- main 构建一次；`package.json` 有变化时选择发布，publish 串行复用同一次 Actions 的 ZIP/SHA256，不重新构建。纯文档/CI 改动不改 `package.json` 时只检查。
- 使用短期 `GITHUB_TOKEN`，仅 publish 授予 `contents: write`。先按源码 SHA 创建 draft Release，再上传并实际下载核验附件，最后发布并核对标签；同版本不同字节拒绝覆盖，相同字节允许恢复同工作流的部分上传或只读重试。
- Release 自动记录版本、源码、工作流、ZIP/SHA256 下载地址及摘要，不需手动建标签、单独准备 PR 或发布后的状态文档 PR。Release 附件是长期分发入口，30 天 Actions Artifacts 不是长期下载地址。
- 不使用 Git 分支分发安装包；未经真实作业通过，不宣称 GitHub CI 或发布已验证。原生宿主验收仍与构建、CLI、Linux 自动检查分开记录。
