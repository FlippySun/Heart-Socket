# 💓 Heart Socket

> Apple Watch 心率实时监测 VSCode 插件

在 VS Code 状态栏实时显示 Apple Watch 心率数据，支持多种数据源。

---

## ✨ 功能特性

- **实时心率显示** — 状态栏显示当前心率 BPM + 心跳动画
- **心率区间变色** — 根据心率自动切换颜色（蓝/绿/黄/橙/红）
- **多数据源支持** — HDS / HypeRate / Pulsoid / 自定义 WebSocket
- **智能告警** — 高心率/低心率弹窗提醒，可配置阈值和冷却时间
- **自动重连** — 网络断开后指数退避自动重连
- **心率统计** — 查看当前、最低、最高、平均心率和监测时长

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

### 方案 1：Health Data Server (HDS) — 推荐

1. 在 Apple Watch 上安装 [Health Data Server](https://apps.apple.com/us/app/health-data-server/id1496042074)
2. 在 HDS App 中设置目标 IP 为你的 Mac IP 地址，端口 8080
3. 在 VS Code 设置中配置：

```json
{
  "heartSocket.provider": "hds",
  "heartSocket.websocketUrl": "ws://localhost:8080"
}
```

4. 按 `Cmd+Shift+P` → `Heart Socket: Connect`

### 方案 2：HypeRate

1. 注册 [HypeRate](https://www.hyperate.io) 账号并获取 API Token
2. 在 Apple Watch 上安装 HypeRate App
3. 配置：

```json
{
  "heartSocket.provider": "hyperate",
  "heartSocket.apiToken": "YOUR_API_TOKEN",
  "heartSocket.sessionId": "YOUR_SESSION_ID"
}
```

### 方案 3：Pulsoid

1. 注册 [Pulsoid](https://pulsoid.net) 账号并获取 Access Token
2. 配置：

```json
{
  "heartSocket.provider": "pulsoid",
  "heartSocket.apiToken": "YOUR_ACCESS_TOKEN"
}
```

### 方案 4：自定义 WebSocket

连接任意 WebSocket 服务器，通过 JSON Path 配置心率字段路径：

```json
{
  "heartSocket.provider": "custom",
  "heartSocket.websocketUrl": "ws://your-server:port",
  "heartSocket.heartRateJsonPath": "data.heart_rate"
}
```

支持的数据格式：
- 纯数字：`75`
- JSON：`{"heartRate": 75}`
- 嵌套 JSON：`{"data": {"heart_rate": 75}}`

## ⚙️ 全部配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `heartSocket.provider` | enum | `hds` | 数据源类型 |
| `heartSocket.websocketUrl` | string | `ws://localhost:8080` | WebSocket 地址 |
| `heartSocket.apiToken` | string | `""` | API Token |
| `heartSocket.sessionId` | string | `""` | Session ID (HypeRate) |
| `heartSocket.autoConnect` | boolean | `false` | 启动时自动连接 |
| `heartSocket.alertHighBpm` | number | `150` | 高心率告警阈值 |
| `heartSocket.alertLowBpm` | number | `50` | 低心率告警阈值 |
| `heartSocket.alertCooldown` | number | `60` | 告警冷却时间（秒） |
| `heartSocket.heartRateJsonPath` | string | `heartRate` | 自定义 JSON 路径 |
| `heartSocket.statusBarPosition` | enum | `left` | 状态栏位置 |
| `heartSocket.showHeartbeatAnimation` | boolean | `true` | 心跳动画 |
| `heartSocket.zones` | object | `{rest:60,...}` | 心率区间阈值 |

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
├── providers/
│   ├── baseProvider.ts   # 抽象基类
│   ├── hdsProvider.ts    # Health Data Server
│   ├── hyperateProvider.ts # HypeRate (Phoenix Channel)
│   ├── pulsoidProvider.ts  # Pulsoid
│   └── customProvider.ts   # 自定义 WebSocket
├── statusBarManager.ts   # 状态栏 UI
├── alertManager.ts       # 告警通知
└── heartRateManager.ts   # 核心管理器
```

## 📄 License

MIT
