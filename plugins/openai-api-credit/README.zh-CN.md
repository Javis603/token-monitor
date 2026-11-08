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

## 兼容性及安装

需要 **Token Monitor 0.88.0 或更新版本**。

打开“**设置 → 插件 → 探索**”，在“**精选插件**”选择带有 Token Monitor 官方标识的 **OpenAI API Credits**，检查后选择“**安装并启用**”。也可在“**设置 → 插件**”导入 `.tmplugin` 文件或完整源代码文件夹。确认插件已启用，再在“**AI 工具额度**”勾选并展开 **OpenAI**，设置账户凭证。

## 设置

1. 将 OpenAI 设置中的账单网址复制到常用浏览器，登录并选择组织。
2. 打开 DevTools（**F12** 或 **Cmd+Opt+I**）→ **Network**，重新加载并选择 `credit_grants`。
3. 在 **Headers → Request Headers**，将 `Authorization` 复制到 **Platform session token**，将 `OpenAI-Organization` 复制到 **Organization ID**。Token 可包含 `Bearer` 前缀；不要使用普通 API key、Cookie header 或 ChatGPT/Codex token。
4. 保存凭证。App 会验证，成功后收起编辑器；返回“**额度**”查看余额。

使用“修改凭证”替换已保存的值；输入框不会回填秘密。登录过期时重新获取凭证。不要在对话或截图中分享凭证。

## 显示及刷新

余额直接取自 OpenAI。进度条总额只包含当前可用且仍有余额的点数批次；过期或耗尽的批次不计入，因此总额会随批次状态改变。百分比、条形填充程度及显示金额会一同跟随 App 的“已用／剩余”设置；已用金额按当前点数池计算。

无法确认可靠总额时，只显示余额。进度条下方显示可用点数最早的已知到期时间。有 2 至 12 笔可用点数且到期时间不同时，提示框会列出各笔余额及到期时间；超过 12 笔时省略明细。

刷新沿用 App 的额度间隔、自适应设置及界面可见状态。显示选项更改后立即保存；保存凭证会另外验证一次。

## 数据及访问

App 在用户数据目录下的 `plugin-credentials/openai-api-credit/credits.json` 以私有权限、未加密文件保存凭证，与插件代码及普通偏好设置分开。后端通过 App 支持代理的传输层，将凭证发送至 `https://api.openai.com/v1/dashboard/billing/credit_grants`。这是未公开记载的端点，端点及登录凭证可能改变或失效。 Windows 沿用文件夹的访问权限，App 不会额外设置仅所有者可读的 ACL。

插件使用你输入的登录凭证，不读取其他 App 的登录文件或发送分析数据。插件是受信任的本地程序，可访问操作系统用户的文件。

## 更新

在“**设置 → 插件**”导入较新版本并检查更新；不会自动安装。详见[更新记录](CHANGELOG.zh-CN.md)。

如需从仓库根目录打包，请选择尚不存在的输出路径：

```sh
node scripts/build-plugin-package.js plugins/openai-api-credit ./openai-api-credit-0.1.0.tmplugin
```

## 许可

[MIT](LICENSE)。
