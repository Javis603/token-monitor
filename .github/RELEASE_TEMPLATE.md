# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **fx usage:** Adds token usage tracking. (#887)
- **Visible usage items:** Lets you hide individual usage rows for each limits provider across Limits, Home and Edge Dock. (#901, #902)
- **Claude and Codex cache estimates:** Shows estimated prompt-cache time remaining in session lists, Home and Edge Dock. (#898)
- **Session title display:** Adds a setting to hide session titles across views. (#920)
- **Session metrics:** Shows cache hit rate and average generation speed when data is available. (#910)
- **Session model breakdown:** Hover or focus a multi-model label to see token counts and shares for each model. (#909)
- **Live model rates:** Shows per-model rates in the widget and Edge Dock tooltips, grouped by device when several devices contribute. (#912)

### Improved
- **Long session text:** Reveals overflowing text with smooth hover scrolling in Sessions, session details, Home and Edge Dock. (#906)
- **Session details:** Shows conversation titles in headings and lets you click the heading to return; Codex Auto Review runs show model labels and shorter model-and-time headings. (#904, #906)
- **Session IDs:** Moves selectable, copyable IDs into session details for supported tools. (#910)
- **Edge Dock quota refills:** Animates quota refills on rail rings and cards. (#893)
- **Codex reset forecasts:** Separates scheduled resets, active signals and the last reset in tooltips. (#918)

### Fixed
- **Factory limits:** Shows missing monthly quotas, Core pool quotas and extra-usage balances. (#900)
- **Tool icons:** Fixes icons appearing as solid squares when the installation path contains parentheses. (#892)
- **Home limits:** Shows a loading message while initial quota data is being fetched. (#688)
- **Quota refill animations:** Keeps simultaneous refills in sync and prevents jumps during usage refreshes. (#888, #889)
- **macOS window activation:** Restores the hidden or minimized main window when reopening the running app. (#907)
- **Windows Edge Dock:** Prevents ordinary windows from covering the dock after it appears. (#878)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.65.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.65.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-Setup-0.65.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.65.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.AppImage)

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
- **fx 用量：** 新增 Tokens 用量追踪支持。（#887）
- **可见用量项目：** 可为各限额来源单独隐藏用量条目，并应用于“额度”、主页和侧边栏。（#901、#902）
- **Claude 与 Codex 缓存估算：** 在会话列表、主页和侧边栏显示提示缓存的预计剩余时间。（#898）
- **会话标题显示：** 新增设置，可在各界面隐藏会话标题。（#920）
- **会话指标：** 有可用数据时，显示缓存命中率和平均生成速度。（#910）
- **会话模型分解：** 悬停或聚焦多模型标签，即可查看各模型的 Tokens 用量与占比。（#909）
- **模型实时速率：** 在小组件和侧边栏的提示中显示各模型速率，多设备参与时按设备分组。（#912）

### 改进
- **会话长文本：** 在“会话”、会话详情、主页和侧边栏中，悬停可平滑滚动查看超出宽度的文本。（#906）
- **会话详情：** 标题栏显示会话标题，点击即可返回；Codex 自动审查显示模型标签，并使用简洁的模型与时间标题。（#904、#906）
- **会话 ID：** 支持会话详情的工具可在详情中选择并复制 ID。（#910）
- **侧边栏额度恢复：** 为轨道圆环和卡片添加额度恢复动画。（#893）
- **Codex 重置预测：** 在提示中分区显示已排期的重置、活跃信号和上次重置。（#918）

### 修复
- **Factory 限额：** 补全缺失的每月额度、Core 额度池和额外用量余额。（#900）
- **工具图标：** 修复安装路径含括号时，图标显示为实心方块的问题。（#892）
- **主页限额：** 首次获取额度数据时显示加载提示。（#688）
- **额度恢复动画：** 同时恢复的额度动画同步结束，用量刷新时不再跳动。（#888、#889）
- **macOS 窗口唤起：** 重新打开运行中的应用时，恢复隐藏或最小化的主窗口。（#907）
- **Windows 侧边栏：** 修复侧边栏显示后可能被普通窗口遮挡的问题。（#878）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.65.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.65.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-Setup-0.65.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.65.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.64.0...v0.65.0">v0.64.0...v0.65.0</a></summary>

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
- **fx 用量：** 新增 Tokens 用量追蹤支援。（#887）
- **可見用量項目：** 可為各限額來源個別隱藏用量項目，並套用至「額度」、主頁與側邊欄。（#901、#902）
- **Claude 與 Codex 快取估算：** 在會話列表、主頁與側邊欄顯示提示快取的預估剩餘時間。（#898）
- **會話標題顯示：** 新增設定，可在各介面隱藏會話標題。（#920）
- **會話指標：** 有可用資料時，顯示快取命中率與平均生成速度。（#910）
- **會話模型分解：** 懸停或聚焦多模型標籤，即可查看各模型的 Tokens 用量與佔比。（#909）
- **模型即時速率：** 在小工具與側邊欄的提示中顯示各模型速率，多裝置參與時按裝置分組。（#912）

### 改進
- **會話長文字：** 在「會話」、會話詳情、主頁與側邊欄中，懸停可平滑捲動查看超出寬度的文字。（#906）
- **會話詳情：** 標題列顯示會話標題，點擊即可返回；Codex 自動審查顯示模型標籤，並使用簡潔的模型與時間標題。（#904、#906）
- **會話 ID：** 支援會話詳情的工具可在詳情中選取並複製 ID。（#910）
- **側邊欄額度恢復：** 為軌道圓環與卡片加入額度恢復動畫。（#893）
- **Codex 重置預測：** 在提示中分區顯示已排程的重置、活躍訊號與上次重置。（#918）

### 修復
- **Factory 限額：** 補上缺少的每月額度、Core 額度池與額外用量餘額。（#900）
- **工具圖示：** 修復安裝路徑含括號時，圖示顯示為實心方塊的問題。（#892）
- **主頁限額：** 首次取得額度資料時顯示載入提示。（#688）
- **額度恢復動畫：** 同時恢復的額度動畫同步結束，用量更新時不再跳動。（#888、#889）
- **macOS 視窗喚起：** 重新開啟執行中的應用程式時，恢復隱藏或最小化的主視窗。（#907）
- **Windows 側邊欄：** 修復側邊欄顯示後可能被一般視窗遮擋的問題。（#878）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.65.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.65.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-Setup-0.65.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.65.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **fx 사용량:** 토큰 사용량 추적을 지원합니다. (#887)
- **표시할 사용량 항목:** 한도 제공자별 사용량 항목을 숨길 수 있으며, 한도·홈·Edge Dock에 함께 적용됩니다. (#901, #902)
- **Claude 및 Codex 캐시 예상 시간:** 세션 목록, 홈, Edge Dock에 프롬프트 캐시의 예상 잔여 시간을 표시합니다. (#898)
- **세션 제목 표시:** 각 화면에서 세션 제목을 숨기는 설정을 추가했습니다. (#920)
- **세션 지표:** 데이터가 제공되면 캐시 적중률과 평균 생성 속도를 표시합니다. (#910)
- **세션 모델별 사용량:** 여러 모델을 나타내는 라벨에 마우스를 올리거나 포커스를 두면 모델별 토큰 수와 비율을 확인할 수 있습니다. (#909)
- **모델별 실시간 속도:** 위젯과 Edge Dock 툴팁에 모델별 속도를 표시하며, 여러 기기의 사용량이 반영될 때는 기기별로 묶어 보여 줍니다. (#912)

### 개선
- **긴 세션 텍스트:** 세션, 세션 상세, 홈, Edge Dock에서 잘린 텍스트에 마우스를 올리면 부드럽게 스크롤됩니다. (#906)
- **세션 상세:** 대화 제목을 머리글에 표시하고 클릭하면 돌아갈 수 있습니다. Codex 자동 리뷰에는 모델 라벨과 간결한 모델·시간 머리글을 표시합니다. (#904, #906)
- **세션 ID:** 상세 보기를 지원하는 도구는 세션 상세에서 ID를 선택하고 복사할 수 있습니다. (#910)
- **Edge Dock 할당량 복구:** 레일의 원형 게이지와 카드에 할당량 복구 애니메이션을 추가했습니다. (#893)
- **Codex 초기화 예측:** 툴팁에서 예정된 초기화, 활성 신호, 최근 초기화를 구분해 보여 줍니다. (#918)

### 수정
- **Factory 한도:** 누락된 월간 할당량, Core 풀 할당량, 추가 사용 잔액을 표시합니다. (#900)
- **도구 아이콘:** 설치 경로에 괄호가 있으면 아이콘이 단색 사각형으로 표시되던 문제를 수정했습니다. (#892)
- **홈 한도:** 첫 할당량 데이터를 가져오는 동안 로딩 안내를 표시합니다. (#688)
- **할당량 복구 애니메이션:** 동시에 복구되는 항목이 함께 완료되고, 사용량 갱신 중 애니메이션이 튀지 않도록 수정했습니다. (#888, #889)
- **macOS 창 활성화:** 실행 중인 앱을 다시 열면 숨겨지거나 최소화된 기본 창을 복원합니다. (#907)
- **Windows Edge Dock:** 표시된 Dock이 일반 창에 가려질 수 있던 문제를 수정했습니다. (#878)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.65.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.65.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-Setup-0.65.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.65.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **fx 使用量：** トークン使用量の追跡に対応しました。 (#887)
- **表示する使用量項目：** プロバイダーごとに使用量項目を非表示にできます。設定は制限、ホーム、Edge Dockに反映されます。 (#901, #902)
- **Claude・Codex のキャッシュ推定：** セッション一覧、ホーム、Edge Dockにプロンプトキャッシュの推定残り時間を表示します。 (#898)
- **セッションタイトル表示：** 各画面でセッションタイトルを非表示にする設定を追加しました。 (#920)
- **セッション指標：** データがある場合、キャッシュヒット率と平均生成速度を表示します。 (#910)
- **セッションのモデル別内訳：** 複数モデルのラベルにカーソルを合わせるかフォーカスすると、モデルごとのトークン数と割合を確認できます。 (#909)
- **モデル別リアルタイム速度：** ウィジェットとEdge Dockのツールチップにモデル別の速度を表示し、複数のデバイスが使用中の場合はデバイスごとにまとめます。 (#912)

### 改善
- **長いセッションテキスト：** セッション、セッション詳細、ホーム、Edge Dockで、表示幅を超えるテキストをホバーで滑らかにスクロールできます。 (#906)
- **セッション詳細：** 見出しに会話タイトルを表示し、クリックで戻れるようにしました。Codex 自動レビューにはモデルのラベルと簡潔なモデル・時刻の見出しを表示します。 (#904, #906)
- **セッション ID：** 詳細表示に対応したツールでは、セッション詳細で ID を選択してコピーできます。 (#910)
- **Edge Dockのクォータ回復：** レールのリングとカードにクォータ回復アニメーションを追加しました。 (#893)
- **Codex リセット予測：** ツールチップで予定されたリセット、有効なシグナル、前回のリセットを分けて表示します。 (#918)

### 修正
- **Factory の上限：** 表示されていなかった月間クォータ、Core プールのクォータ、追加使用量の残高を表示します。 (#900)
- **ツールアイコン：** インストール先のパスに括弧があると、アイコンが塗りつぶされた四角になる問題を修正しました。 (#892)
- **ホームの上限：** 初回のクォータデータ取得中に読み込みメッセージを表示します。 (#688)
- **クォータ回復アニメーション：** 同時に回復する項目の完了タイミングを揃え、使用量更新時のアニメーションの跳ねを修正しました。 (#888, #889)
- **macOS のウィンドウ表示：** 実行中のアプリを再度開くと、非表示または最小化されたメインウィンドウを復元します。 (#907)
- **Windows Edge Dock：** 表示後に通常のウィンドウに隠れることがある問題を修正しました。 (#878)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.65.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.65.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-Setup-0.65.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.65.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.65.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.65.0/Token-Monitor-0.65.0.AppImage)

</details>

</details>
