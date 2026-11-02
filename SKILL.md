---
name: dsh-upgrade
description: DSH（DeepSeek Harness）平台升级工作流——发现新版本、diff 官方依赖清单找破坏性变更、在隔离环境验证、按"插件与内核同一步生效"的顺序切换、留可回滚快照。当用户说"更新 dsh""升级 harness""检查有没有新版本""插件跟不上新版本""走一遍升级流程"时使用。
whenToUse: 用户提到升级/更新 DSH 或 DeepSeek Harness、检查是否有新版本、插件与新内核不兼容、或要求执行升级流程时。也适用于"只是想看看要不要升"的评估请求。
metadata:
  owner: 用户本人（2026-10-26 建立）
  scripts: dsh-upgrade/scripts/ 下 5 个脚本
  verifiedAt: 2026-10-26
  verifiedOn: 0.1.5-rc.1 → 0.2.1-rc.2（报告脚本实跑通过）
---

# DSH 升级工作流

把"升级 DSH"从一件每次都要重新想的事，变成照着跑一遍的事。

## 0. 铁律（违反任何一条，回滚成本都会翻倍）

1. **先备份，再动手；每一步动完读回验证。** 验证不过立刻停，不要"再试一下另一个写法"。
2. **会话格式迁移是单向的**（v2 → v3）。所以任何会启动新内核的动作，先在**副本 home** 上做。
3. **插件与内核必须"同一步生效"**（见第 4 节，这条最容易被误解）。
4. 仓库路径含 `[ai]`，PowerShell 一律用 `-LiteralPath`，否则会出现"路径存在却报不存在"。
5. 命令在**普通终端**里跑。agent 在沙箱里跑 `npm` 会被拒（它要写自己的缓存目录）。
6. 报告分不清"能不能升"和"升了会不会用着别扭"——**后者只有用户能判断**，不要替他下结论。

## 1. 阶段总览

| 阶段 | 做什么 | 脚本 | 验收标准 |
|---|---|---|---|
| 0 | 发现新版本 + diff 依赖清单 | `dsh-upgrade-report.mjs` | 报告落盘，风险清单可读 |
| 1 | 备份 | `robocopy`（见第 3 节） | 文件数、总大小、关键文件 SHA256 三项一致 |
| 2 | 隔离试运行 | `dsh-trial.ps1` | 副本 home 起来，3091 端口能开页面 |
| 3 | 冒烟 + 人工验收 | `dsh-smoke.mjs` + 手动清单 | 脚本全 PASS + 逐项打勾 |
| 4 | 切换（插件+内核同一步） | `dsh-switch.ps1` | 先不带参看计划，再 `-Apply`；末尾冒烟 0 失败 |
| 5 | 记录 | `change-log` 技能 | 修改记录 + 项目备忘各一条 |
| 回滚 | 任何时候不满意 | `dsh-rollback.ps1` | 三个部分各自恢复到备份状态 |

## 2. 阶段 0：发现

```powershell
node dsh-upgrade\scripts\dsh-upgrade-report.mjs --workspace "D:\...\启动DeepSeekHarness" --out dsh-upgrade\reports --json
```

脚本给不出发布说明（本机到 `api.github.com` 的连接会被中断），所以**下一步必须由 agent 用 web_fetch 抓**：

