# ADR 0004: MCP 改用 pi 内置 MCP Client，规则沿用 0003

日期：2026-10-02 · 状态：已接受 · 取代 [ADR 0003](0003-mcp-via-adapter.md)

本 ADR 取代 ADR 0003。0003 里仍然有效的规则在「决定」里重写一遍，以本文为准。

## 背景

pi v0.99.0（2026-09-29）起内核自带 MCP Client（内置 extension `builtin:mcp`），本机 pi 是 1.0.0。0003 写的「pi 内核不带 MCP 客户端」不再成立。

现状有两处冲突：

- pi 的规则是：已安装的 extension 只要注册了 `/mcp`，就替换内置 MCP 支持。`pi-mcp-adapter@2.36.0` 正是这样的 extension。
- 用户在账号的 `settings.json` 里写了 `"extensions": ["-builtin:mcp"]`，内置 MCP 被关掉。

Figma 的情况没有变化：

- Figma 的 MCP Catalog（官方客户端名单）列了 24 个客户端，没有 pi。
- 以 `pi` 名义做 DCR（Dynamic Client Registration，动态客户端注册），注册接口返回 403。
- 截至 2026-10-02，Figma 没有发布新的官方包。

三条路：

1. 用 pi 内置 MCP Client，移除 adapter。
2. 留在 adapter 2.36.0。
3. 升级 adapter 到 5.0.0。它会接管内置 MCP，自己把 `-builtin:mcp` 写进 `settings.json`，并读取 `~/.pi/agent/mcp.json`。这两份文件都由 Template 物化、`pin doctor` 查 Drift，第三方包改写它们，与 ADR 0002 的「配置只来自 Template」冲突。

## 决定

选 1。Template 不再登记 adapter，`pin setup` 不再 `pi install` 它。

### 沿用 0003 的规则

- **MCP Server 由宿主自己的 MCP 客户端接入；只有 chrome-devtools 走 CLI Facade，本仓不为其他服务器新建 Facade。**
- 配置只来自 Template `mcp.json`，`pin setup` 物化到账号目录。不导入其他宿主的配置。
- **不借身份。** pi 自己的文档在 OAuth 一节给了 Figma 例子：`"oauth": { "clientName": "Claude Code" }`。这正是借身份，禁止照抄。Template 里任何服务器都不写 `oauth.clientName`；账号 `mcp.json` 里出现不等于 `pi` 的 `clientName`，`pin doctor` 报 FAIL。
- **`figma-rest` 是读 Figma 的兜底，也是现在 pi 上唯一可用的 Figma 路径。** Framelink（`figma-developer-mcp@0.13.2`）用个人 access token 调官方 REST API，`--no-telemetry` 加 `FRAMELINK_TELEMETRY=off` 关遥测，`--env /dev/null` 不读当前目录的 `.env`。理由和与官方 MCP 的差距见 0003。
- **官方远程 `figma` 是首选，现在是禁用占位。** pi 进入 Catalog 之前不启用。不接 Figma Desktop 本地服务器。

### 工具暴露

- 三个启用的服务器（kimi-cu、deepwiki、figma-rest）都写 `"exposure": "direct"`：工具像内置工具一样直接声明给模型。
- 顶层写 `"autoEnableCodemode": false`。

原因：

- pi 的默认 `exposure` 是 `codemode`（模型写脚本、在脚本里调 MCP 工具）。新加的服务器漏写 `exposure` 时，pi 会自动打开 codemode。关掉自动打开后，漏写会变成 pi 启动时的一条警告，而不是悄悄多出一种执行方式。
- 三个服务器的工具集都小，直接声明就够用，不需要 `tool_search`（按需加载工具）或脚本。
- 直接调用时，会话里看到的是一次次具体的工具调用；codemode 下用户看到的是一段脚本。权限门两种都能拦（见下），但 direct 让人在确认时更容易看懂。
- deepwiki 在 0003 里走 `mcp` 元工具，现在改为直接工具。内置 MCP Client 没有 `mcp` 元工具。

### 权限门

- 工具名是 `mcp__<server>__<tool>`，服务器名和工具名里字母、数字、`_` 以外的字符都换成 `_`。例：`mcp__kimi_cu__get_app_state`、`mcp__figma_rest__get_figma_data`。
- 每一次 MCP 调用都经过 pi 的工具管线，包括 codemode 脚本里的调用（带 `parentToolCallId`）。Permission Gate 在 `tool_call` 事件里看到的 toolName 就是 `mcp__…`。
- `denyTools` 只接受新写法：以 `mcp__` 开头、只含 `[A-Za-z0-9_*]` 的通配。旧写法 `<server>_<tool>`（如 `figma_use_figma`）算配置错误，报错里给出改写建议。
- Template 默认拦 Figma 写画布的工具：`mcp__figma*__use_figma`、`mcp__figma*__create_*`、`mcp__figma*__generate_*`、`mcp__figma*__upload_*`、`mcp__figma*__add_*`。`figma*` 同时覆盖 `figma`、`figma_rest`，以后加的同前缀服务器也在内。

