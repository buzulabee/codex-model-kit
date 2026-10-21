# GitHub Actions 与正式发布

源码与正式发布：[buzulabee/codex-model-kit](https://github.com/buzulabee/codex-model-kit)。构建和发布由 GitHub Actions 执行，安装包通过 GitHub Releases 分发。

## 工作流

配置：[.github/workflows/ci.yml](https://github.com/buzulabee/codex-model-kit/blob/main/.github/workflows/ci.yml)。使用 GitHub 标准托管的 Ubuntu 24.04 和 Node 24，不需要自托管 Runner 或个人发布令牌。官方 Actions 固定到提交 SHA。

1. PR 自动运行 `npm ci`、`npm run check` 和 `npm run release:package`，不发布。普通功能分支 push、标签 push 不另开流水线。
2. 合并 main 后检查实际合并提交，构建一次并保存 ZIP/SHA256 为 30 天 Actions Artifact。`package.json` 有变化时，必须是受保护 main，才选择发布。
3. `publish` 等待 `release` Environment 人工批准，通过固定 concurrency group 串行执行。仅此任务授予 `contents: write`，其他任务只读；PR 不使用写令牌，不使用 `pull_request_target`，不持久化 checkout 凭据。
4. publish 下载同一次工作流产物，不安装开发依赖、不重新构建。脚本核对源码属于远端 main、checkout 与 SHA 一致、既有标签不冲突、本地摘要有效、没有更高正式版本。
5. 先按精确源码 SHA 创建 draft Release，再上传 ZIP/SHA256。所有已有文件先比对，不删除、不覆盖；上传后实际重新下载校验，通过后才发布。再次核对正式 Release、实际标签和附件字节。
6. Release 保存 SHA256、源码 SHA 和 Actions 链接，正式附件作为长期安装入口；不是临时 Artifacts，也不是 Source code ZIP。不需要发布后的状态文档 PR。

默认 CI 不下载 Codex CLI，不执行 `npm run test:package`；本地可用已有 CLI 另行验证。Linux 成功不代表原生 Windows/macOS 安装、模型目录写入恢复或 Codex 页面已验收。

## 一次性仓库设置

在首次发布合并前由维护者核对，YAML 不能代替服务端设置：

- 仓库公开、默认分支 main。分支保护或 ruleset 要求 PR 和成功的 `Verify` 检查，禁止 force push 和删除。个人维护者仍可合并自己的 PR；不要设置无法满足的必需他人审批。
- Settings → Environments 创建 `release`，限制部署分支为 main，并配置 Required reviewers。个人仓库维护者需要能够批准自己的工作流，不开启 Prevent self-review。Environment 未配置时不得发布，不能依赖 GitHub 自动创建的无保护同名环境。
- Actions 默认工作流权限保持只读；publish 通过 job 权限使用短期 `GITHUB_TOKEN`，不新增 PAT、仓库 secret 或永久凭据。默认检查不缓存 PR 提供的依赖安装目录或构建输出。
- 推荐启用 Release immutability；脚本已采用 draft → 上传/校验 → 发布流程，兼容发布后锁定标签与附件。未实际启用时，不声称平台已强制不可变。

## 手动入口与重试

- 日常：功能分支改代码并运行 `npm run version:release` → 一个 PR 审核合并 → main 检查打包 → 人工批准 Environment 中的 Publish。
- 手动检查：Actions → CI → Run workflow，选择 main，保持 `publish=false`。明确要发布 main 当前版本时可选 `publish=true`；仍执行完整检查、main 保护及 Environment 审批，不绕过门禁。只允许尚未发布的新版本。
- publish 失败：在 Artifacts 有效期内只重跑失败的 publish job。相同工作流、相同字节允许恢复 draft 的缺失文件或只读核验正式 Release。不要重跑全部构建来替换原产物。
- 版本或文件冲突、原产物过期、已发布附件缺失：停止，发布新版本。不删除远端附件、不移动标签、不用其他来源或本地重建包顶替。
- 更高版本已经发布：旧工作流不得重新成为 latest；安装回退应显式选旧版原包。

## 公开前检查

公开提交前检查 tracked 文件、将推送的提交、常见敏感文件名、凭据格式及截图。实际用户配置、auth、依赖、测试输出和构建目录不入库；测试连接、模型和密钥必须使用明确的虚构数据。

规则扫描不是完整的秘密泄漏证明，仍需人工检查和 GitHub Secret scanning。提交信息、PR 标题和 Release 标题使用英文；默认 README 使用中文，英文入口为 [README.en.md](README.en.md)。
