# ADR 0001: 以 Pi Package 扩展 pi，不 fork 内核

日期：2026-09-22 · 状态：已接受

## 背景

用户想要一个「属于自己的 pi」：带上自己在 Claude Code、Codex、Grok Build 上形成的习惯（共享规则文件、共享 skill 源、危险命令拦截、等待输入时的即时提醒、结构化提问工具、多账号目录隔离）。

三条路：

1. 不 fork，写一个 Pi Package，装到官方 pi 上。
2. fork `earendil-works/pi`，改内核，自己出二进制。
3. 用 `pi-coding-agent` SDK 另写一个 CLI。

## 决定

选 1。本仓库是一个 Pi Package，pi 本体永远从 npm 安装官方版本。

## 理由

- pi 的设计前提就是「靠 extension 适配，不改内核」。想要的每一项能力官方 examples 里都有 extension 版：`permission-gate.ts`、`question.ts`、`subagent/`、`custom-compaction.ts`。
- pi 版本迭代快（0.87.x）。fork 意味着长期 rebase；SDK 另写意味着自己维护 TUI 和会话管理。两者都把精力从「用」转到「养」。
- 现有习惯的载体已经是外置的：skill 在 `~/.agents/skills`（pi 默认读取），规则文件是一个可链接的 `AGENTS.md`，提醒是一个外部脚本。没有一项必须改内核。

## 代价

- 内核不提供的能力（MCP 客户端、sub-agent、plan mode）只能以 extension 形式补，或者不补。
- 扩展 API 随 pi 升级可能变动，需要跟随。

## 何时重新评估

连续两周日常使用后，出现任何一项「必须改内核才能解决」的阻塞，重开此 ADR。
