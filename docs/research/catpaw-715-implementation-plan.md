---
summary: "CatPaw issue 715 implementation handoff: shared offline parser for Miaoshou and overseas CatPaw in the Tokscale fork, source registration, model snapshots and release gates."
read_when:
  - Implementing CatPaw or Miaoshou local token collection
  - Updating CatPaw model snapshots or supported storage paths
---

# CatPaw #715 实施清单

状态：Tokscale 本地原型已实现并验证，Token Monitor 生产接线尚未开始；完成情况与验证边界见 [开工交接](catpaw-715-handoff.md)。截至 2026-10-06，国内妙手与外区 CatPaw 的 macOS SQLite schema、消息结构及样本 token 计量可以共用解析；应用数据目录和模型编号不同。Windows 国内安装包已静态核对，相关 schema/持久化/SDK usage 透传方法与 macOS 国内版相同，可以使用同一 parser；静态代码比较不能代替 Windows 实机读库，也未覆盖外区 Windows 包。证据见 [区域对照报告](catpaw-715-overseas.md)、[消息对照](catpaw-715-message-comparison.json)、[外区模型快照](catpaw-715-overseas-models.json)、[Windows 包核对](catpaw-715-windows.md)、[Windows 校验记录](catpaw-715-windows-evidence.json)。

## 已确认的产品与架构范围

