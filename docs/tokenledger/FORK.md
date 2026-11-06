# 这个 fork 与上游的差别

本仓库是 [`Javis603/token-monitor`](https://github.com/Javis603/token-monitor) 的个人分支，跟随上游发布（当前基线 **v0.86.0**）。上游负责 token 统计、Hub、插件体系、多机器同步；本 fork 只在一件事上做了加法：**在 token 之外，把「积分」也变成一等数据**，并让只有积分、没有 token 的厂商（Trae CN）在主界面上占一行真实的位置。

改动尽量收敛在新增文件 + 少量挂钩点，每次同步只解 `hubBuildRegistry.json` 这类生成物冲突。

---

## 一、积分账本（WorkBuddy，本地读取）

| 项 | 说明 |
|---|---|
| 数据源 | `~/.workbuddy/workbuddy.db` 的 `credit_json`，逐请求展开，不走任何网络 |
| 形态 | `device.credits = { available, confidence, totals{credits,requests,byModel}, recentEvents[], calibration }`，随设备记录一起走 hub，字段有界 |
| 今日消耗 | attach 时对**全量**事件求和（不是 200 条窗口），忙日不会漏掉清晨的请求 |
| 校准 | 对 `projects/*/<sessionId>.jsonl` 的逐会话 transcript 做回归，12 会话 + R²≥0.9 门控；系数 `0.9531 credits/Mtok` |
| 置信度 | `exact`（本地文件）/ `vendor`（厂商自报）/ `estimated`（回归推断）三级，随数据走，各界面不再自己推断 |

校准口径踩过的坑：最初拿 `session_usage.used` 当计费 token，R² 只有 **0.675**；换成 transcript 轴后 **0.979** —— 因为 `used` 是**上下文占用**，不是计费量。这条写在代码注释里，防止后来者"优化"回去。

## 二、只有积分的厂商（Trae CN）

Trae 只发布一个累计数 `usage_summary.consumed_amount`：没有模型拆分、没有 token、本地库加密、唯一的用量接口对这个账号返回 0 行。所以这里做的是**在既有约束下把信息榨干**，不做估算。

- **限额卡**：余额 + 今日消耗（`≈−X credits today`）
- **权益包 ⓘ**：18 个权益包按名称聚合成 4 行（`签到奖励 ×15`），带剩余/总额与最早到期日 —— 与官方用量页逐条一致
- **每日消耗**：以两次采样之差逐日落盘（`trae-credit-spend.json`，本地 60 天），卡片 ⓘ 里列近 7 天
- **工具行**：首页工具模块与工具明细页各一行，用同一套模板、同一列，单位写 `credits`，**不给百分比**（它没有 token 份额，0% 会撒谎）
- **鉴权**：web session cookie（`X-Cloudide-Session` 是关键的那一条），`~/.trae-cn` 里没有可复用的凭据

明确**不做**的事：不把积分换算成 token。任何换算比都需要一个上游从未发布过的汇率，硬套别家系数只会得到一个有小数点的错误答案。

## 三、collector 修复（唯一改到上游逻辑的地方）

`configFingerprint` 里原来含 `pricing:<hash>`，而锚点有效性用它判断。价格缓存（models.dev / LiteLLM）会在后台自动刷新 → 指纹变 → 锚点作废 → 全量重扫 → 历史图未就绪期间 **month/allTime 发布 0**，而 today 走增量扫描仍正常。用户侧看到的就是"当天正常，超过一天全废"，且发作频繁。

修法：拆成 `anchorConfigKey`（token 身份，决定锚点是否有效）与 `configFingerprint`（额外带价格版本）。价格变了返回 `pricingChanged`：锚点继续用（面板不掉数），但强制一次全量扫描把成本重新算过。上游 `collectorPricing` 的契约（改价必须重算所有窗口）原样保留。

## 四、界面改动清单

| 位置 | 改动 |
|---|---|
| 首页 · 工具模块 | WorkBuddy 行加积分徽章；credits-only 厂商追加一行（真实行，非脚注） |
| 首页 · 限额模块 | WorkBuddy 追加「Spent」卡（累计 + 今日 + ⓘ 每日/按模型）；Trae 卡加今日消耗与权益包 ⓘ |
| 工具明细页 | credits-only 厂商追加一行（同模板、无进度条、无百分比） |
| `limits/core.js` | 窗口新增可选字段 `detailEntries`（有界：≤16 行、≤3 列、每格 ≤40 字符），复用上游原生 ⓘ tooltip |

## 五、数据可信度与边界

| 数据 | 来源 | 可信度 |
|---|---|---|
| WorkBuddy 积分流水 | 本地 sqlite（`credit_json`） | 精确 |
| WorkBuddy 积分→token 系数 | 逐会话回归，R² 0.979 | 估算（标注） |
| Trae 余额 | 官方接口 `user_current_entitlement_list` | 精确 |
| Trae 权益包与到期 | 同上（`user_entitlement_pack_list`） | 精确 |
| Trae 每日消耗 | 两次采样之差 | 观测值（有未观测间隙） |
| Trae token / 模型 | **无任何来源** | 不提供 |

## 六、同步与维护

见 [`upstream-sync.md`](upstream-sync.md)：合并节奏、三个必须绕开的坑（`ELECTRON_RUN_AS_NODE`、`npm ci` 后的两个二进制、git 走代理 502）。

未完成/待观察：

- Trae 的 `X-Cloudide-Session` 是会话 cookie，约 2 周过期，目前**需要人工重新提供一次**。自动读取受限于 Chromium 的 DPAPI 加密（Electron `safeStorage` 解不了别的应用），可行路线见该文档末尾的讨论。
- 上游 v0.86 自带的 quota history 能算积分消耗，但数值只进悬停预览窗，主面板拿不到，所以本 fork 保留了同步口径的 `spendHistory`，两者是同一事实的两个出口。
