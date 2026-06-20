# src 模块变更日志

## 2026-06-20: 提取启动加速功能到独立分支
- **文件:** `src/shared/collector.js`
- **原因:** 从 develop 分支提取启动加速相关改动到 feat/startup-optimization 分支，排除贴边隐藏/OpenCode 多账号等无关代码
- **决策:** 手动从 develop 分支的 collector.js 中识别并提取仅与启动加速相关的代码段，保持 WSL 代码完整（不属于启动加速范畴，不做删除）
- **改动:**
  - 锚点持久化：全量扫描结果保存到 `collector-anchor.json`，启动时加载并检查 dateKey 有效性
  - 目录时间戳缓存：`collectDirTimestamps()` 收集各客户端数据目录 mtime，排除自同步客户端，保存到 `collector-dirts.json`；启动时对比无变化则完全跳过 tokscale
  - 渐进式展示：`onProgress` 回调使 today 扫完即推送数据，不等 month/allTime
  - 同步修复：`maybeSyncCursor`/`maybeSyncAntigravity` 移到 `skipTokenscan` 判断之前，始终执行
  - 空锚点保护：`anchorHasData` 检查 `totalTokens > 0` 防止静默显示空数据
  - `loop()` 启动首 tick 根据锚点有效性决定 `todayOnly` 模式
  - 锚点 tick 后更新目录时间戳快照，锁定新基线
- **影响范围:** `src/shared/collector.js` 仅启动加速功能
