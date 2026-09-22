# ADR 0002: 配置分三层，账号层用「复制 + 漂移检查」而不是 symlink

日期：2026-09-22 · 状态：已接受

## 背景

本仓库是公开仓，但它要驱动的 pi 账号目录里全是私有内容：登录态、API key、机器专属路径、个人规则文件。同时用户已有的多账号约定（`acc`）对 Claude / Codex / Grok 用的是「共享项 symlink 回主目录」。

要解决三件事：公开与私有的边界在哪；多个 pi 账号之间怎么共享又允许差异；Extension 从哪里读配置。

## 决定

配置分三层，边界固定：

| 层 | 位置 | 内容 | 可见性 |
|---|---|---|---|
| Repo Layer | 本仓库 | 代码、`config.schema.json`、`templates/`、文档 | 公开 |
| Account Layer | `$PI_CODING_AGENT_DIR` | `settings.json`、`models.json`、`adonis-pi.json`、`AGENTS.md` 链接、`auth.json`、`sessions/` | 私有 |
| Secret Layer | `$PI_CODING_AGENT_DIR/proxy.env` | API key 等，`chmod 600` | 私有，仅 Launcher 读取 |

四条规则：

1. Repo Layer 不含绝对路径、密钥、个人目录布局。机器专属值只能出现在 Account Layer，或以 `$VAR` 的形式引用环境变量。
2. 每一个 Account Layer 文件在 Repo Layer 有且只有一个 Template。`pin setup` 在目标不存在时复制 Template；目标已存在时**永不覆盖**，只由 `pin doctor` 报告 Drift。
3. Extension 只通过 `lib/config.ts` 读 `adonis-pi.json`，不直接读 `process.env`、不读 `proxy.env`。需要环境变量时在 `adonis-pi.json` 里写 `$VAR`，由 `lib/config.ts` 统一解析。
4. 密钥只进 `proxy.env`，由 `pin` 在子 shell 里 `source` 后启动 pi。pi 自身的 `models.json` 用 `"apiKey": "$GLM_API_KEY"` 这类引用，因此密钥从不落在 Account Layer 的 JSON 文件里。

## 为什么不沿用 symlink 共享

- Grok 家族已经证明：某些宿主在沙箱路径上不认 symlink，`acc` 为此维护了「真副本」例外。pi 的 extension 由 jiti 动态加载，symlink 的解析路径会影响相对 import，风险同类。
- 账号之间需要差异：`pin 1` 用 ChatGPT 订阅，`pin 2` 可能是纯 API 账号，`settings.json` 的 `defaultModel` 不该被迫相同。
- 复制 + 漂移检查让「共享」变成显式动作：Template 改了，`pin doctor` 会指出哪个账号落后，由人决定同步。symlink 的隐式同步在多账号里曾造成 MCP 漂移事故。

## 代价

- 多一个 `pin doctor` 要维护，Template 改动不会自动生效。
- Account 数量增加时，同步是 O(N) 的手工确认。当前预期 N ≤ 3。

## 何时重新评估

Account 超过 3 个，或某个 Account Layer 文件被证明在所有账号里永远相同，可以把该文件改回 symlink。