### 字段迁移

adapter 与内置 MCP Client 的 `mcp.json` 都用 `mcpServers`，但字段不同：

| adapter 2.36.0 | 内置 MCP Client | 说明 |
|---|---|---|
| `disabled: true` | `enabled: false` | |
| `directTools: true` | `exposure: "direct"` | 单个工具用 `toolExposure` |
| `requestTimeoutMs: 180000` | `timeout: 180` | 单位从毫秒变成秒 |
| 顶层 `settings`（`toolPrefix`、`scriptMode`、`notifyOnStartupConnect`） | 删除 | codemode 开关改为顶层 `autoEnableCodemode` |
| `$env:VAR`、`{env:VAR}` | `${VAR}` | |
| 工具名 `kimi-cu_get_app_state` | `mcp__kimi_cu__get_app_state` | |
| `denyTools` 写 `<server>_<tool>` | 写 `mcp__<server>__<tool>` | |

内置 MCP Client 的取值语法（`env`、`headers`、`oauth.clientSecret` 适用）：

- `${NAME}` 和 `$NAME` 出现在值里任何位置都是变量引用；`$` 后面紧跟字母、下划线、`{`、`$` 或 `!` 时，要表示字面的 `$` 就写 `$$`。`${A:-x}` 这类带默认值的写法 pi 不认，会原样发出。
- 以 `!` 开头的值是一条 shell 命令，连接时执行，结果作值；字面的开头 `!` 要写 `$!`。
- 引用的变量没设置，pi 不连这台服务器。
- `url`、`cwd`、`args` 是字面值，不展开 `${VAR}`。

pi 对不认识的字段一律静默忽略。adapter 的 `disabled: true` 留在账号文件里，pi 不报错，直接把那台服务器连上。所以 `pin doctor` 对残留报 FAIL，每条都写明怎么改：

- `settings.json` 的 `packages` 里有 `npm:pi-mcp-adapter…`，字符串条目和对象条目的 `source` 都算（它会替换内置 MCP）。
- `settings.json` 的 `extensions` 关掉了 `builtin:mcp`：按 pi 的覆盖规则判断，`-builtin:mcp`、`!builtin:*`、`!*` 都算，`+builtin:mcp` 能把 `!` 抵消。项目级 `.pi/settings.json` 也能覆盖，doctor 不读项目。
- `mcp.json` 里有 `disabled`、`directTools`、`requestTimeoutMs`、顶层 `settings`，或 `$env:VAR`、`{env:VAR}` 写法。
- `url`、`cwd` 里写了 `${VAR}`。
- 借来的 `oauth.clientName`。
- 名字只差 `-` 和 `_` 的两台服务器（pi 只留第一台）、`type: "sse"`、`type` 和 `url` / `command` 对不上的条目，以及 `${A:-x}` 这类 pi 会原样发出的写法。

`oauth.clientId`（预注册客户端，跳过注册）只报 WARN：自己注册的客户端可以用，别的宿主的 clientId 不能用，doctor 分不出来，由人确认。Server Status 按 pi 实际选的传输方式判断：同时写了 `url` 和 `command` 时按 `url` 算，stdio 只看 `env`，HTTP 只看 `headers` 和 `oauth.clientSecret`。

`<agentDir>/npm/node_modules/pi-mcp-adapter` 还在、但 `packages` 里没有登记时，pi 不会加载它，doctor 只报 WARN。

### 检查分工

- `pin doctor` 保持静态检查，不连服务器，不跑 `pi mcp list`。它只给出 Server Status 的裁决；值是 `!command` 时只报 WARN，结果要连上才知道。
- 在 `/mcp` 里启用、禁用或改 exposure，pi 会把结果写回账号 `mcp.json`（启用时删 `enabled` 键，改回 codemode 时删 `exposure` 键）。这是 pi 自己的行为，之后 doctor 看到的值可能和 Template 不同，按 Drift 处理。
- 现场检查用 `pi mcp list`：它连上每一台启用的服务器，打印状态、工具和错误，有无效条目或连不上就以 1 退出。要经 `pin` 跑（`pin 1 mcp list`），`proxy.env` 里的变量才在环境里。