- `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v<目标版本>`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=10`（看中间还夹了哪些版本）

### 怎么判读报告

| 报告位置 | 含义 | 动作 |
|---|---|---|
| 4.1 「引用了目标版本里不存在的包」 | **硬冲突**：包根本没发布 | 该插件必须换版本或移除，没有第二条路 |
| 4.2 「peer 范围不接受目标版本」 | 插件是按旧内核编的 | 该插件必须升级到声明新范围的版本 |
| 2「被移除的官方包」 | 内核删了东西 | 逐个检查是否有插件依赖；被删的能力无法靠兼容层弥补 |
| 2「疑似改名」 | 很可能只是改名 | 人工确认，通常只需改 import |
| 3「引用官方包 **0 个**」 | 该插件没有包级耦合 | 唯一剩下的风险是服务方法形状与 DOM，风险低 |

**别只看 `latest` 标签**：2026-10-26 实测 `latest` 是 `0.2.1-rc.2`，而 `next` 已经是 `0.2.1-rc.3`。要升就明确写版本号，不要用标签。

## 3. 阶段 1：备份

```powershell
$bk = "D:\dsh-backup\$(Get-Date -Format yyyy-MM-dd)-before-dsh"
New-Item -ItemType Directory -Path $bk -Force | Out-Null
Copy-Item -LiteralPath "$env:LOCALAPPDATA\DeepSeekHarness\config.json" -Destination "$bk\config.json"
Copy-Item -LiteralPath "$env:LOCALAPPDATA\DeepSeekHarness\config.json" -Destination "$bk\config.json.bak"
robocopy "$env:USERPROFILE\.dsh" "$bk\dsh-home" /E /XJ /XD node_modules /R:1 /W:1 /NFL /NDL /NP
```

> **`/XJ` 和 `/XD node_modules` 不能省。** 实测教训：`~\.dsh` 里有 663 个 junction（pnpm 的软链布局，集中在 `profiles\node_modules`）。robocopy 默认会**跟进**这些联接，把目标内容再复制一遍——同一份 545 MB 的 home，备份出来变成 1015 MB、文件数从 17704 变成 57810。而这样恢复回去会把"联接"变成"真目录"，pnpm 布局就废了。
>
> `node_modules` 本身是可重装的（有 `package.json` + `pnpm-lock.yaml` 就够），排除它之后备份只有 156 MB / 760 个文件，既小又安全。

`robocopy` 退出码 **0–7 都是成功**（含增量），8 及以上才是失败。

**三重验证（缺一不可）**：文件数相等、总大小相等、关键文件的 SHA256 相同。**两侧都要排除 `node_modules`** 再比对，否则会出现上面那种假的不一致。

```powershell
$src = "$env:USERPROFILE\.dsh"; $bk = "<备份目录>\dsh-home"
$s1 = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\node_modules\\' })
$s2 = @(Get-ChildItem -LiteralPath $bk  -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\node_modules\\' })
"文件数 源=$($s1.Count) 备份=$($s2.Count)"
"总大小 源=$([math]::Round((($s1|Measure-Object Length -Sum).Sum)/1MB,1)) MB"
foreach ($f in @('settings.yaml','.credentials.yaml','profiles\web\package.json','profiles\web\cordis.patch.yml')) {
  (Get-FileHash -LiteralPath (Join-Path $src $f) -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath (Join-Path $bk $f) -Algorithm SHA256).Hash
}
```

不相等就停下。**2026-10-26 基线**：760 个文件 / 155.9 MB。

## 4. 阶段 2：隔离试运行（含"插件先还是内核先"的正确解法）

用户常说的顺序是"先更新插件，再更新内核"。**准备**顺序确实是这样，但**生效**顺序不行：

- 新插件会声明 `dsh.engines.dsh: ">=0.2.1-rc.2"`（实测 `@linxin666/dsh-web-all@0.4.8` 就是这样），旧内核会**拒绝加载**它；
- 所以"先把新插件装进正在跑的旧内核"会把当前可用环境直接弄坏。

正确解法：**在副本 home + 新内核里把插件装好、验通，然后一步完成正式环境的"换插件 + 换内核"。**

```powershell
# 1) 装新内核到独立目录 + 克隆 home（跳过 node_modules）
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-trial.ps1 `
  -Version 0.2.1-rc.2 -PrepareInstall -CopyHome

# 2) 在副本 home 里升级插件（用的是新内核的 CLI）
$env:DSH_HOME = "$env:LOCALAPPDATA\DeepSeekHarness\trial-home"
node "$env:LOCALAPPDATA\DeepSeekHarness\versions\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add <包名@版本> ...

# 3) 起试运行服务（独立端口）
node "...\bin.js" web --no-open --port 3091
```

### 插件升级命令的注意点

- `dsh plugin --profile <p> add <pkg>` 会把参数转给 pnpm。本机 pnpm 12.4.2 是全局装着的（早期脚本里"没装 pnpm"的注释已过期）。
- pnpm 12 有**新版本冷却**策略。若 `add` 之后落盘的不是你要的版本，去 `profiles\<p>\pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里补上精确版本。
- **不要以命令输出为准，读 package.json 核对实际版本。**

## 5. 阶段 3：冒烟

先跑脚本，再做人工清单。

```powershell
node dsh-upgrade\scripts\dsh-smoke.mjs --url "http://127.0.0.1:3091/?token=<启动时打印的令牌>"
```

它按浏览器的两步走：首请求带 `?token=` 拿 303 + Set-Cookie，再带 Cookie 取页面，检查 8 项
（可达 / 握手 / Cookie / 200 / text-html / 非空 / 含引导数据）。**别用 `curl -L` 判断**——
它不带 Cookie，只会拿到 401，看起来像坏了，其实协议是对的。

以下这些脚本判不了，需要人看：

- [ ] 会话列表加载，历史会话能打开（验证格式迁移）
- [ ] 新会话能发消息并收到回答
- [ ] 模型列表里有默认模型与自定义 provider，且能真的发出请求
- [ ] **插件设置是否原样继承**：皮肤、主题、字号、宠物、鲸鱼挂件、任务板、右侧栏的 `viewersEnabled` / `workspaceFence`（对着 `settings.yaml` 逐项比）
- [ ] 插件市场能打开
- [ ] 右侧栏在（文件树 / 终端 / git）
- [ ] 技能列表完整（数量与备份时一致）
- [ ] 设置页各卡片都在：重启、应用图标、侧栏透明度、用量提示
- [ ] 服务日志里没有插件加载报错（启动时那行 `dsh: warning: N entries did not activate` 必须是 0）

## 6. 阶段 4：切换（插件与内核同一步）

```powershell
# 先看计划：只读，不改任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-switch.ps1 -Version 0.2.1-rc.2

# 确认计划无误后执行
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-switch.ps1 -Version 0.2.1-rc.2 -Apply
```

脚本的六个步骤，每步验证通过才走下一步：

1. **快照** —— profile（不含 node_modules）+ 手工放置的插件，一起存进 `D:\dsh-backup\<时间戳>-pre-switch\`；文件数不符就中止
2. **装插件** —— 用**新内核的 CLI** 在正式 profile 上装新版（此时还没重启，旧内核仍在跑，但新插件不会被它加载）
3. **补回手工插件** —— `pnpm add` 可能把"不在 `package.json` 里"的包剪掉，从步骤 1 的快照复原
4. **钉住** —— `dsh-version.mjs pin`（自动备份 config 并读回验证）
5. **重启** —— `Launch-DeepSeekHarness.ps1 -Restart`
6. **冒烟** —— 从 `server-url.json` 取地址跑 `dsh-smoke.mjs`；失败就打印回滚命令

> 为什么不能"先重启到旧内核试新插件"：新插件声明 `engines.dsh >= 0.2.1-rc.2`，旧内核会拒绝加载，
> 结果是"插件没了、内核也没换"的半坏状态。所以插件与内核必须在同一次重启里生效。

> **谁来执行这一步 —— 这条很关键。** 第 5 步重启会杀掉承载对话的服务进程。实测结论：
> **agent 的沙箱里 detached 子进程不会真正执行**（spawn 返回了 pid，子进程却没有任何输出，
> 连续三次探针都是 0 字节日志）。所以不要设计"我在后台跑、跑完看日志"的方案。
>
> 两种可行做法：
> 1. **让用户在自己的终端里跑一条命令**（最稳）：
>    ```powershell
>    powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-switch.ps1 -Version 0.2.1-rc.2 -Apply
>    ```
> 2. 在对话里跑，但**接受这一轮会被重启打断**，事后再从 `server-url.json` 与冒烟结果确认。
>
> 危险窗口在"装了新插件（第 2 步）"到"钉住新内核（第 4 步）"之间：这几秒内若旧内核重启，
> 就会出现"旧内核 + 新插件"的半坏状态。所以这几步必须一口气跑完，不要中间停顿。

> **不升级也建议钉住**：`dshPath` 为空时 launcher 按 `bin.js` 修改时间挑最新，任何人跑一次 `npx @deepseek-ai/dsh` 就可能让它静默跳到新版本。钉住只需一个字段，把升级变成"你决定才发生"。

## 7. 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-rollback.ps1 -ListBackups
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-upgrade\scripts\dsh-rollback.ps1 `
  -BackupDir "D:\dsh-backup\2026-10-26-before-dsh" -What all -DryRun   # 先看
# 确认无误去掉 -DryRun 再跑
```

`-What` 可选 `profile,sessions,settings,config`。默认**只覆盖不删除**；`-Purge` 会删掉备份里没有的文件（包括升级后新产生的会话）——用之前想清楚。

## 8. 阶段 5：记录

用 `change-log` 技能写两条：升级了什么版本、动了哪些插件、验收结论、回滚点在哪。下次升级时这份记录就是"上次为什么这么干"的依据。

## 9. 已知坑

| 坑 | 症状 | 处理 |
|---|---|---|
| 路径含 `[ai]` | `Test-Path` 说路径不存在 | 一律 `-LiteralPath` |
| agent 在沙箱跑 npm | `EPERM ... _cacache\tmp` | 交给用户在普通终端跑 |
| GitHub API 不可达 | `fetch failed` / TLS 错误 | 由 agent 用 `web_fetch` 抓发布说明 |
| pnpm 冷却策略 | `add` 后版本没变 | 补 `minimumReleaseAgeExclude` |
| `--from-default-profile` | 会**替换** profile 及其插件和设置 | 绝不要对正式 profile 用 |
| 会话迁移单向 | 降级后新会话读不了 | 试运行只用副本 home |
| 标签会漂移 | `latest` 与 `next` 可能不是同一个 | 升级命令里写死版本号 |
| 自建插件无 npm 源 | "升级"= 重编 + 重测 | 源码要在手里，否则坏了修不了 |
| **手工放置的插件不在 `package.json` 里** | 克隆 home 后这些包"消失"，启动日志报 `N entries did not activate` | 克隆前先记下 `node_modules` 里有哪些包**没写进 `package.json`**（2026-10-26 实测有 3 个：`dsh-sidebar-opacity`、`dsh-plugin-app-icon`、`dsh-plugin-restart`），克隆后原样补进去 |
| 复制的数据带锁 | `task-board ledger is already owned by process N` | 副本里删掉 `<trial-home>\task-board\ledger-v2.lock`；正式实例还在用那个锁 |
| `process.exit()` 撞 fetch | `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 0xC0000409 | 设 `process.exitCode` 让进程自然退出，别强杀 |
| npm 的 allow-scripts | `N packages have install scripts not yet covered` | 先确认对等：`node-pty` 自带 prebuild、`koffi` 在两版里都没有 `.node` 文件，则与可运行状态一致，可忽略 |
| agent 沙箱里的 detached 子进程 | `spawn` 返回了 pid，子进程却没有任何输出或副作用 | 切换必须由用户在终端跑；沙箱里别指望"后台跑完再看日志" |
| `pnpm peers check` 报 missing peer | `missing peer @deepseek-ai/dsh` 一大串 | **结构性提示，不是问题**：官方包由内核提供，不在 profile 的 node_modules 里；能启动就没问题 |
| **0.2.1 的 settings 是有损迁移** | 升级后"界面看起来全变了"：`settings.yaml` 消失、多出 `settings.yaml.imported` | `dsh-settings.importLegacyDocument()` **先把 `settings.yaml` 改名为 `.imported` 再逐段导入**；导入不认的段落只记一条警告，**永久留在改名后的文件里**。2026-10-26 实测丢的是 `skin-wallpaper` 与 `skin-custom-theme`。对策：升级前把这两段手动补进 profile 补丁层（`dsh-switch.ps1` 的 step 3b 已自动补 custom-theme） |
| 壁纸功能被拆成独立插件 | 皮肤中心升级后壁纸消失 | `@linxin666/dsh-client-ui-skin-center@0.4.8` 的 README 明写：壁纸归 `dsh-plugin-wallpaper-engine`，旧 `skin-wallpaper` 段"会被忽略且不会被改写"。**必须单独安装** `dsh-plugin-wallpaper-engine`（自带 8 个 host 行与 5 个伴生包） |
| 壁纸引擎的状态不在 DSH_HOME 里 | 正式环境与试运行共用同一份壁纸配置 | 状态在 `%USERPROFILE%\.dsh-wallpaper-engine\`，`config.json` 的 `settings.id` 就是当前壁纸 id。隔离试运行时注意：它是共享的 |
| 浏览器本地值不随 DSH_HOME 迁移 | 侧栏透明度、右侧栏面板布局这类"看起来变了" | 存在浏览器 localStorage，且**按源（端口）隔离**：`:3080` 与 `:3081` 是两个源。只能在新端口下重设一次。能从 Edge 的 `Local Storage\leveldb` 看出痕迹，但文件被浏览器占用，需先复制出来再读 |
| **自定义主题会盖住壁纸** | 壁纸引擎日志显示在播（`playing=true`、`fails=0`），画面却全黑 | `skin-custom-theme.applied: true` 会把 `dark.background`（默认 `#171719`）刷成整个应用底板，而壁纸层是挂在 `body` 上 `z-index: -2` 的普通元素 → 被压在下面。改成 `applied: false` 即恢复；8 位带 alpha 的写法不一定被客户端接受。**排查顺序**：先关主题看壁纸是否出现，再看 `wallpaperOpacity` / `scrim` / `backgroundBrightness` |
| 带中文的 `.ps1` 必须存成 UTF-8 **带 BOM** | 解析报错指向毫不相干的注释行，或脚本行为莫名异常 | Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文被拆坏。要么全 ASCII（本仓库旧脚本的做法），要么加 BOM。用 `Parser::ParseFile` 验证 |
| 兼容性判据的四个陷阱 | 检查器报一堆"硬冲突/peer 不满足"，实际运行全正常 | ① 只有 `@deepseek-ai/dsh-*` 跟内核版本走，`cordis`（4.0.x）/`schemastery`（3.18.x）有自己的版本线；② 官方包由**内核安装**的 node_modules 提供，不在 profile 里；③ 只认 `import/require/import()` 的引用，别把包名清单和模板前缀当 import；④ DSH 判定用 `semver.satisfies(..., { includePrerelease: true })`（见 `dsh-app-boot` 的 plugin-compatibility），所以 `^0.2.0-rc.1` 接受 `0.2.1-rc.2` |
| 默认 `disabled` 的 bundle 行 | "装了但没挂上"看着像故障 | `@linxin666/dsh-web-all` 把 `web-ui-ssh`、`web-ui-skill-explorer` 等按需项默认写 `disabled: true`，在插件页启用后才挂载。对账时先排除这些 |

## 10. 脚本清单

| 脚本 | 用途 | 动到工作区外吗 |
|---|---|---|
| `dsh-upgrade-report.mjs` | 阶段 0：版本、依赖 diff、插件扫描、风险清单 | 只读 |
| `dsh-smoke.mjs` | 阶段 3：HTTP 级冒烟（令牌握手 + 页面） | 只读 |
| `dsh-boot-inspect.mjs` | 阶段 3：解析 `__DSH_BOOT__`，列出客户端插件条目，可与另一实例做差分 | 只读 |
| `dsh-compat-check.mjs` | **升级后体检**：逐个核对已装插件的声明是否覆盖当前内核（engines.dsh / 官方 peer / import 的包是否存在），并与运行时挂载条目对账 | 只读 |
| `dsh-switch.ps1` | 阶段 4：快照 → 装插件 → 补手工插件 → 钉住 → 重启 → 冒烟 | 写 `~\.dsh`、`config.json`、`D:\dsh-backup` |
| `dsh-switch-detached.mjs` | 让切换在独立进程里跑并留日志（**只在用户终端里有效**，沙箱里子进程不执行） | 写 `D:\dsh-backup\switch-logs` |
| `dsh-trial.ps1` | 阶段 2：装版本、克隆 home、打印启动命令 | 写 `%LOCALAPPDATA%\DeepSeekHarness\` |
| `dsh-version.mjs` | 阶段 4：钉住/解除/诊断版本 | 写 launcher 的 `config.json` |
| `dsh-rollback.ps1` | 回滚：按部分恢复 | 写 `~\.dsh` 与 `config.json` |
| `install-skill.ps1` | 部署本技能到 `~\.dsh\skills\` | 写 `~\.dsh\skills` |

除 `dsh-upgrade-report.mjs` 外，其余脚本都会写工作区之外的位置——执行前必须让用户确认。
