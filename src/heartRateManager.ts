/**
 * Heart Socket - 核心管理器
 *
 * 协调所有模块的中央控制器：
 * - 创建和管理 Provider（数据源适配器）
 * - 协调 StatusBarManager、AlertManager
 * - 管理心率统计数据
 * - 处理配置变更
 */
import * as vscode from 'vscode';
import * as os from 'os';
import { getConfig, onConfigChange } from './config';
import { StatusBarManager } from './statusBarManager';
import { AlertManager } from './alertManager';
import { HdsProvider } from './providers/hdsProvider';
import { HypeRateProvider } from './providers/hyperateProvider';
import { PulsoidProvider } from './providers/pulsoidProvider';
import { CustomProvider } from './providers/customProvider';
import { ConnectionStatus } from './types';
import type {
  HeartRateData,
  HealthData,
  HealthSnapshot,
  HeartSocketConfig,
  HeartRateStats,
  ProviderType,
  IHeartRateProvider,
} from './types';

/** 心率历史记录最大保留数量 */
const MAX_HISTORY_SIZE = 3600; // 约1小时（1条/秒）

export class HeartRateManager {
  private provider: IHeartRateProvider | null = null;
  private statusBar: StatusBarManager;
  private alertManager: AlertManager;
  private config: HeartSocketConfig;
  private disposables: vscode.Disposable[] = [];

  // 心率统计
  private stats: HeartRateStats = {
    current: 0,
    min: Infinity,
    max: -Infinity,
    avg: 0,
    samples: 0,
    duration: 0,
    history: [],
  };
  private sessionStartTime: number = 0;
  private bpmSum: number = 0;

  // 健康数据快照（最新值）
  private healthSnapshot: HealthSnapshot = {};

  // 输出通道（日志）
  private outputChannel: vscode.OutputChannel;

  // Webview 面板单例引用
  private statsPanel: vscode.WebviewPanel | null = null;

  constructor() {
    this.config = getConfig();
    this.statusBar = new StatusBarManager(this.config);
    this.alertManager = new AlertManager(this.config);
    this.outputChannel = vscode.window.createOutputChannel('Heart Socket');

    // 监听配置变更
    const configDisposable = onConfigChange((newConfig) => {
      this.onConfigChanged(newConfig);
    });
    this.disposables.push(configDisposable);
  }

