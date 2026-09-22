# CONTEXT

adonis-pi 的术语表。只定义词，不写实现。实现决策见 `docs/adr/`，阶段设计见 `docs/specs/`。

## 宿主与家族

- **Host（宿主）**：运行 coding agent 的终端程序。当前有四个：Claude Code、Codex、Grok Build、pi。
- **pi**：`@earendil-works/pi-coding-agent`，一个靠 extension 适配、不改内核的终端 coding agent。本仓不修改 pi 本体。
- **Family（家族）**：同一宿主的一组账号目录。pi 家族的主目录是 `~/.pi`，第 N 个账号是 `~/.pi-NNN`（三位数字）。目录就是身份。
- **Account（账号）**：家族里的一个目录，对应一份独立的登录态、会话、设置。pi 用 `PI_CODING_AGENT_DIR` 指向某个账号的 `agent/` 子目录。主目录 `~/.pi` 视为 001 号账号。

## 包与资源

- **adonis-pi**：本仓库，也是它产出的 Pi Package 的名字。装到任意 pi 账号上，让 pi 具备下文列出的能力。
- **Pi Package**：pi 定义的分发单元，一个含 `package.json` 的目录，里面有 `extensions/`、`skills/`、`prompts/`、`themes/` 中的任意几项。pi 通过 `settings.json` 的 `packages` 字段加载它。
- **Extension**：pi 的 TypeScript 扩展模块，可监听事件、注册工具与命令。本仓一个关注点一个 extension。
- **Skill**：符合 Agent Skills 规范的 `SKILL.md` 目录。本仓不存放 skill；skill 的唯一来源是 **Skill Source**。
- **Skill Source（技能源）**：机器上所有宿主共用的 skill 仓库，位于 `~/.agents/skills`。pi 默认读取它，不需要复制或链接。
- **Prompt Template**：pi 的 `/name` 提示模板，Markdown 文件。第一阶段不使用。

## 配置三层

- **Repo Layer（仓库层）**：本仓库里受版本管理、可公开的内容：代码、schema、Template、文档。不含任何机器专属路径或密钥。
- **Account Layer（账号层）**：某个 Account 目录里的真实配置文件：`settings.json`、`models.json`、`adonis-pi.json`、`AGENTS.md` 链接、`auth.json`、`sessions/`。私有，不进仓。
- **Secret Layer（密钥层）**：Account 目录里的 `proxy.env`，权限 600，只被 Launcher 读取并以环境变量注入 pi 进程。任何 Extension 不直接读它。
- **Template**：Repo Layer 里对某个 Account Layer 文件的模板。`pin setup` 在文件不存在时复制它；已存在时永不覆盖。
- **Drift（漂移）**：某个 Account Layer 文件与它的 Template 在结构上不一致。`pin doctor` 报告 Drift，由人决定是否对齐。
- **Config（扩展配置）**：Account Layer 里的 `adonis-pi.json`，是所有 Extension 唯一的配置入口。值可以用 `$VAR` 引用环境变量，和 pi 自身 `models.json` 的写法一致。

## 入口

- **Launcher（入口）**：`pin` 命令。`pin <n>` 启动第 n 号 Account 的 pi；`pin setup <n>` 把 Template 物化到该 Account；`pin doctor <n>` 体检。
- **acc**：机器上已有的跨家族账号维护命令。pi 家族接入 acc 时，acc 委托 `pin`，不重复实现。

## 能力（第一阶段）

- **Permission Gate（权限门）**：拦截危险工具调用的 Extension。命中 Deny 规则时，交互模式下询问，非交互模式下直接阻止。
- **Deny 规则**：Permission Gate 的一条匹配规则，作用于命令文本、文件路径，或 MCP 工具名（`<server>_<tool>`，直接工具按名字，`mcp` 元工具按其 `tool` 参数）。
- **Attention Notify（注意力提醒）**：在 agent 等待输入、出错、空闲时通知用户的 Extension。它只负责判定事件并调用一个外部 Notifier，不负责发送。
- **Notifier**：Attention Notify 调用的外部命令，由 Config 指定。发送渠道（飞书或其他）由 Notifier 决定。
- **Ask Tool**：名为 `AskUserQuestion` 的工具，参数与 Claude Code 同名工具兼容，让写给 Claude Code 的 skill 无需改字就能在 pi 里向用户提问。
- **Provider**：pi 的模型供应方配置。第一阶段有三个：ChatGPT 订阅（OAuth）、GLM、Kimi。
- **Session（会话上下文）**：一次 pi 进程里 Extension 共用的东西：生效 Config、Surface、向 Notifier 报事的入口。Extension 只说「发生了什么」，Session 决定要不要告诉 Notifier。
- **Surface（交互面）**：当前 pi 进程能怎样和人互动的三个判定：能弹对话框、能画自定义面板、能叫 Notifier。由 pi 的运行模式一次性推出，所有 Extension 共用同一张表。

## MCP（第二阶段）

- **MCP Server（MCP 服务器）**：通过 MCP 协议向宿主提供工具的外部进程或 HTTP 服务。第二阶段启用三个：kimi-cu（macOS 桌面操作）、deepwiki、figma-rest（经 Figma REST API 只读设计文件）；figma（Figma 官方远程服务器）只保留禁用占位，不接。
- **MCP Bridge（MCP 桥）**：让 pi 具备 MCP 客户端能力的 Pi Package。本仓不实现 MCP 协议，只依赖并配置一个现成的 Bridge（ADR 0003 选 `pi-mcp-adapter`，版本锁在 Template 里）。
- **MCP Config**：Account Layer 里的 `mcp.json`，MCP Bridge 的唯一配置入口，列出该账号启用的 MCP Server。有 Template，受 Drift 检查。
- **Server Status（服务器状态）**：对一个 MCP Server「此账号启动的 pi 能否用到它」的唯一裁决：可用，或不可用及原因（已禁用、占位符未解析、无 command 也无 url、命令不可执行、所需变量为空或无法判断）。`pin doctor` 与启动检查只呈现这个裁决，不各自判断。
- **CLI Facade（命令行门面）**：把一个 MCP Server 包成命令行程序、由 Skill 调用的方式。机器上 chrome-devtools 走这条路，pi 沿用；本仓不为其他 MCP Server 新建 Facade。

## 验收

- **Verification Task（验收任务）**：在真实仓库里用 pi 完成的一条完整工作流。第一阶段的验收仓是用户日常主仓，任务是「读代码、改代码、跑测试、走 commit skill」。
- **Phase（阶段）**：一组有明确验收任务的能力。第一阶段的范围在 `docs/specs/2026-09-22-adonis-pi-phase1-design.md`。
