## 2026-06-21: 为 Anchor 持久化添加测试

- **文件:** `tests/shared/collectorAnchorPersistence.test.js`
- **测试覆盖:**
  - configFingerprint 函数：标准化 whitespace、不同输入产生不同输出
  - configFingerprint 边界：undefined/empty 输入
  - Anchored tick 使用 todayOnly 并正确推导 month/allTime
