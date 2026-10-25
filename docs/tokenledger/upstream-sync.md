# TokenLedger · 上游同步与配置指南

## 一、官方（upstream）更新怎么办

**原则：绝不用应用内"检查更新"安装官方版**——那个更新器指向 Javis603 的 release，装上会把我们的积分/校准功能全部覆盖掉（`automaticAppUpdates` 已确认为关）。

正确姿势（命令行同步源码，我们的功能全部保留）：

```bash
cd E:\1project\tokenledger
git fetch upstream                       # 拉官方
git checkout main
git merge upstream/main                  # 或 rebase，见下
npm ci                                   # 依赖变化时
npm run update:hub-build                 # 改过 src/shared 必须（worker 闭包+构建标记）
npx eslint .                             # 门禁
node --test "tests/{shared,electron,hub}/**/*.test.js"   # 按目录验收（全量并发在本机会停摆）
npm start                                # 本机冒烟
git push
```

- **merge vs rebase**：日常用 merge（历史保真、冲突好解）；提 PR 前的干净分支用 cherry-pick。
- **冲突面极小**：我们的全部改动 = 独立模块（`src/shared/credits/`、`providers/workbuddy/credits.js`）+ 四个小挂钩（usageTransform 可选步骤、usage.js 白名单两处、agent/main/worker 三处注入、renderer 设备行徽章）。官方动到的概率低。
- 上游若官方实现了同类功能（如 credits），同步时以冲突为信号决定取舍，保留两者数据结构兼容优先。

## 二、本机推荐配置（settings / 设置页）

| 设置 | 建议 | 原因 |
|---|---|---|
| 系统玻璃 systemGlass | **关**（已写好） | Windows acrylic 在本机渲染不完整 → 四角白色直角；关闭后走真透明圆角 |
| 应用内自动更新 | **保持关**（已是） | 防止官方包覆盖 fork 功能 |
| Trae CN 额度 | 待配置 token | traE.cn 登录后 F12→Cookies 复制 `cloud-ide-jwt`，粘贴到设置 Trae 处 |
| 托盘内容 | 按喜好切 tokens/cost/bars | 默认"活跃 agent 图标"会显示当期用量最高者的 logo |
| 语言 | 中文（已是 zh-CN） | — |
| DeepSeek 额度 | 已通过 `.env` 配好 | 余额 ¥31.69 卡片已就绪 |

## 三、隐私与数据安全边界

- 积分线上传输内容 = 模型名 + 积分数值 + 请求哈希 + 会话 id（**无路径、无内容、无凭据**），hub 归一化全部截断/封顶。
- `.env`（DEEPSEEK_API_KEY）已 gitignore，永不入库。
- 设备记录中的 cwd/项目路径仅留在本机 hub-devices.json / repo data/，不进 credits 块。
