/* i18n.js: translations + language resolution. No auto-run; main.js drives it. */
var supportedLanguages = ["en", "zh-TW", "zh-CN"];
var languageStorageKey = "token-monitor-site-language";

var translations = {
  en: {
    "meta.title": "Token Monitor: AI Tools usage at a glance",
    "meta.description": "Token Monitor is a local-first desktop app for live tokens, cost, limits, sessions, and history across 28+ AI coding tools.",
    "meta.ogTitle": "Token Monitor",
    "meta.ogDescription": "Live tokens, cost, limits, sessions, and history across 28+ AI coding tools.",
    "nav.skip": "Skip to content",
    "nav.primary": "Primary",
    "nav.home": "Token Monitor home",
    "nav.language": "Language",
    "nav.github": "GitHub",
    "nav.star": "Star",
    "nav.githubStar": "Star Token Monitor on GitHub",
    "nav.sections": "Section navigation",
    "nav.features": "Features",
    "nav.privacy": "Privacy",
    "nav.download": "Download",

    "hero.eyebrow": "Local-first AI coding telemetry",
    "hero.title": "Token Monitor",
    "hero.lede": "See usage, cost, and limits across every AI coding tool at a glance.",
    "hero.actions": "Primary actions",
    "hero.platforms": "Other platform downloads",
    "hero.alsoAvailable": "Also for",
    "hero.preview": "Preview of the Token Monitor Home dashboard",
    "hero.periods": "Usage period",
    "cta.download": "Download latest release",
    "cta.download.generic": "Download latest release",
    "cta.download.mac": "Download for macOS",
    "cta.download.windows": "Download for Windows",
    "cta.download.linux": "Download for Linux",
    "cta.download.meta.generic": "macOS, Windows, and Linux",
    "cta.download.meta.mac": "Choose Apple Silicon or Intel",
    "cta.download.meta.macArm": "Apple Silicon · .dmg",
    "cta.download.meta.macIntel": "Intel · .dmg",
    "cta.download.meta.windows": "Windows 10 and 11 · Setup .exe",
    "cta.download.meta.linux": "Portable x64 AppImage",
    "cta.download.aria.generic": "Download the latest Token Monitor release",
    "cta.download.aria.mac": "Download Token Monitor for macOS",
    "cta.download.aria.windows": "Download Token Monitor for Windows",
    "cta.download.aria.linux": "Download Token Monitor for Linux",
    "cta.github": "View on GitHub",

    "tools.eyebrow": "28+ tools and providers",
    "home.limits": "LIMITS",
    "home.models": "MODELS",
    "home.activity": "ACTIVITY",
    "home.activeDays": "120 active days ↗",
    "home.trend": "TREND",
    "home.peak": "Peak 430.2M",
    "home.footer": "⌂ Home",

    "feature.title": "Shape the whole AI coding workflow around what you need to see.",
    "feature.menubar.title": "A menu bar arranged your way",
    "feature.menubar.body": "Drag together tool icons, single or double quota bars, reset times, percentages, tokens, cost, spacers, separators, and custom text, then see the live result before saving.",
    "feature.menubar.previewKicker": "MENU BAR COMPOSER",
    "feature.menubar.previewTitle": "Build the signal you want to see.",
    "feature.menubar.previewSaved": "Live preview",
    "feature.menubar.previewOrder": "Display order",
    "feature.menubar.previewHint": "Drag to reorder · Select to edit",
    "feature.menubar.previewAdd": "Add to display",
    "feature.menubar.previewSync": "Updates with every refresh",
    "feature.live.title": "Live token tracking & cost",
    "feature.live.body": "Watch every supported AI coding tool, including Claude Code, Codex, Cursor, Kimi, Qwen, Grok, Copilot, and the rest, update within seconds of each turn. Cost and cache-hit rates sit alongside every count.",
    "feature.limits.title": "AI Tool Limits before you hit the wall",
    "feature.limits.body": "See session, weekly, billing, credits, and balance windows across every supported provider, including Claude Code, Codex, Cursor, Grok, Copilot, Kiro, and more, before a limit interrupts your work.",
    "feature.session.title": "Per-session detail on demand",
    "feature.session.body": "Open a Claude Code, Codex, or OpenCode session to see tokens per prompt and per reply, read on-demand from local transcripts or databases. Never synced.",
    "feature.trends.title": "A year of trends, inside the widget",
    "feature.trends.body": "Flip to the Trends view for a twelve-month sparkline with active days, streaks, and your peak day, without leaving the widget. The full dashboard below goes deeper.",
    "feature.status.title": "Provider status, right in the widget",
    "feature.status.body": "Watch Claude, OpenAI, Cursor, and DeepSeek service status without leaving the widget. Each card leads with the active incident title and the count of affected components, and re-checks on your chosen interval.",

    "dash.title": "A year of AI coding, charted.",
    "dash.lede": "Turn on opt-in history and Token Monitor opens a full dashboard window: a GitHub-style activity heatmap with streaks, plus per-tool and per-model usage stacked over time in bar and K-line views, rolled up across all your devices.",
    "mock.you": "YOU",
    "mock.newest": "↕ Newest",
    "mock.session.one": "Compare model spend...",
    "mock.session.two": "Inspect reply details...",

    "surfaces.title": "The same usage, on every surface you already use.",
    "menubar.file": "File",
    "menubar.edit": "Edit",
    "menubar.view": "View",
    "menubar.window": "Window",
    "surfaces.menubar.title": "Custom menu bar & tray",
    "surfaces.menubar.body": "Build a live display from tool icons, quota bars, reset times, cost, tokens, and text, with an instant preview.",
    "surfaces.bubble.title": "Floating Bubble",
    "surfaces.bubble.body": "Collapse the widget into a draggable mini-window with click or hover preview.",
    "surfaces.discord.playing": "Playing",
    "surfaces.discord.title": "Discord Rich Presence",
    "surfaces.discord.body": "Broadcast today's tokens, cost, and top tool to your profile. Opt-in.",
    "surfaces.ios.title": "iOS widget",
    "surfaces.ios.body": "Today's totals on your Home Screen via the Worker hub, with Widgy or Scriptable.",

    "how.title": "Start with one widget. Add a hub for multi-device sync.",
    "how.lede": "Local stays the default path. Add self-hosted sync when you want token usage from multiple devices rolled into one view.",
    "how.local.title": "Local mode",
    "how.local.body": "The widget reads local usage summaries through tokscale and renders them on the same machine. No account, no cloud.",
    "how.pivot.note": "There is no mode toggle. Paste a hub URL and the widget starts syncing; clear the field and everything stays on this machine.",
    "how.sync.title": "Sync mode",
    "how.sync.body": "Each widget or headless agent posts that device's usage summary to your hub, which merges totals and streams them back to every connected widget.",
    "how.node.widget": "Widget",
    "how.node.tokscale": "tokscale",
    "how.node.localLogs": "Local AI logs",
    "how.node.mac": "Mac widget",
    "how.node.windows": "Windows widget",
    "how.node.agent": "Headless agent",
    "how.node.hub": "Self-hosted hub",
    "how.node.summaryStream": "Summary stream",
    "how.backends": "Pick a sync backend; all three speak the same ingest protocol.",
    "how.backends.label": "Self-hostable sync backends",
    "how.backend.widget": "In-widget hub",
    "how.backend.node": "Node CLI hub",
    "how.backend.worker": "Cloudflare Worker",

    "privacy.title": "Your code and conversations are not the product.",
    "privacy.body": "Token Monitor syncs only the fields needed to show totals, costs, tool and model breakdowns, and normalized account limit status.",
    "privacy.payload.cap": "The entire record a hub ever receives: counts, costs, labels, and limit percentages. The account behind each limit is a one-way hash, never the login itself.",
    "privacy.never": "Never syncs",
    "privacy.never.1": "Raw prompts or source files",
    "privacy.never.2": "Conversation transcripts",
    "privacy.never.3": "OAuth credentials or provider responses",

    "final.title": "Download the packaged app and keep every coding tool visible.",
    "final.readme": "Read the setup guide",
    "final.downloads": "Release download options",
    "final.recommended": "Best for this device",
    "final.mac.title": "macOS .dmg",
    "final.mac.body": "Apple Silicon and Intel, signed and notarized",
    "final.win.title": "Windows Setup .exe",
    "final.win.body": "Installer build, recommended",
    "final.linux.title": "Linux AppImage",
    "final.linux.body": "Portable x64 build",
    "final.source": "Portable Windows builds and source installs are covered in the README.",

    "footer.api": "API docs",
    "footer.worker": "Worker docs",
    "footer.license": "License"
  },

  "zh-TW": {
    "meta.title": "Token Monitor：AI Tools 用量一眼看清",
    "meta.description": "Token Monitor 是本地優先的桌面 App，可即時查看 28+ 種 AI coding 工具的 token、成本、限額、session 與歷史。",
    "meta.ogTitle": "Token Monitor",
    "meta.ogDescription": "即時查看 28+ 種 AI coding 工具的 token、成本、限額、session 與歷史。",
    "nav.skip": "跳到內容",
    "nav.primary": "主要導覽",
    "nav.home": "Token Monitor 首頁",
    "nav.language": "語言",
    "nav.github": "GitHub",
    "nav.star": "Star",
    "nav.githubStar": "在 GitHub 上為 Token Monitor 加星",
    "nav.sections": "區塊導覽",
    "nav.features": "功能",
    "nav.privacy": "隱私",
    "nav.download": "下載",

    "hero.eyebrow": "本地優先的 AI coding telemetry",
    "hero.title": "Token Monitor",
    "hero.lede": "一眼掌握所有 AI coding 工具的用量、成本與限額。",
    "hero.actions": "主要操作",
    "hero.platforms": "其他平台下載",
    "hero.alsoAvailable": "其他版本",
    "hero.preview": "Token Monitor Home dashboard 預覽",
    "hero.periods": "用量期間",
    "cta.download": "下載最新版本",
    "cta.download.generic": "下載最新版本",
    "cta.download.mac": "下載 macOS 版",
    "cta.download.windows": "下載 Windows 版",
    "cta.download.linux": "下載 Linux 版",
    "cta.download.meta.generic": "macOS、Windows 與 Linux",
    "cta.download.meta.mac": "選擇 Apple Silicon 或 Intel",
    "cta.download.meta.macArm": "Apple Silicon · .dmg",
    "cta.download.meta.macIntel": "Intel · .dmg",
    "cta.download.meta.windows": "Windows 10 / 11 · 安裝程式",
    "cta.download.meta.linux": "可攜式 x64 AppImage",
    "cta.download.aria.generic": "下載最新版 Token Monitor",
    "cta.download.aria.mac": "下載 macOS 版 Token Monitor",
    "cta.download.aria.windows": "下載 Windows 版 Token Monitor",
    "cta.download.aria.linux": "下載 Linux 版 Token Monitor",
    "cta.github": "查看 GitHub",

    "tools.eyebrow": "28+ 種工具與供應商",
    "home.limits": "額度",
    "home.models": "模型",
    "home.activity": "活動",
    "home.activeDays": "活躍 120 天 ↗",
    "home.trend": "趨勢",
    "home.peak": "峰值 430.2M",
    "home.footer": "⌂ 主頁",

    "feature.title": "把整套 AI coding 工作流，排成你真正想看的樣子。",
    "feature.menubar.title": "Menu bar，照你的工作方式排",
    "feature.menubar.body": "拖曳組合工具圖示、單層或雙層限額條、重設時間、百分比、tokens、成本、留白、分隔符與自訂文字；儲存前就能看到即時結果。",
    "feature.menubar.previewKicker": "MENU BAR 編排器",
    "feature.menubar.previewTitle": "只留下你真正想看的訊號。",
    "feature.menubar.previewSaved": "即時預覽",
    "feature.menubar.previewOrder": "顯示順序",
    "feature.menubar.previewHint": "拖曳排序 · 點選編輯",
    "feature.menubar.previewAdd": "加入顯示",
    "feature.menubar.previewSync": "每次刷新同步更新",
    "feature.live.title": "即時 token 追蹤與成本",
    "feature.live.body": "所有支援的 AI coding 工具，包括 Claude Code、Codex、Cursor、Kimi、Qwen、Grok、Copilot 等，都會在每輪對話後數秒內更新。每個數字旁都有成本與 cache 命中率。",
    "feature.limits.title": "在撞牆前看見 AI Tool Limits",
    "feature.limits.body": "跨所有支援的供應商查看 session、每週、帳單、credits 與餘額視窗，包括 Claude Code、Codex、Cursor、Grok、Copilot、Kiro 等，在限制打斷工作前先看到它。",
    "feature.session.title": "需要時才看 session 明細",
    "feature.session.body": "打開 Claude Code、Codex 或 OpenCode session，看每個 prompt 與 reply 的 token；從本機 transcript 或資料庫即時讀取，永不同步。",
    "feature.trends.title": "一年的趨勢，就在 widget 裡",
    "feature.trends.body": "切到 Trends 視圖，不用離開 widget 就能看到 12 個月的用量長條、活躍天數、連續天數與單日高峰。想看更深入的，往下捲到完整 dashboard。",
    "feature.status.title": "服務狀態，就在 widget 裡",
    "feature.status.body": "不必離開 widget，就能查看 Claude、OpenAI、Cursor 與 DeepSeek 的服務狀態。每張卡片以進行中的事件標題與受影響元件數開頭，並依你設定的間隔重新檢查。",

    "dash.title": "把一年的 AI coding 畫成圖。",
    "dash.lede": "開啟可選的歷史收集，Token Monitor 會打開完整的 dashboard 視窗：GitHub 風格的活動熱力圖與連續天數，加上隨時間堆疊的各工具、各模型用量，提供長條圖與 K 線兩種檢視，並彙整你所有裝置。",
    "mock.you": "你",
    "mock.newest": "↕ 最新",
    "mock.session.one": "比較模型成本...",
    "mock.session.two": "查看 reply 明細...",

    "surfaces.title": "同一份用量，出現在你本來就在用的每個介面。",
    "menubar.file": "檔案",
    "menubar.edit": "編輯",
    "menubar.view": "顯示",
    "menubar.window": "視窗",
    "surfaces.menubar.title": "自訂 menu bar 與工作列",
    "surfaces.menubar.body": "用工具圖示、限額進度、重設時間、成本、tokens 與文字組出自己的即時顯示，並立即預覽。",
    "surfaces.bubble.title": "Floating Bubble",
    "surfaces.bubble.body": "把 widget 收成可拖曳的迷你視窗，支援點擊或 hover 預覽。",
    "surfaces.discord.playing": "正在遊玩",
    "surfaces.discord.title": "Discord Rich Presence",
    "surfaces.discord.body": "把今日 tokens、成本與最常用工具廣播到你的個人檔案，可選開啟。",
    "surfaces.ios.title": "iOS 小工具",
    "surfaces.ios.body": "透過 Worker hub，用 Widgy 或 Scriptable 把今日總量放到主畫面。",

    "how.title": "先用一個 widget。要同步多台裝置時才加 hub。",
    "how.lede": "本地仍是預設路徑。想彙整多台裝置的 Token 用量時，再加一層自架同步。",
    "how.local.title": "本地模式",
    "how.local.body": "Widget 透過 tokscale 讀取本機用量摘要，並在同一台機器上顯示。不需要帳號、不需要雲端。",
    "how.pivot.note": "沒有模式開關。貼上 hub 網址，widget 就開始同步；清空欄位，一切就留在這台機器上。",
    "how.sync.title": "同步模式",
    "how.sync.body": "每個 widget 或 headless agent 會把該裝置的用量摘要送到你的 hub，hub 彙整後再串流回所有已連線 widget。",
    "how.node.widget": "Widget",
    "how.node.tokscale": "tokscale",
    "how.node.localLogs": "本機 AI logs",
    "how.node.mac": "Mac widget",
    "how.node.windows": "Windows widget",
    "how.node.agent": "Headless agent",
    "how.node.hub": "自架 hub",
    "how.node.summaryStream": "摘要串流",
    "how.backends": "同步後端三選一，都走同一套 ingest 協定。",
    "how.backends.label": "可自架的同步後端",
    "how.backend.widget": "widget 內建 hub",
    "how.backend.node": "Node CLI hub",
    "how.backend.worker": "Cloudflare Worker",

    "privacy.title": "你的程式碼與對話不是產品。",
    "privacy.body": "Token Monitor 只同步顯示總量、成本、工具與模型拆分，以及標準化帳戶限制所需的欄位。",
    "privacy.payload.cap": "這就是 hub 收到的完整紀錄：數字、成本、標籤與限制百分比。每個限制背後的帳戶都是單向 hash，永遠不是登入身分本身。",
    "privacy.never": "永不同步",
    "privacy.never.1": "原始提示詞或原始碼",
    "privacy.never.2": "對話 transcript",
    "privacy.never.3": "OAuth 憑證或 provider 回應",

    "final.title": "下載打包好的 App，讓每個 coding 工具的用量都看得見。",
    "final.readme": "閱讀設定指南",
    "final.downloads": "Release 下載選項",
    "final.recommended": "最適合這部裝置",
    "final.mac.title": "macOS .dmg",
    "final.mac.body": "Apple Silicon 與 Intel，已簽署並 notarize",
    "final.win.title": "Windows Setup .exe",
    "final.win.body": "建議使用安裝版",
    "final.linux.title": "Linux AppImage",
    "final.linux.body": "可攜式 x64 版本",
    "final.source": "Windows 可攜版與原始碼安裝方式請看 README。",

    "footer.api": "API 文件",
    "footer.worker": "Worker 文件",
    "footer.license": "授權"
  },

  "zh-CN": {
    "meta.title": "Token Monitor：AI Tools 用量一眼看清",
    "meta.description": "Token Monitor 是本地优先的桌面 App，可实时查看 28+ 种 AI coding 工具的 token、成本、限额、session 与历史。",
    "meta.ogTitle": "Token Monitor",
    "meta.ogDescription": "实时查看 28+ 种 AI coding 工具的 token、成本、限额、session 与历史。",
    "nav.skip": "跳到内容",
    "nav.primary": "主要导航",
    "nav.home": "Token Monitor 首页",
    "nav.language": "语言",
    "nav.github": "GitHub",
    "nav.star": "Star",
    "nav.githubStar": "在 GitHub 上为 Token Monitor 加星",
    "nav.sections": "区块导航",
    "nav.features": "功能",
    "nav.privacy": "隐私",
    "nav.download": "下载",

    "hero.eyebrow": "本地优先的 AI coding telemetry",
    "hero.title": "Token Monitor",
    "hero.lede": "一眼掌握所有 AI coding 工具的用量、成本和限额。",
    "hero.actions": "主要操作",
    "hero.platforms": "其他平台下载",
    "hero.alsoAvailable": "其他版本",
    "hero.preview": "Token Monitor Home dashboard 预览",
    "hero.periods": "用量期间",
    "cta.download": "下载最新版本",
    "cta.download.generic": "下载最新版本",
    "cta.download.mac": "下载 macOS 版",
    "cta.download.windows": "下载 Windows 版",
    "cta.download.linux": "下载 Linux 版",
    "cta.download.meta.generic": "macOS、Windows 与 Linux",
    "cta.download.meta.mac": "选择 Apple Silicon 或 Intel",
    "cta.download.meta.macArm": "Apple Silicon · .dmg",
    "cta.download.meta.macIntel": "Intel · .dmg",
    "cta.download.meta.windows": "Windows 10 / 11 · 安装程序",
    "cta.download.meta.linux": "便携式 x64 AppImage",
    "cta.download.aria.generic": "下载最新版 Token Monitor",
    "cta.download.aria.mac": "下载 macOS 版 Token Monitor",
    "cta.download.aria.windows": "下载 Windows 版 Token Monitor",
    "cta.download.aria.linux": "下载 Linux 版 Token Monitor",
    "cta.github": "查看 GitHub",

    "tools.eyebrow": "28+ 种工具与提供商",
    "home.limits": "额度",
    "home.models": "模型",
    "home.activity": "活动",
    "home.activeDays": "活跃 120 天 ↗",
    "home.trend": "趋势",
    "home.peak": "峰值 430.2M",
    "home.footer": "⌂ 首页",

    "feature.title": "把整套 AI coding 工作流，排成你真正想看的样子。",
    "feature.menubar.title": "Menu bar，按你的工作方式排",
    "feature.menubar.body": "拖拽组合工具图标、单层或双层限额条、重置时间、百分比、tokens、成本、留白、分隔符与自定义文字；保存前就能看到实时结果。",
    "feature.menubar.previewKicker": "MENU BAR 编排器",
    "feature.menubar.previewTitle": "只留下你真正想看的信号。",
    "feature.menubar.previewSaved": "实时预览",
    "feature.menubar.previewOrder": "显示顺序",
    "feature.menubar.previewHint": "拖拽排序 · 点击编辑",
    "feature.menubar.previewAdd": "加入显示",
    "feature.menubar.previewSync": "每次刷新同步更新",
    "feature.live.title": "实时 token 追踪与成本",
    "feature.live.body": "所有受支持的 AI coding 工具，包括 Claude Code、Codex、Cursor、Kimi、Qwen、Grok、Copilot 等，都会在每轮对话后数秒内更新。每个数字旁都有成本与 cache 命中率。",
    "feature.limits.title": "在撞墙前看见 AI Tool Limits",
    "feature.limits.body": "跨所有受支持的提供商查看 session、每周、账单、credits 与余额窗口，包括 Claude Code、Codex、Cursor、Grok、Copilot、Kiro 等，在限制打断工作前先看到它。",
    "feature.session.title": "需要时才看 session 明细",
    "feature.session.body": "打开 Claude Code、Codex 或 OpenCode session，看每个 prompt 与 reply 的 token；从本机 transcript 或数据库实时读取，永不同步。",
    "feature.trends.title": "一年的趋势，就在 widget 里",
    "feature.trends.body": "切到 Trends 视图，不用离开 widget 就能看到 12 个月的用量柱状、活跃天数、连续天数与单日峰值。想看更深入的，往下滚到完整 dashboard。",
    "feature.status.title": "服务状态，就在 widget 里",
    "feature.status.body": "不必离开 widget，就能查看 Claude、OpenAI、Cursor 与 DeepSeek 的服务状态。每张卡片以进行中的事件标题与受影响组件数开头，并按你设定的间隔重新检查。",

    "dash.title": "把一年的 AI coding 画成图。",
    "dash.lede": "开启可选的历史收集，Token Monitor 会打开完整的 dashboard 窗口：GitHub 风格的活动热力图与连续天数，加上随时间堆叠的各工具、各模型用量，提供柱状图与 K 线两种视图，并汇总你所有设备。",
    "mock.you": "你",
    "mock.newest": "↕ 最新",
    "mock.session.one": "比较模型成本...",
    "mock.session.two": "查看 reply 明细...",

    "surfaces.title": "同一份用量，出现在你本来就在用的每个界面。",
    "menubar.file": "文件",
    "menubar.edit": "编辑",
    "menubar.view": "显示",
    "menubar.window": "窗口",
    "surfaces.menubar.title": "自定义 menu bar 与任务栏",
    "surfaces.menubar.body": "用工具图标、限额进度、重置时间、成本、tokens 与文字组成自己的实时显示，并立即预览。",
    "surfaces.bubble.title": "Floating Bubble",
    "surfaces.bubble.body": "把 widget 收成可拖拽的迷你窗口，支持点击或 hover 预览。",
    "surfaces.discord.playing": "正在玩",
    "surfaces.discord.title": "Discord Rich Presence",
    "surfaces.discord.body": "把今日 tokens、成本与最常用工具广播到你的个人资料，可选开启。",
    "surfaces.ios.title": "iOS 小组件",
    "surfaces.ios.body": "通过 Worker hub，用 Widgy 或 Scriptable 把今日总量放到主屏幕。",

    "how.title": "先用一个 widget。要同步多台设备时才加 hub。",
    "how.lede": "本地仍是默认路径。想汇总多台设备的 Token 用量时，再加一层自托管同步。",
    "how.local.title": "本地模式",
    "how.local.body": "Widget 通过 tokscale 读取本机用量摘要，并在同一台机器上显示。不需要账号、不需要云端。",
    "how.pivot.note": "没有模式开关。粘贴 hub 网址，widget 就开始同步；清空字段，一切就留在这台机器上。",
    "how.sync.title": "同步模式",
    "how.sync.body": "每个 widget 或 headless agent 会把该设备的用量摘要送到你的 hub，hub 汇总后再流式推送回所有已连接 widget。",
    "how.node.widget": "Widget",
    "how.node.tokscale": "tokscale",
    "how.node.localLogs": "本机 AI logs",
    "how.node.mac": "Mac widget",
    "how.node.windows": "Windows widget",
    "how.node.agent": "Headless agent",
    "how.node.hub": "自托管 hub",
    "how.node.summaryStream": "摘要流",
    "how.backends": "同步后端三选一，都走同一套 ingest 协定。",
    "how.backends.label": "可自托管的同步后端",
    "how.backend.widget": "widget 内置 hub",
    "how.backend.node": "Node CLI hub",
    "how.backend.worker": "Cloudflare Worker",

    "privacy.title": "你的代码与对话不是产品。",
    "privacy.body": "Token Monitor 只同步显示总量、成本、工具与模型拆分，以及标准化账号限制所需的字段。",
    "privacy.payload.cap": "这就是 hub 收到的完整记录：数字、成本、标签与限制百分比。每个限制背后的账号都是单向 hash，永远不是登录身份本身。",
    "privacy.never": "永不同步",
    "privacy.never.1": "原始提示词或源码",
    "privacy.never.2": "对话 transcript",
    "privacy.never.3": "OAuth 凭证或 provider 响应",

    "final.title": "下载打包好的 App，让每个 coding 工具的用量都看得见。",
    "final.readme": "阅读设置指南",
    "final.downloads": "Release 下载选项",
    "final.recommended": "最适合这台设备",
    "final.mac.title": "macOS .dmg",
    "final.mac.body": "Apple Silicon 与 Intel，已签名并 notarize",
    "final.win.title": "Windows Setup .exe",
    "final.win.body": "建议使用安装版",
    "final.linux.title": "Linux AppImage",
    "final.linux.body": "便携式 x64 版本",
    "final.source": "Windows 便携版与源码安装方式请看 README。",

    "footer.api": "API 文档",
    "footer.worker": "Worker 文档",
    "footer.license": "许可证"
  }
};

