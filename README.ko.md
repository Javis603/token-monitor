<p align="right">
   <a href="./README.md">EN</a> | <a href="./README.zh-CN.md">简</a> | <a href="./README.zh-TW.md">繁</a> | <strong>KO</strong> | <a href="./README.ja.md">JA</a>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <em>모든 AI 코딩 도구의 실시간 사용량을 한 화면에서, 여러 기기에 동기화.</em>
</p>

<p align="center">
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/v/release/Javis603/token-monitor?include_prereleases&style=flat-square&label=release&color=22c55e" alt="최신 릴리스" /></a>
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/downloads/Javis603/token-monitor/total?style=flat-square&color=22c55e" alt="총 다운로드" /></a>
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 이상" />
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 or later" />
    <img src="https://img.shields.io/badge/Linux-x64-64748b?style=flat-square&logo=linux&logoColor=white" alt="Linux x64" />
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="라이선스: MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## Token Monitor란?

Claude Code, Codex, Cursor, GitHub Copilot 등 25개 이상의 AI 코딩 도구의 실시간 토큰 사용량과 AI 도구 한도를 보여 주는 데스크톱 위젯입니다. 여러 기기 간 실시간 동기화, 사용 추세 기록, 도구·기기·모델·세션·프로젝트별 분류 보기를 지원합니다.

## 지원 도구

Token Monitor는 **토큰 사용량**, **계정 한도**, **세션 상세**를 각각 지원합니다.

