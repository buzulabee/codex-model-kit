# 安装发布包

仓库：https://github.com/buzulabee/codex-model-kit

**推荐入口：[README.md](README.md) 的一句话安装。** 安装和更新使用同一流程；安装已发布的包不需要克隆源码、运行 npm、启动或等待流水线。

## 给执行安装的模型

用户说“安装这个插件”时，直接完成以下步骤，已有旧版也要检查更新，不要求用户复制长命令：

1. 读取项目默认分支的 README 和本页，识别目标电脑的系统及 Codex 环境。查询[最新正式 Release](https://github.com/buzulabee/codex-model-kit/releases/latest)；必要时读取 [Releases API](https://api.github.com/repos/buzulabee/codex-model-kit/releases/latest)，选择已发布、非 draft、非 prerelease 的最新正式版本。用户明确指定版本时选该正式 Release，不根据源码版本或本机已装版本推断最新。
2. 下载 Release 关联的同版本 ZIP 与 SHA256，核对实际 ZIP 摘要、校验文件与 Release 描述中的 SHA256 三者一致，再解压。不要使用 Source code ZIP。没有正式发布时停止；无权限或下载返回登录页时报告访问问题，不索取或记录访问令牌，不回退到源码或旧产物分支。
3. 优先复用客户端提供的 Node >=24 和原生 Codex CLI，按下节识别实际路径；必要时使用客户端运行时查询工具。不要硬编码维护者路径、混用 Windows/WSL、安装 Node 或修改系统 PATH；缺运行时、CLI 或权限时停止并报告。
4. 安装前说明稳定目标是当前用户的 `CODEX_HOME/marketplaces/codex-model-kit`，未设置时为用户主目录下 `.codex/marketplaces/codex-model-kit`。按对应平台先执行包内安装器的 `-Check` / `--check`，通过后再安装；完整命令见下文。不修改全局执行策略或绕过企业限制。
5. 由安装器校验文件、设置已检查的原生启动路径，通过官方 `codex plugin` 命令安装或更新。不手改托管缓存、连接配置、凭据、当前模型或模型目录，不自动刷新供应商、测试推理、写入模型或重启客户端。
6. 核对官方 CLI 的 installed/enabled 版本，报告 Release 版本、安装路径与结果。提醒用户在**新会话**从侧边栏打开插件，核对右上角版本；能实际操作宿主时再验收页面，否则明确待确认。新会话仍旧时才考虑重启；团队历史验收不替代本次目标电脑核对。

失败时报告阶段、当前状态与脱敏诊断，不自行改写安装器、手动切换稳定源、删除缓存、终止进程或绕过策略。`cleanup_pending` 只表示安装器暂存目录待清理，不推翻已核验成功的结果，详见末节。

包内 README/验收/CI 是构建时快照，实际版本、源码提交、下载和摘要以 [Release](https://github.com/buzulabee/codex-model-kit/releases) 为准；查找更新读取默认分支，不为更新发布状态重建或替换同版本 ZIP。

下载目标版本的 `codex-model-kit-v年份.月份日期.时分.zip` 和同名 `.zip.sha256`，不要下载 GitHub 自动生成的 Source code ZIP 代替插件包。公开包无需访问令牌。下载返回登录页、限流或网络错误时停止并报告，不在命令行、聊天或仓库中填写访问令牌，也不使用其他来源的附件代替。

## 运行时和安全边界

- 插件需要 Node >=24。优先使用当前桌面客户端提供的 `CODEX_MCP_NODE_PATH`，其次使用可用的 Node；不需要单独安装 npm 或开发依赖。运行时版本会在安装前实际执行检查，不符合时停止，不自动安装 Node、不修改系统 PATH。
- 需要支持 `codex plugin` 命令的原生 Codex CLI。优先使用客户端提供的 `CODEX_CLI_PATH`，否则使用 PATH 中的 `codex`。Windows 的 npm `.cmd` 包装器不能作为原生启动文件；请显式指定实际的 `codex.exe`。
- 安装器只通过官方 CLI 修改插件注册/启用元数据，把发布包复制到自己的 `${CODEX_HOME}/marketplaces/codex-model-kit`（默认用户主目录下 `.codex`）。它在稳定源中生成包含已验证 Node 绝对路径的 `.mcp.json`，不再依赖 `/bin/sh`，不编辑托管 cache。
- 不修改中转站、凭据、当前模型或模型目录，不自动刷新模型、测试推理或重启客户端。安装前后在内存比较除插件元数据外的配置和已配置目录，不保存含秘密的配置副本。安装源不应位于临时目录；解压目录可以在安装成功后清理。
- Windows 用户已反馈安装和拉取供应商模型可用；保存与恢复还需在对应修复版本的真实宿主中验收。macOS 或 Windows 原生 Node 的隔离文件测试不等于真实业务目录验收。Windows 写入回执为文件已同步并回读校验，不承诺父目录项 fsync 或异常断电持久化；文件权限、同步和冲突错误仍会拒绝写入。先核对页面和版本，业务写入另行明确确认。

## Windows

模型目录使用用户可控的本地 NTFS 普通文件；UNC 网络目录、设备/ADS 路径和最终符号链接不支持，不绕过 ACL 或文件占用限制。Codex 更新若移除安装时记录的 Node 路径，重新按本页运行安装器，不手改 cache。诊断复制与详细验证边界见 [WINDOWS.md](WINDOWS.md)。

用 PowerShell 在 ZIP 所在目录验证校验值，将文件名替换为实际下载版本：

```powershell
$zip = '.\codex-model-kit-v年份.月份日期.时分.zip'
$expected = ((Get-Content -LiteralPath "$zip.sha256" -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'SHA256 mismatch; stop' }
Expand-Archive -LiteralPath $zip -DestinationPath '.\codex-model-kit-release'
Set-Location '.\codex-model-kit-release'
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`-Check` 只检查运行时、包内文件校验、CLI 和安装目标，不注册插件；检查通过再执行安装。`ExecutionPolicy Bypass` 仅作用于本次子进程，不使用 `Set-ExecutionPolicy` 修改全局策略；企业策略禁止运行时应停止并联系管理员，不绕过企业限制。

如果当前 Codex 环境没有导出客户端 Node/CLI 路径，可使用该客户端可用的运行时查询工具取得实际路径，再明确传入；不要搜索/复制他人的缓存路径或硬编码维护者路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NodePath '实际的客户端 node.exe 路径' -CodexPath '实际的 codex.exe 路径' -Check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NodePath '实际的客户端 node.exe 路径' -CodexPath '实际的 codex.exe 路径'
```

路径包含空格时照常加引号。自定义 `CODEX_HOME` 时先在当前进程设置 `$env:CODEX_HOME`，不要改到 WSL 的 Linux 用户目录；此安装流程针对 Windows 原生客户端。

## macOS / Linux

先使用系统 SHA256 工具核对 `.zip.sha256`，再解压进入发布包目录：

```sh
sh ./install.sh --check
sh ./install.sh
```

指定现有运行时与原生 CLI：

```sh
CODEX_MCP_NODE_PATH='/actual/node' CODEX_CLI_PATH='/actual/codex' sh ./install.sh --check
CODEX_MCP_NODE_PATH='/actual/node' CODEX_CLI_PATH='/actual/codex' sh ./install.sh
```

## 验收、更新与卸载

安装成功后在新会话从侧边栏打开插件，对照发布版本、CLI installed/enabled 版本和页面右上角版本。现有会话可能仍连接旧 MCP 进程；先关闭旧页并在新会话打开，仍旧再考虑重启。写入模型目录之后需要重启客户端才能让模型菜单及顺序生效，与插件更新本身不是同一件事。

更新时下载新版本包、重新校验，再运行同一安装流程。安装器兼容只返回 name/root 的 marketplace list，仍核对真实目标与目录归属；明确声明非 local 来源或目标冲突时拒绝覆盖。

跨版本更新直接使用官方 `plugin add`，不先 `remove` 正在使用的旧缓存。随后核对 installed/enabled、发布文件摘要及实际 Node 启动配置，不能仅凭 add 返回成功就报告完成。同版本且缓存与启动配置均一致时只核验；已禁用时通过官方 enable 启用，不重复 add。客户端更新导致运行时路径失效或缓存不完整时，重新运行安装器进行官方 add 修复；若文件仍被占用则明确失败，关闭旧插件会话后重试，必要时重启客户端后重试，不强制解锁。

失败时尝试恢复旧稳定源及原安装，并核对原版本、启用状态及关键文件。恢复失败会明确输出 `recovery_required`、保留恢复目录并停止。已确认安装成功后仅暂存目录清理失败时，输出 `cleanup_pending` 和待清理位置，不能报成安装失败，也不自动重试完整更新。CLI 错误诊断含阶段、退出码及白名单原因，不输出原始 CLI 正文。

安装模型遇到失败时不得自行拼装“等价手工流程”、修改安装器或删除托管缓存；报告错误与当前状态，由维护者处理。无论安装是否成功，都不要自动删除其他会话遗留的目录、杀进程、提权或绕过本机策略。

卸载只使用：

```sh
codex plugin remove codex-model-kit@codex-model-kit
codex plugin marketplace remove codex-model-kit
```

不要删除系统 Node、其他插件、用户连接配置、凭据或模型目录。
