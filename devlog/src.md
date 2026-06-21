## 2026-06-21: Anchor 持久化 — 跨重启复用全量扫描快照

- **文件:** `src/shared/collector.js`
- **原因:** PR #23 审查反馈 #1/#4 — 启动时复用 anchor 避免全量 month/allTime 扫描，配置绑定防止使用过期 baseline
- **决策:**
  - Anchor 持久化到 `sharedDataDir()/collector-anchor.json`，全量扫描后写入，启动时读取
  - 配置绑定通过 `configFingerprint(clients, allTimeSince)` 实现，配置变化时 anchor 自动失效
  - Interval loop 在 anchor 有效时使用 `todayOnly`，避免每次都做 3 次全量扫描
  - Dir-skip 不做（作者建议 "drop the skip entirely"）
  - WSL 部分不动（上游 main 已经正确）
- **影响范围:** `src/shared/collector.js` — `configFingerprint` 新函数，`startCollector` 中 anchor 读写，`loop` 的 todayOnly 优化
- **安全分析:**
  - dateKey 校验确保跨日不用旧 anchor
  - fingerprint 校验确保配置变化时触发全量扫描
  - 文件写入失败时 try-catch 吞掉，内存 anchor 仍在，下次启动重新全量扫描
  - 文件损坏/不存在时 `readJson` 返回 null，降级为全量扫描
