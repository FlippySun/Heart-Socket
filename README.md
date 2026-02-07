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

> HDS 是一个专为 Apple Watch 设计的心率广播 App，支持将心率数据实时推送到本地网络或云端。本插件支持**本地中继模式**连接。

#### 1. 准备工作
*   在 Apple Watch 上购买并安装 [Health Data Server](https://apps.apple.com/us/app/health-data-server/id1496042074)。
*   在 Mac 上下载 **HDS Overlay (Desktop)** 客户端（作为本地 WebSocket 中继服务器）：
    *   下载地址：[Rexios80/hds_overlay (GitHub)](https://github.com/Rexios80/hds_overlay/releases) 或 [pilo1337/Health-Data-Server-Overlay](https://github.com/pilo1337/Health-Data-Server-Overlay/releases)
    *   下载对应 macOS 版本并解压。

#### 2. 运行本地服务
1.  双击运行 HDS Overlay 应用。
2.  可能会弹出 macOS 安全警告，需在【系统偏好设置】->【安全性与隐私】中允许运行。
3.  应用启动后，它会在本地开启 WebSocket 服务，默认端口为 **3476**（这是数据传输端口，不是 8080）。

#### 3. 配置 Apple Watch
1.  确保 Apple Watch 与 Mac 连接在 **同一个 Wi-Fi 网络** 下。
2.  获取 Mac 的局域网 IP 地址（例如 `192.168.1.5`）。
3.  在 Apple Watch 打开 HDS App，进入设置。
4.  将 **Configuration** 目标地址设置为你 Mac 的 IP 和端口，格式为 `IP:Port`。
    *   例如：`192.168.1.5:3476`
5.  点击 Watch 上的 **Start** 按钮开始广播数据。HDS Overlay 界面上应该能看到心率数字跳动。

#### 4. 配置插件
在 VS Code 设置中配置：

```json
{
  "heartSocket.provider": "hds",
  "heartSocket.websocketUrl": "ws://localhost:3476"
}
```

注意：这里使用 `localhost` 即可，因为 VS Code 与 HDS Overlay 运行在同一台 Mac 上。

---

### 方案 2：HypeRate

> HypeRate 是另一款流行的心率直播工具，支持多种设备。

1.  注册 [HypeRate](https://www.hyperate.io) 账号。
2.  在 Apple Watch 上安装 HypeRate App，并在 App 中记下你的 **Session ID**（通常显示在屏幕上或 Widget URL 的末尾）。
3.  获取 **API Token**（通常需要开发者权限或联系官方获取，或抓包查看）。
    *   *注：如果你只能使用公开的 Widget URL，建议使用方案 4 自定义 WebSocket 尝试连接。*
4.  配置插件：

```json
{
  "heartSocket.provider": "hyperate",
  "heartSocket.apiToken": "YOUR_API_TOKEN",
  "heartSocket.sessionId": "YOUR_SESSION_ID"
}
```

---

### 方案 3：Pulsoid

> Pulsoid 支持广泛的可穿戴设备，拥有完善的 API。

1.  注册 [Pulsoid](https://pulsoid.net) 账号。
2.  安装 Pulsoid 手机 App 并连接你的心率设备（Apple Watch 用户需要安装 Pulsoid Watch App）。
3.  获取 **Access Token**：
    *   前往 [Pulsoid Developer Dashboard](https://pulsoid.net/oauth2/authorize?client_id=...&response_type=token&scope=data:heart_rate:read) （需构建 OAuth 流程或使用个人 Token 生成页）。
    *   权限 Scope 需要包含 `data:heart_rate:read`。
4.  配置插件：

```json
{
  "heartSocket.provider": "pulsoid",
  "heartSocket.apiToken": "YOUR_ACCESS_TOKEN"
}
```

---

### 方案 4：自定义 WebSocket (通用)

如果你有其他心率广播设备或自建服务，可以使用此模式。

需要一个 WebSocket 服务端，推送 JSON 格式或纯文本格式的心率数据。

配置示例：

```json
{
  "heartSocket.provider": "custom",
  "heartSocket.websocketUrl": "ws://192.168.1.10:8080",
  // 指定 JSON 中包含心率数值的字段路径，支持 . 分隔嵌套
  "heartSocket.heartRateJsonPath": "data.payload.bpm"
}
```

**支持的数据格式示例：**

1.  **纯数字**（直接发送 Text Frame）：
    ```
    75
    ```

2.  **简单 JSON**：
    ```json
    { "heartRate": 75 }
    ```
    配置 `heartRateJsonPath`: `"heartRate"`

3.  **嵌套 JSON**：
    ```json
    {
      "source": "apple-watch",
      "data": {
        "bpm": 75,
        "energy": 120
      }
    }
    ```
    配置 `heartRateJsonPath`: `"data.bpm"`

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
