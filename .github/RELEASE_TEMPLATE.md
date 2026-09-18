# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Amp usage:** Tracks token usage from Amp sessions. (#694)
- **Factory Droid limits:** Reads Factory Droid plan quotas and the Extra Usage balance from an automatically detected API key. (#685)
- **Model aliases:** Merges different names for the same model into one row, with optional automatic duplicate or prefix grouping. (#661)
- **Native macOS Widgets:** Adds Summary, Activity, Breakdown, Quota, and Dashboard Widgets for macOS 14+. (#642, #689)

### Improved
- **Sessions:** Pages long session lists. (#693)

### Fixed
- **Live token rate:** Includes Kimi Code responses in the generation speed. (#695)
- **Antigravity CLI sessions:** Dates each turn from its own timestamp so it lands on the correct day. (#695)
- **Cline sessions:** Shows the model that answered each request instead of an unresolved model name. (#695)
- **OpenRouter costs:** Corrects estimated costs that used the wrong service tier or missed a differently spelled model name. (#695)
- **WorkBuddy 5.5 usage:** Counts sessions created by WorkBuddy 5.5. (#695)
- **Session history:** Prevents the app from freezing once the preserved archive grows large. (#693)
- **Codex sessions in T3 Code:** Shows the session title instead of the first user message. (#692)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.58.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.58.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-Setup-0.58.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.58.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **Amp 用量：** 新增 Amp 会话的 Token 用量统计。（#694）
- **Factory Droid 额度：** 支持自动检测 API 密钥，读取 Factory Droid 方案额度与 Extra Usage 余额。（#685）
- **模型别名：** 可将同一模型的不同名称合并为一行显示，支持自动合并重复或移除前缀。（#661）
- **原生 macOS 小部件：** 新增摘要、活动、明细、额度和仪表盘小部件，支持 macOS 14+。（#642, #689）

### 改进
- **会话列表：** 较长时改为分页显示。（#693）

### 修复
- **实时 Token 速率：** 生成速度现在也包含 Kimi Code 的响应。（#695）
- **Antigravity CLI 会话：** 按每轮自身的时间标记归属日期，会话会归入正确的一天。（#695）
- **Cline 会话：** 显示每次请求实际使用的模型，不再显示无法识别的模型名称。（#695）
- **OpenRouter 成本：** 修正可能取用错误服务档位价格，或因模型名称写法不同而无法匹配的问题。（#695）
- **WorkBuddy 5.5 用量：** 统计 WorkBuddy 5.5 创建的会话。（#695）
- **会话历史：** 保留的历史累积变大后，应用不再卡顿。（#693）
- **T3 Code 中的 Codex 会话：** 显示会话标题，不再显示首条消息。（#692）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.58.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.58.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-Setup-0.58.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.58.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.57.0...v0.58.0">v0.57.0...v0.58.0</a></summary>

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
- **Amp 用量：** 新增 Amp 會話的 Token 用量統計。（#694）
- **Factory Droid 額度：** 支援自動偵測 API 金鑰，讀取 Factory Droid 方案額度與 Extra Usage 餘額。（#685）
- **模型別名：** 可將同一模型的不同名稱合併為一列顯示，支援自動合併重複或移除前綴。（#661）
- **原生 macOS 小工具：** 新增摘要、活動、明細、額度與儀表板小工具，支援 macOS 14+。（#642, #689）

### 改進
- **會話列表：** 較長時改為分頁顯示。（#693）

### 修復
- **即時 Token 速率：** 生成速度現在也包含 Kimi Code 的回應。（#695）
- **Antigravity CLI 會話：** 依每輪自身時間標記歸屬日期，歸入正確的一天。（#695）
- **Cline 會話：** 顯示每次請求實際使用的模型，不再顯示無法辨識的模型名稱。（#695）
- **OpenRouter 成本：** 修正可能取用錯誤服務層級價格，或因模型名稱寫法不同而無法匹配的問題。（#695）
- **WorkBuddy 5.5 用量：** 統計 WorkBuddy 5.5 建立的會話。（#695）
- **會話記錄：** 保留的歷史累積變大後，應用不再卡頓。（#693）
- **T3 Code 中的 Codex 會話：** 顯示會話標題，不再顯示首則訊息。（#692）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.58.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.58.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-Setup-0.58.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.58.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Amp 사용량:** Amp 세션의 토큰 사용량을 추적합니다. (#694)
- **Factory Droid 할당량:** API 키를 자동으로 감지해 Factory Droid 플랜 할당량과 Extra Usage 잔액을 읽습니다. (#685)
- **모델 별칭:** 같은 모델의 서로 다른 이름을 한 줄로 묶어 표시하며, 중복 병합이나 접두사 제거를 선택할 수 있습니다. (#661)
- **네이티브 macOS 위젯:** 요약, 활동, 분석, 할당량, 대시보드 위젯을 macOS 14+에 추가합니다. (#642, #689)

### 개선
- **세션 목록:** 세션이 많으면 페이지로 나누어 표시합니다. (#693)

### 수정
- **실시간 토큰 속도:** 생성 속도에 Kimi Code 응답도 포함합니다. (#695)
- **Antigravity CLI 세션:** 각 턴의 자체 시간을 기준으로 날짜를 판단해 올바른 날에 표시합니다. (#695)
- **Cline 세션:** 각 요청을 실제로 처리한 모델을 표시하고, 확인되지 않은 모델 이름을 표시하지 않습니다. (#695)
- **OpenRouter 비용:** 잘못된 서비스 등급 가격을 사용하거나 모델 이름 표기가 달라 매칭되지 않던 문제를 수정했습니다. (#695)
- **WorkBuddy 5.5 사용량:** WorkBuddy 5.5에서 만든 세션을 집계합니다. (#695)
- **세션 기록:** 보관된 기록이 커져도 앱이 멈추지 않습니다. (#693)
- **T3 Code의 Codex 세션:** 첫 메시지 대신 세션 제목을 표시합니다. (#692)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.58.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.58.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-Setup-0.58.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.58.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Amp の使用量：** Amp セッションのトークン使用量を集計します。（#694）
- **Factory Droid のクォータ：** API キーを自動検出し、Factory Droid のプランクォータと Extra Usage 残高を読み取ります。（#685）
- **モデルの別名：** 同じモデルの異なる名前を 1 行にまとめて表示し、重複の統合や接頭辞の削除を選べます。（#661）
- **ネイティブ macOS ウィジェット：** サマリー、アクティビティ、内訳、クォータ、ダッシュボードのウィジェットを macOS 14 以降に追加します。（#642, #689）

### 改善
- **セッション一覧：** セッションが多い場合はページに分けて表示します。（#693）

### 修正
- **ライブ Token レート：** 生成速度に Kimi Code の応答も含めます。（#695）
- **Antigravity CLI のセッション：** 各ターン自身の時刻で日付を判定し、正しい日に表示します。（#695）
- **Cline のセッション：** 各リクエストを実際に処理したモデルを表示し、判別できないモデル名を表示しません。（#695）
- **OpenRouter のコスト：** 誤ったサービス階層の価格を使ったり、モデル名の表記違いで一致しなかったりする問題を修正しました。（#695）
- **WorkBuddy 5.5 の使用量：** WorkBuddy 5.5 が作成したセッションを集計します。（#695）
- **セッション履歴：** 保持した履歴が大きくなってもアプリが固まりません。（#693）
- **T3 Code の Codex セッション：** 最初のメッセージではなくセッションタイトルを表示します。（#692）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.58.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.58.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-Setup-0.58.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.58.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.58.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.58.0/Token-Monitor-0.58.0.AppImage)

</details>

</details>