维护者已经认可先接助手版，使用**离线解析、本地模型映射、默认关闭**；不读应用登录凭据联网刷新，CatPawAI IDE 暂不做。用量解析进入 `Javis603/tokscale` 的 `crates/tokscale-core/src/token_monitor/`；Token Monitor 补 `forkOnly`、来源/展示与 token contract。原桌面 02/03/08/12 中的 JS local adapter 接线、独立定价 subprocess 及“无需 token contract”不再适用。[维护者回复](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6008803049)、[迁移 PR #933](https://github.com/Javis603/token-monitor/pull/933)

用户已确认统一使用 `catpaw` 作为追踪客户端 ID，覆盖国内妙手与外区 CatPaw 助手、macOS 与 Windows。在 parser 内以来源目录区分地区并选择模型表；fork `CLIENT_ID`、Token Monitor catalog、CLI/filter 和 wire client 字段均使用同一 ID，不按地区或平台拆分 client。首版不增加 limits provider、凭据设置、自动刷新机制或依赖。未知模型照常计 token。[当前 tracked-client 接入指南](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/docs/providers/README.md)

本清单核对的官方源码基线：Token Monitor 主线 `54c0da02ddae30d0aba5df2ddc23197431455ea0`；Tokscale fork 主线 `789aea2adcc0300e8e8709a490cb4a73acd9b396`。当前工作区 `171996aba552514dceca5c9c8beb7fa44ccfd4bd` 仍是旧 adapter 架构。开工时重新核对主线并在合适的干净 checkout 实施，保留现有工作区材料；本轮没有拉取、切换分支或覆盖现有改动。

## Windows 国内安装包核对（静态证据，非实机）

| 检查项 | 结果 / 证据 |
|---|---|
| 国内安装包版本、SHA-256 | 妙手 `2026.0917.1230`；安装包 `05710871ff31c93880b88fbc5f95a5879c9182eeff2ad244a54384b9fc6dc5fd`；app.asar `3244886833a39430dd19ffde606df5eb210b6d33faedb9fbde0dcae09f0a737d` |
| 官方 ASAR 抽取后关键文件 | `main-Bwpu7z8v.js`、`dataPathService-N484K7oM.js`、`storageService-BCgP9vM4.js`、`uiSdkStateHolder-BA5pXBfe.js`、`modelTypesService-SWfH4ab_.js`；安装包解包链见 Windows 报告 |
| applicationName / package | `catpaw-moon`；本清单不以 macOS bundle ID 代替 Windows identity |
| `resolveUserDataDir()` 默认根及覆盖 | 源码为 `app.getPath('appData') + catpaw-moon`，Windows 即 `%APPDATA%/catpaw-moon/`；`--user-data-dir` 可覆盖 |
| DB 文件模式与运行根 | `catpaw-memory-<scope>.db`，匿名库需排除；CLI runtime `homedir/.meituan-catpaw`，不作为 token root |
| 三张相关表 schema 与 macOS 比较 | `ui_sdk_messages`、`sessions`、`conversations` 建表 DDL 全部逐字相同；checksum 见 Windows evidence |
| SDK usage 透传 | v1/v2 adapter 的 computeStreamMessageExtra、recordAssistantExtra、handleStreamResponse、buildAssistantMessage 八项全部逐字相同；SDK 版本分别 `1.2.3` / `0.1.21`，不能称整个库版本相同 |
| 持久化、模型选择与取表 | 同样 `JSON.stringify(payload)`、schema 1、整体重写与 session 当前模型字段；POST model-types 的 path/body、300000ms 内存缓存相同；实际 Windows 模型供给仍未取样 |
| 项目 JSONL 根是否有直接源码证据 | 本轮未确认 Windows 项目根，先不声明一个猜测路径 |
| Windows 实机 SQLite/WAL/SHM、消息样本 | **仍待实机**；解包通过不等于该项通过 |

国内 Windows 关键 schema/usage 链路相同，可使用同一 Rust parser，平台差异只留在根路径解析与必要的 filename/path 处理。外区 Windows 包尚未解包，不能把国内结果直接当作其验证。默认 appData 路径有 [Electron 官方定义](https://www.electronjs.org/docs/latest/api/app#appgetpathname) 与包内 resolveUserDataDir 调用链互证；这仍是源码链验证，不是 Windows 上真实 DB 路径观测。

## 1. Fork：新增 owned client，沿用当前扫描通道

- [ ] 先读 fork 根 [AGENTS.md](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/AGENTS.md)，检查实施 checkout 是否新增嵌套指导；自动调用 Tokscale 都加 `--no-spinner`。
- [ ] 新增 `crates/tokscale-core/src/token_monitor/catpaw.rs`，导出 `CLIENT_ID` 与 `parse(home_dir: &str) -> Vec<UnifiedMessage>`；`token_monitor/mod.rs` 加模块声明与 `CLIENTS` 项。这是 owned client，不能放 `SUPPLEMENTS`，也不应改 upstream `ClientId`、`ClientFilter` 或各客户端 lane。
- [ ] 沿用已有 CLI owned-client hook；只有显式 `--client catpaw` 才解析，普通未过滤 Tokscale 扫描不自动增加此客户端。测试 mixed `--client claude,catpaw` 和仅 catpaw 的实际 JSON 扫描，保留其他客户端的原有行为。
- [ ] 输出 `UnifiedMessage` / `TokenBreakdown`，复用既有聚合、日期过滤、模型定价和 session/workspace 报告；不在模块里生成 today/month/allTime/history，也不为定价再启动 Tokscale。

依据：[core token_monitor/mod.rs](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/token_monitor/mod.rs)、[CLI owned-client hook](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-cli/src/token_monitor.rs)、[UnifiedMessage](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/sessions/mod.rs)。

## 2. 来源发现：地区、平台与 scope 分开

| 来源 | macOS | Windows | 证据边界 |
|---|---|---|---|
| 国内妙手 | `<effective home>/Library/Application Support/catpaw-moon/` | `%APPDATA%/catpaw-moon/`，APPDATA 缺失时 parser 可采用 `<effective home>/AppData/Roaming/...` fallback | macOS 真实库已读；Windows 默认根及 schema 有本轮包源码链，尚未实机；fallback 是与现有 fork 一致的实施策略 |
| 外区 CatPaw | `<effective home>/Library/Application Support/catpaw-overseas/` | `%APPDATA%/catpaw-overseas/`，同类 fallback | macOS 真实库已读；Windows 暂为产品路径函数推导，尚未验证外区 Windows 包 |

- [ ] 在每个支持的地区根仅发现 `catpaw-memory-<scope>.db`，排除 `catpaw-memory-anon.db`、WAL/SHM、自定义 store 与其他库。scope 可含字母、数字、下划线和连字符，不能只匹配数字 userId；来源地区来自选择的根，不从模型编号猜地区。[区域路径证据](catpaw-715-overseas.md)
- [ ] 默认纳入发现的非匿名历史账号库，不读登录态来筛“当前账号”。以地区 + DB 来源 namespace + conversation/message identity 防止不同账号或地区碰撞；相同 DB 内重复更新同一消息只能贡献一次。明确此为全本机留存历史，不是当前登录账号用量。
- [ ] 路径解析遵守 fork 实际 `home_dir` 与平台 env；Token Monitor 的 JS paths helper 必须镜像该行为，包括 Windows effective HOME 与 APPDATA 优先级。不要沿用 `os.homedir()` 与 scanner 不一致的路径。
- [ ] APPDATA 属于 host env，因此在 Windows WSL 扫描排除 `catpaw`，避免每个 distro 重复读 host 库；没有 Linux app 或来源证据时不声明 Linux/WSL marker。Linux 上 default path 不猜 `~/.config/catpaw-*`。可用 synthetic fixture 测 parser 的底层读库函数，无需宣称 Linux 产品支持。
- [ ] 首版先覆盖已证实的默认根。应用 `--user-data-dir` 可以改变根；自动探测进程参数、读 scope/auth 指针或新建用户设置不是本次首版必需项。若将来需要路径 override，必须同时落实 scanner、watch、anchor、文档与 hermetic tests，不能只加一边。

项目归属单独处理：国内 `~/.catpaw/projects` 已有 JSONL 证据但无 usage，仅用于已验证的会话→cwd 信息；外区项目根尚未证实。首版可以不做额外项目文件读取，在 source 缺失时保留无项目归属，绝不能把 project UUID 或可歧义的目录名当真实 cwd。context 是可选后续功能；仅从记录的 `contextWindowTokens` 与 `totalUsageTokens` 提取，保持 `shouldReadSessionContext()` 门控，不能从模型名推窗口。[区域实测](catpaw-715-overseas.md)、[当前 provider 指南](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/docs/providers/README.md)

路径先例：[Qoder CN JS paths](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/src/shared/providers/qodercn/paths.js)、[Qoder CN Rust data_paths](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/token_monitor/qodercn.rs)、[WSL 排除与 host APPDATA 原因](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/src/shared/wslUsage.js)。

## 3. SQLite、token 与失败语义

- [ ] 复用现有 `open_readonly_sqlite()`（rusqlite READ_ONLY），设置有界 busy timeout；直接读取原 DB/WAL，不把主库单独复制后读。读取会话选择与消息投影时使用一致的读事务；不执行应用代码、迁移、清库、解密或写业务表。
- [ ] SQL 仅投影需要的字段：消息 identity/时间及 `payload.extra.contextInfo.usage`，session 当前模型选择等。不要 `SELECT *`，不保存对话、推理正文、draft、完整 payload 或凭据。无 usage 行正常略过；usage JSON 损坏或计量不合法应明确报失败。
- [ ] token 字段按非负整数验证后映射：input=promptTokens，output=completionTokens，cache_read=cacheReadTokens，cache_write=cacheWriteTokens；reasoning=0，cache_write_1h=0（来源未给独立证据）。cacheWrite 不硬编码为零；不能由 residual、duration 或 maxOutputTokens 反推 reasoning/模型。
- [ ] 校验 `prompt + cacheRead + cacheWrite + completion == totalTokens`，用有界/checked 算术避免溢出；不成立时该源的本次完整读失败，并保留上次完整快照，避免坏数字进入 exact delta。
- [ ] 活样本国内 4/4、外区 3/3，全部 cacheWrite=0，来自独立每轮记录而非 cumulative session counter。真实外区合计 65229，国内合计 96351；样本不证明每个模型、子代理或非零 cacheWrite 行为。新增 synthetic cacheWrite>0 用来验映射，不冒充真实语义验证。[消息证据](catpaw-715-message-comparison.json)
- [ ] 时间取有效 `created_at_ms`，缺失时回退有效 `updated_at_ms`；都不可用时遵守 Tokscale 无有效时间规则，不以 now 填充。parser 读当前完整源快照，由 Tokscale 外层日期过滤；不照旧 JS adapter 在 SQL 仅读 since 窗口，否则会丢历史/修改后的旧行。
- [ ] `ui_sdk_messages` 是 upsert/重写存储，不能假定 seq 永远只追加；以稳定 message identity 去重，重读时替换旧值。会话/消息真实删除应在下一次成功完整读取中反映。创建时间用于 period，更新时间/DB-WAL fingerprint 用于失效，两者用途分开。
- [ ] 参照 Qoder CN Rust 的每源 last-good 缓存：主 DB 与 WAL 长度/mtime 做 fingerprint，unchanged 不重读/不重写 cache；锁、I/O、schema 变化、读预算或校验失败保留旧数据，不发布 partial/空读。缓存只存数值和必要 metadata，写入采用当前模式的原子替换。目录读取失败不能误判所有 DB 已删除；确认缺失与读取失败分开。
- [ ] 限制 DB 数量、行/字节读取、JSON 大小与等待时间；先复用合理的现有约定并以重库样本验证，预算触发属于源失败，不是合法截断总量。冷启动失败没有 last-good 时只给可解释的缺数据状态，不能标成已成功读取零用量。

依据：[只读 SQLite 工具](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/sessions/utils.rs)、[Qoder CN read_db/collect_db/cache](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/token_monitor/qodercn.rs)、[TokenBreakdown.total](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/lib.rs)、[区域消息重写源码比对](catpaw-715-overseas.md)。

## 4. 模型快照、auto 与成本

映射按来源地区查 `modelTypeId`。下面是取表时刻的离线基线，不是永恒目录；国内来自 [2026-10-04 桌面证据的字段转录](catpaw-715-domestic-models.json)，外区来自 [2026-10-06 CDP 快照](catpaw-715-overseas-models.json)。不要把 description 展示名自动当作另一模型、也不要把同名不同编号合并成一个来源映射。

| 国内 ID | 模型 | 外区 ID |
|---:|---|---:|
| 0 | auto | 10000003 |
| 63 | deepseek-v4-flash | — |
| 64 | deepseek-v4-pro | — |
| 70 | MiniMax-M3 | — |
| 77 | LongCat-2.0 | 10000002 |
| 83 | kimi-k3 | 10000007 |
| 89 | glm-5.3 | 10000005 |
| 91 | glm-5.3-flash | 10000006 |
| 98 | glm-5.3-flashx | — |
| — | gpt-5.6-terra | 10000001 |

- [ ] 当前 `persistedModelSelection.isAuto` / 当前 modelId 与 `persistedModelId` 优先；没有当前字段才考虑 legacy/initial mode。样本已有 initial auto + 当前具体模型，不能一见 `initialModelMode:auto` 就盖过当前选择。按源码定义明确两个当前 ID 字段冲突的处理，无法确定则 unknown，不自行选价格更低的模型。
- [ ] 识别国内 auto=0、外区表 auto=10000003，以及 app 静态路由/safe-room sentinel 与 legacy lite/pro/max；外区新 auto 不等于替换所有 0。除已经证明是真实具体模型的 LongCat 外，路由档不可推出背后的模型。未知数字保留地区和 ID（如 `catpaw-overseas-model-<id>`），负数显示来源区分的自定义占位，不解密名字或 API key。[sentinel 与真实供给差异](catpaw-715-overseas.md)
- [ ] 没有逐消息模型身份：本次按 session 当前选择归属，写明中途换模型会使历史归属近似；不能用模型表或输出上限“修复”该限制。
- [ ] auto/路由、未知 ID、自定义占位使用既有 `unpriced:catpaw` provider convention，保持 `CostSource::Unknown`，默认 cost 初值 0 不是 provider-reported $0。避免 fuzzy model lookup 把 auto 或未知标签匹配到外部套餐/模型。
- [ ] 已知具体模型交给既有 PricingService，必要时使用 `inferred_provider_from_model` 的现有 provider identity；匹配不到价格则保持未知，不读应用网络/积分接口。估价只代表现有模型 API 参考价，不是 CatPaw 账单。`rateMultiplier` 不进入 token bucket 或美元单价。
- [ ] `unpriced:` 禁止**自动目录估价**，但 fork 的 `PricingService` 已明确允许用户显式 custom pricing 优先作为 escape hatch。本接入沿用该边界并测试：无 custom rate 时 auto/unknown 保持未知；精确 custom rate 若配置则遵循既有用户定价规则，不伪称自动识别了真实模型。不要为本 client 修改全局 pricing 行为。
- [ ] 映射表随版本离线更新，未知 ID 不阻塞 token；如需诊断，使用受支持的现有诊断通道，去掉 credential/正文/原始路径，不新增网络自动刷新。不能把任意 stderr 文本当已实现的 renderer diagnostic wire。

依据：[Qoder CN 的 unpriced provider](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/token_monitor/qodercn.rs)、[lookup 的 unpriced 拒绝与 explicit custom escape hatch](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/pricing/lookup.rs)、[PricingService custom 优先级](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/crates/tokscale-core/src/pricing/mod.rs)。

## 5. Token Monitor：注册、watch 与元数据

- [ ] `src/shared/clientCatalog.js` 添加 client，`forkOnly:true`、`defaultTracked:false`；不要恢复 `locallyParsed`。客户端命名要与 fork CLIENT_ID 固定一致。
- [ ] `providers/catpaw/paths.js` 只解析必要 source roots，供 `clientSources.js`、health 与 anchor 共用；不在 JS 加 token parser。平台根与实际 fork 一致，动态 DB 文件集合排序后进入 anchor/config fingerprint。
- [ ] 每个已发现 DB 用 `[checkId, parentDir, exactDbPath]`。watch 限定该 DB/WAL/必要 SHM，不能整树递归读取 auth/settings/logs。还需覆盖默认目录内新增/删除 DB 的动态发现：测试零 DB→首个 DB、多账号新增/删除会更新 watch 与 anchor，不能只对启动时存在的文件永久定格。
- [ ] `CLIENT_SOURCE_CHECK_IDS` 加需要的 check ID（保持排序），不要把地区另一根缺失一概当客户端异常；测试单地区安装和两个地区共存的 health/检测含义。raw 绝对路径不能进入 published health record。
- [ ] `normalizeClientName()` 用精确 catpaw identity，不用 includes 吞掉 `catpawai`；若不需要 alias 就不新增 alias。通过 fixed-point、filter 回到 parent 与不发 synthetic 的既有 partition guards。
- [ ] WSL 排除对应 client；forkOnly 默认不开放 custom scan paths，保持 capability check 从 --help 跳过而由真实 fixture gate 验证。
- [ ] 根据 Rust scanner 的实际行为决定 SHM 事件抑制：在应用运行中/WAL 未 checkpoint 时连续扫描验证，再决定是否使用现有 `SELF_WATCHED_SQLITE_SIDECAR_CLIENTS`。不能拿旧 JS 只读测试下结论；DB/WAL 外部变化仍必须触发。
- [ ] 保持 full scan serial today/month/allTime，watch tick today exact delta/no cooldown；失败快照不污染 anchor。新根集合导致历史来源变化时触发安全的全量重基线，而不是沿用旧 today delta。
- [ ] 添加 `VENDOR_PRESENTATION`、图标与 README 所有现有 locale 的支持行、注册守卫；更新文档声明默认关闭、两地区默认根、私有格式/模型归属/unknown cost 限制。`.env.example` 若含支持名单注释则同步；默认 CSV 不纳入 defaultTracked:false 客户端。
- [ ] 新 `docs/providers/catpaw.md` 记录 identity/data sources/安全边界/限制与验证，front matter ids 与 catalog 一致。共享源改动后同步 Worker；不要编辑 `worker/src/shared` 生成副本。最后一次 Hub/shared 改动完成再运行 `npm run update:hub-build`（已含 Worker 同步）。

标题、workspace metadata 可由 fork 的 `UnifiedMessage` 报告现有 scan 支持的字段；live context 若追加 JS metadata pass，使用现有门控与最小字段读取。不要因数据“白送”而把独立 UI 功能、额度支持和全新的元数据接口塞进首个解析补丁。

依据：[tracked-client checklist](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/docs/providers/README.md)、[clientSources 精确文件根](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/src/shared/clientSources.js)、[collector configFingerprint/watch policy](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/src/shared/collector.js)、[architecture](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/docs/architecture.md)。

## 6. 有效测试与 token contract

Fork 的模块级 fixture 覆盖：两地区与同 conversation/message ID 不碰撞；anon 排除；非纯数字 scope；无 usage 元数据行；零 cacheRead；非零 cacheWrite 的映射；负数/非整数/溢出/恒等式失败；NULL 创建时间；消息更新/删除/重写；模型当前字段优先于 initial auto；两地 auto/未知/负数拒绝自动估价；已知模型参考价及明确 custom override；DB lock/corrupt/schema/budget/目录读失败保留 last-good；WAL 改变使缓存失效；unchanged 不重写；真实缺失与不可读区分。优先验证这些行为，不复制实现细节做镜像测试。

- [ ] 在 `scripts/verify-vendored-tokscale.js` 的 `TOKEN_CONTRACT_CASES` 为新 client 添加 SQLite fixture（同一 client 可用两个地区 case），覆盖非零 cache bucket 和地区模型映射；不依赖开发机真实账号库。`expectedRow`、`hasExplicitTotal`、`expectedPeriod`、`expectedSession` 都按**实际编译 binary JSON**断言。
- [ ] 推荐至少一个合成代表值：prompt=1200、cacheRead=500、cacheWrite=80、completion=340、total=2120，reasoning=0；原始 total 用于 parser 自校验，是否有 explicit total JSON 由 binary 实际输出决定，不能把 DB 字段存在等同于 report 有该字段。
- [ ] hermetic child env 固定 HOME/USERPROFILE/APPDATA/XDG/TOKSCALE_CONFIG_DIR，primed fresh pricing cache + cache-only，剔除能改变 scan 路径的变量；若未来加 path override，必须在 gate 删除相应变量。用于不支持默认 app 根的平台时，fixture 可经测试专用底层 reader 验证，生产 gate 的支持/空输出规则必须明确，不得读 host live DB。[当前 token contract gate](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/scripts/verify-vendored-tokscale.js)
- [ ] 实际 report 运行 `client,model` 与生产 `client,workspace,session,model`，比较 raw buckets 与 `extractUsageFromTokscale()` 后周期/session 总数；检查 output 不重复叠加 reasoning。测试日/月边界与 existing exact delta：7 条实测 usage 的总量作为离线回归样本，不作为“所有历史完整”证明。
- [ ] `tests/shared/tokscaleTokenContracts.test.js` 必须认可该 client 已有 case；`verify-vendored-tokscale-clients.js` 需通过 fork-only 真实扫描而非 --help 字符串，保留默认关闭也有 gate 覆盖。[clients gate](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/scripts/verify-vendored-tokscale-clients.js)

平台 gate 要特别处理：当前 vendor matrix 含 Linux，首版来源仅 macOS/Windows。建议为 contract case 增加可选 `platforms:['darwin','win32']`，fixture 写入与执行统一筛选，未指定时沿用现有全平台行为；catalog case coverage guard 仍检查全部登记的 cases，运行输出明确说明 CatPaw 非零 case 不适用 Linux。Linux 的 fork-only 空扫描只验证客户端 ID 被接受；底层 SQLite reader/model/token/cache 逻辑由跨平台 Rust fixtures 验证。这样既不让 Linux 默认无 app 的情况导致非零 fixture 假失败，也不为测试发明 Linux 产品根。此为开工建议，不是当前 gate 已有字段。

## 7. Vendor pin 与交付顺序

当前主线 manifest 为 mode `override`，npm baseVersion `4.18.0`，commit `d5e8ad9b25bfafb43b5b6804940929b728a6f48a`，release tag `token-monitor-d5e8ad9b`。这是本次查证快照，开工时重新读 manifest；添加 fork client 不能改 mode 为 upstream。[manifest](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/scripts/vendor/tokscale.json)

1. Fork 先完成 parser 与 tests，得到包含 CatPaw 与现有 report/owned-client 能力的确定 commit。不要为了新增 client 重写 upstream 接口。
2. 使用 fork 已有 `.github/workflows/token-monitor-binaries.yml`（Token Monitor Vendor Release），显式指定 `source_repository:Javis603/tokscale` 与具体 source_ref。默认 source_repository 是 upstream，因此**不能直接沿用 workflow 默认值**；流水线解析确定 SHA，生成 `token-monitor-<short SHA>`，拒绝覆盖已有 release，构建资产与 SHA256SUMS。此清单只是交接，未触发发布。[官方 workflow](https://github.com/Javis603/tokscale/blob/789aea2adcc0300e8e8709a490cb4a73acd9b396/.github/workflows/token-monitor-binaries.yml)
3. 对存在且校验过的实际 release 更新 Token Monitor manifest commit/title/releaseTag/reason 和所有平台 sha256；baseVersion 继续跟 npm optionalDependencies，只有依赖本身升级才改。不能先填写假 checksum 或把本地 binary 当正式发布 pin。
4. 登记 client + token contracts 并对确定的新 binary 运行验收；PR 说明链接 #715 与 fork 变更，依赖不可用时说明具体剩余项，不把“catalog 已加”当可发布完成。

生产验收命令（在对应实施 checkout 执行；本地原型已执行的检查见交接文档）：

```bash
# Fork：先针对模块，再完整 Rust 验证
cargo test -p tokscale-core token_monitor::catpaw
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Token Monitor：正常 verify 不下载 Tokscale
npm run verify
node scripts/verify-vendored-tokscale-release.js
node scripts/verify-vendored-tokscale-clients.js
node scripts/verify-vendored-tokscale.js

# shared 修改最终完成后生成 metadata/Worker 副本
npm run update:hub-build
git diff --check
```

执行客户端/contract gates 之前，新 pinned binary 必须已通过**专门的 vendor preparation**可用；不要把 `ensure:tokscale` 加到 npm test/lint/verify/install/hub。本仓库 vendor CI 已有独立 ensure 与 gate 顺序。release-assets 检查需要联网访问真实 release，与普通 networkless verify 分开。[vendor CI](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/.github/workflows/vendor-tokscale.yml)、[release 校验](https://github.com/Javis603/token-monitor/blob/54c0da02ddae30d0aba5df2ddc23197431455ea0/scripts/verify-vendored-tokscale-release.js)

最终验收保留 macOS 两地区真实只读 smoke、Windows 实机根/WAL 测试、watch 3–5 秒更新与重复扫不重复计量。UI 注册变更需要按本仓库 PR 约定附截图；不得用 synthetic fixture 代替真实平台验证说明。

## 明确尚未解决的项

- Windows 国内静态包已通过；Windows 实机运行、外区 Windows 安装包与真实 usage 仍待验证。
- 外区项目 JSONL 根与真实 workspace attribution；首版可缺省。
- 非零 cacheWrite、多模型/子代理、legacy runtime、跨账号/服务端重放的大样本语义。支持范围先限制到已证实的 ui-sdk schema，旧格式不能静默当完整历史。
- 当前 owned-client parser 签名返回 Vec，没有 renderer diagnostic DTO；沿用 last-good + bounded warning 可以保护计量，但新 ID/源失败如何显示给用户要在现有通道中确认，不能声称已有 UI 提示。
- 统一 client ID 已确定为 `catpaw`；展示文案在实际变更中说明。同地区/不同地区 token 合并与模型表选择仍须有 fixture。

本轮只整理调研交接文档与脱敏证据；未改业务代码、分支或桌面调研，未发布 GitHub 消息/Release。
