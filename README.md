# 💓 Heart Socket

> Apple Watch 心率实时监测 VSCode 插件

在 VS Code 状态栏实时显示 Apple Watch 心率数据，支持多种数据源。

---

## ✨ 功能特性

- **实时心率显示** — 状态栏显示当前心率 BPM + 心跳动画
- **多种健康数据** — 心率、卡路里、步数、血氧、距离、速度等一目了然
- **心率区间变色** — 根据心率自动切换颜色（蓝/绿/黄/橙/红）
- **多数据源支持** — HDS 本地直连 / HypeRate / Pulsoid / 自定义 WebSocket
- **智能告警** — 高心率/低心率弹窗提醒，可配置阈值和冷却时间
- **自动重连** — 网络断开后指数退避自动重连
- **心率统计** — 查看当前、最低、最高、平均心率和监测时长
- **网络变化检测** — WiFi/IP 变化时自动弹窗提醒，引导更新 Watch 地址
- **⌨️ 敲代码强度** — 基于手腕加速度实时分析打字强度（💤⌨️⚡🔥🚀 五级指示），状态栏常驻显示
- **🪑 久坐提醒** — 步数 + 加速度综合判断，超过阈值弹窗提醒（默认 45 分钟）
- **🖐️ 姿态感知** — 检测抬手/摸鱼姿势，持续超时定时弹框提醒（默认 30 秒）
- **🎯 心流检测** — 稳定打字 + 稳定心率超过 15 分钟自动识别心流状态
- **🐟 摸鱼指数** — 综合姿态、打字强度、久坐时长的摸鱼评分（0-100）
- **🔋 精力水平** — 基于心率趋势、活动量、时段的精力评估

## 📦 安装

### 从源码安装（开发模式）

```bash
cd Heart-Socket
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动扩展开发宿主。

### 从 VSIX 安装

```bash
npm run package
# 生成 heart-socket-x.x.x.vsix
code --install-extension heart-socket-*.vsix
```

## 🔌 数据源配置

### 方案 1：HDS 本地连接 — 推荐 ⭐⭐

> **零中间件，Apple Watch 直连 VSCode！** 插件内置 HTTP Server，HDS Watch App 直接推送心率数据到插件，无需安装任何桌面端软件。

#### 只需 3 步：

**① 安装 Watch App**

在 Apple Watch 上购买并安装 [Health Data Server](https://apps.apple.com/us/app/health-data-server/id1496042074)（需 watchOS 8+）。

**② 在 VSCode 中启动**

按 `Cmd+Shift+P` → 输入 `Heart Socket: Connect` → 选择 **"💓 HDS (Apple Watch 本地直连)"** → 插件自动启动 HTTP Server（默认端口 `8580`）。

启动后状态栏会显示 `♡ 等待设备连接...`，同时 VSCode 会打开 **引导面板** 显示服务器地址。

**③ 配置 Apple Watch**

1. 确保 Apple Watch 与 Mac 在 **同一个 Wi-Fi 网络**。
2. 打开 Watch 上的 HDS App → **关闭 HDS Cloud 开关**。
3. **打开 Advanced IP entry 开关**（否则无法输入 http 等英文字符）。
4. 在 Overlay IDs 输入框中填入引导面板中显示的地址：

   **🏠 Bonjour 地址（切换 WiFi 无需修改）：**
   ```
   http://MacBook-Air.local:8580/
   ```
   > ⚠️ 需确保 Watch 直连 WiFi — 请在 iPhone 上**关闭蓝牙**或开启**飞行模式**，否则 .local 无法解析（Watch 通过 iPhone 蓝牙桥接时 mDNS 多播包会被丢弃）。

   **🔌 IP 地址（任何模式可用）：**
   ```
   http://192.168.x.x:8580/
   ```
   > ⚠️ 切换 WiFi 后 IP 会改变，VSCode 会自动弹窗提醒您更新地址。

   > ⚠️ **URL 必须以 `http://` 开头并以 `/` 结尾**，否则 Watch 会显示 **"Bad URL"** 错误。

5. 点击 Watch 上的 **Start** 按钮 → VSCode 状态栏立即显示实时心率 ♥ 🎉

