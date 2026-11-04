# System vitals

CPU 和内存以额度环样式显示在 Token Monitor 边缘停靠栏上，悬停卡片内附最近三分钟的负载曲线。

![Overview](docs/images/overview.png)

## Compatibility

- Token Monitor: ≥ 0.82.0（在 0.85.0 / macOS arm64 上实测）
- Platforms: macOS（内存读数来自 `vm_stat`，按"实际可用页"计算）；Windows/Linux 使用 `os.freemem()` 兜底，未实测

## Install

插件仓库：<https://github.com/swingmonkey/token-monitor-plugin-system-vitals>

从 [Releases](https://github.com/swingmonkey/token-monitor-plugin-system-vitals/releases) 页下载 `system-vitals-<version>.tmplugin`，然后在 Token Monitor 中：

1. 设置 → 插件 → 已安装 → 更多操作 → 导入包，选择下载的 `.tmplugin` 文件
2. 审查包内容与权限提示，选择「信任并安装并启用」（或「仅安装」稍后手动启用）
3. 首次启用时确认后台运行与放置位置（默认建议放入边缘停靠栏）
4. 在停靠栏编辑器（边缘停靠 → 添加）里把「CPU 圆环」「内存圆环」两个单元加入 rail，可排序

## Usage

- 两个独立视图：`CPU 圆环` 与 `内存圆环`，可分别放置、排序或移除
- Rail 单元：圆环弧长 = 占用率，环内为指标名，环下为百分比；≥70% 变橙，≥90% 变红
- 悬停卡片：大数字 + 最近约 3 分钟负载曲线（固定 0–100 轴）+ 时间窗标题；CPU 卡附负载均值，内存卡附 已用/总量
- 悬浮卡片与 rail 每 2 秒刷新

## Data and access

- 本机采样：CPU 通过 `os.cpus()` 差分；macOS 内存通过子进程调用系统自带 `vm_stat`（每 3 秒一次，1.5s 超时）
- 采样在插件的 Node 后端（Electron utility process）中进行，每 2 秒发布一次快照；开启后台运行后 Token Monitor 运行期间持续采样
- 不访问网络、不读取凭证、不向设备外发送任何数据；历史曲线（90 个采样点）仅保存在内存中

## Updates

发布与更新通过本仓库 GitHub Releases 提供（`system-vitals-<version>.tmplugin`，作者 swingmonkey）。更新需在应用内对新版本重新确认信任。回滚恢复代码，不回滚数据迁移。

## License and credits

MIT License · 作者 [swingmonkey](https://github.com/swingmonkey)。灵感与环形视觉语言来自 Token Monitor 内置的额度环。
