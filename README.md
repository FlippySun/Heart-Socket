# 💓 Heart Socket

<p align="center">
  <strong>在 VS Code 状态栏实时显示 Apple Watch 心率，专为开发者设计的健康监测插件</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=flippysun.heart-socket"><img src="https://img.shields.io/visual-studio-marketplace/v/flippysun.heart-socket?style=flat-square&label=VS%20Code%20Marketplace" alt="Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=flippysun.heart-socket"><img src="https://img.shields.io/visual-studio-marketplace/i/flippysun.heart-socket?style=flat-square" alt="Installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=flippysun.heart-socket"><img src="https://img.shields.io/visual-studio-marketplace/r/flippysun.heart-socket?style=flat-square" alt="Rating"></a>
  <a href="https://github.com/FlippySun/Heart-Socket/blob/main/LICENSE"><img src="https://img.shields.io/github/license/FlippySun/Heart-Socket?style=flat-square" alt="License"></a>
</p>

<!-- 🖼️ 在此处放置功能截图或 GIF 动图 -->
<!-- ![Heart Socket Demo](images/demo.gif) -->

---

## ✨ 功能亮点

### 💓 核心功能
- **实时心率显示** — 状态栏 BPM 数值 + 心跳动画，一目了然
- **9 级心率区间** — 编程场景优化的细粒度划分，每个区间对应不同颜色
- **多种健康数据** — 心率、卡路里、步数、血氧、距离、速度、体重、BMI
- **智能告警** — 高/低心率弹窗提醒，可配置阈值和冷却时间

### 📊 数据与统计
- **心率统计面板** — 趋势图（1 分钟~12 小时时间尺度）、区间分布饼图、健康数据总览
- **📅 历史日历** — 月视图查看心率日报，持久化存储 90 天

### 🧠 Motion 智能分析（HDS 专属）
- **⌨️ 敲代码强度** — 基于手腕加速度分析打字强度（💤⌨️⚡🔥🚀 五级）
- **🖐️ 姿态识别** — 5 种姿态：😴 静息 / ⌨️ 打字 / 🖱️ 鼠标 / 💪 活动 / 🚶 走动
- **🪑 久坐提醒** — 步数 + 加速度综合判断，超阈值弹窗提醒
- **🎯 心流检测** — 稳定打字 + 稳定心率 15 分钟以上自动识别
- **🐟 摸鱼指数** — 综合姿态、打字强度、久坐时长（0-100 评分）
- **🔋 精力水平** — 基于心率趋势、活动量、时段的精力评估

### 🔌 多数据源
- **HDS 本地直连** ⭐ — Apple Watch → WiFi → VS Code，零配置
- **Pulsoid** — 免费云端方案
- **HypeRate** — 商业 API 方案
- **自定义 WebSocket** — 连接任意心率数据源

### 🛡️ 稳定可靠
- **自动重连** — 断网后指数退避自动重连
- **网络变化检测** — WiFi/IP 变化时自动弹窗提醒
- **端口冲突处理** — 端口被占用时自动引导配置

## 📦 安装

### 从 VS Code 扩展市场安装（推荐）

1. 打开 VS Code
2. 按 `Cmd+Shift+X` 打开扩展面板
3. 搜索 **Heart Socket**
4. 点击 **安装**

### 从 VSIX 安装

```bash
npm run package
code --install-extension heart-socket-*.vsix
```

## 🔌 快速开始

### 方案 1：HDS 本地直连 ⭐ 推荐

> **零中间件，Apple Watch → WiFi → VS Code 直连！**

