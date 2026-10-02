# MCP 改用 pi 内置 Client 验收记录（2026-10-02）

依据 ADR 0004。本机 pi 1.0.0，KimiCU 0.6.6。真机用 1 号账号（`~/.pi/agent`，默认模型 `kimi-coding/k3`）在本仓目录跑 print 模式；会改账号配置的用例（B5）在账号副本上跑，避免影响同一账号上正在运行的 pi 会话。

## 自动化

| 编号 | 结果 | 备注 |
|---|---|---|
| A1 | 通过 | `npm test` 115 / 115（迁移前 107）；`npm run typecheck`（devDependencies 升到 pi 1.0.0）与 `npm run leak-check` 通过 |

## 账号迁移

| 编号 | 结果 | 备注 |
|---|---|---|
| B1 | 通过 | 迁移前文件备份在账号目录 `backup-mcp-builtin-20261002/`（`settings.json`、`mcp.json`，以及 adapter 留下的 `mcp-cache.json`、`mcp-npx-cache.json`）。`pi remove npm:pi-mcp-adapter@2.36.0` 删掉 44 个包；`settings.json` 去掉 `-builtin:mcp`；`mcp.json` 按 Template 重写，保留本机 kimi-cu 路径 |
| B2 | 通过 | `pin doctor 1` 迁移后 16 条全 OK、退出 0，含 `pi 1.0.0 on PATH`、`figma disabled` |
| B3 | 通过 | 反向：迁移前的 `settings.json` / `mcp.json` 加一条旧格式 `denyTools: ["figma_use_figma"]` 放进临时 HOME 跑 doctor，报 8 条 FAIL：adapter 包、`-builtin:mcp`、`settings` 块、两处 `directTools`、`requestTimeoutMs`、`disabled`（写明 pi 会忽略它而连接）、旧规则（给出 `mcp__figma__use_figma`）。每条带修法 |
| B4 | 通过 | `pin 1 mcp list` 退出 0：kimi-cu 20 个工具、deepwiki 3 个、figma-rest 2 个，均为 `direct`；figma 为 disabled |

## 真机调用

| 编号 | 结果 | 备注 |
|---|---|---|
| B5 | 通过 | 账号副本加 `denyTools: ["mcp__kimi_cu__list_apps"]`：模型原文回报 `adonis-pi permission gate: MCP tool matches denyTools mcp__kimi_cu__list_apps`；同一轮的 `mcp__kimi_cu__list_windows` 未被拦，返回 1 个窗口 |
| B6 | 通过 | `mcp__deepwiki__ask_wiki_question(repoName="earendil-works/pi")` 返回 pi 的一句话定义 |
| B7 | 通过 | `mcp__figma_rest__get_figma_data(nodeId="128064:299803", depth=1)` 返回顶层节点名与 4 个子节点；key 来自 `proxy.env` |
| B8 | 通过 | `mcp__kimi_cu__get_app_state(app="com.stablyai.orca", mode="image")`：模型确认收到图片块并描述出侧栏项目、标签页标题和状态栏内容。上一轮 M5 的 `UNVERIFIED` 解除（当时是 KimiCU 0.5.11 截图为空）。对不在当前屏幕的窗口（最小化或在别的 Space），kimi-cu 只返回 JSON 和 `screenshot_diagnosis`，不是本仓问题 |
| B9 | 通过 | system prompt 边界节原文：`Available: kimi-cu (direct tools mcp__kimi_cu__*); deepwiki (direct tools mcp__deepwiki__*); figma-rest (direct tools mcp__figma_rest__*).`、`Not available in pi: figma.` |

## 观察

- 迁移时同一账号上有一个迁移前启动的 pi 会话在跑。它在内存里仍是旧的 adapter，重启后才会改用内置 Client。
- 一次 `pin 1 -p …` 在非 TTY 环境下停在启动阶段 5 分钟以上（CPU 0.28 秒、无子进程、无网络连接）。stdin 接 `</dev/null` 后不再复现。推断是 print 模式在等 stdin，与本次改动无关，未进一步定位。

## 独立评审（subagent，只读）

结论：无 High，3 个 Medium、6 个 Low，逐条对 pi 1.0.0 源码核实后全部成立，已修：