function normalizeLanguage(value) {
  if (!value) return "";
  var normalized = value.replace("_", "-");
  if (supportedLanguages.indexOf(normalized) !== -1) return normalized;
  var lower = normalized.toLowerCase();
  if (lower === "zh" || lower.indexOf("zh-hant") === 0 || lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo") return "zh-TW";
  if (lower.indexOf("zh-hans") === 0 || lower === "zh-cn" || lower === "zh-sg") return "zh-CN";
  if (lower.indexOf("en") === 0) return "en";
  return "";
}
function readStoredLanguage() { try { return normalizeLanguage(window.localStorage.getItem(languageStorageKey)); } catch (e) { return ""; } }
function storeLanguage(language) { try { window.localStorage.setItem(languageStorageKey, language); } catch (e) {} }
function languageFromUrl() {
  var queryLanguage = "";
  try { queryLanguage = normalizeLanguage(new URLSearchParams(window.location.search).get("lang")); } catch (e) {}
  if (queryLanguage) return queryLanguage;
  return normalizeLanguage(window.location.hash.slice(1)); /* legacy #zh-TW links */
}
function preferredLanguage() { return languageFromUrl() || readStoredLanguage() || normalizeLanguage(window.navigator.language) || "en"; }

function reflectLanguageInUrl(language) {
  try {
    var url = new URL(window.location.href);
    url.searchParams.set("lang", language);
    if (normalizeLanguage(url.hash.slice(1))) url.hash = "";
    window.history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString() + url.hash);
  } catch (e) {}
}