#### ⚠️ 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Watch 显示 **"Bad URL"** | URL 格式不正确 | 必须使用完整格式 `http://xxx:8580/`，**不能省略 `http://` 和末尾 `/`** |
| Watch 显示 **"重连中"** | Watch 和 Mac 不在同一网络 | 确保 Watch 和 Mac 连接同一个 Wi-Fi |
| `.local` 地址连不上 | Watch 通过 iPhone 蓝牙桥接上网 | 在 iPhone 上**关闭蓝牙**或开启**飞行模式**，让 Watch 直连 WiFi |
| 切换 WiFi 后 IP 连不上 | Mac IP 地址变了 | VSCode 会自动弹窗提醒，点击「查看新地址」获取最新 IP |
| 无法输入 http 字符 | HDS 默认键盘不支持英文 | 打开 HDS App 的 **Advanced IP entry** 开关 |

#### 可选配置

```json
{
  "heartSocket.provider": "hds",
  "heartSocket.serverPort": 8580
}
```

> **💡 提示**：如果端口 8580 被占用，可以在设置中修改 `heartSocket.serverPort`，Watch App 中的端口也需要同步修改。

---

### 方案 2：Pulsoid — 免费替代

> Pulsoid 免费、原生支持 Apple Watch，通过云端中转心率数据。

#### 只需 3 步：

**① 注册 + 安装**

