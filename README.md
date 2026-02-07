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

### 方案 1：Health Data Server (HDS) — 推荐 ⭐

> **零中间件，Apple Watch 直连 VSCode！** 插件内置 WebSocket Server，HDS Watch App 直接推送心率数据到插件，无需安装任何桌面端软件。

#### 只需 3 步：

**① 安装 Watch App**

在 Apple Watch 上购买并安装 [Health Data Server](https://apps.apple.com/us/app/health-data-server/id1496042074)（需 watchOS 8+）。

**② 在 VSCode 中启动**

按 `Cmd+Shift+P` → 输入 `Heart Socket: Connect` → 插件自动启动 WebSocket Server（默认端口 `8580`）。

启动后状态栏会显示 `♡ 等待设备连接...`，同时弹出提示告知监听端口。

**③ 配置 Apple Watch**

1. 确保 Apple Watch 与 Mac 在 **同一个 Wi-Fi 网络**。
2. 获取 Mac 的局域网 IP（终端运行 `ifconfig | grep "inet " | grep -v 127.0.0.1`，或在**系统偏好设置 → Wi-Fi → 详细信息**中查看）。
3. 打开 Watch 上的 HDS App → 设置目标地址为 `你的Mac IP:8580`（例如 `192.168.1.5:8580`）。
4. 点击 Watch 上的 **Start** 按钮 → VSCode 状态栏立即显示实时心率 ♥ 🎉

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

---

### 方案 3：HypeRate — 付费 API

> ⚠️ HypeRate API 需要商业开发者权限（€1,900/年），仅适合已有 API Token 的用户。

如果你没有 HypeRate API Token，建议使用 **HDS（方案 1）** 或 **Pulsoid（方案 2）**。

已有 API Token 的用户：`Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择 HypeRate → 按引导输入 Token 和 Session ID。

---

### 方案 4：自定义 WebSocket — 高级用户

> 连接任意 WebSocket 服务端，适合自建心率数据服务。

`Cmd+Shift+P` → `Heart Socket: Switch Provider` → 选择自定义 WebSocket → 按引导输入 WebSocket URL 和 JSON Path。

**支持的数据格式：**

| 格式 | 示例 | JSON Path 配置 |
|------|------|---------------|
| 纯数字 | `75` | 留空 |
| 简单 JSON | `{"heartRate": 75}` | `heartRate` |
| 嵌套 JSON | `{"data": {"bpm": 75}}` | `data.bpm` |

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
