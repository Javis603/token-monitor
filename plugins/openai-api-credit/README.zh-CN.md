# OpenAI API Credits

在 Token Monitor 原生额度页显示实际的 OpenAI Platform API 点数余额。

![额度页中的 OpenAI API 点数余额](assets/limits.png)

界面示例；余额及到期时间以你的实际账户为准。

## 功能

- 可与其他提供商一起排序的 **OpenAI** 额度项目，沿用 Codex 图标、配色及你的自定义颜色。
- 可选进度条及余额，或仅余额。
- 多笔可用点数到期时间不同时，显示各笔余额及 UTC 到期时间。
- 手动输入登录凭证，由 App 验证及管理。
- 界面、README 及更新记录支持英文、繁中、简中、日文、韩文及巴西葡文。

此插件显示 API 点数，而非 ChatGPT 消息限额，也不是根据 Costs 推算的余额。

## 兼容性及安装

使用支持原生额度插件、凭证验证及原生外观的 Token Monitor（`tmApi: 1`）。若 App 无法显示此额度模块，请先更新 App。

在“**设置 → 插件**”导入 `.tmplugin` 文件或完整源代码文件夹，检查后启用。然后在“**AI 工具额度**”勾选并展开 **OpenAI**。安装不会自动配置账户。

## 设置

1. 将 OpenAI 设置中的账单网址复制到常用浏览器，登录并选择组织。
2. 打开 DevTools（**F12** 或 **Cmd+Opt+I**）→ **Network**，重新加载并选择 `credit_grants`。
3. 在 **Headers → Request Headers**，将 `Authorization` 复制到 **Platform session token**，将 `OpenAI-Organization` 复制到 **Organization ID**。Token 可包含 `Bearer` 前缀；不要使用普通 API key、Cookie header 或 ChatGPT/Codex token。
4. 保存凭证。App 会验证，成功后收起编辑器；返回“**额度**”查看余额。

使用“修改凭证”替换已保存的值；输入框不会回填秘密。登录过期时重新获取凭证。不要在对话或截图中分享凭证。此插件不会打开内嵌登录浏览器。

## 显示及刷新

余额直接取自服务。进度条以当前可用且仍有余额的点数批次总额作分母。例如可用 $100 加上已停用的 $0/$24，会显示 **$100 / $100**。这是当前可用的点数池，而非每月或历史消费；批次到期或耗尽时，分母也会改变。

批次信息无法可靠解释余额时，只显示实际余额；零仍显示零。进度条下方显示可用点数最早的已知到期时间。只有多笔可用点数到期时间不同时，Tooltip 才列出各笔余额，不重复历史总额，也不会把过期点数称为消费。

刷新沿用 App 的额度间隔、自适应设置及界面可见状态。保存凭证会另外验证一次；插件没有自行轮询的计时器。你也可以在设置中选择“仅余额”。

## 数据及访问

App 在用户数据目录下的 `plugin-credentials/openai-api-credit/credits.json` 以私有权限、未加密文件保存凭证，与插件代码及普通偏好设置分开。后端通过 App 支持代理的传输层，将凭证发送至 `https://api.openai.com/v1/dashboard/billing/credit_grants`。这是未公开记载的端点，端点及登录凭证可能改变或失效。

界面只接收整理后的额度数据。插件不读取其他 App 的登录文件、不打开登录窗口，也不发送分析数据。插件是受信任的本地代码，并非与操作系统用户文件隔离。目前此模块整合原生额度及设置页。

## 更新

在“**设置 → 插件**”导入较新版本并检查更新；不会自动安装。详见[更新记录](CHANGELOG.zh-CN.md)。

如需从仓库根目录打包，请选择尚不存在的输出路径：

```sh
node scripts/build-plugin-package.js plugins/openai-api-credit /tmp/openai-api-credit-0.1.0.tmplugin
```

## 许可

[MIT](LICENSE)。