1. 注册 [Pulsoid](https://pulsoid.net) 账号。
2. 在 iPhone 上安装 [Pulsoid iOS App](https://apps.apple.com/app/pulsoid/id1524269977)（Watch App 会自动同步安装）。
3. 在 Pulsoid App 中登录账号，打开 Watch 上的 Pulsoid App 开始心率广播。

**② 获取 Token**

打开 [Pulsoid Token 页面](https://pulsoid.net/ui/keys) → 生成一个 Token → 复制。

> 💡 **更简单的方式**：在 VSCode 中按 `Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择 Pulsoid → 插件会自动引导你打开 Token 页面并输入。

**③ 连接**

`Cmd+Shift+P` → `Heart Socket: Connect` → 完成 🎉

#### ⚠️ Motion 功能兼容性说明

Pulsoid 数据源仅提供 **心率 BPM**，不支持 Motion 传感器数据（加速度、姿态、步数）。插件会使用 **编辑器活动（字符数/秒）** 作为兼容回退方案，让 Pulsoid 也能使用上层 Motion 功能：

| 功能 | HDS (Motion) | Pulsoid (Editor 回退) | 说明 |
|------|-------------|----------------------|------|
| ⌨️ 敲代码强度 | ✅ 加速度传感器 | ✅ 字符数/秒 | Pulsoid 通过编辑器活动估算 |
| 🪑 久坐提醒 | ✅ 步数+加速度 | ✅ 编辑器活动 | 基于编辑器空闲时长判断 |
| 🖐️ 姿态感知 | ✅ Motion 传感器 | ⚠️ 默认 'typing' | Pulsoid 无姿态数据 |
| 🎯 心流检测 | ✅ 心率+Motion | ✅ 心率+编辑器 | 可用但准确度略低 |
| 🐟 摸鱼指数 | ✅ 完整数据 | ✅ 无姿态数据 | 仅评估打字强度+久坐 |
| 🔋 精力水平 | ✅ 心率+Motion | ✅ 心率+编辑器 | 可用但准确度略低 |

> **⚠️ 编辑器活动回退方案的局限性：**
> - 仅检测 **VS Code 文本编辑事件**（插入/删除字符）
> - **无法检测**：AI 代码生成、阅读文档、浏览网页、终端操作、调试交互
> - **AI 辅助编程场景下结果会偏低**：当 AI 批量生成代码时，用户实际输入字符数很少
> - **推荐使用 HDS（方案 1）获得最准确的 Motion 数据分析**

---

### 方案 3：HypeRate — 付费 API

> ⚠️ HypeRate API 需要商业开发者权限（€1,900/年），仅适合已有 API Token 的用户。

如果你没有 HypeRate API Token，建议使用 **HDS（方案 1）** 或 **Pulsoid（方案 2）**。

已有 API Token 的用户：`Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择 HypeRate → 按引导输入 Token 和 Session ID。

#### ⚠️ Motion 功能兼容性说明

HypeRate 数据源的 Motion 功能支持情况与 **Pulsoid（方案 2）** 相同，请参考方案 2 的兼容性说明。

---

### 方案 4：自定义 WebSocket — 高级用户

> 连接任意 WebSocket 服务端，适合自建心率数据服务。

`Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择自定义 WebSocket → 按引导输入 WebSocket URL 和 JSON Path。

#### ⚠️ Motion 功能兼容性说明

自定义 WebSocket 数据源的 Motion 功能支持情况与 **Pulsoid（方案 2）** 相同，请参考方案 2 的兼容性说明。

**支持的数据格式：**

| 格式 | 示例 | JSON Path 配置 |
|------|------|---------------|
| 纯数字 | `75` | 留空（自动识别为心率） |
| 简单 JSON | `{"heartRate": 75}` | `heartRate` |
| 嵌套 JSON | `{"data": {"bpm": 75}}` | `data.bpm` |
| 多字段 JSON | `{"hr": 75, "cal": 120, "steps": 5000}` | 分别配置各字段路径 |

#### 🎯 多字段数据支持

除了心率，Custom WebSocket 还支持从同一条 JSON 消息中提取多种健康数据，对齐 HDS 方案的数据能力：

| 数据类型 | 配置项 | 示例值 | 校验规则 |
|---------|--------|--------|----------|
| ❤️ 心率 | `heartRateJsonPath` | `"data.hr"` | 20-250 BPM |
| 🔥 卡路里 | `caloriesJsonPath` | `"data.calories"` | ≥ 0 |
| 👟 步数 | `stepCountJsonPath` | `"data.steps"` | ≥ 0 且为整数 |
| 🩺 血氧 | `bloodOxygenJsonPath` | `"data.spo2"` | 0-100 |
| 📏 距离 | `distanceJsonPath` | `"data.distance"` | ≥ 0 |
| 🏃 速度 | `speedJsonPath` | `"data.speed"` | ≥ 0 |

**配置示例：**

```json
{
  "heartSocket.provider": "custom",
  "heartSocket.websocketUrl": "ws://192.168.1.100:9090",
  "heartSocket.heartRateJsonPath": "data.heartRate",
  "heartSocket.caloriesJsonPath": "data.calories",
  "heartSocket.stepCountJsonPath": "data.steps",
  "heartSocket.bloodOxygenJsonPath": "data.spo2"
}
```

对应的 WebSocket 消息格式：

```json
{
  "data": {
    "heartRate": 75,
    "calories": 120,
    "steps": 5000,
    "spo2": 98
  }
}
```

> 💡 **提示**：所有健康数据字段配置项默认为空，留空表示不启用该字段提取。只需配置你的 WebSocket 服务端实际发送的字段即可。

## ⚙️ 全部配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `heartSocket.provider` | enum | `hds` | 数据源类型 |
| `heartSocket.serverPort` | number | `8580` | HDS 模式 WebSocket Server 监听端口 |
| `heartSocket.websocketUrl` | string | `ws://localhost:8080` | WebSocket 地址（HypeRate/Pulsoid/自定义） |
| `heartSocket.apiToken` | string | `""` | API Token |
| `heartSocket.sessionId` | string | `""` | Session ID (HypeRate) |
| `heartSocket.autoConnect` | boolean | `false` | 启动时自动连接 |
| `heartSocket.alertHighBpm` | number | `150` | 高心率告警阈值 |
| `heartSocket.alertLowBpm` | number | `50` | 低心率告警阈值 |
| `heartSocket.alertCooldown` | number | `60` | 告警冷却时间（秒） |
| `heartSocket.heartRateJsonPath` | string | `heartRate` | 自定义数据源心率字段 JSON 路径 |
| `heartSocket.caloriesJsonPath` | string | `""` | 自定义数据源卡路里字段 JSON 路径（留空不启用） |
| `heartSocket.stepCountJsonPath` | string | `""` | 自定义数据源步数字段 JSON 路径（留空不启用） |
| `heartSocket.bloodOxygenJsonPath` | string | `""` | 自定义数据源血氧字段 JSON 路径（留空不启用） |
| `heartSocket.distanceJsonPath` | string | `""` | 自定义数据源距离字段 JSON 路径（留空不启用） |
| `heartSocket.speedJsonPath` | string | `""` | 自定义数据源速度字段 JSON 路径（留空不启用） |
| `heartSocket.statusBarPosition` | enum | `left` | 状态栏位置 |
| `heartSocket.showHeartbeatAnimation` | boolean | `true` | 心跳动画 |
| `heartSocket.zones` | object | `{rest:60,...}` | 心率区间阈值 |
| `heartSocket.enableMotion` | boolean | `true` | 启用 Motion 传感器数据分析（需 HDS） |
| `heartSocket.sedentaryMinutes` | number | `45` | 久坐提醒阈值（分钟，10-120） |
| `heartSocket.postureAlertSeconds` | number | `30` | 不良姿态提醒阈值（秒，10-300） |
| `heartSocket.showCodingIntensity` | boolean | `true` | 状态栏显示敲代码强度图标 |
| `heartSocket.showFlowState` | boolean | `true` | tooltip 显示心流状态 |
| `heartSocket.showSlackingIndex` | boolean | `true` | tooltip 显示摸鱼指数 |

## 🎮 命令

| 命令 | 说明 |
|------|------|
| `Heart Socket: Connect` | 连接心率监测 |
| `Heart Socket: Disconnect` | 断开连接 |
| `Heart Socket: Switch Provider` | 切换数据源 |
| `Heart Socket: Show Heart Rate Stats` | 显示心率统计 |

## 🎨 心率区间颜色

| 区间 | BPM 范围 | 颜色 | 说明 |
|------|----------|------|------|
| 偏低 | < 50 | 🔵 蓝色 | 低于告警阈值 |
| 静息 | 50-60 | 🔵 蓝色 | 静息状态 |
| 正常 | 60-100 | 🟢 绿色 | 正常范围 |
| 中等 | 100-140 | 🟡 黄色 | 中等运动强度 |
| 高强度 | 140-170 | 🟠 橙色 | 高强度运动 |
| 极高 | > 170 | 🔴 红色 | 需要注意 |

## 🏗 架构

```
src/
├── extension.ts          # 插件入口
├── types.ts              # 类型定义
├── config.ts             # 配置管理
├── webSocketClient.ts    # WebSocket 客户端（含自动重连）
├── motionAnalyzer.ts     # Motion 数据深度分析引擎（双数据源）
├── editorActivityTracker.ts  # 编辑器活动追踪（Motion 兼容回退方案）
├── providers/
│   ├── baseProvider.ts   # 抽象基类（heartRate + healthData + log）
│   ├── hdsProvider.ts    # Health Data Server（本地直连 + Motion + 健康数据）
│   ├── hyperateProvider.ts # HypeRate (Phoenix Channel)
│   ├── pulsoidProvider.ts  # Pulsoid
│   └── customProvider.ts   # 自定义 WebSocket（多字段 JSON Path 提取）
├── statusBarManager.ts   # 状态栏 UI（心率 + 敲代码强度）
├── alertManager.ts       # 告警通知
└── heartRateManager.ts   # 核心管理器（协调 Motion 分析器）
```

### Motion 数据流

```
Apple Watch (HDS App)
    │ motion:{accelerometer, gravity, rotationRate, attitude}
    ▼
hdsProvider.ts          ── 解析 JSON/CSV 格式 Motion 数据
    │ emit 'motionData'
    ▼
heartRateManager.ts     ── 转发数据 + 协调各模块
    │ feedMotion / feedHeartRate / feedStepCount
    ▼
motionAnalyzer.ts       ── 滑动窗口算法引擎（3s 窗口，1s 输出）
    │ emit 'codingIntensityChange' / 'analysisResult' / 'sedentaryAlert' / 'postureAlert' / 'flowStateChange'
    ▼
statusBarManager.ts     ── 状态栏图标 + tooltip 显示
heartRateManager.ts     ── 弹窗告警（久坐/姿态/心流）
```

## 📄 License

MIT
