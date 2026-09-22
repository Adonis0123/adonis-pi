# 第二阶段（MCP）验收记录（2026-09-22）

执行方式：本会话按 ADR 0003 与 `docs/specs/2026-09-22-adonis-pi-phase2-mcp.md` 实现。自动化：`npm test` 100 通过（第一阶段末 87 → 96 → figma-rest 追加后 100），`npm run typecheck`、`npm run leak-check` 通过。真机以 1 号账号（`~/.pi/agent`，默认模型 `kimi-coding/k3`）在本仓目录用 `pin 1 --no-skills -p` 跑 print 模式。

| 编号 | 结果 | 备注 |
|---|---|---|
| M1 | 通过 | 96 / 96；新增测试：denyTools 两种形态与 pi 自带工具不受影响、ask 模式下 MCP 命中的确认与提醒、配置损坏即 block、setup 解析占位符 / 无 KimiCU 时保留占位符并由 doctor 报 FAIL、doctor 对 adapter 缺失 / 版本不符 / 命令路径不存在的 FAIL、startup-check 边界节 |
| M2 | 通过 | `pin setup 1`：`write mcp.json (kimi-cu -> /Applications/KimiCU.app/Contents/MacOS/kimi-cu)`、`packages: npm:pi-mcp-adapter@2.36.0 added`、`pi install` 44 个包 8s、安装到 `~/.pi/agent/npm/node_modules/pi-mcp-adapter`（位置与代码假设一致）。`pin doctor 1` 全 OK 退出 0，新增 5 行：packages 锁版、adapter 2.36.0 已装、kimi-cu 路径、deepwiki url、figma disabled |
| M3 | 通过 | 冒烟 `-p "Reply with exactly: ok"` 输出 `ok`（adapter 与本包四个 extension 同时加载无报错）。deepwiki：模型先用 `mcp` 搜索再调 `deepwiki_ask_wiki_question`，答出 pi 的一句话定义；它指出我提示里写的 `deepwiki_ask_question` 不存在，说明代理搜索路径可用。kimi-cu：`kimi-cu_list_apps` 直接工具返回 15 个应用 |
| M4 | 通过 | 临时在账号 `adonis-pi.json` 加 `denyTools: ["kimi-cu_list_apps"]`。直接形态：模型原文回报 `adonis-pi permission gate: MCP tool matches denyTools kimi-cu_list_apps`。代理形态（`mcp` 元工具 `tool=kimi-cu_list_apps`）：同一条拦截文本。随后恢复账号文件 |
| M5 | `UNVERIFIED`，非本仓问题 | pi 内 `kimi-cu_get_app_state mode=image` 得到 `(empty result)`。排查：用 `@modelcontextprotocol/client` 直连 kimi-cu，`mode=image` 对 Finder、TickTick、WorkBuddy、Orca 全部返回 `content: []`，`mode=ax` / `full` 正常返回控件树；同一时刻 Claude Code 自己的 `mcp__kimi-cu__get_app_state mode=image` 也「completed with no output」。`kimi-cu xpc-ping` 报 `accessibility=true screenRecording=true`，`service-status` 为 enabled，版本 0.5.11。结论：截图为空是 KimiCU 当前状态问题，与 pi、adapter 无关；adapter 对图片块的转换未被本次验证覆盖。复验步骤：KimiCU 恢复出图后，在 pi 里执行 `kimi-cu_get_app_state app=<bundle id> mode=image`，模型应能描述截图 |
| M6 | `UNVERIFIED` | 依赖 M5 |
| M7 | 通过 | 账号 1 的 `mcp.json` 手工补上 Template 的 `figma-rest` 块后：`proxy.env` 未加 key 时 `pin doctor 1` 报 `WARN mcp.json references $FIGMA_API_KEY but proxy.env leaves it empty`，其余 `OK mcp.json figma-rest -> npx (env: $FIGMA_API_KEY)`；加上 key 后全 OK。`PIN_DRY_RUN=1 pin 1` 列出 `FIGMA_API_KEY=<unset>`。不带 key 启动 pi，system prompt 边界节写 `Available: kimi-cu, deepwiki` / `Not available in pi: figma-rest, figma`（让模型原文复述得到） |
| M8 | 通过 | `pin --no-skills --no-session -p` 让模型调 `figma-rest_get_figma_data(fileKey, nodeId="111165:296533", depth=1)`：返回顶层节点名 `Create（0914）`、64 个子节点，工具名 `figma-rest_get_figma_data`。首次懒连接由 `npx` 从缓存起 Framelink |
| M9 | 通过（改超时后） | 第一次导出整页画布（64 个 1920×1080 frame）两次 `Request timed out`：adapter 默认用 MCP SDK 的 60 秒，Figma 渲染整页要更久（直连 REST 冷渲染一个 32×32 frame 也要 12.6 秒）。Template 与账号给 figma-rest 加 `requestTimeoutMs: 180000` 后，`figma-rest_download_figma_images(nodeId="111820:139749", pngScale=2, localPath="out")` 在 pi 的当前目录写出 `out/icon.png`（PNG 96×96 RGBA，8.7 KB）。key 来自 `proxy.env`，命令行未导出变量 |

