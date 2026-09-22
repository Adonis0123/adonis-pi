# adonis-pi 第二阶段：MCP 接入

日期：2026-09-22 · 状态：已实施并真机验证（记录见 `../verification/2026-09-phase2-mcp.md`） · 决策见 ADR 0003 · 术语见 `../../CONTEXT.md`「MCP（第二阶段）」

## 1. 目标

pi 能调用用户在其他 Host 上真实依赖、且 pi 没有替代品的 MCP Server，同时不破坏第一阶段的三层配置、权限门与提醒。

## 2. 范围

| 项 | 决定 |
|---|---|
| MCP Bridge | `pi-mcp-adapter`，Template `settings.json` 的 `packages` 锁 `npm:pi-mcp-adapter@2.36.0` |
| MCP Config | Template `templates/mcp.json` → `pin setup` 物化到 `<账号>/mcp.json`；kimi-cu 的 `command` 在 Template 里是占位符 `{{KIMI_CU_BIN}}`，setup 时按 `$ADONIS_PI_KIMI_CU_BIN` → `/Applications/KimiCU.app` → `PATH` 解析（Repo Layer 不含本机路径） |
| 启用 | kimi-cu（stdio，`directTools`，工具名 `kimi-cu_*`）；deepwiki（http，走 `mcp` 元工具，名字形如 `deepwiki_ask_wiki_question`） |
| Figma（只读） | figma-rest：Framelink `figma-developer-mcp@0.13.2`，`command: npx`，args `--stdio --env /dev/null --no-telemetry`（Framelink 默认以 `override: true` 加载当前目录的 `.env`，能覆盖传入的 key 和遥测开关，实测复现；指到 `/dev/null` 后只认 adapter 传的环境），stdio，`directTools`，工具名 `figma-rest_get_figma_data` / `figma-rest_download_figma_images`；`env` 写 `${FIGMA_API_KEY}`（值只在 `proxy.env`）与 `FRAMELINK_TELEMETRY=off`；`requestTimeoutMs: 180000`，因为 Figma 渲染整页 PNG 常超过 adapter 默认的 60 秒。第三方项目、走官方 REST API，见 ADR 0003 |
| 占位 | figma（官方远程 MCP）：`disabled: true`。原因见 ADR 0003 |
| 不接 | chrome-devtools（已走 `chrome-dev-mcp-cli`）、github（`gh`）、context7、chatcut_desktop |
| adapter 设置 | `toolPrefix: server`、`scriptMode: false`（关掉 `mcpScript`）、`notifyOnStartupConnect: false` |

## 3. 改动

### 3.1 Permission Gate：`denyTools`

`adonis-pi.json` 新增 `permissionGate.denyTools: string[]`，通配符语法与 `protectedPaths` 相同，匹配对象是 MCP 工具名 `<server>_<tool>`：

- 直接工具：`tool_call` 的 `toolName` 不是 pi 自带工具（bash / read / write / edit / find / grep / ls / powershell）也不是本包的 `AskUserQuestion`，就按名字匹配。
- 代理调用：`toolName === "mcp"` 时取 `input.tool`；没有 `tool` 的调用（search / describe / connect）是只读桥操作，不匹配。
- 默认值只拦 Figma 写画布类：`figma_use_figma`、`figma_create_*`、`figma_generate_*`、`figma_upload_*`、`figma_add_*`。kimi-cu 全放行，与 Claude Code / Grok 现状一致；要收紧，在账号 `adonis-pi.json` 追加即可（数组追加，不覆盖默认）。

### 3.2 配置损坏即 block

`adonis-pi.json` 解析或校验失败时，Session 退回 Template，但 `permissionGate.mode` 强制为 `block`（原为 `ask`）：账号自己追加的 Deny 规则读不到，默认规则命中的调用不能再靠「确认」放过。提示语同时说明这一点。

### 3.3 `pin setup` / `pin doctor`