- M1 `packages` 里对象形式的条目（`{ "source": … }`）pi 也会加载，doctor 原先只看字符串条目。修：两种都算。
- M2 关掉 `builtin:mcp` 不只 `-builtin:mcp` 一种写法。修：`builtinMcpOffBy` 按 pi 的 `isEnabledByOverrides` 判断（`!glob` 排除，`+` 打开，`-` 最后关闭）。
- M3 预注册的 `oauth.clientId` 会跳过注册。改为报 WARN：自己注册的客户端可以用，doctor 分不出是谁的，由人确认。
- L1 Server Status 按 pi 实际选的传输判断：`url` 优先于 `command`、`type` 必须匹配、`sse` 拒收、只差 `-`/`_` 的同名服务器报 FAIL；stdio 只看 `env`，HTTP 只看 `headers` 和 `oauth.clientSecret`。
- L2 变量语法逐分支移植 pi 的 `parseConfigValueTemplate`：`${A:-x}` 这类写法会原样发出，doctor 报 FAIL。测试改为直接拿 pi 的 `getConfigValueEnvVarNames` 当 oracle，16 个样例一致。
- L3 `autoEnableCodemode: false` 时，没写 exposure 的服务器调不到，startup-check 改为列入不可用；有 `toolExposure` 时加一句说明。
- L4 `denyTools` 现在要求 `mcp__` 之后出现 `*` 或工具名前的 `__`，`mcp__figma_use_figma` 这种永远匹配不上的规则会被拒并给出改写建议。
- L5、L6 文档：CONTEXT.md 的「与 Claude Code 同名」改成写明连字符差异；Env Ref 补上 `$VAR` 和 `oauth.clientSecret`；ADR 写明 `$$` 什么时候需要，以及 `/mcp` 会写回账号 `mcp.json`。

## pi 自审（2026-10-02）

`pin 1 --no-skills --tools read,grep,find,ls --thinking medium --no-session -p …`（`kimi-coding/k3`，diff 放在文件里让它读）。结论「可接受」，2 个 Medium、5 个 Low。它从运行时独立确认了工具名：能看到 `mcp__kimi_cu__*`、`mcp__deepwiki__*`、`mcp__figma_rest__*`，没有 `mcp` 元工具，figma-desktop 和 figma 不可用。

- Medium 1 doctor 没有完整对齐 pi 的条目校验，比如 `url` 缺 scheme、`exposure: "Direct"`，pi 会跳过这样的条目，doctor 原先报 OK。修：`mcpTransport` 移植了 `validateMcpServerConfig` 的全部检查，测试用 pi 的原函数对照 45 个条目形状和 4 个服务器名，报错文字也要一致。
- Medium 2 pi 的间接路由是整个账号共用的：只要有一台 `deferred` 服务器，`tool_search` 就会激活，codemode 服务器的工具也能用到。修：startup-check 先按账号算出激活了哪些路由，再给每台服务器写说明；`hidden` 但用 `toolExposure` 放出部分工具的服务器，也列为可用。
- Low：旧 spec 加了「已被 ADR 0004 取代」标记；`mcpToolName` 注释写明超过 64 字符时截断并加 hash 后缀。另有三条记录不改：adapter 残留期间 Permission Gate 看不到旧形态的调用（此时 doctor 已报 FAIL）；对象条目能否用 `pi remove` 删掉（核对源码，`getPackageSourceString` 能处理，不是问题）；doctor 只读 `proxy.env`，比 pi 保守（误报方向安全）。

两轮修完后：`npm test` 116 / 116，typecheck、leak-check 通过；`pin doctor 1` 全 OK；`pin 1 mcp list` 三台已连接、两台禁用；真机边界节原文不变。

## 用户纠正：去掉 figma-desktop（2026-10-02）

用户说的「兜底」是调用 Figma API 的 figma-rest，不是 Figma Desktop。已从 Template、账号 `mcp.json`、startup-check、`lib/config.ts` 改写建议、测试和文档里删掉 `figma-desktop`。现在的结构是：官方远程 `figma` 是首选，但 pi 不在 Catalog 里，保留禁用占位；`figma-rest` 是兜底，也是目前唯一可用的 Figma 路径。

| 编号 | 结果 | 备注 |
|---|---|---|
| B10 | 通过 | `mcp__figma_rest__download_figma_images(nodeId="128064:299803", pngScale=1, localPath="out")` 连跑两次，在 pi 的当前目录写出 `out/node1.png`、`out/node2.png`（PNG 360×952 RGBA，19.9 KB），每次 26–32 秒，在 `timeout: 180` 之内 |
| B11 | 通过 | 删除后：`npm test` 115 / 115，typecheck、leak-check 通过；`pin doctor 1` 全 OK；`pin 1 mcp list` 只剩 kimi-cu、deepwiki、figma-rest 三台已连接加 `figma` 禁用；边界节为 `Not available in pi: figma.`，figma-rest 一行写明它是官方 Figma MCP 不可用时的兜底 |

观察：同一提示第一次在 scratchpad 目录里跑时，模型看不到 `mcp__figma_rest__*`，只有 deepwiki 和 kimi-cu。同目录 `pin 1 mcp list` 3.8 秒内连上 figma-rest，随后两次重跑都正常，原因未定位。实测从启动到 MCP `initialize` 返回：`npx -y figma-developer-mcp@0.13.2 …` 5 次为 869–936 ms，加 `--prefer-offline` 3 次为 410–442 ms，差值是 npx 每次向 npm registry 查元数据的往返。正常启动远低于 pi 首轮等待 direct 服务器的 10 秒，所以「npx 冷启动太慢」不成立；只有 registry 请求卡住时才可能超时（推断，未复现）。不改为全局安装：全局包不受 Template 锁版，nvm 切换 Node 版本后路径失效，Template 还要为它加占位符。