## 观察

- adapter 的直接工具在第一次调用后才连接服务器（懒连接），pi 的 session 日志里能看到 `toolsAdded` 系统消息，说明工具是在会话中动态注入的；这与 startup-check 在 `before_agent_start` 注入边界节的时机兼容。
- 权限门代理形态的 `detail` 会带上 `args` 的前 200 字符，确认框里能看到目标与参数。
- `pi install` 走的是账号目录下自己的 `npm/`，与本仓的 `node_modules` 无关，clean clone 不需要额外安装。

## pi 自审（2026-09-22 晚）

用 `pin 1 --no-skills --tools read,grep,find,ls --thinking medium --no-session -p` 让 pi（k3）只读审查整份 diff 与四个新文件。第一次把 62 KB 的 diff 直接塞进 `-p` 参数，进程 79 分钟零网络零 CPU，从未发出请求，杀掉后改为让它 `read` 文件，8 分钟内返回。结论「可接受，无 High」。

采纳并已修：`mcp` 元工具无 `tool` 参数的调用改为按名字 `mcp` 匹配（原先整体放行，connect 会拉起服务器进程）；startup-check 的可用判定与 doctor 一致（命令不存在也算不可用），`mode=ax` 提示只在 kimi-cu 可用时出现，边界节写明 deepwiki 的「先搜索再调用」两步和 `mcpScript` 已关；ADR 补 `/Applications/KimiCU.app` 例外说明；spec 风险节登记 `NATIVE_TOOLS` 假设与 `off` 模式回退行为。

记录不改：`PIN_SKIP_INSTALL` 与 pi 不在 PATH 两个 note 分支无用例（都是提示文案）。

## figma-rest 追加（2026-09-22 晚）

- 用户给的个人 access token 用 REST 探过一遍（token 本身不记录）：`/v1/me`、文件、节点、图片渲染、图片填充、组件、样式、评论、版本、dev resources 全部 200；`variables/local`、`variables/published`、library analytics 返回 403，错误体列出 token 的 scope：`current_user:read, file_comments:read/write, file_content:read, file_metadata:read, file_versions:read, library_assets:read, library_content:read, team_library_content:read, file_dev_resources:read/write, folders:read, webhooks:read/write`，缺 `file_variables:read`（Figma 文档：Enterprise only）。结论：还原 UI 所需的读取全部可用，Variables 不可用，写画布 REST 本身不支持。
- 官方文档核实：远程 Figma MCP 只走 OAuth 且只认目录内客户端（Claude Code、Codex、Cursor、VS Code、Xcode），个人 token 对它无效；REST API 用 `X-Figma-Token` 头，token 任何套餐可建。Framelink（`figma-developer-mcp`）是 GLips 维护的 MIT 社区项目，不是 Figma 官方；0.13.2 暴露 `get_figma_data(fileKey, nodeId, depth)` 与 `download_figma_images(fileKey, nodes, pngScale, localPath)`，从环境变量 `FIGMA_API_KEY` 读 key，默认开 PostHog 遥测，`FRAMELINK_TELEMETRY=off` 关闭（Template 已设）。直连 stdio 探测：连接 192 ms，`get_figma_data` 返回默认的 `tree` 格式（缩进文本，形似 YAML）。
- 该 token 曾出现在聊天记录里。按用户要求已写入账号 1 的 `proxy.env`；建议在 Figma 撤销并重建，替换那一行即可，其他配置不变。

## Codex 评审 figma-rest 增量（2026-09-22 晚）

`review-loop consult --peer=codex`，只读，材料走文件。结论 BLOCKED：0 High、4 Medium、1 Low。逐条对上游源码与本机复现核实，全部成立，已修：

