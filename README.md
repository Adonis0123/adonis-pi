# adonis-pi

一个 [pi](https://github.com/earendil-works/pi) 的 Pi Package：把我在 Claude Code、Codex、Grok Build 上养成的习惯装进 pi，不 fork、不改内核。

## 它做什么

- **权限门**：危险命令（`sudo`、`rm -rf /`、`git push --force`……）和受保护路径在执行前询问或阻止。规则来自你的配置，不是硬编码；命令按 `;` `&&` `|` `&` 子 shell和 `sh -c` 切开逐段匹配。它防的是误操作，不是安全隔离：不拦读取，不解析 shell 变量、别名和引号。
- **注意力提醒**：agent 等你回答、出错、空闲时，调用你自己的通知命令。发到哪里由你的命令决定。
- **`AskUserQuestion` 工具**：与 Claude Code 同名工具参数兼容，写给 Claude Code 的 skill 不改字就能在 pi 里向你提问。
- **多账号入口 `pin`**：`pin 1` / `pin 2` 各自独立的登录态与设置，模板复制一次，之后只报告漂移、不覆盖。
- **Provider 模板**：ChatGPT 订阅走 pi 自带 OAuth；GLM 在 `models.json` 里以 `$GLM_API_KEY` 引用 key；Kimi 用 pi 内建的 `kimi-coding` provider，只要 `proxy.env` 里有 `KIMI_API_KEY`。key 只存在 600 权限的 `proxy.env` 里，只有 `pin` 会加载它；直接运行 `pi` 时启动检查会提示缺哪个变量。
- **MCP**：pi 本身没有 MCP 客户端，本包用锁定版本的 [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) 补上，配置来自模板 `mcp.json`。默认接 kimi-cu（macOS 桌面操作，直接工具 `kimi-cu_*`）、deepwiki（走 `mcp` 元工具）和 figma-rest（用 Framelink 走 Figma 官方 REST API 读设计，直接工具 `figma-rest_get_figma_data` / `figma-rest_download_figma_images`，key 来自 `proxy.env` 的 `FIGMA_API_KEY`）；官方 Figma MCP 留禁用占位，原因见 `docs/adr/0003-mcp-via-adapter.md`。权限门的 `denyTools` 按 `<server>_<tool>` 通配拦 MCP 工具，直接调用和 `mcp` 元工具两种形态都管。
- **默认关闭 pi 的安装遥测**：模板 `settings.json` 里 `enableInstallTelemetry: false`。

Skill 不在这里。pi 默认读取 `~/.agents/skills`，本包沿用这一约定。

## 状态

第一阶段代码已实现（2026-09-22），第二阶段 MCP 接入同日完成（`docs/verification/2026-09-phase2-mcp.md`）；自动化测试通过；TUI 内的 `AskUserQuestion` 面板、权限门确认框和飞书提醒已验证，ChatGPT `/login` 与 commit skill 全流程待完成，记录见 `docs/verification/2026-09-phase1.md`。设计见 `docs/specs/2026-09-22-adonis-pi-phase1-design.md`，术语见 `CONTEXT.md`，决策见 `docs/adr/`。

## 安装（第一阶段完成后）

需要 Node ≥ 22.18（`bin/lib/account.ts` 直接由 Node 运行）和 pi 0.87.x。

```sh
npm install -g @earendil-works/pi-coding-agent@0.87.0
git clone https://github.com/Adonis0123/adonis-pi <任意目录>
export PATH="<任意目录>/bin:$PATH"
pin setup 1
pin doctor 1
pin 1
```

`pin setup` 会在 `~/.pi/agent/` 生成 `settings.json`、`models.json`、`adonis-pi.json`、`mcp.json`（kimi-cu 的路径按本机 KimiCU.app 填入），登记并用 `pi install` 安装锁定版本的 `pi-mcp-adapter`，然后提示你填写 `agentsMd` 与 `proxy.env`（要用 figma-rest 就在 `proxy.env` 里加一行 `export FIGMA_API_KEY=<Figma 个人 access token>`，token 在 Figma 的 Settings → Security 里创建，至少勾 File content 读权限）。本包自身不需要 `npm install`：pi 加载的是 TypeScript 源文件，`settings.json` 的 `packages` 指向这个 checkout。

## 日常使用

| 想做什么 | 怎么做 |
|---|---|
| 启动 | `pin`（等于 `pin 1`）；任何 pi 参数直接跟在后面，如 `pin -p "总结这个仓库"` |
| 换模型（本次会话） | TUI 里 `/model` 选择；或启动时 `pin --model kimi/k3`、`pin --model glm/glm-5.3` |
| 换默认模型 | `/model` 里选中后按 `Ctrl+S` 保存；或改 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel` |
| ChatGPT 订阅 | TUI 里 `/login` 选 `openai-codex`，浏览器授权一次，登录态存在该账号的 `auth.json` |
| 体检 | `pin doctor 1`：权限、Drift、`$VAR`（含 `mcp.json` 的 `env`）、`packages`、pi 版本、adapter 版本、`mcp.json` 里的命令（路径或 PATH 上的名字） |
| MCP | TUI 里 `/mcp` 看服务器状态；kimi-cu 工具名 `kimi-cu_get_app_state` 等，deepwiki 通过 `mcp` 元工具搜索后调用；要拦某个 MCP 工具，在 `adonis-pi.json` 的 `permissionGate.denyTools` 加通配 |
| 读 Figma 设计 | 贴 Figma 链接，pi 用 `figma-rest_get_figma_data(fileKey, nodeId)` 拿布局、样式和文本，`figma-rest_download_figma_images` 把切图存到当前目录。没有 `FIGMA_API_KEY` 时启动检查会提示，system prompt 里把 figma-rest 列为不可用 |
| 第二个账号 | `pin setup 2 && pin 2`：独立的 `~/.pi-002/agent`，有自己的 `auth.json`、`proxy.env`、`settings.json`、会话 |

什么时候需要第二个账号：另一个 ChatGPT 订阅身份、想让某个账号只用 API key 且默认模型不同、或想把某个项目/客户的会话历史与设置完全隔开。只切换 GLM / Kimi 不需要第二个账号，`/model` 就够。

pi 本身没有权限弹窗，工具调用默认全部直接执行（相当于其他宿主的 yolo 模式）。会拦你的只有两样：本包的权限门（`permissionGate.mode`：`ask` 命中时问、`block` 一律拦、`off` 关掉），以及 pi 自带的项目信任提示（首次进入含 `.agents/skills` 或 `.pi/` 的项目时问一次，TUI 里 `/trust` 保存后不再问；`settings.json` 的 `defaultProjectTrust` 设为 `"always"` 则任何项目都不问，代价是陌生仓库里的 `.pi/extensions` 也会直接执行）。

账号目录里的 `adonis-pi.json` 只写你要覆盖的键（`pin setup` 生成的就是这样），其余默认值随包更新；`denyCommands` 这类数组是追加，不是替换。

## 更新

```sh
git -C <任意目录> pull
pin doctor 1
```

拉取即生效，下一次 `pin 1` 就是新代码。`doctor` 会指出模板新增了哪些键（Drift）由你决定是否同步到账号文件。改 `adonis-pi.json` 不用重启 pi，下一个事件即重读。

## 许可

MIT
