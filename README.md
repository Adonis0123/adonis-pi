# adonis-pi

一个 [pi](https://github.com/earendil-works/pi) 的 Pi Package：把我在 Claude Code、Codex、Grok Build 上养成的习惯装进 pi，不 fork、不改内核。

## 它做什么

- **权限门**：危险命令（`sudo`、`rm -rf /`、`git push --force`……）和受保护路径在执行前询问或阻止。规则来自你的配置，不是硬编码；命令按 `;` `&&` `|` `&` 子 shell和 `sh -c` 切开逐段匹配。它防的是误操作，不是安全隔离：不拦读取，不解析 shell 变量、别名和引号。
- **注意力提醒**：agent 等你回答、出错、空闲时，调用你自己的通知命令。发到哪里由你的命令决定。
- **`AskUserQuestion` 工具**：与 Claude Code 同名工具参数兼容，写给 Claude Code 的 skill 不改字就能在 pi 里向你提问。
- **多账号入口 `pin`**：`pin 1` / `pin 2` 各自独立的登录态与设置，模板复制一次，之后只报告漂移、不覆盖。
- **Provider 模板**：ChatGPT 订阅走 pi 自带 OAuth；GLM、Kimi 以 `$ENV_VAR` 引用 key，key 只存在 600 权限的 `proxy.env` 里。只有 `pin` 会加载 `proxy.env`；直接运行 `pi` 时启动检查会提示缺哪个变量。
- **默认关闭 pi 的安装遥测**：模板 `settings.json` 里 `enableInstallTelemetry: false`。

Skill 不在这里。pi 默认读取 `~/.agents/skills`，本包沿用这一约定。

## 状态

第一阶段代码已实现（2026-09-22），自动化测试通过；TUI 内的 `AskUserQuestion` 面板、权限门确认框和飞书提醒已验证，ChatGPT `/login` 与 commit skill 全流程待完成，记录见 `docs/verification/2026-09-phase1.md`。设计见 `docs/specs/2026-09-22-adonis-pi-phase1-design.md`，术语见 `CONTEXT.md`，决策见 `docs/adr/`。

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

`pin setup` 会在 `~/.pi/agent/` 生成 `settings.json`、`models.json`、`adonis-pi.json`，并提示你填写 `agentsMd` 与 `proxy.env`。不需要 `npm install`：pi 加载的是 TypeScript 源文件，`settings.json` 的 `packages` 指向这个 checkout。

## 更新

```sh
git -C <任意目录> pull
pin doctor 1
```

拉取即生效，下一次 `pin 1` 就是新代码。`doctor` 会指出模板新增了哪些键（Drift）由你决定是否同步到账号文件。改 `adonis-pi.json` 不用重启 pi，下一个事件即重读。

## 许可

MIT
