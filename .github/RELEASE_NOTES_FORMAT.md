# Release Notes Format

`.github/RELEASE_TEMPLATE.md` is the live GitHub release body used by
`.github/workflows/release.yml` through `body_path`. Replace its release-specific
sections for each tag; do not treat it as a permanent placeholder template.

## Editable Sections

Only replace these blocks unless download, first-launch, or tokscale guidance is
actually stale:

- English: `## What's changed`
- Simplified Chinese: `## 更新内容`
- Other languages: one outer collapsed `<details>` block whose summary is an
  inline Markdown navigation row, followed by three independent collapsed
  `<details>` blocks
- Traditional Chinese: a collapsed `<details>` block containing a
  `## 繁體中文` heading followed by `## 更新內容` and the
  `app-update-notes:zh-TW` markers
- Korean: a collapsed `<details>` block containing a `## 한국어` heading
  followed by `## 업데이트 내용` and the `app-update-notes:ko` markers
- Japanese: a collapsed `<details>` block containing a `## 日本語` heading
  followed by `## 更新内容` and the `app-update-notes:ja` markers

Keep the localized structure and remove categories that do not apply.
Each localized release block includes a translated download heading and the same
five version-pinned links; translate labels only, never filenames or URLs.
Add one `**Full Changelog**` compare link immediately below the divider that
starts the other-language block and immediately before the outer `<details>`.
Use the immediately previous and current tags in both the link text and URL; do
not repeat it inside every locale block. After the divider, wrap the locale area
in one outer `<details>` whose summary is the plain-language row
`繁體中文 · 한국어 · 日本語`. Do not add anchor links or a visible `其他語言`
label. Keep each locale in its own nested independent `<details>` block so the
three sections remain collapsed separately.

## Category Order

Use this order when categories apply:

1. `Added` / `新增` / `추가` / `追加`
2. `Changed` / `变更` / `變更` / `변경` / `変更`
3. `Improved` / `改进` / `改進` / `개선` / `改善`
4. `Fixed` / `修复` / `修復` / `수정` / `修正`

Keep the four-category skeleton as the canonical format. In the live
`.github/RELEASE_TEMPLATE.md` for a specific tag, remove categories with no
release-note bullets. Use `Changed` / `变更` only for meaningful behavior changes
that are not simply new, improved, or fixed.

## Writing Rules

- Describe shipped user-facing behavior, not internal commits.
- Keep same-batch follow-up fixes inside the final feature wording.
- Do not include README-only, formatting-only, template-only, or internal docs
  maintenance as release-note bullets.
- Put experimental features under `Added` / `新增`, and say when they are off by
  default or still being tested.
- Use current UI terms from `src/electron/renderer/i18n.js`.
- Simplified Chinese release notes use Simplified Chinese, Traditional Chinese
  release notes use Traditional Chinese, and Korean/Japanese release notes use
  their respective languages.

## Skeleton

```markdown
## What's changed

### Added
- ...

### Changed
- ...

### Improved
- ...

### Fixed
- ...

## 更新内容

### 新增
- ...

### 变更
- ...

### 改进
- ...

### 修复
- ...

---

**Full Changelog:** [vPREVIOUS...vCURRENT](https://github.com/Javis603/token-monitor/compare/vPREVIOUS...vCURRENT)

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- ...

### 變更
- ...

### 改進
- ...

### 修復
- ...
<!-- app-update-notes:zh-TW:end -->

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- ...

### 변경
- ...

### 개선
- ...

### 수정
- ...
<!-- app-update-notes:ko:end -->

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- ...

### 変更
- ...

### 改善
- ...

### 修正
- ...
<!-- app-update-notes:ja:end -->

</details>

</details>
```
