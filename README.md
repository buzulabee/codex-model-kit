# Codex 模型工具

[简体中文](README.md) | [English](README.en.md)

在 Codex 里刷新供应商模型、编辑参数、调整菜单顺序，确认后同步到本地模型目录。

**只管理 `model_catalog_json`，不修改连接配置、密钥或当前模型。**

[安装与更新](#安装更新与卸载) · [使用说明](docs/usage.md) · [最新正式版](https://github.com/buzulabee/codex-model-kit/releases/latest) · [验收记录](ACCEPTANCE.md)

![模型列表：查看已有配置、筛选模型并编辑参数](docs/screenshots/model-list.png)

> 截图来自当前生产 UI 的离线测试，连接、模型和密钥均为虚构数据，不代表真实供应商或原生 Codex 宿主验收。

## 安装、更新与卸载

在要安装插件的电脑上打开 Codex，发送：

```text
请按 README 安装或更新这个插件：https://github.com/buzulabee/codex-model-kit
```

需要可用的 Node >=24 和支持插件命令的原生 Codex CLI；优先复用客户端运行时，不自动安装 Node。**已有旧版也使用同一句话更新。**

### 给执行安装的模型

1. 先读取默认分支的 [INSTALL.md](INSTALL.md)，按其中的执行步骤完成安装或更新，不因“已安装”跳过版本检查。
2. 从[最新正式 Release](https://github.com/buzulabee/codex-model-kit/releases/latest) 获取同版本 ZIP 与 SHA256，核对发布说明、校验文件和实际摘要一致。源码版本不代表已发布；不使用 Source code ZIP，不克隆源码或运行 npm。
3. 安装到当前用户的 `CODEX_HOME/marketplaces/codex-model-kit`（默认 `~/.codex/marketplaces/codex-model-kit`），先执行包内安装器的检查，再安装。只通过官方 CLI 注册，不手改托管缓存、连接配置、凭据或模型目录。
4. 核对 CLI 的 installed/enabled 版本，报告目标路径和结果；请用户在**新会话**打开插件，核对右上角版本。未操作真实宿主时，明确页面待确认。

无正式 Release、无权限、缺运行时或安装失败时停止并报告具体原因，不自行拼装手工安装流程。完整命令、失败处理和卸载步骤见 [INSTALL.md](INSTALL.md)。

## 使用

1. 从 Codex 侧边栏打开插件，检查读取到的已有配置。
2. **刷新供应商模型**，勾选需要保留的模型；用行内设置编辑参数，也可手动添加模型。
3. 点击**更新模型列表**，修正未知参数，再调整顺序；可先**预览变更**，确认后写入。
4. 写入或恢复后重启 Codex，使模型菜单及顺序生效；恢复入口在**写入记录与恢复**。

<details>
<summary>查看写入预览</summary>

![写入预览：核对目标、差异和完整 JSON 后确认](docs/screenshots/write-preview.png)

预览不写文件，关闭弹框也不写入。确认写入前会检查冲突并备份原文件。

</details>

直连检测是可选操作，需单独确认，会向供应商发送请求并消耗 token；通过只代表本次基础文本流测试成功，不保证所有模型能力。参数规则、备份恢复及安全边界见[使用说明](docs/usage.md)。

## 开发

需要 Node >=24 和 `zip`，在源码仓库运行：

```sh
npm ci
npm run check
npm run release:package
```

[开发与发布检查清单](docs/development.md) · [CI 与正式发布](CI.md) · [Windows 支持边界](WINDOWS.md)

`.claude-plugin/marketplace.json` 是当前 Codex 安装流程使用的兼容 marketplace 清单，不是闲置的 Claude 插件目录；构建、版本同步和安装校验均依赖它，不能直接删除。
