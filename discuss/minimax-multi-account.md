# MiniMax 多账号支持与托盘多账号展示（方案记录）

> 状态：已实施（2026-08-23）。本文是评审记录，代码以仓库为准。

## 需求

1. 一个供应商（首个：MiniMax）能够维护多个账号——此前每个供应商只有一个凭据槽（`settings.minimaxApiKey` 单字符串）。
2. 托盘「AI 工具额度」模式（`trayContent: 'limitsAllSessions'`）此前每供应商只显示剩余最低的一个账号；多账号后每个账号一行，最多两行。

## 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 实现范围 | 适度共用 | MiMo 已有完整多账号先例。真正同构的部分（credentialStore 动态凭据读写、main 进程元数据归一化与 remove/setEnabled/IPC 注册、renderer 账号列表与组渲染）提取共用，MiMo 装配层一并切换；账号创建/活体验证因供应商差异（cookie 解析 vs API key 清洗、email 回填 vs 标签）各自实现，不做参数化工厂（避免多模式行为）。 |
| 托盘布局 | 供应商分列，最多两列 | 多账号出现时位图按供应商分列：单账号供应商一列大字（图标 + 百分比，垂直居中，与历史单行一致）；多账号供应商一列只画**一个正常尺寸的图标**（左侧垂直居中，与单账号列同尺寸——每行各画小图标会小到看不清），右侧上下两行小字百分比（字号约 0.34×height，菜单栏 22pt 高度内两行的物理上限，第三个账号截断）。**最多展示两家供应商**（沿用历史容量约定，超出按供应商配置顺序截断）——截断在渲染层执行，因为 pick 函数已改为返回全部条目供展示层自取。列序 = 供应商配置顺序。例如 GLM + 双账号 MiniMax：`[GLM图 64%]` 上排居左，`[MM图] 42% / 85%` 为第二列（图标居中、两行数值在右侧）。全部供应商均单账号时保持旧的单行渲染（`·` 分隔，同样最多两家），行为与改造前完全一致。title 兜底文本保持单行、取前两个条目。 |
| 账号标识 | 自定义标签 + key 尾号回退 | API key 是不透明字符串（不像 MiMo cookie 能解析邮箱）。添加账号时可选填标签（≤64 字符）；未填时回退 key 末 4 位。尾号存入元数据 `keySuffix`，创建时派生一次。**尾号不带省略号等装饰字符**：wire 层 `normalizeAccountLabel` 的字符白名单（`\p{L}\p{M}\p{N} +._-`）会剥掉 `…`，导致设置页与 limits 页显示不一致。托盘位图不展示标识（空间受限）。 |
| 旧凭据迁移 | 启动时自动、幂等 | `ensureSettingsLoaded()` 内调用 `migrateLegacyMinimaxApiKey()`：无账号且 `settings.minimaxApiKey` 非空时转为第一个账号。`accountKey = hashKey('minimax', key)` 公式与单账号路径一致 → limits 行身份、`limitsRuntime` per-account 调度、订阅绑定全部连续。凭据写入 credentials.json 成功后才清空旧 settings key；任何一步失败保持旧路径下次重试。env（`MINIMAX_CODING_API_KEY`）路径不动，headless agent 仍单 key。 |
| 托盘 pick 粒度 | 分轮填充 | `pickConfiguredLimitProviders` 改为：第一轮每供应商取一条代表条（kind 优先 session>weekly>billing、同级剩余最低——与旧版「每供应商择一」完全一致），第二轮把多账号供应商的其余账号条目补在末尾。旧测试的展示顺序与截断语义全部保留，多账号条目追加其后。pick 不再截断到两家：title 与两行位图各自取前 2。 |

## 数据与存储形状

- **settings.json**：`minimaxManagedAccounts: [{ id, accountKey, accountLabel, keySuffix, addedAt, updatedAt, enabled }]`——仅元数据，永不携带密钥。
- **credentials.json**：`providers.minimax.accounts.<id>.apiKey` 动态路径（credentialStore 泛化的 `readManagedAccountCredential(provider, id, field)`；MiMo 原方法为薄委托）。
- **wire**：形状不变。`fetchMinimaxLimits` 在 `options.minimaxManagedAccounts` 非空时逐账号探测返回多行（失败行也带 accountKey，否则 `limitsRuntime` 的失败行全落 provider 通配 identity 互相覆盖）；为空时走旧单 key/env 路径返回单行（行为与改造前一致）。
- **聚合**：`providerCollapseKey` 白名单加 `minimax`（Node hub 与 Worker hub，经 `npm run sync:worker`）。**旧 hub 会把 minimax 多行折叠回一行**（丢一行数据）——多账号用户需同步更新 hub。
- **调度**：`limitsRuntime` 无需改动（identities/accountRevisions 本就按 identityKey 索引）；`providerPhysicalBoundMs` 给 minimax 加按账号数放大探测时限（对齐 mimo）。

## IPC 通道（增量）

`minimax:accounts` / `minimax:addAccount(apiKey, label)` / `minimax:setAccountEnabled` / `minimax:removeAccount`，与 `mimo:*` 同形。`settings:update` 拒绝 `minimaxManagedAccounts` patch（与 `mimoManagedAccounts` 同策略）。添加账号时 main 端先活体验证（`fetchMinimaxLimits([account])`，unauthorized → `invalidApiKey` 拒绝入库），renderer 不再有单账号 pending 遮罩机制（`markMinimaxKeyCheckPending` 等已删除）。

## 验证

`npm run verify`（lint + 全量 node:test）；新增 `tests/shared/minimaxAccounts.test.js`、`tests/electron/managedAccounts.test.js`，扩充 `minimaxLimits.test.js`（多账号返回/失败行身份/scope 过滤/单 key 回退/优先级）与 `credentialStore.test.js`（泛化 + mimo 委托回归）。hub build 注册已更新（`npm run update:hub-build`）。

## 已知边界

- 托盘两行位图的每行字号约 `height * 0.34`，在小屏或低分屏上偏小——这是菜单栏 22pt 高度内画两行的物理上限，剩余细节交给 limits 页。
- 同供应商多账号在「账号条目」中排序为：代表条（剩余最低）在前，其余按 kind/剩余排序补位；跨供应商仍按用户的供应商顺序。
- 后续其他供应商（如 zai、kimi）接入多账号时，直接复用 `managedAccounts.js` 装配层 + `minimaxAccounts.js` 的模式即可。
