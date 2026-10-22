# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **New API account spend:** Adds Today, rolling-week and Month totals where available, with Today and Month in the account summary and more periods in the tooltip. (#1139)
- **Node Hub save interval:** Adds optional batched saves to reduce disk writes. Abrupt termination can lose unsaved updates. (#1029)

### Improved
- **Settings and account refreshes:** Avoids rescanning usage when refreshing quotas after settings or account changes. (#1106)

### Fixed
- **Live model rates:** Keeps concurrent models visible when their usage updates arrive at different times. (#1016)
- **Cline accounts:** Keeps distinct accounts and API keys separate across synced devices, even when their email addresses match. (#1096)
- **Cline API key:** Uses the key saved in Settings when fetching quotas. (#1147)
- **Cursor quotas:** Failed plan lookups no longer show a false 100% remaining allowance. (#1145)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.77.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.77.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-Setup-0.77.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.77.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **New API 账号消费：** 支持查看可用的今日、最近七天和本月消费，账号摘要显示今日与本月，悬浮提示提供更多时段明细。 （#1139）
- **Node Hub 保存间隔：** 支持按设定间隔批量保存，减少磁盘写入；异常终止可能丢失尚未保存的更新。 （#1029）

### 改进
- **设置与账号刷新：** 修改设置或账号后刷新额度时，不再重复扫描用量。 （#1106）

### 修复
- **模型实时速率：** 多个模型的用量先后更新时，保留各自的实时速率显示。 （#1016）
- **Cline 账号：** 跨设备同步时，不同账号和 API Key 不再因邮箱相同而被合并。 （#1096）
- **Cline API Key：** 查询额度时正确使用设置中保存的密钥。 （#1147）
- **Cursor 额度：** 套餐查询失败时，不再错误显示剩余额度为 100%。 （#1145）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.77.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.77.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-Setup-0.77.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.77.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.76.0...v0.77.0">v0.76.0...v0.77.0</a></summary>

<!-- github-generated-release-notes -->

</details>

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- **New API 帳號消費：** 支援查看可用的今日、最近七天與本月消費，帳號摘要顯示今日與本月，浮動提示提供更多時段明細。 （#1139）
- **Node Hub 儲存間隔：** 支援按設定間隔批次儲存，減少磁碟寫入；異常終止可能遺失尚未儲存的更新。 （#1029）

### 改進
- **設定與帳號重新整理：** 修改設定或帳號後重新整理額度時，不再重複掃描用量。 （#1106）

### 修復
- **模型即時速率：** 多個模型的用量先後更新時，保留各自的即時速率顯示。 （#1016）
- **Cline 帳號：** 跨裝置同步時，不同帳號與 API Key 不再因電子郵件相同而被合併。 （#1096）
- **Cline API Key：** 查詢額度時正確使用設定中儲存的金鑰。 （#1147）
- **Cursor 額度：** 方案查詢失敗時，不再錯誤顯示剩餘額度為 100%。 （#1145）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.77.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.77.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-Setup-0.77.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.77.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **New API 계정 지출:** 조회 가능한 오늘, 최근 7일, 이번 달 지출을 표시합니다. 계정 요약에는 오늘과 이번 달 지출을, 툴팁에는 더 많은 기간의 내역을 보여줍니다. (#1139)
- **Node Hub 저장 간격:** 지정한 간격으로 일괄 저장하여 디스크 쓰기를 줄일 수 있습니다. 비정상 종료 시 저장하지 않은 업데이트가 유실될 수 있습니다. (#1029)

### 개선
- **설정 및 계정 새로고침:** 설정이나 계정 변경 후 한도를 새로고칠 때 사용량을 다시 스캔하지 않아 불필요한 처리를 줄였습니다. (#1106)

### 수정
- **모델별 실시간 속도:** 여러 모델의 사용량이 서로 다른 시점에 갱신되어도 각 모델의 실시간 속도를 유지해 표시합니다. (#1016)
- **Cline 계정:** 기기 간 동기화 시 이메일 주소가 같아도 서로 다른 계정과 API 키를 별도로 표시합니다. (#1096)
- **Cline API 키:** 한도를 조회할 때 설정에 저장한 키를 올바르게 사용합니다. (#1147)
- **Cursor 한도:** 요금제 조회에 실패했을 때 남은 한도가 100%로 잘못 표시되던 문제를 수정했습니다. (#1145)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.77.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.77.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-Setup-0.77.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.77.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **New API アカウントの支出:** 取得可能な本日・直近7日間・今月の支出を表示します。アカウントの概要には本日と今月の金額を、ツールチップにはほかの期間の内訳を表示します。 (#1139)
- **Node Hub の保存間隔:** 指定した間隔でまとめて保存し、ディスクへの書き込みを減らせます。異常終了すると、未保存の更新が失われる場合があります。 (#1029)

### 改善
- **設定とアカウントの更新:** 設定やアカウントの変更後に上限を更新する際、使用量の再スキャンを省きます。 (#1106)

### 修正
- **モデル別のリアルタイム速度:** 複数モデルの使用量が異なるタイミングで更新されても、各モデルの速度表示を維持します。 (#1016)
- **Cline アカウント:** デバイス間の同期で、メールアドレスが同じでも異なるアカウントと API キーを別々に表示します。 (#1096)
- **Cline API キー:** 上限の取得時に、設定に保存したキーを正しく使用します。 (#1147)
- **Cursor の上限:** プランの取得に失敗した際、残りの利用枠が誤って100%と表示される問題を修正しました。 (#1145)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.77.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.77.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-Setup-0.77.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.77.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.77.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.77.0/Token-Monitor-0.77.0.AppImage)

</details>

</details>
