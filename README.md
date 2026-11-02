# dsh-upgrade

把「升级 DSH（DeepSeek Harness）」从每次现场摸索，变成照着跑一遍的流程：**发现新版本 → 备份 → 隔离验证 → 一步切换 → 冒烟 → 回滚点**。

A repeatable, staged upgrade recipe for DSH: discover, back up, validate in an isolated copy, switch plugins and kernel in one restart, smoke-test, and keep a rollback point.

> 基线：这套流程在 **DSH 0.1.5-rc.1 → 0.2.1-rc.2** 上完整跑通过一次（Windows 11 / Node 24 / pnpm 12）。其他版本可用，但脚本里的示例版本号要换成你的目标版本。

---

## 它解决什么

手工升级 DSH 最容易踩的三件事：

1. **插件与内核有版本枷锁**——新插件声明 `engines.dsh >= 0.2.x`，旧内核会拒绝加载；反过来只升内核，旧插件会报缺包。所以「插件先、内核后」在**准备**顺序上成立，在**生效**顺序上不成立。
2. **配置迁移是有损的**——新版把 `settings.yaml` 改名成 `.imported` 再逐段导入，运行期不认的段落只记一条警告就永久丢弃（实测丢过 `skin-wallpaper`、`skin-custom-theme`、`dsh-better-sidebar`）。
3. **会话格式迁移单向**——用新内核起过一次，旧版就读不了新会话了。所以任何会启动新内核的动作都该先在副本上做。

这套脚本把这三件事固化成了步骤和检查。

---

## 目录

```
SKILL.md              工作流正文：铁律、阶段表、判读规则、已知坑（建议先读这个）
scripts/
  dsh-upgrade-report.mjs   阶段 0：版本发现 + 官方依赖清单 diff + 本地插件耦合扫描 + 风险清单
  dsh-trial.ps1            阶段 2：把指定版本装到独立目录，克隆一份 DSH_HOME 用于试运行
  dsh-smoke.mjs            阶段 3：HTTP 冒烟（令牌握手两步走，别用 curl -L 判）
  dsh-boot-inspect.mjs     阶段 3：解析页面里的 __DSH_BOOT__，列客户端插件条目，可与另一实例差分
  dsh-compat-check.mjs     升级后体检：已装插件的声明是否覆盖当前内核，并与运行时挂载条目对账
  dsh-switch.ps1           阶段 4：快照 → 装插件 → 补手工插件 → 钉住内核 → 重启 → 冒烟
  dsh-switch-detached.mjs  让切换在独立进程里跑并留日志（需在用户终端里跑）
  dsh-version.mjs          钉住 / 解除 / 诊断 launcher 实际使用的内核版本
  dsh-rollback.ps1         回滚：按 profile / sessions / settings / config 分别恢复
  dsh-get.mjs              带鉴权 GET 任意插件端点（调试用）
  install-skill.ps1        把本仓库的 SKILL.md 部署到 $DSH_HOME/skills/dsh-upgrade
```

`SKILL.md` 里的命令写作 `dsh-upgrade\scripts\xxx`（它假设被部署为 DSH 技能目录）；在本仓库里直接跑时把前缀换成 `scripts\xxx`。

---

## 前置条件

- **Node.js ≥ 20**（脚本只用内置模块，无第三方依赖）
- **Windows**：`dsh-switch.ps1` / `dsh-trial.ps1` / `dsh-rollback.ps1` 用 Windows PowerShell 5.1 或 PowerShell 7 均可；`.ps1` 文件带 UTF-8 BOM（PS 5.1 读无 BOM 的 UTF-8 会把中文拆坏）
- 一个按 `dsh web` 方式运行的 DSH 安装，通常位于 `%LOCALAPPDATA%\DeepSeekHarness\`
- 从 `dsh plugin` 装插件需要 `pnpm`（DSH 会把参数转给 pnpm）

macOS / Linux 下 `.mjs` 脚本可直接用；`.ps1` 需要改写成对应 shell 脚本。

---

## 快速开始

```powershell
# 0) 先看要升的是什么、有哪些包会断
node scripts\dsh-upgrade-report.mjs --workspace . --out reports --json

# 1) 备份（关键：/XJ 与 /XD node_modules 不能省，见 SKILL.md 第 3 节）
#    然后在副本上验证：

# 2) 装目标内核到独立目录 + 克隆 home
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-trial.ps1 -Version 0.2.1-rc.2 -PrepareInstall -CopyHome

# 3) 在副本里升级插件（用新内核的 CLI），再起试运行实例、冒烟
node scripts\dsh-smoke.mjs --url "http://127.0.0.1:3091/?token=<启动时打印的令牌>"

# 4) 验通后一步切换（先不带 -Apply 看计划）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-switch.ps1 -Version 0.2.1-rc.2

# 5) 升级后体检
node scripts\dsh-compat-check.mjs
```

---

## 安全边界

**这些脚本会写 DSH 数据目录之外的位置。** 使用前请读一遍再运行：

| 脚本 | 写入位置 |
|---|---|
| `dsh-switch.ps1` | `$DSH_HOME`（默认 `~\.dsh`）、`%LOCALAPPDATA%\DeepSeekHarness\config.json`、`D:\dsh-backup` |
| `dsh-trial.ps1` | `%LOCALAPPDATA%\DeepSeekHarness\versions\`、`...\trial-home\` |
| `dsh-rollback.ps1` | `$DSH_HOME`、`config.json`（可用 `-DryRun` 先看） |
| `dsh-version.mjs` | `config.json`（改前备份，写后读回校验） |
| `install-skill.ps1` | `$DSH_HOME\skills\dsh-upgrade` |

设计上的几条约束：

- **每步先备份、写完读回验证**；验证不过就中止，不"再试一次另一个写法"。
- **默认只覆盖不删除**；`dsh-rollback.ps1 -Purge` 才会删掉备份里没有的文件（会丢升级后新产生的会话）。
- 切换脚本的备份落在 `<备份根>\<时间戳>-pre-switch\`，失败时会打印回滚命令。

---

## 已知限制

- **不能无人值守跑完整切换**：第 5 步会重启承载当前终端/对话的服务进程。请在独立终端里跑，或接受这一轮对话被重启打断。
- **发布说明抓不到**：脚本只访问 npm registry；GitHub API 在部分网络下不可达，发布说明需手动取。
- **兼容性判定是静态的**：`dsh-compat-check.mjs` 只核对声明与包是否存在，判不了"跑起来是否顺手"。
- **没有覆盖视觉验收**：皮肤、壁纸、字号这类观感差异需要人眼确认。

---

## 说明

按 DSH 0.2.1-rc.2 的实际行为编写，其中不少结论来自踩坑（`SKILL.md` 第 9 节记了二十来条）。发现某条在新版本上不成立时，欢迎提 issue 或 PR。

## 许可证

[MIT](LICENSE) © 2026 chenkui-luo

随意使用、修改、分发，包括商用；保留版权声明即可。
