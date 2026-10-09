# CatPaw #715：Windows 国内安装包核对

核对日期：2026-10-06。**Windows 国内妙手的关键落盘契约与已测 macOS 国内版一致，可以共用解析器；平台差异放在数据根发现中。** 本轮仅解包核对，没有安装或启动 Windows 妙手，没有 Windows 实机消息/WAL 样本，也没有外区 Windows 安装包。

## 材料与解包

下载文件 `17896219866009741973_妙手-2026.0917.1230-x64.exe` 是国内版，内部 `package.json` 为 `catpaw-moon / 2026.0917.1230`；比 macOS 国内 `2026.0923.1851` 和外区 `2026.0929.1522` 都旧。安装器为 Inno Setup 6.4.0，安装脚本声明 x64、`PrivilegesRequired=lowest`，安装目录由 `{code:GetDefaultInstallDir}` 决定。解包重建的安装脚本没有该编译函数体，不能据此断言安装目录的具体值；安装目录也不应当作数据根。

使用作者维护的 [Inno Setup Unpacker 2.71.1](https://github.com/jrathlev/InnoUnpacker-Windows-GUI/tree/master/innounp-2)，通过已有 CrossOver 在独立临时 Wine 目录中运行解包器，只提取 `{code_GetDestDir}/resources/app.asar` 与 `install_script.iss`。随后用 Electron 官方 [`@electron/asar` 3.4.1](https://github.com/electron/asar) 的 `listPackage()` / `extractFile()` 抽取源码；30173 个 ASAR 条目，选取 775 个主进程/SDK 源文件。工具与抽取材料均在临时目录，未向项目添加依赖或工具，没有执行安装包或其应用代码。

| 材料 | 字节数 | SHA-256 |
|---|---:|---|
| Windows 安装包 | 471641384 | `05710871ff31c93880b88fbc5f95a5879c9182eeff2ad244a54384b9fc6dc5fd` |
| 提取的 app.asar | 396815209 | `3244886833a39430dd19ffde606df5eb210b6d33faedb9fbde0dcae09f0a737d` |

机器可读核对结果见 [Windows 静态证据](catpaw-715-windows-evidence.json)。

## 数据根与账号库

源码链是 `applicationName:catpaw-moon` → `resolveUserDataDir()` 返回 `path.join(app.getPath('appData'), applicationName)` → main 调用 `app.setPath('userData', ...)` → storage 在 userData 下打开账号库。Electron 的 Windows `appData` 默认是 `%APPDATA%`，因此默认用量库为：

```text
%APPDATA%\catpaw-moon\catpaw-memory-<scope>.db
```

这通常对应用户 `AppData\Roaming`，实际以 APPDATA/系统配置为准。[Electron app.getPath 文档](https://www.electronjs.org/docs/latest/api/app#appgetpathname)

| 检查项 | Windows 国内结果 |
|---|---|
| 产品身份 | `catpaw-moon`，appId `com.catx.catpaw` |
| 默认库名 | `catpaw-memory${activeScopeSuffix}.db` |
| 匿名库 | `catpaw-memory-anon.db`，不作为正常账号 usage 来源 |
| scope | passport 分支取 uid 或 loginName；只保留 `[a-zA-Z0-9_-]`，企业分支组合 uid 与 entId，不能只认数字 |
| 自定义根 | main 检查 `--user-data-dir`；存在时保留 Electron 的覆盖目录 |
| 产品运行时/CLI 根 | `os.homedir()/.meituan-catpaw`，账号子目录再拼 scope；不是上述 SQLite 根 |
| Windows IPC | `\\.\pipe\paw`；不是 usage 文件 |
| 项目 JSONL 根 | 本轮没有取得足以确认 Windows 项目 JSONL 根的证据；首版不依赖它 |

源码位置：`dist-electron/dataPathService-N484K7oM.js`、`main-Bwpu7z8v.js`、`storageService-BCgP9vM4.js`。仅扫描目标 DB 及必要 sidecars；不用安装目录、运行时目录、登录 scope 指针或 auth/log 树代替数据发现。

外区 macOS 产品配置是 `catpaw-overseas`，相同默认路径函数推导 Windows 外区根为 `%APPDATA%\catpaw-overseas\`。**这仍是跨平台源码推导，不是外区 Windows 安装包验证结果。** 如首版纳入该默认根，应明确其验证等级，并保留外区模型表。

## 与 macOS 的契约比较

| 比较项 | 结果 |
|---|---|
| `ui_sdk_messages`、`sessions`、`conversations` 建表语句 | 三项逐字相同，哈希与 [macOS 报告](catpaw-715-overseas.md) 一致 |
| v1/v2 adapter 四个关键方法 | 共八项逐字相同：`computeStreamMessageExtra`、`recordAssistantExtra`、`handleStreamResponse`、`buildAssistantMessage` |
| payload 写入 | SDK 消息 `JSON.stringify()`，schema version 1 |
| 更新模式 | 有按 conversation 删除消息后整体重写路径；不是永久 append-only |
| 模型选择 | session 当前 `persistedModelId / persistedModelSelection`，仍有 initial 字段回退；没有新增逐消息模型归属的证据 |
| 模型取表 | `POST /api/agent/maas/model-types`，tenant `CatDesk`、scene `CATX_APP`、env `EXTERNAL`，300000 ms 内存缓存、登出清除 |
| 路由常量 | 0、10000、10001/10002/10003、LongCat 77，与国内 macOS 相同；不能拿路由档反推真实模型 |

Windows SDK adapter 版本为 v1 `1.2.3`、v2 `0.1.21`，低于 macOS 国内/外区，但上述消息方法没有变化。对比仅覆盖关键契约，不宣称整个 SDK、所有迁移或全部功能相同。

使用源码提取建表语句并 assert 与 macOS 国内证据一致；SDK 方法按顶层方法边界提取完整方法后比较。**3 张表 + 8 个方法全部通过。** 关键写入与选择源码在 `uiSdkStateHolder-BA5pXBfe.js`；取表逻辑在 `main-Bwpu7z8v.js`。

## 共用解析器的边界

消息 `contextInfo` 的透传和 JSON 持久化链相同，支持共用读取 `payload.extra.contextInfo.usage` 的解析器。prompt/cache 相加语义由此前 macOS 国内 4/4、外区 3/3 真实样本证实；Windows 解包证明相同客户端处理链，不能替代 Windows 服务端消息的真实计量验证。

实施时不按平台复制 parser；按来源地区选择离线模型映射，按平台发现默认根。账号库与 WAL 就地只读，精确去重并处理旧消息重写；未知模型继续计 token，auto/路由/未知模型拒绝自动估价，用户明确 custom pricing 沿用现有规则。详见 [实施清单](catpaw-715-implementation-plan.md)。

可以开始实现默认关闭的助手支持。发布前仍要补 Windows 实机的默认根、运行中 WAL/SHM、修改/删除/多账号，以及非零 cacheWrite/工具与子代理样本；外区 Windows 若要声明已验证，需对应安装包或实机证据。本轮只更新调研文档和脱敏静态证据，未改业务代码。
