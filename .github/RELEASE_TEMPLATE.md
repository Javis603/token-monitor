# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Kimi Work usage:** Track Kimi Work usage under Kimi and show available project attribution in the usage breakdown. (#453)
- **Trae CN Credits:** Track Trae CN and TRAE SOLO Credits in AI Tool Limits. (#483)
- **Sub2API accounts:** Add a Sub2API-compatible preset under Third-party APIs, with USD balance plus monthly and cumulative spend. (#476)

### Improved
- **Usage source compatibility:** Recent Antigravity timestamps and large Cursor exports are handled more reliably. (#501)

### Fixed
- **Usage collection stability:** Restarting usage collection no longer freezes the interface, while repeated tracking changes no longer accumulate obsolete work or memory growth. (#486, #495)
- **Usage totals:** Reasoning tokens are counted correctly, and DeepSeek Harness compaction contributes to token and cost totals without increasing reply counts. (#501)
- **Model breakdown clarity:** Unrecognized models now use the Token Monitor mark instead of a vendor-like dot, and fallback colors stay distinct from real vendors.
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.48.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.48.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-Setup-0.48.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.48.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.AppImage)

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
- **Kimi Work 用量：** 新增 Kimi Work 用量追踪，并在用量分解中显示可用的项目归因。（#453）
- **Trae CN Credits：** 支持在 AI 工具额度中查看 Trae CN 和 TRAE SOLO Credits。（#483）
- **Sub2API 账号：** 在 Third-party APIs 中新增 Sub2API 兼容预设，可查看美元余额、本月支出和累计支出。（#476）

### 改进
- **用量来源兼容性：** 改进 Antigravity 最新时间戳和大型 Cursor 导出的处理。（#501）

### 修复
- **用量采集稳定性：** 重启用量采集时不再冻结界面，反复更改追踪工具也不会累积过时的采集任务和内存占用。（#486, #495）
- **用量统计：** 正确计入推理 Tokens，DeepSeek Harness 压缩用量也会计入 Token 和成本统计，但不会增加回复次数。（#501）
- **模型分解显示：** 无法识别的模型现在使用 Token Monitor 标记，而不是容易被误认为供应商图标的圆点；备用颜色也会与真实供应商保持区分。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.48.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.48.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-Setup-0.48.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.48.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.47.0...v0.48.0">v0.47.0...v0.48.0</a></summary>

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
- **Kimi Work 用量：** 新增 Kimi Work 用量追蹤，並在用量分解中顯示可用的專案歸因。（#453）
- **Trae CN Credits：** 支援在 AI 工具額度中查看 Trae CN 與 TRAE SOLO Credits。（#483）
- **Sub2API 帳戶：** 在 Third-party APIs 新增 Sub2API 相容預設方案，可查看美元餘額、本月支出與累計支出。（#476）

### 改進
- **用量來源相容性：** 改進 Antigravity 最新時間戳與大型 Cursor 匯出的處理。（#501）

### 修復
- **用量收集穩定性：** 重新啟動用量收集時不再凍結介面，反覆變更追蹤工具也不會累積過時的收集工作和記憶體佔用。（#486, #495）
- **用量統計：** 正確計入推理 Tokens，DeepSeek Harness 壓縮用量也會計入 Token 與成本統計，但不會增加回覆次數。（#501）
- **模型分解顯示：** 無法識別的模型現在使用 Token Monitor 標記，而不是容易被誤認為供應商圖示的圓點；備用顏色也會與真實供應商保持區分。
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.48.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.48.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-Setup-0.48.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.48.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Kimi Work 사용량:** Kimi Work 사용량을 추적하고 사용량 내역에 확인 가능한 프로젝트 귀속을 표시합니다. (#453)
- **Trae CN Credits:** AI Tool Limits에서 Trae CN 및 TRAE SOLO Credits를 추적합니다. (#483)
- **Sub2API 계정:** Third-party APIs에 Sub2API 호환 프리셋을 추가해 USD 잔액과 월간·누적 지출을 표시합니다. (#476)

### 개선
- **사용량 소스 호환성:** 최신 Antigravity 타임스탬프와 대규모 Cursor 내보내기를 더 안정적으로 처리합니다. (#501)

### 수정
- **사용량 수집 안정성:** 사용량 수집을 다시 시작해도 인터페이스가 멈추지 않으며, 추적 도구를 반복해서 변경해도 오래된 작업이나 메모리가 누적되지 않습니다. (#486, #495)
- **사용량 합계:** 추론 토큰을 올바르게 합산하고 DeepSeek Harness 압축을 토큰 및 비용 합계에 포함하되 답변 수는 늘리지 않습니다. (#501)
- **모델 내역 표시:** 인식할 수 없는 모델에 공급자처럼 보이는 점 대신 Token Monitor 마크를 표시하고, 대체 색상도 실제 공급자와 겹치지 않게 합니다.
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.48.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.48.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-Setup-0.48.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.48.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Kimi Workの使用量：** Kimi Workの使用量を追跡し、使用量の内訳に取得できるプロジェクト情報を表示します。（#453）
- **Trae CN Credits：** AI Tool LimitsでTrae CNとTRAE SOLOのCreditsを追跡できます。（#483）
- **Sub2APIアカウント：** Third-party APIsにSub2API互換プリセットを追加し、USD残高と月間・累計支出を表示します。（#476）

### 改善
- **使用量ソースの互換性：** 最新のAntigravityのタイムスタンプと大規模なCursorエクスポートをより安定して処理します。（#501）

### 修正
- **使用量収集の安定性：** 使用量収集を再起動しても画面が停止せず、追跡するツールを繰り返し変更しても古い処理やメモリが蓄積しません。（#486, #495）
- **使用量の合計：** 推論トークンを正しく集計し、DeepSeek Harnessの圧縮をトークンとコストの合計に含めつつ、返信数は増やしません。（#501）
- **モデル内訳の表示：** 認識できないモデルにベンダー風のドットではなくToken Monitorマークを表示し、フォールバック色も実際のベンダーと重ならないようにします。
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.48.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.48.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-Setup-0.48.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.48.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.48.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.48.0/Token-Monitor-0.48.0.AppImage)

</details>

</details>
