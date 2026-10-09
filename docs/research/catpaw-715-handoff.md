# CatPaw #715 开工交接

更新：2026-10-06。**可以开始助手版的离线接入：国内妙手与外区 CatPaw 共用解析器，地区决定模型映射，平台决定数据根。** 维护者要求 parser 放 `Javis603/tokscale` fork，Token Monitor 注册 `forkOnly`，默认关闭；CatPawAI IDE 暂缓。[issue 最新回复](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6008803049)

## 阅读顺序

1. [实施清单](catpaw-715-implementation-plan.md)：最新 fork/Token Monitor 基线、接线位置、模型/成本规则、fixture 与 binary 发布验收。
2. [国内与外区对照](catpaw-715-overseas.md)：macOS 解包、真实消息、CDP 模型表及桌面旧调研更正。
3. [Windows 国内包核对](catpaw-715-windows.md)：默认路径、跨版本 schema/SDK 对比和验证边界。
4. 数值证据：[消息对照](catpaw-715-message-comparison.json)、[国内模型转录](catpaw-715-domestic-models.json)、[外区模型快照](catpaw-715-overseas-models.json)、[Windows 静态比较](catpaw-715-windows-evidence.json)。

## 已有证据

| 被测产品 | 版本 | 默认 SQLite 根 | 验证 |
|---|---|---|---|
| macOS 国内妙手 | 2026.0923.1851 | `~/Library/Application Support/catpaw-moon/` | 解包 + 真实只读库，4/4 usage 恒等式成立 |
| macOS 外区 CatPaw | 2026.0929.1522 | `~/Library/Application Support/catpaw-overseas/` | 解包 + 真实只读库，3/3 usage 恒等式成立 + CDP 模型表 |
| Windows 国内妙手 | 2026.0917.1230 | `%APPDATA%\catpaw-moon\` | 安装包源码；三表与八个 SDK 方法和 macOS 国内逐字相同 |
| Windows 外区 CatPaw | 未取得包 | `%APPDATA%\catpaw-overseas\` | 仅由外区产品配置与路径函数推导 |

库名为 `catpaw-memory-<scope>.db`，排除 anon；scope 不限数字。`--user-data-dir` 可覆盖默认根，首版无需自动探测该覆盖。

用量读取 `payload.extra.contextInfo.usage`，分别映射 prompt/completion/cacheRead/cacheWrite，检查四项相加等于 total。没有独立 reasoning token 证据。完整上下文窗口是 `contextWindowTokens`，不把可用预算 `maxTokens` 当窗口。消息可重写，必须读取成功完整快照、去重并反映删除，失败保留 last-good。

国内与外区模型 ID 不同；外区 auto 为 `10000003`，国内表为 0，产品路由 sentinel 仍需保留。模型只来自 session 当前选择，换模型后历史归属存在近似；auto/路由/未知模型拒绝自动目录估价，显式 custom pricing 服从既有用户配置。积分倍率不是 token 单价。

## 开工与验收边界

当前本地 HEAD 仍在旧 JS adapter 架构；实施要基于最新主线与 fork，不能直接照桌面旧接线文档添加 JS parser。新实现保留两个地区离线模型快照的来源日期，未知 ID 不阻塞 token。用户已确认统一 client ID 为 `catpaw`，国内/外区及 macOS/Windows 共用；以数据根区分地区并选择模型表，所有注册、CLI/filter 与 wire identity 保持一致。

Windows 静态核对已足以支持共用 parser 的设计，发布验收仍需要 Windows 实机库/WAL，以及修改/删除、多账号、非零 cacheWrite 和工具/子代理样本。外区 Windows 路径可实现为推导根，但文档应继续标明尚未包/实机核对。Linux 默认来源不作无证据声明；跨平台 contract gate 的 fixture 适用性在实施时处理。

Token Monitor 侧目前只有文档与脱敏证据，尚未接业务代码；Tokscale 已完成下述本地原型。文档校验不等于生产接入或发布验收，尚无 GitHub 消息或发布操作。

## 开工环境准备（后续，2026-10-06）

用户授权检查并清理过期分支后，已在 `/Users/remixplay/IdeaProjects/tokscale` 从 `Javis603/tokscale` 主线 `789aea2adcc0300e8e8709a490cb4a73acd9b396` 建立并切到 `codex/catpaw-local-usage`，当前有未提交的 CatPaw 原型改动。新增 remote `token-monitor` 指向 `https://github.com/Javis603/tokscale.git`，保留 origin（个人 fork）和 upstream（原始 Tokscale）。parser 实现与验证见下节。