  /**
   * 连接心率监测
   */
  async connect(): Promise<void> {
    // 如果已有连接，先断开
    if (this.provider) {
      this.disconnect();
    }

    try {
      this.provider = this.createProvider(this.config.provider);
      this.bindProviderEvents(this.provider);
      this.resetStats();
      this.log(`正在连接到 ${this.provider.name}...`);
      this.provider.connect();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`连接失败: ${msg}`);
      vscode.window.showErrorMessage(`Heart Socket 连接失败: ${msg}`);
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.provider) {
      this.log('断开连接');
      this.provider.dispose();
      this.provider = null;
    }
    this.statusBar.updateStatus(ConnectionStatus.Disconnected);
  }

  /**
   * 切换数据源（引导式向导）
   */
  async switchProvider(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      {
        label: '$(heart) Health Data Server (HDS)',
        description: '⭐ 推荐 — Apple Watch 直连',
        detail: '插件内置 WebSocket Server，Watch 直连无需中间件，只需安装 HDS Watch App',
        picked: this.config.provider === 'hds',
      },
      {
        label: '$(pulse) Pulsoid',
        description: '免费 — 需要 Access Token',
        detail: '支持 Apple Watch / Android Watch / BLE 心率带，通过 Pulsoid 云端中转',
        picked: this.config.provider === 'pulsoid',
      },
      {
        label: '$(broadcast) HypeRate',
        description: '付费 API（€1,900/年）',
        detail: '适合已有 HypeRate API 开发者权限的用户',
        picked: this.config.provider === 'hyperate',
      },
      {
        label: '$(plug) 自定义 WebSocket',
        description: '高级 — 连接任意 WebSocket 服务器',
        detail: '自建心率服务或第三方数据源，支持 JSON Path 配置',
        picked: this.config.provider === 'custom',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择心率数据源',
      title: 'Heart Socket - 选择数据源',
    });

    if (!selected) {
      return;
    }

    // 从 label 中提取 provider 名称（去掉 codicon 前缀）
    const labelMap: Record<string, ProviderType> = {
      '$(heart) Health Data Server (HDS)': 'hds',
      '$(pulse) Pulsoid': 'pulsoid',
      '$(broadcast) HypeRate': 'hyperate',
      '$(plug) 自定义 WebSocket': 'custom',
    };

    const newProvider = labelMap[selected.label];
    if (!newProvider) {
      return;
    }

    // 引导式配置
    const configured = await this.guideProviderSetup(newProvider);
    if (!configured) {
      return;
    }

    // 保存 provider 选择
    const wsConfig = vscode.workspace.getConfiguration('heartSocket');
    await wsConfig.update('provider', newProvider, vscode.ConfigurationTarget.Global);

    // 询问是否立即连接
    const action = await vscode.window.showInformationMessage(
      `Heart Socket: 已配置 ${selected.description?.replace(/[⭐ ]/g, '').trim()}，是否立即连接？`,
      '立即连接',
      '稍后'
    );

    if (action === '立即连接') {
      await this.connect();
    }
  }

  // ─── 引导式配置向导 ─────────────────────────────

  /**
   * 根据 Provider 类型引导用户完成配置
   * @returns true 配置完成，false 用户取消
   */
  private async guideProviderSetup(type: ProviderType): Promise<boolean> {
    switch (type) {
      case 'hds':
        return this.guideHdsSetup();
      case 'pulsoid':
        return this.guidePulsoidSetup();
      case 'hyperate':
        return this.guideHypeRateSetup();
      case 'custom':
        return this.guideCustomSetup();
      default:
        return false;
    }
  }

  /**
   * HDS 引导 — 最简单，只需确认端口
   */
  private async guideHdsSetup(): Promise<boolean> {
    const port = await vscode.window.showInputBox({
      title: 'HDS — 配置监听端口',
      prompt: '插件将在此端口启动 WebSocket Server，Apple Watch 连接到此端口',
      value: String(this.config.serverPort),
      placeHolder: '8580',
      validateInput: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
          return '请输入 1024-65535 之间的端口号';
        }
        return null;
      },
    });

    if (port === undefined) {
      return false;
    }

    const wsConfig = vscode.workspace.getConfiguration('heartSocket');
    await wsConfig.update('serverPort', Number(port), vscode.ConfigurationTarget.Global);
    return true;
  }

  /**
   * Pulsoid 引导 — 打开 Token 页面 → 用户粘贴 Token
   */
  private async guidePulsoidSetup(): Promise<boolean> {
    // 如果已有 token，询问是否使用现有的
    if (this.config.apiToken) {
      const keep = await vscode.window.showQuickPick(
        [
          { label: '使用现有 Token', description: `${this.config.apiToken.substring(0, 8)}...` },
          { label: '重新获取 Token', description: '打开 Pulsoid 页面生成新 Token' },
        ],
        { title: 'Pulsoid — 已检测到 Access Token' }
      );

      if (!keep) {
        return false;
      }
      if (keep.label === '使用现有 Token') {
        return true;
      }
    }

    // 打开 Pulsoid Token 页面
    const openBrowser = await vscode.window.showInformationMessage(
      'Pulsoid: 需要获取 Access Token。点击"获取 Token"将打开浏览器，登录后复制你的 Token。',
      '获取 Token',
      '我已有 Token'
    );

    if (!openBrowser) {
      return false;
    }

    if (openBrowser === '获取 Token') {
      await vscode.env.openExternal(vscode.Uri.parse('https://pulsoid.net/ui/keys'));
    }

    // 等待用户输入 Token
    const token = await vscode.window.showInputBox({
      title: 'Pulsoid — 粘贴 Access Token',
      prompt: '从 Pulsoid 页面复制 Access Token 后粘贴到这里',
      placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      password: false,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v || v.trim().length < 10) {
          return 'Token 不能为空';
        }
        return null;
      },
    });

    if (!token) {
      return false;
    }

    const wsConfig = vscode.workspace.getConfiguration('heartSocket');
    await wsConfig.update('apiToken', token.trim(), vscode.ConfigurationTarget.Global);
    return true;
  }

  /**
   * HypeRate 引导 — 输入 API Token 和 Session ID
   */
  private async guideHypeRateSetup(): Promise<boolean> {
    // 提示费用门槛
    const proceed = await vscode.window.showWarningMessage(
      'HypeRate API 需要商业开发者权限（€1,900/年）。如果你没有 API Token，建议使用 HDS 或 Pulsoid 方案。',
      '我有 API Token',
      '返回选择'
    );

    if (proceed !== '我有 API Token') {
      return false;
    }

    // 输入 API Token
    const token = await vscode.window.showInputBox({
      title: 'HypeRate — 输入 API Token',
      prompt: '从 HypeRate 开发者后台获取的 API Token',
      value: this.config.apiToken || undefined,
      ignoreFocusOut: true,
      validateInput: (v) => (!v?.trim() ? 'Token 不能为空' : null),
    });

    if (!token) {
      return false;
    }

    // 输入 Session ID
    const sessionId = await vscode.window.showInputBox({
      title: 'HypeRate — 输入 Session ID',
      prompt: 'HypeRate Widget URL 末尾的几位字符（如 URL 是 app.hyperate.io/12ab，则填 12ab）',
      value: this.config.sessionId || undefined,
      ignoreFocusOut: true,
      validateInput: (v) => (!v?.trim() ? 'Session ID 不能为空' : null),
    });

    if (!sessionId) {
      return false;
    }

    const wsConfig = vscode.workspace.getConfiguration('heartSocket');
    await wsConfig.update('apiToken', token.trim(), vscode.ConfigurationTarget.Global);
    await wsConfig.update('sessionId', sessionId.trim(), vscode.ConfigurationTarget.Global);
    return true;
  }

  /**
   * 自定义 WebSocket 引导 — 输入 URL 和 JSON Path
   */
  private async guideCustomSetup(): Promise<boolean> {
    // 输入 WebSocket URL
    const url = await vscode.window.showInputBox({
      title: '自定义 WebSocket — 输入服务器地址',
      prompt: 'WebSocket 连接地址（ws:// 或 wss://）',
      value: this.config.websocketUrl || 'ws://localhost:8080',
      placeHolder: 'ws://192.168.1.10:8080',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v?.trim()) {
          return '地址不能为空';
        }
        if (!v.startsWith('ws://') && !v.startsWith('wss://')) {
          return '地址必须以 ws:// 或 wss:// 开头';
        }
        return null;
      },
    });

    if (!url) {
      return false;
    }

    // 输入 JSON Path
    const jsonPath = await vscode.window.showInputBox({
      title: '自定义 WebSocket — 心率字段路径',
      prompt: 'JSON 中心率数值的字段路径（用 . 分隔嵌套），如数据是纯数字则留空',
      value: this.config.heartRateJsonPath || 'heartRate',
      placeHolder: 'data.heart_rate',
      ignoreFocusOut: true,
    });

    if (jsonPath === undefined) {
      return false;
    }

    const wsConfig = vscode.workspace.getConfiguration('heartSocket');
    await wsConfig.update('websocketUrl', url.trim(), vscode.ConfigurationTarget.Global);
    if (jsonPath.trim()) {
      await wsConfig.update('heartRateJsonPath', jsonPath.trim(), vscode.ConfigurationTarget.Global);
    }
    return true;
  }

  /**
   * 显示心率统计
   */
  async showStats(): Promise<void> {
    if (this.stats.samples === 0) {
      vscode.window.showInformationMessage('Heart Socket: 暂无心率数据，请先连接数据源');
      return;
    }

    // 单例模式：如果面板已存在，更新内容并显示
    if (this.statsPanel) {
      this.statsPanel.webview.html = this.getStatsHtml();
      this.statsPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    // 创建新面板
    this.statsPanel = vscode.window.createWebviewPanel(
      'heartSocketStats',
      '💓 Heart Socket Stats',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );

    this.statsPanel.webview.html = this.getStatsHtml();

    // 监听面板关闭，清除引用
    this.statsPanel.onDidDispose(() => {
      this.statsPanel = null;
    });
  }

  /**
   * 获取当前统计数据
   */
  getStats(): HeartRateStats {
    return { ...this.stats };
  }

  /**
   * 销毁所有资源
   */
  dispose(): void {
    this.disconnect();
    this.statusBar.dispose();
    this.outputChannel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  // ─── 私有方法 ───────────────────────────────────

  /**
   * 创建 Provider 实例
   */
  private createProvider(type: ProviderType): IHeartRateProvider {
    switch (type) {
      case 'hds':
        return new HdsProvider(this.config);
      case 'hyperate':
        return new HypeRateProvider(this.config);
      case 'pulsoid':
        return new PulsoidProvider(this.config);
      case 'custom':
        return new CustomProvider(this.config);
      default:
        throw new Error(`不支持的数据源类型: ${type}`);
    }
  }

  /**
   * 绑定 Provider 事件
   */
  private bindProviderEvents(provider: IHeartRateProvider): void {
    provider.on('heartRate', (data: HeartRateData) => {
      this.onHeartRate(data);
    });

    provider.on('healthData', (data: HealthData) => {
      this.onHealthData(data);
    });

    provider.on('statusChange', (status: ConnectionStatus) => {
      this.onStatusChange(status);
    });

    provider.on('error', (error: Error) => {
      this.log(`错误: ${error.message}`);
    });

    provider.on('log', (msg: string) => {
      this.log(msg);
    });
  }

  /**
   * 处理心率数据
   */
  private onHeartRate(data: HeartRateData): void {
    // 更新统计
    this.stats.current = data.bpm;
    this.stats.min = Math.min(this.stats.min, data.bpm);
    this.stats.max = Math.max(this.stats.max, data.bpm);
    this.stats.samples++;
    this.bpmSum += data.bpm;
    this.stats.avg = Math.round(this.bpmSum / this.stats.samples);
    this.stats.duration = Date.now() - this.sessionStartTime;

    // 保存历史记录（环形缓冲）
    this.stats.history.push(data);
    if (this.stats.history.length > MAX_HISTORY_SIZE) {
      this.stats.history.shift();
    }

    // 更新状态栏（传递健康数据快照）
    this.statusBar.updateHeartRate(data, this.healthSnapshot);

    // 检查告警
    this.alertManager.check(data);

    // 日志
    this.log(`❤️ ${data.bpm} BPM (${data.source})`);
  }

  /**
   * 处理健康数据（卡路里、步数、血氧等）
   */
  private onHealthData(data: HealthData): void {
    // 更新健康数据快照
    this.healthSnapshot[data.type] = data.value;

    // 刷新状态栏 tooltip（携带最新健康数据）
    if (this.stats.current > 0) {
      this.statusBar.updateHealthSnapshot(this.healthSnapshot);
    }
  }

  /**
   * 处理连接状态变化
   */
  private onStatusChange(status: ConnectionStatus): void {
    this.statusBar.updateStatus(status);

    const labels: Record<string, string> = {
      disconnected: '已断开',
      connecting: '启动中...',
      connected: '已连接',
      reconnecting: this.config.provider === 'hds' ? '等待设备连接...' : '重连中...',
      error: '连接错误',
    };

    this.log(`状态: ${labels[status] ?? status}`);

    if (status === ConnectionStatus.Connected) {
      vscode.window.showInformationMessage(`Heart Socket: 已连接到 ${this.provider?.name}`);
    }

    // HDS Server 模式：服务启动后提示用户配置 Watch
    if (status === ConnectionStatus.Reconnecting && this.config.provider === 'hds') {
      const port = (this.provider as HdsProvider)?.port ?? this.config.serverPort;
      const hostname = this.getLocalHostname();
      const ip = this.getLocalIp();

      const localUrl = `http://${hostname}.local:${port}/`;
      const ipUrl = ip ? `http://${ip}:${port}/` : null;

      const lines = [
        `Heart Socket: 服务已启动（端口 ${port}）`,
        `\n推荐地址（切换WiFi无需修改）: ${localUrl}`,
      ];
      if (ipUrl) {
        lines.push(`备用地址: ${ipUrl}`);
      }
      lines.push(`\n请在 Watch HDS App 的 Overlay IDs 中输入以上地址并点击 Start`);

      vscode.window.showInformationMessage(lines.join('\n'));
    }
  }

  /**
   * 处理配置变更
   */
  private onConfigChanged(newConfig: HeartSocketConfig): void {
    const providerChanged = this.config.provider !== newConfig.provider;
    this.config = newConfig;

    this.statusBar.updateConfig(newConfig);
    this.alertManager.updateConfig(newConfig);

    if (this.provider) {
      this.provider.updateConfig(newConfig);
    }

    // 如果 Provider 类型变了且当前已连接，需要重新连接
    if (providerChanged && this.provider) {
      this.log(`数据源已切换到: ${newConfig.provider}，正在重新连接...`);
      this.connect();
    }
  }

  /**
   * 重置统计数据
   */
  private resetStats(): void {
    this.stats = {
      current: 0,
      min: Infinity,
      max: -Infinity,
      avg: 0,
      samples: 0,
      duration: 0,
      history: [],
    };
    this.bpmSum = 0;
    this.healthSnapshot = {};
    this.sessionStartTime = Date.now();
    this.alertManager.reset();
  }

  /**
   * 日志输出
   */
  private log(message: string): void {
    const time = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${time}] ${message}`);
  }

  /**
   * 获取本机 Bonjour hostname（去掉 .local 后缀）
   */
  private getLocalHostname(): string {
    let hostname = os.hostname();
    // macOS 的 os.hostname() 可能带 .local 后缀
    if (hostname.endsWith('.local')) {
      hostname = hostname.slice(0, -'.local'.length);
    }
    return hostname;
  }

  /**
   * 获取本机局域网 IPv4 地址
   */
  private getLocalIp(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        // 过滤：IPv4、非内部地址
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }

  /**
   * 格式化时长
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * 生成统计页面 HTML
   */
  private getStatsHtml(): string {
    const { current, min, max, avg, samples, duration } = this.stats;
    const durationStr = this.formatDuration(duration);
    const minDisplay = min === Infinity ? '--' : min;
    const maxDisplay = max === -Infinity ? '--' : max;

    // 构建健康数据卡片
    const healthCards: string[] = [];
    if (this.healthSnapshot.calories !== undefined) {
      healthCards.push(`
    <div class="stat-card">
      <div class="value">${this.healthSnapshot.calories}</div>
      <div class="label">🔥 卡路里 (kcal)</div>
    </div>`);
    }
    if (this.healthSnapshot.stepCount !== undefined) {
      healthCards.push(`
    <div class="stat-card">
      <div class="value">${this.healthSnapshot.stepCount}</div>
      <div class="label">👟 步数</div>
    </div>`);
    }
    if (this.healthSnapshot.bloodOxygen !== undefined) {
      healthCards.push(`
    <div class="stat-card">
      <div class="value">${this.healthSnapshot.bloodOxygen}%</div>
      <div class="label">🩸 血氧</div>
    </div>`);
    }
    if (this.healthSnapshot.distance !== undefined) {
      healthCards.push(`
    <div class="stat-card">
      <div class="value">${this.healthSnapshot.distance.toFixed(2)}</div>
      <div class="label">📏 距离 (km)</div>
    </div>`);
    }
    if (this.healthSnapshot.speed !== undefined) {
      healthCards.push(`
    <div class="stat-card">
      <div class="value">${this.healthSnapshot.speed.toFixed(1)}</div>
      <div class="label">⚡ 速度 (km/h)</div>
    </div>`);
    }

    const healthSection = healthCards.length > 0
      ? `<h2 style="text-align:center;margin-top:32px;margin-bottom:16px;opacity:0.7;">📊 健康数据</h2>
  <div class="stats-grid">${healthCards.join('')}
  </div>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Heart Socket Stats</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .header h1 {
      font-size: 28px;
      margin: 0;
    }
    .header .bpm {
      font-size: 64px;
      font-weight: bold;
      color: var(--vscode-charts-red, #e74c3c);
      margin: 16px 0;
    }
    .header .bpm-label {
      font-size: 18px;
      opacity: 0.7;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
      max-width: 600px;
      margin: 0 auto;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .stat-card .value {
      font-size: 32px;
      font-weight: bold;
      color: var(--vscode-foreground);
    }
    .stat-card .label {
      font-size: 12px;
      opacity: 0.6;
      margin-top: 4px;
      text-transform: uppercase;
    }
    .footer {
      text-align: center;
      margin-top: 32px;
      font-size: 12px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>💓 Heart Socket</h1>
    <div class="bpm">${current}</div>
    <div class="bpm-label">当前心率 (BPM)</div>
  </div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="value">${minDisplay}</div>
      <div class="label">最低心率</div>
    </div>
    <div class="stat-card">
      <div class="value">${maxDisplay}</div>
      <div class="label">最高心率</div>
    </div>
    <div class="stat-card">
      <div class="value">${avg}</div>
      <div class="label">平均心率</div>
    </div>
    <div class="stat-card">
      <div class="value">${samples}</div>
      <div class="label">采样次数</div>
    </div>
    <div class="stat-card">
      <div class="value">${durationStr}</div>
      <div class="label">监测时长</div>
    </div>
  </div>
  ${healthSection}
  <div class="footer">
    Heart Socket - Apple Watch Heart Rate Monitor for VS Code
  </div>
</body>
</html>`;
  }
}