**① 安装 Watch App**
在 Apple Watch 上安装 [Health Data Server](https://apps.apple.com/us/app/health-data-server/id1496042074)（需 watchOS 8+）。

**② 在 VS Code 中启动**
`Cmd+Shift+P` → `Heart Socket: Connect` → 选择 **HDS** → 插件自动启动服务器。

**③ 配置 Apple Watch**
1. 确保 Watch 与 Mac 在**同一 WiFi**
2. 打开 HDS App → **关闭 HDS Cloud**，**打开 Advanced IP entry**
3. 在 Overlay IDs 中填入地址（格式 `http://xxx:8580/`，**必须含 `http://` 和末尾 `/`**）
4. 点击 **Start** → 完成 🎉

> 💡 推荐使用 Bonjour 地址（如 `http://MacBook-Air.local:8580/`），切换 WiFi 无需修改。  
> ⚠️ 使用 `.local` 地址时需确保 Watch 直连 WiFi（iPhone 关闭蓝牙或开启飞行模式）。

<details>
<summary>📋 常见问题</summary>

| 问题 | 解决方案 |
|------|---------|
| Watch 显示 **"Bad URL"** | URL 必须以 `http://` 开头、`/` 结尾 |
| `.local` 连不上 | iPhone 关闭蓝牙，让 Watch 直连 WiFi |
| 切换 WiFi 后连不上 | VS Code 会自动弹窗提醒新地址 |
| 无法输入 http 字符 | 打开 HDS 的 **Advanced IP entry** 开关 |

</details>

---

### 方案 2：Pulsoid（免费云端）

1. 注册 [Pulsoid](https://pulsoid.net)，安装 iOS + Watch App
2. `Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择 Pulsoid → 按引导输入 Token
3. `Cmd+Shift+P` → `Heart Socket: Connect` → 完成 🎉

> ⚠️ Pulsoid 仅提供心率数据，Motion 功能通过编辑器活动回退方案实现。

---

### 方案 3：HypeRate / 自定义 WebSocket

- **HypeRate**：需商业 API Token（€1,900/年），按引导输入 Token + Session ID
- **自定义 WebSocket**：连接任意服务端，支持多字段 JSON Path 提取

`Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择对应方案即可。

## ⚙️ 配置项

所有配置通过 VS Code 设置面板（`Cmd+,` → 搜索 `heartSocket`）修改。

<details>
<summary>📋 展开查看全部配置项</summary>

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `provider` | enum | `hds` | 数据源：hds / pulsoid / hyperate / custom |
| `serverPort` | number | `8580` | HDS 服务器端口 |
| `autoConnect` | boolean | `false` | VS Code 启动时自动连接 |
| `alertHighBpm` | number | `150` | 高心率告警阈值 |
| `alertLowBpm` | number | `50` | 低心率告警阈值 |
| `alertCooldown` | number | `60` | 告警冷却时间（秒） |
| `statusBarPosition` | enum | `left` | 状态栏位置 |
| `showHeartbeatAnimation` | boolean | `true` | 心跳动画 |
| `zones` | object | `{...}` | 心率区间阈值（9 级） |
| `enableMotion` | boolean | `true` | Motion 传感器分析 |
| `sedentaryMinutes` | number | `45` | 久坐提醒阈值（分钟） |
| `postureAlertSeconds` | number | `30` | 离开工位提醒阈值（秒） |
| `showCodingIntensity` | boolean | `true` | 状态栏敲代码强度图标 |
| `showFlowState` | boolean | `true` | tooltip 心流状态 |
| `showSlackingIndex` | boolean | `true` | tooltip 摸鱼指数 |

> 以上配置项前缀均为 `heartSocket.`，如 `heartSocket.provider`。

</details>

## 🎮 命令

| 命令 | 说明 |
|------|------|
| `Heart Socket: Connect` | 连接心率监测 |
| `Heart Socket: Disconnect` | 断开连接 |
| `Heart Socket: Switch Provider` | 切换数据源 |
| `Heart Socket: Show Heart Rate Stats` | 心率统计面板 |
| `Heart Socket: Quick Actions` | 快捷操作菜单 |

## 🎨 心率区间

> 针对开发者编程场景优化，在 50-120 BPM 静息范围内做了 9 级细粒度划分。

| 区间 | BPM | 颜色 | 编程状态 |
|------|-----|------|---------|
| ⚠️ 偏低 | < 50 | 🔵 | 低于告警阈值 |
| 😪 深度放松 | 50-58 | 🟣 | 深度休息 |
| 😴 放松 | 58-65 | 🔵 | 轻松浏览 |
| 😌 平静 | 65-72 | 🟢 | 阅读文档 |
| 🧘 轻度集中 | 72-80 | 🟢 | 思考设计 |
| 🧠 专注 | 80-90 | 🟣 | 深度编码 |
| 😰 紧张 | 90-105 | 🟡 | Debug |
| 😤 高压 | 105-120 | 🟠 | 赶 deadline |
| 🚨 异常 | > 120 | 🔴 | 需关注 |

## 🤝 贡献

欢迎 [提交 Issue](https://github.com/FlippySun/Heart-Socket/issues) 反馈 Bug 或功能建议。

## 📄 License

[MIT](LICENSE) © FlippySun
