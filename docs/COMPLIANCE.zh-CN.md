# AI 账号占用建议灯：合规边界

审查日期：2026-07-16。本文是产品与技术合规审查，不是法律意见；企业 MSA、组织管理员政策、地区条款和后续更新可能优先适用。

## 可以做什么

- 统计账号所有者本人，或组织正式分配给该用户的账号。
- 在用户自己的设备上记录任务开始、心跳、结束和匿名设备标签。
- 被动读取官方客户端/CLI 明确提供的额度信息；计划名称拿不到时由用户手动填写。
- 给出“预计可用 / 可能拥挤 / 建议换号 / 数据不足”的本地建议，并说明依据。
- 允许用户无视红灯继续使用或继续登记；灯不会控制 AI 服务。

## 不做什么

- 不保存或同步服务商密码、Cookie、OAuth token、API key、提示词、回答或源代码。
- 不把个人订阅账号提供给其他人，不出租或转售账号池。
- 不自动登录、自动切换账号、自动提交或重试请求。
- 不绕过速率限制、额度、保护措施、设备控制或服务商的反滥用策略。
- 不抓取私有接口，不根据价格、消费或 Cookie 猜测套餐与官方并发数。
- 不宣称红黄绿等于服务商公布的并发限制或真实网络卡顿。

## 服务商结论

### OpenAI / ChatGPT / Codex

OpenAI 允许账号所有者在多台设备登录，但个人账号不能共享给他人；条款也禁止规避速率限制、限制或保护措施。OpenAI 现有账号切换功能让两个独立账号保持登录状态，但不会合并套餐、账单、历史或工作区。因此本工具只做本人账号的状态展示是可接受方向，不能以“突破限制”宣传或自动切号。

官方资料：

- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
- [OpenAI Account Sharing Policy](https://help.openai.com/en/articles/10471989)
- [Use multiple accounts with account switching](https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

### Anthropic / Claude

Anthropic 个人条款禁止共享账号凭据、抓取服务数据、未经明确许可的自动化/非人类访问，以及绕过保护措施。为采用保守边界，本项目默认不在 `claude.ai` 注入网页 DOM 检测器；Claude 网页使用手动登记，Claude Code 使用本地 wrapper 或未来的官方生命周期 hook。

官方资料：

- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Using Claude Code with Pro or Max](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-max-plan)

### Google / Gemini

Google 条款禁止绕过保护措施，并限制违反机器可读指令的自动访问。Gemini 个人限额是动态计算额度，会受提示复杂度、模型、功能、对话长度、测试和系统容量影响；不同付费层级扩大的是使用额度，不是公开的固定并发数。套餐和刷新时间应由用户从 Gemini 的 Usage limits 页面确认。

官方资料：

- [Google Terms of Service](https://policies.google.com/terms)
- [Gemini Apps limits and upgrades](https://support.google.com/gemini/answer/16275805)

### Cursor

Cursor 条款要求保护账号密码，禁止出租、出借、出售服务，以及采集、抓取或提取服务数据。个人套餐主要提供不同规模的月度 Agent 使用池；达到包含额度时编辑器会通知，额度本身不能换算为“会不会卡”。普通个人 IDE 没有文档化的实时账号并发接口。

官方资料：

- [Cursor Terms of Service](https://cursor.com/en-US/terms-of-service)
- [Cursor Models & Pricing](https://docs.cursor.com/account/pricing)

## 检测可信度

| 信号 | 可知道什么 | 不能知道什么 | 标记 |
| --- | --- | --- | --- |
| CLI/官方生命周期事件 | 本地 turn/request 的开始与结束 | 未安装检测器的设备和网页任务 | 确认或推测，取决于事件粒度 |
| 当前 CLI wrapper | 进程/会话仍在运行 | 模型此刻是否仍在生成 | 推测 |
| ChatGPT 可见停止按钮 | 当前标签页可能正在生成 | 后台任务、切号后的身份、官方并发上限 | 推测 |
| 手动登记 | 用户声明有任务 | 是否仍在生成、实际响应速度 | 推测 |
| Token 日志 / lastUsedAt | 最近有过活动 | 当前仍在执行几个任务 | 不能作为实时计数 |
| 官方额度/429/Retry-After | 额度或限流风险 | 设备间真实任务数 | 官方额度证据 |

## 红黄绿算法边界

当前版本先按“观察到的任务数 + 用户自定义建议阈值”给出占用建议：0 个任务为绿，有任务但未达阈值为黄，达到阈值为红。它不测真实延迟，所以界面必须同时注明“按自定义阈值判断”。

后续如增加体验观测，只能被动使用用户真实任务产生的首响应时间、429、Retry-After、超时和失败；不得额外发送探针请求。额度、占用和延迟应分别显示，主灯采用最严重的新鲜证据并展示原因。红灯始终只是建议。