function translateElement(element, messages) {
  var key = element.getAttribute("data-i18n");
  if (key && messages[key]) element.textContent = messages[key];
  var attrConfig = element.getAttribute("data-i18n-attr");
  if (!attrConfig) return;
  var pairs = attrConfig.split(",");
  for (var i = 0; i < pairs.length; i++) {
    var parts = pairs[i].split(":");
    var attr = (parts[0] || "").trim(), attrKey = (parts[1] || "").trim();
    if (attr && attrKey && messages[attrKey]) element.setAttribute(attr, messages[attrKey]);
  }
}
function applyLanguage(language) {
  var active = supportedLanguages.indexOf(language) !== -1 ? language : "en";
  var messages = translations[active];
  document.documentElement.lang = active;
  document.title = messages["meta.title"];
  var nodes = document.querySelectorAll("[data-i18n], [data-i18n-attr]");
  for (var i = 0; i < nodes.length; i++) translateElement(nodes[i], messages);
  var langBtns = document.querySelectorAll("[data-lang]");
  for (var j = 0; j < langBtns.length; j++) langBtns[j].setAttribute("aria-checked", String(langBtns[j].getAttribute("data-lang") === active));
  storeLanguage(active);
  reflectLanguageInUrl(active);
}
function setupLanguageButtons() {
  var btns = document.querySelectorAll("[data-lang]");
  for (var i = 0; i < btns.length; i++) {
    (function (b) { b.addEventListener("click", function () { applyLanguage(b.getAttribute("data-lang")); }); })(btns[i]);
  }
  window.addEventListener("popstate", function () { applyLanguage(preferredLanguage()); });
}