- setup：写 `mcp.json`（占位符解析）；在 `settings.json` 的 `packages` 追加 `npm:pi-mcp-adapter@2.36.0`；若 `<账号>/npm/node_modules/pi-mcp-adapter` 不存在或版本不符，执行一次 `pi install`（用户级 npm 包 pi 不会在启动时自动安装）。`PIN_SKIP_INSTALL=1` 跳过安装（测试用）。
- doctor：`packages` 必须恰好含一条 `npm:pi-mcp-adapter@<锁定版本>`；安装目录下 `package.json` 的 `version` 必须等于锁定版本；`mcp.json` 每个启用的 stdio 服务器 `command` 必须是可执行的普通文件（带 `/` 的按路径查，裸名字如 `npx` 按 doctor 所在 shell 的 PATH 查；空 PATH 项跳过），占位符未解析报 FAIL；`mcp.json` 参与 Drift 检查。
- doctor 对 `mcp.json` 的环境变量引用按 adapter 2.36.0 的语法识别（`${VAR}`、`$env:VAR`、`{env:VAR}`，可嵌在字串中），对照 `proxy.env` 的静态解析结果（每个 `export` 变量三态：非空 / 空 / 需要 shell 求值的「无法判断」；只认 `export NAME=值`、`NAME=值`、`unset NAME`、注释四种行，支持前导空格、引号、反斜杠、词后 `# 注释`，词内 `#` 按字面量，`$HOME` 视为已知；出现任何其他行（`;` 后的第二条命令、重定向、行尾 `\` 续行、`if`、`source`、跨行引号、`${X:=…}` 这类会给别的变量赋值的展开等）整份文件降为「无法判断」；文件自己改过或 `unset` 过 HOME 后 `$HOME` 不再视为已知，宁可不判也不给错误结论；不执行任何 shell），空报 WARN 且该服务器一行写明 unavailable，无法判断时写明 doctor 不能求值、用 `PIN_DRY_RUN=1 pin` 看运行时；整串裸 `$VAR` adapter 不展开，只报 WARN 提示可能写错，不判不可用（它也可能是有意的字面量）。日志里的 URL 只打印 origin 和 path，隐藏 query 与内嵌凭证。`pin --dry-run` 也列出这些变量。已知差异：doctor 用当前 shell 的 PATH，运行时用加载 `proxy.env` 后的 PATH，`proxy.env` 改 PATH 的情况不建模。
- 「可用与否」由 `lib/mcp.ts` 的 `serverStatus(server, {env, path})` 一处裁决（CONTEXT.md「Server Status」）：doctor 用 `proxy.env` 的静态解析作 env 视图，startup-check 用 pi 自己的进程环境；两处只负责措辞。
- 「账号引用了哪些变量」由 `lib/refs.ts` 的 `accountRefs(dir)` 一处计算（CONTEXT.md「Env Ref」）：doctor 对照 `proxy.env`，startup-check 对照进程环境，`pin --dry-run` 经 `account vars` 打印这些名字加上 `proxy.env` 导出的名字（不再用 grep 扫 `proxy.env`）。
- doctor 的实现是 `bin/lib/account.ts` 的 `inspectAccount(n, pinRoot, {home, env})`，返回 Finding 记录（CONTEXT.md「Finding」）；CLI 只做渲染 `LEVEL subject [item] message` 与退出码。测试直接调用 `inspectAccount` 断言级别、对象与细项，措辞不再被测试钉死；只保留两条端到端用例验证渲染格式与退出码。
- `proxy.env` 静态解析（`lib/environment.ts`）除单元用例外，还有一条 oracle 测试：把同一批行形写成临时文件，用 `sh` 按 `bin/pin` 的方式（`set -eu; set +u; . file; set -u`）在假环境里 source 后读 `env -0`，要求解析器对每个变量的结论要么等于 sh 的结论，要么是「无法判断」；sh 拒绝执行的文件，解析器必须标为不确定。只 source 测试夹具，永不碰真实 `proxy.env`。
- `pin` 启动时清掉继承的 `FIGMA_API_KEY` / `FIGMA_OAUTH_TOKEN`（Framelink 两者都设时优先用 OAuth token），与 provider key 一样只从 `proxy.env` 来。

### 3.4 startup-check：MCP 边界

`before_agent_start` 往 system prompt 加一节 `adonis_pi_mcp`：列出本账号可用的服务器与调用形态、不可用的服务器（含未解析占位符、命令不是可执行文件、引用的变量未设置三种，与 doctor 同一套判定；裸 `$VAR` 只由 doctor 提醒），并提醒纯文本模型用 kimi-cu 的 `mode=ax`；figma-rest 可用时说明它走 REST 而非官方 MCP、两个工具的用法、从 Figma URL 取 `fileKey` / `nodeId` 的方法，以及不能读 Variables 和写画布。目的：共享 skill 按其他 Host 的服务器集合（Figma 远程 45 个工具）写，不能在 pi 里调不存在的名字。

## 4. 验收

| 编号 | 任务 |
|---|---|
| M1 | `npm test`、`npm run typecheck`、`npm run leak-check` 通过 |
| M2 | `pin setup 1` 写出 `mcp.json`、登记并安装 adapter；`pin doctor 1` 全 OK |
| M3 | `pin 1 -p` 完成一次 deepwiki 调用（代理形态）与一次 `kimi-cu_list_apps`（直接形态） |
| M4 | 权限门在 print 模式下拦住 `kimi-cu_list_apps` 的直接与代理两种形态 |
| M5 | kimi-cu 截图经 adapter 送达 Kimi k3 |
| M6 | GLM 会话下截图工具的降级表现 |
| M7 | `pin doctor 1` 认出 `figma-rest -> npx`，`proxy.env` 缺 `FIGMA_API_KEY` 时 WARN |
| M8 | 设置 `FIGMA_API_KEY` 后 `pin -p` 完成一次 `figma-rest_get_figma_data` |
| M9 | `figma-rest_download_figma_images` 把 PNG 导出到当前目录 |

## 5. 风险

- adapter 跟随 pi 版本：升级 pi 前先看 adapter 是否支持，两者一起升，`doctor` 会指出不一致。
- 两个 pi 账号同时开 kimi-cu 会各起一个进程并争抢同一块桌面；这与其他宿主的现状相同，不在本阶段处理。
- Template 的 `denyTools` 通配基于 Figma 官方工具名，figma 未启用前无法实测，标 `UNVERIFIED`。它们不会误伤 `figma-rest_*`（前缀不同），后者两个工具都是只读，不需要拦。
- Framelink 是第三方项目，跟随其版本；`npx` 首次连接需要网络。token 的 scope 由用户在 Figma 创建时决定，Framelink 只需 `file_content:read`；Variables 要 `file_variables:read`（Enterprise）。
- `denyTools` 把「不是 pi 自带工具、不是 `AskUserQuestion`」的一切 `toolName` 都当作 MCP 直接工具匹配。将来若装了别的注册工具的 extension，`*` 这类宽通配会连它们一起拦；本仓当前只有 adapter 会注册工具。
- `mcp` 元工具无 `tool` 参数的调用（search / describe / connect）按名字 `mcp` 匹配；默认规则不含它，要拦连接类操作就在账号里加一条 `mcp`。
- 配置损坏时的 block 回退只在 Template 的 `mode` 不是 `off` 时生效：Template 明确关门，损坏的账号文件不会反过来把门打开。