| Logo | 도구 | 데이터 경로 | 토큰 사용량 | AI 도구 한도 | 세션 상세 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME/state.db` 또는 `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/` (Cursor 동기화로 갱신) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/` (Antigravity 동기화로 갱신) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks (`.../saoudrizwan.claude-dev/tasks/`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`, `~/.kimi-code/sessions/` (`KIMI_CODE_HOME`); Kimi Code API 키 (Kimi API로 Kimi Code 할당량 조회) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` 또는 `~/.grok/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`, `~/.copilot/otel/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi | `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` (Oh My Pi) | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks (`.../kilocode.kilo-code/tasks/`) — Linux 및 원격/WSL만 | ✅ | — | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/projects/`; Z.ai API 키 (Z.ai API로 GLM 개인/팀 Coding Plan 할당량 조회) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`, Kiro IDE globalStorage 및 `kiro-cli` DB | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` + IDE / VS Code 확장 로그 | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`, `~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API 키 (DeepSeek API로 잔액 조회) | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API 키 (Minimax API로 Token Plan 할당량 조회) | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key 또는 Volcengine AK/SK (Volcengine API로 Ark Coding Plan 할당량 조회) | — | ✅ | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | Qoder dashboard cookie (Qoder usage API로 big-model credits 조회) | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie (ollama.com/settings에서 session/weekly 사용량 조회) | — | ✅ | — |

## 쇼케이스

<table>
<tr>
<td width="290" align="center"><img src=".github/assets/home-view.png" width="250" alt="홈 보기"><br><sub>커스터마이즈 가능한 대시보드 — 표시할 모듈과 순서를 선택</sub></td>
<td width="290" align="center"><img src=".github/assets/limits-view.png" width="250" alt="한도 보기"><br><sub>여러 계정을 나란히, Codex는 로컬 계정을 원클릭 전환</sub></td>
<td width="290" align="center"><img src=".github/assets/tools-view.png" width="250" alt="도구 보기"><br><sub>도구를 클릭해 입력／출력과 캐시 히트 상세를 펼치기</sub></td>
</tr>
<tr>
<td width="290" align="center"><img src=".github/assets/sessions-view.png" width="250" alt="세션 보기"><br><sub>단일 세션을 열어 프롬프트별 토큰과 사용 도구로 분해</sub></td>
<td width="290" align="center"><img src=".github/assets/models-view.png" width="250" alt="모델 보기"><br><sub>도구 전반에서 각 모델의 사용량과 비용을 집계</sub></td>
<td width="290" align="center"><img src=".github/assets/devices-view.png" width="250" alt="기기 보기"><br><sub>각 기기의 사용량·비용·동기화 상태, 펼치면 기기별 상세</sub></td>
</tr>
</table>

<table>
<tr>
<td width="435" align="center"><img src=".github/assets/dashboard-overview.png" width="400" alt="사용 대시보드 개요"><br><sub>모든 기기를 아우른 1년치 활동 히트맵과 연속 일수</sub></td>
<td width="435" align="center"><img src=".github/assets/dashboard-trends.png" width="400" alt="사용 대시보드 추세"><br><sub>1년치 일별 추세, 도구／모델별 누적, K선 지원</sub></td>
</tr>
</table>

## Token Monitor를 쓰는 이유

대부분의 사용량 모니터는 실행 중인 그 기기에서만 유용합니다. Token Monitor는 멀티 디바이스 작업을 위해 만들어졌습니다. 각 기기가 로컬 로그를 감시하고 hub로 요약을 보내면, 연결된 모든 위젯이 토큰 변화를 거의 실시간으로 볼 수 있습니다.

## 기능

### 사용량 추적

- **실시간 토큰 추적** — Claude Code, Codex, Cursor, GitHub Copilot, Antigravity, OpenCode 등 20개 이상의 AI 도구, 턴당 수 초 내 UI 갱신 (전체 목록은 위 표 참고)
- **세션별 상세** — Claude Code, Codex, OpenCode 세션에서 프롬프트별 토큰, 응답별 토큰 분할·사용 도구까지 확장 (로컬 transcript/DB를 필요할 때만 읽으며 동기화하지 않음)
- **캐시 히트 통계** — 도구·모델 클릭 시 입력 토큰(캐시 hit/miss), 출력 토큰, 히트율 상세
- **비용과 통화** — 토큰 수와 함께 비용 표시. USD, TWD, HKD, CNY 지원, 환율은 매일 자동 갱신, 설정에서 수동 덮어쓰기 가능
- **WSL 사용량 (Windows)** — 실행 중인 WSL 배포판의 파일 기반 사용량을 약 5분마다 자동 감지해 합산합니다. OpenCode와 Hermes 같은 SQLite 기반 도구는 [WSL 내부 헤드리스 에이전트](docs/wsl-sqlite-setup.md)가 필요할 수 있습니다

### 한도·추세·내보내기

- **AI 도구 한도 감지** — Claude Code, Codex, Cursor, GLM, Kimi 등 15개 이상 공급자의 session/weekly/billing/credits, DeepSeek 선불 잔액·오늘/이번 달 사용액
- **여러 계정과 Codex 전환** — 한 공급자에서 여러 계정을 추적하고 각각의 한도를 표시. 추적 중인 Codex 계정은 재인증 없이 로컬 계정으로 한 번에 전환 가능
- **삭제된 세션 사용량 유지** — 많은 도구가 오래된 세션을 정리합니다(Claude Code는 기본적으로 30일 후 트랜스크립트 삭제). 켜면 Token Monitor가 관측한 일별 도구/모델 사용량을 로컬에 보관해, 원본 파일이 사라져도 히트맵과 추세를 유지합니다(아래 [세션 데이터 보존 기간](#세션-데이터-보존-기간) 참고)
- **사용 추세 & 대시보드** — 홈 화면 활동 히트맵·추세 차트, 연속 일수·기기 전체 도구/모델별 누적 사용(막대·K선) 전용 대시보드 창
- **상태 보기** (선택) — Claude, OpenAI, Cursor, DeepSeek 상태 페이지 수동/주기 확인
- **데이터 내보내기** — 도구 무관 CSV + JSON으로 수동 내보내기 또는 폴더 자동 기록 (스프레드시트, Obsidian, Grafana, 스크립트용); [docs/export.md](docs/export.md) 참고

### 멀티 디바이스와 배포

- **멀티 디바이스 실시간 동기화** — Server-Sent Events. 한 기기의 변경이 수 초 내 다른 기기에 반영
- **로컬 우선** — 단일 기기는 서버 불필요
- **자체 호스트 동기화** — 위젯 내 hub, Node CLI hub, Cloudflare Worker
- **iOS 위젯** — Worker hub + Widgy, Scriptable
- **프라이버시 우선** — 프롬프트, 응답, 소스 코드, 파일 내용은 모두 기기에만 보관

### 인터페이스와 표시

- **분류 보기** — 도구, 기기, 모델, 세션, 프로젝트, 계정 한도별
- **메뉴 막대(macOS) / 시스템 트레이(Windows)** — 비용, 토큰, 또는 소진에 가장 가까운 공급자 한도 %를 아이콘 옆에 표시
- **플로팅 버블** — 드래그 가능한 미니 창, 클릭/호버 미리보기
- **외관** — 테마(라이트 포함), 도구별 색, 글래스 투명도·블러, 투명 창
- **도구 목록 커스터마이즈** — 추적은 유지한 채 숨기기, 고정, 순서 변경
- **전역 단축키** — 어디서든 창 표시/숨김
- **Discord Rich Presence** — 오늘 토큰·비용·주요 클라이언트 (옵트인)

## 설치

[GitHub Releases](https://github.com/Javis603/token-monitor/releases)에서 다운로드하세요.

- **macOS (Apple Silicon)** — `.dmg`, 서명 및 notarize 완료
- **macOS (Intel)** — x64 `.dmg`, 서명 및 notarize 완료
- **Windows 10/11** — 설치용 및 휴대용 `.exe`, [서명됨](docs/code-signing.md)
- **Linux x64** — `.AppImage`

패키지 빌드는 GitHub Releases를 자동 확인합니다. 새 버전이 있으면 화면에 업데이트 표시가 나타나며, 지원되는 플랫폼에서는 설정 → 일반에서도 설치할 수 있습니다.

### 첫 실행

로컬 모드가 기본값입니다. 앱을 실행하면 이 기기의 사용량 추적을 시작합니다. hub, agent, 설정 불필요.

## 멀티 디바이스 동기화

모든 기기(및 headless agent)가 연결할 **hub 하나**를 고릅니다. 각 기기에서 위젯을 열고 **설정 → 멀티 디바이스 동기화**에서 모드를 선택합니다. 위젯이 이 기기 사용량을 자동으로 올리며, 위젯이 없는 기기에서만 `npm run agent`를 실행하면 됩니다.

#### 옵션 A — 위젯에서 hub 호스트 (가장 쉬움, CLI 불필요)

항상 켜 둔 기기에서 **설정 → 멀티 디바이스 동기화 → 이 기기에서 Hub 호스팅**을 선택합니다. 위젯이 secret을 생성하고 LAN URL(Tailscale/ZeroTier 포함)을 표시합니다. 다른 기기에서는 **Hub에 연결**에 URL과 secret을 붙여 넣습니다.

Token Monitor가 실행 중일 때만 hub가 동작합니다. 앱을 종료하면(창만 닫는 것과 다름) hub가 멈추고 연결된 기기가 끊깁니다.

#### 옵션 B — Node hub 자체 호스트 (상시 headless 기기)

```bash
# 상시 켜 둔 기기에서
cp .env.example .env
# TOKEN_MONITOR_SECRET을 비공개 값으로 설정한 뒤:
npm run hub
```

#### 옵션 C — Cloudflare Worker hub (네트워크 간, iPhone 포함)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

원클릭 배포 시 `TOKEN_MONITOR_SECRET` 입력을 요청합니다. 수동 배포:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

배포 URL을 각 기기 **설정 → 멀티 디바이스 동기화**에 붙여 넣습니다. iOS 위젯은 [worker/README.md](worker/README.md), HTTP API는 [docs/API.md](docs/API.md)를 참고하세요.

## 앱 데이터

앱 상태는 OS 사용자 데이터 디렉터리에 저장됩니다. 앱과 함께 해당 폴더를 삭제하면 완전히 제거됩니다.

| 플랫폼 | 경로 |
|--------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |
| Linux | `~/.config/Token Monitor/` |

## 소스에서 빌드

직접 설치 파일을 빌드하려면 **대상 OS**에서 Node.js 22.13+를 사용하세요(electron-builder는 macOS `.dmg`와 Windows `.exe` 교차 빌드 불가).

```bash
npm install
npm run dist:mac     # macOS arm64 .dmg           → dist/
npm run dist:mac:x64 # macOS Intel x64 .dmg       → dist/
npm run dist:win     # Windows x64 installer .exe → dist/
npm run dist:linux   # Linux x64 AppImage         → dist/
npm run pack         # 설치 없이 앱 디렉터리만 (로컬 테스트)
```

결과물은 `dist/`에 생성됩니다. Windows와 Linux는 대상 OS에서 위의 해당 `dist:*` 스크립트를 사용하세요. macOS 릴리스 빌드를 패키징하려면 이 Mac에 Developer ID Application 서명 ID가 있어야 합니다. 로컬 개발 또는 지원되지 않는 플랫폼에서는 `npm start`를 사용하세요.

## 동작 방식

```text
모드 A — 로컬 (기본, 설정 없음)
    위젯 (Electron) ──▶ tokscale ──▶ ~/.claude, ~/.codex, $HERMES_HOME

모드 B — 동기화 (옵트인, 멀티 디바이스)
    기기 A agent ──▶
    기기 B agent ──▶  hub  ──▶  아무 기기의 위젯
    기기 C agent ──▶
```

위젯은 **설정 → 멀티 디바이스 동기화**에 따라 로컬/동기화를 선택합니다. hub는 `npm run hub`, Cloudflare Worker, 또는 위젯 내 Host 모드로 실행할 수 있습니다. 동기화 모드에서는 hub가 SSE로 집계 통계를 푸시해 한 기기의 변경이 수 초 내 다른 기기에 반영됩니다.

## 세션 데이터 보존 기간

**삭제된 세션 사용량 유지**(설정 → 수집)를 켜면 Token Monitor는 관측한 일별 도구/모델 사용량을 기간 제한 없이 로컬에 보관합니다. 원본 도구가 나중에 세션을 정리해도 히트맵과 추세는 영향을 받지 않습니다.

<details>
<summary><strong>고급: 원본 도구 자체의 보존 기간 늘리기</strong></summary>

<br>

히트맵과 동기화 데이터는 370일 롤링 기간을 사용합니다(더 오래된 관측 데이터는 향후 보기를 위해 로컬에 남습니다). **Claude Code는 기본적으로 30일치 트랜스크립트만 보관합니다**(`cleanupPeriodDays`). 아카이브가 작동하기 전에 1년치 롤링 기간을 보존하려면, 기간이 지나기 전에 `~/.claude/settings.json`에서 늘리세요:

```json
{
  "cleanupPeriodDays": 370
}
```

값을 키우면 더 오래 남길 수 있지만, 그만큼 트랜스크립트가 디스크에 계속 남습니다. 다른 도구의 기본값과 설정 파일 경로는 tokscale의 [Session Data Retention](https://github.com/junhoyeo/tokscale#session-data-retention) 표를 참고하세요.

이 아카이브는 Token Monitor가 이미 관측한 날짜만 포함합니다. 추적을 시작하기 전에 삭제된 데이터는 복구할 수 없습니다.

</details>

## 설정

Token Monitor 설정은 두 곳에 있으며, 일상 사용에는 앞의 것만 필요합니다.

- **위젯 (GUI)** — 오른쪽 아래 `⚙` 버튼으로 엽니다. 섹션 순서: 일반(언어, 로그인 시 시작, 업데이트), 메인 화면(홈 모듈과 표시 통화), 창(창 동작, 트레이 모드, 플로팅 버블, 단축키), 외관(테마와 도구별 색), 수집(추적 도구, 수집 주기, 삭제된 세션 사용량 유지, 데이터 내보내기), AI 도구 한도, 계정(공급자별 자격 증명), 멀티 디바이스 동기화. 타이틀 바의 `⇧` 버튼으로 창 동작을 전환합니다.
- **Headless agent와 hub** — UI 없음. 프로젝트 루트의 `.env`(`.env.example` 복사)로 설정하며, 우선순위는 CLI 플래그 → 환경 변수 → 기본값입니다.

모든 설정과 환경 변수의 자세한 내용은 [설정 레퍼런스](docs/configuration.md)를 참고하세요.

## 프라이버시

Token Monitor는 사용 로그를 로컬에서 처리하며 프로젝트 관리자에게 분석 또는 원격 측정 데이터를 보내지 않습니다. 네트워크 접근은 문서화되었거나 사용자가 활성화한 기능에만 사용됩니다. 업데이트, 제공자 연동, Discord Rich Presence 및 선택적 다중 기기 동기화에서 사용하는 데이터는 [개인정보 처리방침](docs/privacy.md)을 참고하세요.

## Star 기록

<a href="https://www.star-history.com/?repos=Javis603%2Ftoken-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&theme=dark&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
 </picture>
</a>

## 기여하기

Issue와 PR을 환영합니다. 프로젝트 규약, 아키텍처 노트, 명령어 레퍼런스는 [AGENTS.md](AGENTS.md)에 있습니다 — 코딩 에이전트용으로 작성되었지만 기여자 가이드로도 사용할 수 있습니다.

## 감사의 글

- [tokscale](https://github.com/junhoyeo/tokscale) — 로그 파싱 및 토큰 집계
- [CodexBar](https://github.com/steipete/CodexBar) — AI 도구 한도 연구
- **[코드 서명 정책](docs/code-signing.md):** 무료 코드 서명은 [SignPath.io](https://signpath.io/)에서 제공하고 인증서는 [SignPath Foundation](https://signpath.org/)에서 제공합니다.

## 라이선스

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