- Framelink 默认以 `override: true` 加载当前目录 `.env`，`FIGMA_OAUTH_TOKEN` 优先于 `FIGMA_API_KEY`。复现：在含 `FRAMELINK_TELEMETRY=on` 的 `.env` 目录启动，遥测被重新打开。修：args 加 `--env /dev/null --no-telemetry`；`pin` 启动时清掉继承的 `FIGMA_API_KEY` / `FIGMA_OAUTH_TOKEN`。
- 引用语法与 adapter 不一致：adapter 2.36.0（`utils.ts interpolateEnvVars`）展开 `${VAR}`、`$env:VAR`、`{env:VAR}`，不展开裸 `$VAR`；本仓原先复用 models.json 的 whole-string 规则。修：`mcpServerEnvRefs` 按 adapter 正则扫 env/headers/url/cwd，新增 `mcpBareRefs` 把裸 `$VAR` 当配置错误，doctor 与 startup-check 都视为不可用。
- doctor 与 startup-check 不同义：`export FIGMA_API_KEY=""` 被判 provided；缺 key 时服务器仍 OK。修：`proxyEnvProvided` 解析值（去引号、后者覆盖），缺 key 时服务器行写 unavailable。PATH 差异（doctor 用当前 shell，运行时用 `proxy.env` 之后）记为已知限制，不建模。
- `resolveCommand` 对空命令、目录、不可执行文件放行（复现：`""` 解析成 `/bin`）。修：拒空、要求普通文件且可执行；空 PATH 项跳过并在注释写明。
- 提示里的「YAML」没有配置支撑：Framelink 默认 `tree`。修：提示改为「缩进树」，本记录同步。

测试从 100 增到 102（`npm test`），typecheck、leak-check 通过；账号 1 `pin doctor 1` 全 OK；改后再次验证：在一个放了 `.env`（`FIGMA_API_KEY=bogus-from-dotenv`）的目录里用 `pin -p` 调 `figma-rest_get_figma_data(nodeId="111820:139749", depth=1)`，仍用 `proxy.env` 的真 key 成功返回文件名 `版本/功能-迭代`，说明 `--env /dev/null` 生效；命令行未导出任何 Figma 变量。

## Codex 复审第二轮（2026-09-22 晚）

同样 `review-loop consult --peer=codex`。结论仍 BLOCKED：五条里 4 条 Resolved，第 3 条 Partially resolved（Medium），新增 1 条 Medium，无 High。Codex 未找到我放在 scratchpad 的 diff 文件（它只能读仓库），下次把材料放仓库内 `.review-handoff/runtime/` 下。逐条核实并处理：

- 第 3 条剩余：静态解析不模拟 shell。Codex 用 `/bin/sh` 对照出 6 个行形：`export A="" # comment` 被判非空、`export A=$OTHER` 被判非空、前导空格的 `export` 被判缺失、`export A=b` 后的 `A=` 未被识别为清空等。本地复现一致。修：`proxyEnvState` 三态解析（非空 / 空 / 无法判断），处理前导空格、单双引号、反斜杠、`#` 与 `;` 截断、非 export 的重赋值；含 `$` 或反引号的值标「无法判断」，doctor 对应输出「doctor cannot check it」而不承诺 OK 或 unavailable。测试覆盖 Codex 的 6 个行形加反引号、多命令行。
- 新增 Medium：整串裸 `$VAR` 被一律当误写并禁用服务器，`env: { PROMPT: "$HOME" }` 这类有意字面量会被误伤。采纳：doctor 只 WARN，startup-check 不再据此判不可用。
- 顺带：doctor 打印 `srv.url` 时改为只打印 origin 与 path（Codex 指出 URL 若内嵌凭证会进日志，属延续风险）；`pin` 清继承凭证的测试补上 `FIGMA_API_KEY` / `FIGMA_OAUTH_TOKEN`。

复审结果：`npm test` 102 通过，typecheck、leak-check 通过；账号 1 `pin doctor 1` 全 OK。Codex 自己未运行测试与真实调用（它标 `UNVERIFIED`），运行结果由本会话提供。

## Codex 复审第三轮（2026-09-22 晚）

