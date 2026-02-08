# 贡献指南

感谢你对 Heart Socket 的关注！我们欢迎任何形式的贡献。

## 🚀 快速开始

### 开发环境搭建

1. **Fork** 本仓库并克隆到本地：

   ```bash
   git clone https://github.com/<your-username>/Heart-Socket.git
   cd Heart-Socket
   ```

2. 安装依赖：

   ```bash
   npm install
   ```

3. 启动开发模式：

   - 在 VS Code 中打开项目
   - 按 `F5` 启动扩展开发宿主（Extension Development Host）
   - 修改代码后，在开发宿主窗口按 `Ctrl+R`（Mac: `Cmd+R`）重新加载

4. 构建生产版本：

   ```bash
   npm run build
   ```

## 📝 如何贡献

### 报告 Bug

- 使用 [Bug Report](https://github.com/FlippySun/Heart-Socket/issues/new?template=bug_report.yml) 模板创建 Issue
- 请提供：VS Code 版本、操作系统、数据源类型、错误日志（`Heart Socket: Show Logs` 命令）

### 建议新功能

- 使用 [Feature Request](https://github.com/FlippySun/Heart-Socket/issues/new?template=feature_request.yml) 模板创建 Issue
- 描述你的使用场景和期望行为

### 提交代码

1. 从 `main` 分支创建新分支：

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. 编写代码并确保构建通过：

   ```bash
   npm run build
   ```

3. 提交更改（遵循 [Conventional Commits](https://www.conventionalcommits.org/)）：

   ```bash
   git commit -m "feat: 添加新功能描述"
   git commit -m "fix: 修复某个问题"
   git commit -m "docs: 更新文档"
   ```

4. 推送并创建 Pull Request

## 📐 代码规范

- **语言：** TypeScript（严格模式）
- **构建工具：** esbuild
- **提交信息格式：** [Conventional Commits](https://www.conventionalcommits.org/)
  - `feat:` 新功能
  - `fix:` Bug 修复
  - `docs:` 文档更新
  - `refactor:` 代码重构
  - `chore:` 构建/工具相关

## 📁 项目结构

```
src/
├── extension.ts          # 扩展入口
├── heartRateManager.ts   # 心率管理核心
├── statusBarManager.ts   # 状态栏 UI
├── statsPanel.ts         # 统计面板 WebView
├── dataSources/          # 数据源适配器
│   ├── hds.ts            # Health Data Server (Apple Watch)
│   ├── pulsoid.ts        # Pulsoid
│   ├── hyperate.ts       # HypeRate
│   └── custom.ts         # 自定义 WebSocket
└── types.ts              # 类型定义
```

## ❓ 有问题？

- 在 [Issues](https://github.com/FlippySun/Heart-Socket/issues) 中搜索或提问
- 在 [Discussions](https://github.com/FlippySun/Heart-Socket/discussions) 中参与讨论

感谢你的贡献！❤️