已删除三条本地分支；删除前核对其 head SHA 与对应已合并 PR 一致，GitHub 使用 squash merge，因此不能只依赖 `git branch --merged`：

| 仓库 | 删除的本地分支 | 原 head | 已合并 PR |
|---|---|---|---|
| Token Monitor | `feat/mimo-desktop-membership` | `a18191e5e570869f16187830b6d36bc76f858407` | [#824](https://github.com/Javis603/token-monitor/pull/824) |
| Tokscale | `codex/window-scoped-pricing-ready` | `cc1080f067c96d7f41a1f27a0d27b87ebedf0e6d` | [#2](https://github.com/Javis603/tokscale/pull/2) |
| Tokscale | `codex/mcode-store-draft` | `d87b2d554e6a46a0832a23de10394b80d2f0bac1` | [#1353](https://github.com/junhoyeo/tokscale/pull/1353) |

Token Monitor 当前 `codex/settings-discovery-metadata` 保留：其中 `171996ab perf(mimo): reuse Settings discovery metadata` 在 merged PR head 与 upstream/main 都没有等价 patch。两个 backup 分支和 Tokscale `perf/window-scoped-pricing` 没有直接合并证明，保留。`codex/fix-mimo-windows-cookie-path` 的 PR #950 已合并，但本地分支正被另一个工作区占用，也保留。远端分支未删除，现有 `.mimosa/` 与调研材料均保留。

## 原型与 review（后续，2026-10-06）

Tokscale 分支 `codex/catpaw-local-usage` 已有离线 parser 原型，仅新增 `token_monitor/catpaw.rs` 与 owned-client 注册；原型的核对内容写在 PR 描述里，仓库内不再保留文档，模块头只留代码相关注释。未改 Token Monitor 业务接线，未提交或发布。

九个 CatPaw 行为测试与完整 Rust workspace（4155 passed、0 failed、6 existing ignored）、严格 Clippy、格式检查和 CLI 构建通过。实际 CLI 的脱敏 fixture 与真实 macOS 账号库只读核对均为七条 usage、161580 tokens；日期过滤、session 分组与混合 client filter 也通过。

独立规范 review 修正了跨 home 的缓存隔离/快照保留及 Windows 测试关闭 SQLite 句柄；需求 review 修正了有效当前 selection 对旧 auto mode 的优先级。复查没有当前原型范围的剩余阻塞项。下一阶段仍是生产验收与 Token Monitor 接线，不能将原型验证当作 Windows 实机或正式发布支持。

兄弟 client 测试对照后，仅确认一处新增行为缺口：Windows CatPaw 扫描根曾忽略 `Scope.use_env_roots`，显式 home 仍读取本机 APPDATA。现已透传现有 Scope、复用 `PathRoot::AppData`，并补一条覆盖两条公共解析入口和不同 home 的回归测试；完整 workspace、严格 Clippy 与格式检查再次通过。Windows 路径分支仍需 Windows runner 验证；未照搬 Proma 流式合并、mcode 压缩历史或其他产品的数据格式规则。

最终代码/架构 review 又复现并修复一处模型边界：缺少 Boolean `isAuto` 或可选 `lastSelectedModelId` 不合法的 selection 不应覆盖 legacy 路由。现在按应用源码校验完整 selection，缓存版本 5 清除旧模型归属；原有模型测试补充相关回归，实际 CLI 复现已回退到 `pro` 的未知价格路由。两条独立 review 复查通过，无剩余风格/架构/死代码问题；完整 workspace 仍为 4155 passed、0 failed、6 existing ignored，严格 Clippy、格式与 CLI 重建通过。验证记录在 `/private/tmp/catpaw-715-review-validation/`。
