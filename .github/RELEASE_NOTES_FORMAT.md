# Release Notes Format

`.github/RELEASE_TEMPLATE.md` is the live, per-release GitHub release body used
by `.github/workflows/release.yml` through `body_path`. Replace its
release-specific sections for each tag; do not treat it as a permanent
placeholder template.

This file documents the stable Markdown shape of that release body.

## Structure

- Keep the English and Simplified Chinese release-note sections at the top.
- Keep the existing divider between the English and Simplified Chinese
  sections. After the Simplified Chinese section, put one final `---` divider
  before the additional-language area.
- Put one collapsed `Full Changelog` details block immediately below the
  divider. Its summary contains the single version compare link; clicking the
  summary label expands the generated details, while clicking the version
  opens GitHub's comparison. Keep the `<!-- github-generated-release-notes -->`
  marker as the only content inside the disclosure. The release workflow
  replaces it with GitHub's merged-PR, author, and new-contributor notes for the
  tag. Direct commits that are not associated with a merged pull request are
  added to `What's Changed` with their author and commit link; the release
  commit itself is omitted. Do not add a Markdown `Contributors` list: GitHub
  renders its own contributor section with avatars outside the release body.
- Put the additional-language area after that details block inside one
  collapsed outer `<details>` block with the plain summary
  `繁體中文 · 한국어 · 日本語`.
- Put Traditional Chinese, Korean, and Japanese in three separate nested
  collapsed `<details>` blocks. Each block has its own language heading and
  translated update heading.
- Keep the locale marker content inside the matching language block. The app
  updater reads these five marker pairs: `en`, `zh`, `zh-TW`, `ko`, and `ja`.
- Keep each language's download content with its corresponding release-note
  section. The English and Simplified Chinese sections may retain their
  existing first-launch and other-notes details; keep translated downloads for
  the additional languages inside their own nested `<details>` blocks.

The outer summary is plain text rather than an anchor-navigation row. Do not
add a visible `其他語言` heading or duplicate the Full Changelog link inside
each language block.

## Skeleton

```markdown
## What's changed

<!-- app-update-notes:en:start -->
### Added
- ...

### Changed
- ...

### Improved
- ...

### Fixed
- ...
<!-- app-update-notes:en:end -->

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- ...

### 变更
- ...

### 改进
- ...

### 修复
- ...
<!-- app-update-notes:zh:end -->

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/vPREVIOUS...vCURRENT">vPREVIOUS...vCURRENT</a></summary>

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