裸 `$VAR` 一条 Resolved，新增 High / Medium / Low 均为零；第 3 条仍 Partially resolved，Codex 给出 4 个新反例：同一行 `export A=b; A=`、`unset A`、`export A=#literal`（shell 里 `#` 紧跟 `=` 是字面量）、双引号跨行值。本地复现一致。按它的原则重写：解析器只认四种简单行，其余任何行都让整份文件降为「无法判断」，doctor 额外提示「有 doctor 解析不了的行」；词内 `#` 按字面量；`unset` 生效；`$HOME` 视为已知（pin 从登录 shell 启动，HOME 必有值），消掉账号 1 通知命令 `$HOME/...` 引起的 WARN。测试覆盖三轮全部反例。

## Codex 复审第四轮（2026-09-22 晚）

第三轮四个反例全部通过；新增发现为零；第 3 条仍 Partially resolved，剩 3 个反例加 1 个静态推断：行尾 `\` 续行、`export A=</dev/null` 重定向、`export B=${A:=x}` 给 A 赋值的展开、`unset HOME` 后 `$HOME` 仍被视为非空。全部按「降为无法判断」处理：续行、重定向、赋值型展开让整份文件不确定；文件动过 HOME 后 `$HOME` 回到「需要求值」。测试补齐，103 通过。

## Codex 复审第五轮（2026-09-22 晚）

第四轮的反例全部通过，新增发现为零；第 3 条剩两个：`export B=$((A=1))` 算术展开里给 A 赋值、CRLF 文件（shell 会把 `\r` 留在值里，`export A=` 其实非空）。修：任何 `$(`、反引号让整行不可解析（文件降为无法判断）；文件里出现 `\r` 直接整份降级。测试补两例加命令替换一例，103 通过。

## Codex 复审第六轮（2026-09-22 晚）

第五轮的三项修复全部确认；新增发现为零；第 3 条剩一个：`trim()` 会删掉 U+00A0（不换行空格）和 `\v`，shell 却把它们留在值里。修：只删 ASCII 空格和制表符；补测试。此修复未再送 Codex 复审。六轮下来 Codex 对 figma-rest 增量本身没有剩余发现，反复卡在 doctor 的 `proxy.env` 静态解析这一条上，每轮给出的都是更冷门的 shell 角落用例；所有报出的用例都已修并有回归测试，是否继续投入由用户决定。

## 提交后评审与架构修复（2026-09-22 晚）

`8a603e8` 推送后跑了两份评审：OCR delegate（commit 模式，10 个可评审文件全看，11 个文档 / 测试文件按规则排除）与 codebase-design 架构评审（子代理探查 + 本会话核实，报告为本机临时 HTML）。用户决定：能修的全修，Strong 候选照改。

- Strong 候选「MCP Server 可用性收成一个 module」：`lib/config.ts` 新增 `serverStatus(server, {env, path})`，返回可用或不可用及原因（disabled / placeholder / no-target / command-unresolved / env-empty / env-unknown）；`pin doctor` 用 `proxy.env` 静态解析作 env 视图，startup-check 用进程环境，两处只做措辞。实证过的分歧（无 command 无 url 的服务器一边 WARN 一边 Available）消失。CONTEXT.md 加「Server Status」。
- OCR Medium：三处 PATH 扫描收成 `resolveCommand` 一处（`which`、`resolveKimiCuBin` 改用，只认可执行普通文件）。
- OCR Low：`idleDelaySeconds` 的 TS 校验补上 schema 已有的「整数且 ≥ 0」；`redactUrl` 通过 doctor 测试覆盖（含凭证与 query 的 url 只打印 origin + path）；session.ts 与 account.ts 的嵌套三元改为函数；删掉无生产调用的 `proxyEnvProvided`、只为测试的两处 re-export（attention-notify、startup-check）和无导入方的 `export`（account.ts 五个、`brokenConfigFallback`、`mcpTarget`），测试改从真正的 module 导入。
- 不改：权限门 `detail` 里的 MCP 参数只进 TUI 确认框，不进 Notifier（Notifier 收到的是 session.ts 的 summary），原 Low 不成立；JSON 文件的空白重排已提交，不再回改。

结果：`npm test` 104 通过，typecheck、leak-check 通过；账号 1 `pin doctor 1` 全 OK；真机启动后 system prompt 边界节仍列出 kimi-cu、deepwiki、figma-rest 可用、figma 不可用。剩余候选（拆 `lib/config.ts`、doctor 结构化记录、账号引用统一、proxy.env 解析对 sh 做 oracle）未动。
