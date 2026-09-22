# ADR 0003: MCP 走 pi-mcp-adapter，chrome-devtools 沿用 CLI Facade，Figma 不借身份

日期：2026-09-22 · 状态：已接受

## 背景

pi 内核不带 MCP 客户端，官方立场是「用 CLI + skill，或装 extension 补」。用户的另外三个 Host（Claude Code、Codex、Grok Build）都用宿主自带的 MCP 客户端注册服务器，skill 共享在 `~/.agents/skills`。三个月的真实调用量：chrome-devtools 2817、figma 635、kimi-cu 307、context7 134（已归零）、github 111、deepwiki 50、chatcut_desktop 2。

机器上已有一个例外：chrome-devtools 用 uxc 做成 `chrome-dev-mcp-cli` 命令行门面 + skill，四宿主共用一个守护进程，原因是要共享一个带身份校验的 Chrome 会话、避免每个宿主会话各起一个子进程。

三条路：

1. 装社区包 `pi-mcp-adapter`，配 `<账号>/mcp.json`。
2. 用 uxc 为每个服务器生成 `<server>-cli` + skill，pi 不装 MCP 客户端。
3. 同 2，再写一个薄 extension 把 uxc 的图片产物转成 pi 图片块。

## 决定

选 1。规则写成一句：**MCP Server 由宿主自己的 MCP 客户端接入；只有 chrome-devtools 走 CLI Facade，本仓不为其他服务器新建 Facade。**

- Bridge 锁版：`templates/settings.json` 的 `packages` 写 `npm:pi-mcp-adapter@2.36.0`。pi 对带版本的 npm 包不做 `pi update --all`，升级是改 Template，由 `pin doctor` 报 Drift。
- 配置只来自 Template `mcp.json`，`pin setup` 物化到账号目录。不用 adapter 的 `imports`（`~/.claude.json` 里有明文 token），不用 `~/.agents/mcp.json`（只有 pi 会读，「宿主无关」是空的）。
- 第二阶段启用 kimi-cu（`directTools`）与 deepwiki（代理元工具）；figma 留 `disabled: true` 占位。
- Template 的 `scriptMode: false`：关掉 adapter 的 `mcpScript` 工具，让每一次 MCP 调用要么是直接工具、要么是 `mcp` 元工具，权限门两种形态都看得到。
- Permission Gate 新增 `denyTools`（按 `<server>_<tool>` 通配），同时匹配直接工具名与 `mcp` 元工具的 `tool` 参数。不用 adapter 的 `approveTools`，避免两套确认机制。
- Figma 远程服务器有客户端白名单，pi 不在名单。社区绕法是 OAuth 注册时冒名 Claude Code / Codex，包作者自述可能违反 Figma 条款，用户自己的 `figma-mcp` skill 也禁止借身份。Figma Desktop 本地服务器用户不装。所以 pi 不接官方 Figma MCP；`figma` 保留 `disabled: true` 占位。
- Figma 读设计改走 REST（2026-09-22 追加）：Template 增加 `figma-rest`，用社区项目 Framelink（`figma-developer-mcp@0.13.2`，GLips 维护，MIT，非 Figma 官方）把官方 REST API `api.figma.com` 包成两个工具 `get_figma_data`、`download_figma_images`。认证用个人 access token，任何套餐都能创建，不看客户端身份，所以不存在借身份问题。token 只放 Secret Layer 的 `proxy.env`，Template 写 `"FIGMA_API_KEY": "${FIGMA_API_KEY}"`，由 adapter 在 `env` 字段里展开。`--no-telemetry` 加 `FRAMELINK_TELEMETRY=off` 关掉它默认开启的 PostHog 用量上报；`--env /dev/null` 让它不再读当前目录的 `.env`（否则那份文件能覆盖 key 和遥测开关）。与官方 MCP 的差距：没有生成代码、Code Connect 和截图工具；Variables 端点要 `file_variables:read`，Figma 只对 Enterprise 开放；不能写画布。

## 理由

- 与其他三宿主同一规则，pi 不成为特例；skill 零改动。
- 图片一步直达模型。kimi-cu 的 `get_app_state` 与 Figma 的 `get_screenshot` 都是图片工具，uxc 把图片写成 artifact 文件里的 base64，模型要多两步（解码、`read`）才看得到。
- uxc 的统一价值对 Figma 不成立：其他三端用的是合规的远程服务器，pi 走 uxc 也进不了白名单。对 kimi-cu，「5 个进程收成 1 个」应由 adonis-skills 出 `kimi-cu-cli` 后四端同迁，不该 pi 先迁。
- uxc 的一机一版本、无按消费者隔离的问题未解（0.17 与 0.22 两个 owner 已冲突），再加消费者是在债上盖楼。
- adapter 与 pi 版本同步快（0.87 发布次日 PR #637 合并），月下载约 97 万，是事实上的标准桥。

## 代价

- 多一个第三方常驻 extension，要跟随它的版本；`pin doctor` 查登记项、安装版本与 Template 是否一致。
- pi 内 MCP 工具名是 `kimi-cu_get_app_state`，与 Claude Code 的 `mcp__kimi-cu__get_app_state` 不同名，跨宿主 skill 里的工具名只能按语义匹配。
- `pin setup` 多一步 `pi install`（用户级 npm 包 pi 不会在启动时自动安装）。
- `figma-rest` 的 `command` 是 `npx`：第一次懒连接要从 npm 下载 Framelink（需要网络，之后走 `~/.npm/_npx` 缓存），每次连接起一个 node 子进程。`pin doctor` 和 startup-check 按 PATH 解析裸命令名，`mcp.json` 里 `env` 引用的变量在 `proxy.env` 里缺失时 doctor 报 WARN、startup-check 把该服务器列为不可用。
- ADR 0002 规则 1 的一条例外：`lib/config.ts` 里 `KIMI_CU_CANDIDATES` 写了 `/Applications/KimiCU.app/...`。它是 macOS 应用的标准安装位置，不是个人目录布局；Template 本身仍只放占位符，真实路径只落在 Account Layer。

## 何时重新评估

- adonis-skills 做出四宿主共用的 `kimi-cu-cli` 且 uxc 解决了按消费者隔离：kimi-cu 可整体迁到 CLI Facade。
- Figma 把 pi 加进目录，或用户装了 Figma Desktop：把 Template 里的 figma 占位改成启用，`figma-rest` 可去掉或留作只读备份。
- Framelink 停更或 Figma 改 REST 认证：换成自写的最小 REST 包装，或直接在 skill 里用 `curl` 调 REST。
- adapter 连续两个 pi 版本跟不上：重开本 ADR，考虑自写薄 extension。