### 项目级 `.pi/mcp.json`

保持 pi 的默认行为：项目被信任后才读 `.pi/mcp.json`，同名条目覆盖账号里的条目。本仓不加门禁，也不加启动警告。

用户的账号把 `settings.json` 的 `defaultProjectTrust` 设为 `"always"`，pi 信任每一个项目。于是任何仓库里的 `.pi/mcp.json` 都会被内置 MCP Client 加载。用户知道并接受这个风险，代价见下。

## 理由

- 少一个第三方常驻 extension。`pin setup` 少一步 `pi install`，doctor 不再核对 adapter 的安装版本。
- MCP 与 pi 内核一起发布，版本天然同步。0003 担心的「adapter 跟不上 pi 新版本」不再存在。
- 只有一套实现。shell 下的 `pi mcp` 命令永远用内置实现；如果会话里用 adapter，`pi mcp list` 会按另一套字段读同一份 `mcp.json`（例如把 `disabled: true` 当作不存在），现场检查和真实会话对不上。
- 工具名与 Claude Code 只差连字符（见代价），比 0003 的 `kimi-cu_get_app_state` 近得多；`denyTools` 的写法也和 Claude Code 的 `mcp__…` 规则同形。
- 每次调用都走 pi 的工具管线，权限门不再需要额外匹配 `mcp` 元工具的 `tool` 参数。
- `mcp.json` 格式与 Claude Code、Cursor 一致，迁移和对照更直接。

## 代价

- 工具名仍有一处不同：pi 把连字符换成 `_`，是 `mcp__kimi_cu__…`；Claude Code 保留连字符，是 `mcp__kimi-cu__…`。跨宿主 skill 里的工具名仍要按语义匹配。
- `env` 值里的 `$VAR` 现在是真引用。值里要出现字面 `$`，必须写成 `$$`。
- stdio 服务器的子进程继承 pi 的整个环境，包括 `proxy.env` 注入的全部 key（如 `GLM_API_KEY`、`KIMI_API_KEY`、`FIGMA_API_KEY`），kimi-cu 和 Framelink 都能读到。依据是读 pi 1.0.0 源码：`pi-mcp` 的 `StdioTransport` 在 `inheritEnv` 不是 `false` 时合并 `process.env`，内置 MCP Client 创建它时不传 `inheritEnv`。adapter 2.36.0 默认也继承，所以与之前相同；区别是 adapter 有 `inheritEnv: false` 开关，内置 MCP Client 没有。
- 将来如果某台服务器用 OAuth，token 存在账号目录的 `mcp-auth.json`（`<agentDir>/mcp-auth.json`）。它是 Account Layer 的私有文件，没有 Template；每个账号各自登录。
- `package.json` 的 peer 依赖升到 pi `^1.0.0`。doctor 对 1.0.x 报 OK，低于 0.99.2 报 FAIL，其他版本报 WARN。
- 已有账号的 `mcp.json` 不会被 Template 覆盖，要按 doctor 的 FAIL 逐条手改。
- 会话的第一轮提示最多等 10 秒，等 `direct` 服务器连上。`figma-rest` 首次用 `npx` 下载 Framelink 时可能超过 10 秒，那一轮就拿不到它的工具。
- `defaultProjectTrust: "always"` 下，任何仓库的 `.pi/mcp.json` 都能起本地命令、覆盖同名服务器、把账号里禁用的服务器（如 `figma`）重新打开，也能写回借来的 `clientName`。`pin doctor` 只查账号文件，看不到项目文件；本仓没有门禁和启动警告来拦它。

## 何时重新评估

- Figma 把 pi 加进 MCP Catalog：把 Template 的 `figma` 改为启用，不写 `clientName`；再决定 `figma-rest` 去掉还是留作只读备份。
- Framelink 停更，或 Figma 改了 REST 认证：换成自写的最小 REST 包装，或在 skill 里直接用 `curl` 调 REST。
- pi 内置 MCP Client 出现回归，影响 Template 用到的功能（`exposure`、`timeout`、取值语法、工具名规则）：重开本 ADR，考虑固定 pi 版本或自写薄 extension。
- adonis-skills 做出四宿主共用的 `kimi-cu-cli`，且 uxc 解决了按消费者隔离：kimi-cu 可整体迁到 CLI Facade（沿用 0003）。
- 用户把 `defaultProjectTrust` 从 `"always"` 改掉，或开始在不受信任的仓库里用 pi：重新评估项目级 `.pi/mcp.json` 要不要加门禁或启动警告。
