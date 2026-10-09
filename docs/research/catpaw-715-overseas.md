# CatPaw #715：最新方向与外区安装包对照

核对日期：2026-10-06（Asia/Shanghai）。整合入口见 [开工交接](catpaw-715-handoff.md)，Windows 最新核对见 [Windows 国内包](catpaw-715-windows.md)。阅读了 [issue #715](https://github.com/Javis603/token-monitor/issues/715) 的正文与两条评论、桌面 `CatPaw-Issue-715-调研-2026-10-03` 的 00–13 文档及相关脱敏证据，并使用 Electron 官方 `@electron/asar` 对照国内妙手与下载的外区 CatPaw。本文是调研记录，不是客户端已实现的支持承诺。

## 结论

**外区版是助手版的独立部署，关键 SQLite 表与消息持久化契约沿用妙手；应用身份、默认数据根、认证/服务部署及模型编号发生了变化。** 随后的真实消息对照已确认国内 4/4、外区 3/3 满足缓存相加恒等式；按用户授权通过 CDP 抓到外区六条模型表，当前会话 `10000001` 对应 `gpt-5.6-terra`，表中的 `auto` 为 `10000003`。解析逻辑可共用，但模型映射必须区分来源，不能套用国内表。

另一个影响开工的变化来自维护者的最新回复：**解析放 tokscale fork、先离线模型表、默认关闭、IDE 暂缓**。桌面旧文档中的 JS local adapter 清单与运行时凭据联网刷新设想不能直接继续采用。[维护者回复](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6008803049)

## 被测材料与方法

| 项目 | 国内妙手 | 外区 CatPaw |
|---|---|---|
| 来源 | `/Applications/妙手.app` | `/Users/remixplay/Downloads/CatPaw.20260929154243.dmg` 内的 `CatPaw.app` |
| Info.plist 版本 | `2026.923.1851` / build `2026.923.1851.5515` | `2026.929.1522` / build `2026.929.1522.5592` |
| package.json | `catpaw-moon` / `2026.0923.1851` | `catpaw-overseas` / `2026.0929.1522` |
| bundle ID | `com.catx.catpaw` | `com.catx.catpaw.overseas` |
| asar 列表条目 | 30349 | 30638 |

使用仓库已安装的官方 `@electron/asar` **3.4.1**，无需新增依赖。以只读方式挂载 DMG，使用官方 `listPackage()` / `extractFile()` API 抽取主进程源码、renderer chunks 与 CatPaw SDK/adapter 源码；没有手写 ASAR 解析器，也没有执行安装包内的代码。官方工具用法见 [electron/asar](https://github.com/electron/asar)。

版本不同，所以以下差异是这两个具体安装包的差异，不能全部归因于地区。`dataPathService` 里的产品配置还带有旧的模板 `version` 字段；被测应用版本以上表 Info.plist / package.json 为准。

首次静态核对阶段未安装、启动、登录外区应用，未读取活账号凭据，未调用模型接口，未修改桌面材料、业务代码或向 GitHub 发消息。抽取材料留在 `/private/tmp/catpaw-715-comparison/`，临时挂载在结束时卸载。随后用户提出登录超时，追加了下述登录检查。

## 哪些关键项改变了

| 项目 | 国内 | 外区 | 接入影响 |
|---|---|---|---|
| `applicationName` | `catpaw-moon` | `catpaw-overseas` | 需要另一个应用数据根 |
| 默认 macOS DB 根 | `~/Library/Application Support/catpaw-moon/`，已有实测 | `~/Library/Application Support/catpaw-overseas/`，已有实测 | 只扫国内根会漏掉外区 |
| 默认 Windows DB 根 | `%APPDATA%\\catpaw-moon\\`，Windows 国内包源码已核对、未实机验证 | `%APPDATA%\\catpaw-overseas\\`，由源码推导 | 外区 Windows 也需另一个根，尚无实机样本 |
| 产品运行时/CLI 根 | `~/.meituan-catpaw` | `~/.catpaw-overseas` | 不应把它们整树作为 usage/watch 来源 |
| DB 文件模式 | `catpaw-memory<scopeSuffix>.db` | 同左 | 正常账号为 `catpaw-memory-<scope>.db`；排除 `-anon.db` |
| scope 指针名 | `catx-scope-pointer` | `catpaw-scope-pointer` | 解析无需读取指针或凭据 |
| 登录 provider | `catx-passport` | `overseas-passport` | 不可假设能复用国内登录态 |
| 外区 prod 部署 | 国内 API 调研见桌面 13 | `region: HK`，gateway `https://global-gateway.catpaw.com`，agent `https://catpaw-agent.mykeeta.com`，report `https://catpaw-api.mykeeta.com` | 国内取表脚本不直接适用；后续已通过外区应用 CDP bridge 取表 |

路径证据：`dist-electron/dataPathService-CQpmFtLu.js` / `dataPathService-XNreFn1m.js` 的产品配置与 `resolveUserDataDir()`，`main-DZa7Fn5R.js` / `main-fa9rLKzy.js` 的 `app.setPath('userData', ...)`，以及两个 `storageService` 的 DB 路径函数。默认路径是 `appData + applicationName`；应用可通过 `--user-data-dir` 覆盖，不能把默认值说成唯一位置。

两版账号 scope 都来自 `uid || loginName`，并移除 `[a-zA-Z0-9_-]` 之外的字符。外区不能假定 DB 后缀只含数字。国内另有企业 scope 分支，因此这里使用 `<scope>` 而不把所有文件后缀一概称作纯数字 userId。

认证/部署证据：外区 `dataPathService-XNreFn1m.js` 的 `overseasDeployment` 和 `catpawEnv-Con73sGH.js`。外区 gateway 请求路径使用 `X-Auth-Token`，且限制凭据发送目标；这是源码观察，**并未验证某个 header 能单独完成服务端鉴权**。国内第三轮 `X-Passport-Token` 实测结论不能自动推广到外区。

## 哪些关键项没有改变

### SQLite 与写入方式

对两个 `storageService` 抽出建表语句，逐字比较以下三张表：**全部相同**。

| 表 | 关键契约 | 相同建表语句的 SHA-256 |
|---|---|---|
| `ui_sdk_messages` | `conversation_id / seq / message_id / role / payload / created_at_ms / updated_at_ms / schema_version`；主键 `(conversation_id, seq)`；创建时间可空 | `5aef178a9aab1a3bc5cbf634b716f2d42533f06d43e24b866be3172d94b11a60` |
| `sessions` | `id / extra` 与从 extra 提取的 STORED 生成列 | `b120fbb3ef5a35f73188d9ae67644a0abbd5404f56f85275a6ca8f4656c91d1c` |
| `conversations` | 基础会话表；两版另均添加 `context_usage / round_infos` | `a4116ecb74d1380dc03e07007b013db0e15fdc813a547cbc8228641b472b901b` |

这验证的是这三段建表契约，不代表所有表、迁移逻辑或已有数据库内容完全一样。

`uiSdkStateHolder-MoLe1ExQ.js` / `uiSdkStateHolder-Ddly_Alq.js` 均把 SDK 消息对象 `JSON.stringify()` 写入 `payload`，保留创建/更新时间与 schema version 1；均有删除该会话原消息再整体重写的路径。因此不能仅靠 seq 增长假设消息永远只追加，也不能漏掉旧消息的更新。

### 用量对象透传

两版的 v1/v2 SDK adapter 中，`computeStreamMessageExtra()`、`recordAssistantExtra()`、`handleStreamResponse()` 和 `buildAssistantMessage()` **逐字相同**（两个 adapter 共八项独立比较）。已知 stream message 字段均只有 `messageId / content / finished`；其他字段保留为 `extra`，不对嵌套计数做减法或重新计量。

由此可证：**外区仍具备将服务端 message 的 `contextInfo` 保存到 `payload.extra.contextInfo` 的相同链路。** 源码不枚举 `promptTokens / cacheReadTokens` 等嵌套字段，它们来自运行时消息；解包无法证明外区服务器实际发送同一组键、每轮都携带 usage，或缓存与 prompt 仍满足国内样本恒等式。

adapter 版本已更新，不能把整个库称作相同：

| 模块 | 国内 | 外区 |
|---|---|---|
| `@catpaw-ui/catpaw-sdk-adapter` | `1.2.5` | `1.2.6-beta.0` |
| `@catpaw-ui/catpaw-sdk-v2-adapter` | `0.1.23` | `0.1.25-beta.0` |
| `@catpaw/agent-sdk` | `1.2.0-beta.5` | `1.2.0-beta.7` |

### 模型选择与模型服务

两版 `uiSdkStateHolder` 均更新 `persistedModelMode / persistedModelId / persistedModelSelection`，仍是会话级当前选择；不能依据代码对比承诺新增了逐消息模型归属。

两版主进程获取模型表的路径与 body 相同：`POST /api/agent/maas/model-types`，`{tenant:'CatDesk', scene:'CATX_APP', env:'EXTERNAL'}`；模块级内存缓存 300000 ms，登出清空。外区 gateway 由上文部署配置解析，`EXTERNAL` 也不等于“走国内部署”。renderer 仍以 `modelTypeId` join `modelTypeName`，请求结果只在内存缓存。

两版产品配置中的路由常量相同：`0`（default/auto）、`10000`（safe room）、`10001/10002/10003`（lite/pro/max），以及 legacy LongCat 常量 `77`。**相同的查询协议、路由常量和字段名，不能证明整个外区模型 ID 空间或模型供给表与国内相同。** 静态核对阶段未取得外区模型表；后续 CDP 的真实结果已证实，表中 auto 与 LongCat 分别是 `10000003` 和 `10000002`，并非静态常量 0 / 77。保留产品路由 sentinel 的同时，需识别地区表中的 auto；不能简单把所有 `0` 替换为新编号。

上述证据在国内 `main-DZa7Fn5R.js` / renderer `index-CBHJRcX-.js`，外区 `main-fa9rLKzy.js` / renderer `index-CNeGykBX.js`。提取范围未发现可用的外区内置模型清单。

## 桌面调研与最新 issue 如何衔接

1. **继续采用数据结论**：国内 token 权威源是 SQLite 的 `payload.extra.contextInfo.usage`，不是独立 snake_case 列；按 usage 存在筛行。国内保存的脱敏证据有 2 条 usage，独立复核两条都满足 `prompt + cacheRead + cacheWrite + completion = total`。桌面 12/13 与公开评论记载后续扩大到 4/4，但证据 JSON 仍是初轮样本。后续已补外区 3/3 真实样本；非零 cacheWrite 仍待验证。
2. **不能照 Qoder CN 做减法**：国内 input 直接取 prompt，cacheRead 是相加项。残差也不能自动推断成 reasoning；异常需保留上次有效统计并暴露诊断。
3. **模型选择优先当前字段**：桌面 session 同时含初始 auto 与当前具体 id 91，不能让 `initialModelMode:auto` 无条件覆盖当前选择。会话中换模型会覆写选择，历史模型归属不精确仍是已知限制。
4. **实施路线更新**：维护者明确使用 `Javis603/tokscale` fork 的 `crates/tokscale-core/src/token_monitor/`，Token Monitor 补 `forkOnly` 登记、来源/展示和 token contract；默认关闭，保持离线，不接凭据联网刷新。[最新回复](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6008803049)、[迁移 PR #933](https://github.com/Javis603/token-monitor/pull/933)、[当前接入指南](https://github.com/Javis603/token-monitor/blob/main/docs/providers/README.md)
5. **先对齐仓库版本**：当前工作区 HEAD `171996aba552514dceca5c9c8beb7fa44ccfd4bd` 仍使用旧 locallyParsed 说明，落后于 #933 的接入结构；本轮没有更新分支或覆盖工作区。后续实现应以最新主线/fork 指南为基线。
6. **收窄旧文档断言**：IDE 仅能表述为“被测版本未发现本地 token，维护者暂缓接入”；桌面 06 自己承认实际对话样本不足。WAL 就地只读已测可用，不代表损坏/锁/权限失败不存在。国内“官方下载无 Linux”也不能覆盖外区或后续版本。

桌面来源：`00-阅读入口.md`、`04-妙手实测-路径与落盘.md`、`05-妙手实测-数据契约与token语义.md`、`06-catpawai-ide实测.md`、`09-待验证清单.md`、`10-复核与更正-第二轮.md`、`11-模型映射抗腐烂方案.md`、`12-handoff-2026-10-04.md`、`13-模型表API直取-第三轮.md`、`evidence/asar取证-模型映射-第二轮.md`、`evidence/妙手-ui_sdk_messages-结构脱敏.json`、`evidence/妙手-sessions.json`。均在 `/Users/remixplay/Desktop/CatPaw-Issue-715-调研-2026-10-03/`；02/03/08 的实现接线内容要以维护者新方向替代。

## 补充：真实消息与 CDP 模型表（2026-10-06）

用户完成外区登录与三轮对话后，使用 SQLite `mode=ro`、`PRAGMA query_only=ON` 和事务分别读取两版的账号库。仅导出结构、数值和匿名会话编号，未导出账号编号、对话正文、标题、项目路径、凭据或日志。证据保存在 [消息数值与结构对照](catpaw-715-message-comparison.json)。

| 观察项 | 国内妙手 | 外区 CatPaw |
|---|---|---|
| 样本 | 1 个会话，16 条消息，4 条 usage | 1 个会话，12 条消息，3 条 usage |
| 消息分布 | 4 user / 12 assistant | 3 user / 9 assistant |
| usage 位置 | `payload.extra.contextInfo.usage` | 同左 |
| usage 键与类型 | prompt/completion/total/cacheRead/cacheWrite，均为 camelCase 整数 | 同左 |
| 缓存相加恒等式 | 4/4 成立 | 3/3 成立 |
| usage 行创建/更新时间 | 均非空，毫秒整数 | 同左 |
| 全部消息中创建时间为空 | 8/16（均无 usage） | 6/12（均无 usage） |
| 非零 cacheWrite | 未观测到 | 未观测到 |
| 独立 reasoning token 键 | 未发现 | 未发现 |
| 消息模型字段 | 检查的消息/extra/meta/contextInfo/usage 元数据层未发现数字模型字段 | 同左；模型仍来自 sessions 的当前选择 |
| 上下文完整窗口 / 可用预算 | 204800 / 184800 | 同左 |
| maxOutputTokens 样本 | 32000、32768 | 20000、32000 |
| conversation runtime/schema | `ui-sdk` / 1，旧 messages 数组为空 | 同左 |

三张活数据库表的 `PRAGMA table_xinfo` 结果也完全相同。消息顶层、extra、contextInfo 与 usage 的键集合相同；session extra 的外区样本多了 `generatedTitleOverrideAllowed`，未影响 token 契约。两版均为初始 auto 加当前具体模型选择，不能让初始模式覆盖当前模型。

外区三条真实 usage：

| seq | prompt | cacheRead | cacheWrite | completion | total |
|---:|---:|---:|---:|---:|---:|
| 2 | 11734 | 10624 | 0 | 110 | 22468 |
| 6 | 22269 | 0 | 0 | 91 | 22360 |
| 10 | 20388 | 0 | 0 | 13 | 20401 |

每条均满足 `prompt + cacheRead + cacheWrite + completion = total`，且 `contextInfo.totalUsageTokens = usage.totalTokens`。这些是三轮用量记录，不是按会话累计的计数；本样本合计 65229。国内四条合计 96351。本次也补上了国内 4/4 的数值证据，替代先前仅有第一轮脱敏 JSON 的证据缺口。

### CDP 模型快照

用户明确授权以 CDP 启动抓表。确认无进行中的消息且输入框为空后，退出外区应用，以临时端口 50014 重启；`lsof` 确认监听地址仅为 `127.0.0.1:50014`。通过 renderer 的 `Runtime.evaluate` 调用已知只读 bridge `window.electronAPI.getModelTypes()`，在 renderer 内就投影模型编号、名称、描述、积分倍率和图像支持字段；没有读取/导出凭据、打开调试 UI 或抓取其他运行时对象。

结果保存在 [外区模型快照](catpaw-715-overseas-models.json)。国内对照是桌面 2026-10-04 的快照，外区是 2026-10-06 当前登录态返回值；数量差异也可能包含账号、时间或版本因素。

| 模型名 | 国内快照 modelTypeId | 外区 modelTypeId | 外区 rateMultiplier |
|---|---:|---:|---|
| `auto` | 0 | **10000003** | 未提供 |
| `gpt-5.6-terra` | 无 | **10000001** | 1.03 |
| `LongCat-2.0` | 77 | **10000002** | 0.00 |
| `kimi-k3` | 83 | **10000007** | 0.94 |
| `glm-5.3` | 89 | **10000005** | 0.44 |
| `glm-5.3-flash` | 91 | **10000006** | 0.03 |

国内快照的 deepseek 两款、MiniMax-M3、glm-5.3-flashx 未出现在本次外区返回的六条清单里。**同名模型的编号不同已被明确证实**；不应把两个地区视为同一张模型映射表。`rateMultiplier` 仍是积分倍率，不是美元 token 单价。

外区 `sessions.extra.persistedModelId`、`persistedModelSelection.modelId` 和 `lastSelectedModelId` 均为 `10000001`，`isAuto:false`；UI 当前显示 `gpt-5.6-terra`，与 CDP 映射一致。这只证明会话的当前模型选择；消息里未发现逐轮模型身份，因此不能倒推之前三轮全都用了该模型。

提取后已退出带 CDP 参数的进程，确认端口停止响应，并正常启动 CatPaw。未更改代理、模型选择或消息内容。

### 对实现的具体影响

- 依据来源目录 `catpaw-moon` / `catpaw-overseas` 选择模型表，同时保留未知 id；同一解析逻辑读取各自 DB。
- 外区快照的 `10000003` 必须按 auto 排除定价，不能只检查 `id === 0`。也不能因此删掉 app 仍使用的 0/路由 sentinel；应结合当前 selection 的 `isAuto` 与地区映射分类。
- 国内/外区 prompt 都直接映射，cacheRead/cacheWrite 分别相加，不走 Qoder CN 的减法。
- `maxOutputTokens` 的差异不能用来反推模型身份；上下文使用原始完整窗口，模型归属保留会话粒度限制。

## 仍需补齐的外区验证

- 更多模型、工具调用/子代理、非零 cacheWrite 的真实样本；当前三轮短对话不能覆盖所有 token 行为。未发现 reasoning token 键也不等于已独立证明所有模型的 reasoning 计量。
- 外区 actual DB 默认根已实测存在；项目 JSONL 根仍未验证。不能仅因产品目录改变就把国内 `~/.catpaw/projects` 机械改为 `~/.catpaw-overseas/projects`。
- [Windows 国内包静态核对](catpaw-715-windows.md) 已通过关键表/SDK 比较，默认 `%APPDATA%\catpaw-moon\` 已由源码确认；Windows 实机与外区 Windows 包仍未验证。运行中 WAL/SHM 读取、重复落盘、会话修改/删除与多账号留存规则仍需扩大验证。

**当前可行动结论**：国内和外区都有可读取的同形状 token 记录，样本计量一致；可按维护者方向实现共用离线解析与分地区模型映射。默认关闭、未知 id 保留、auto 拒绝自动目录估价（显式 custom pricing 沿用现有规则），扩大边界样本后再确认支持范围。完整开工接线见 [实施清单](catpaw-715-implementation-plan.md)。

## 复现入口与校验标识

安装包以只读挂载后，官方 CLI 可复现列表与指定文件抽取（输出目录选择临时目录）：

```bash
node node_modules/@electron/asar/bin/asar.js --version
node node_modules/@electron/asar/bin/asar.js list '/private/tmp/catpaw-715-global-volume/CatPaw.app/Contents/Resources/app.asar'
# 在临时输出目录执行 extract-file：
node /Users/remixplay/IdeaProjects/token-monitor-main/node_modules/@electron/asar/bin/asar.js extract-file '/private/tmp/catpaw-715-global-volume/CatPaw.app/Contents/Resources/app.asar' 'dist-electron/storageService-BXxoJQen.js'
```

关键抽取文件还包括 `dist-electron/dataPathService-XNreFn1m.js`、`catpawEnv-Con73sGH.js`、`uiSdkStateHolder-Ddly_Alq.js`、`main-fa9rLKzy.js`，以及 `node_modules/@catpaw-ui/{catpaw-sdk-adapter,catpaw-sdk-v2-adapter}/dist/index.js`。按上文国内对应文件比较，不执行被抽取代码。

校验方法是从 `storageService` 提取三个 `CREATE TABLE ... );` 段，assert 逐字相同；从 adapter 提取上文四个方法体，分别 assert 国内/外区逐字相同。**3 个表 + 8 个方法全部通过**。业务代码未变更，因此本轮没有运行业务测试套件。

| 材料 | 字节数 | SHA-256 |
|---|---:|---|
| 下载的外区 DMG | 459202892 | `bfb1a44a3d8e8b135c069dabf391e645c4ae8039b8f75bff0924ccb1044d6b8b` |
| 外区 app.asar | 417109644 | `207e6fb53e1191634e69f4c6e3d7d6a4aeb3f16dabc12fd69750eb0e8d94322b` |
| 国内 app.asar | 399445884 | `f34ea1b416943bb227d69c7eca141b079ab8babd35feac2f2b1e4f9d56dfcf7d` |

## 补充：登录超时检查（2026-10-06）

用户反馈打开软件点击 Sign in 后提示超时。检查了已安装的 `/Applications/CatPaw.app`，版本仍为 `2026.929.1522`。点击后曾显示 `Signing in…`；随后 Firefox 显示 CatPaw 的 `Signed in` 页面，应用也进入包含 Library/项目列表的登录后界面。**本次重试最终成功，未复现最终的超时错误，未修改代理设置，也不能据此断言先前超时的根因。**

只读网络检查：gateway 与 agent 根路径均能完成 TLS 并返回 HTTP 404（仅说明根路径无资源）；真正的公开登录入口配置 `GET https://global-gateway.catpaw.com/api/gateway/passport/login-config` 返回 HTTP 200、`code:0`。独立 Node fetch 用时约 1.31 秒，curl 用时约 3.94 秒；响应的入口为 `/api/gateway/passport/login-entry`。未读取任何登录凭据或取模型表。

源码 `catpawEnv-Con73sGH.js` 中入口配置请求超时为 5000 ms；整个登录等待上限为 300000 ms，浏览器完成后通过本地 loopback 或 sid 轮询回传。只有看到具体报错和失败步骤，才能区分入口请求超时与等待回传超时。系统 HTTP/HTTPS/SOCKS 代理均启用，shell 无代理环境变量；这只是当时配置观察，不足以认定代理为故障原因。
