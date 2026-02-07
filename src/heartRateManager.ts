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
import { getConfig, onConfigChange } from './config';
import { StatusBarManager } from './statusBarManager';
import { AlertManager } from './alertManager';
import { BaseProvider } from './providers/baseProvider';
import { HdsProvider } from './providers/hdsProvider';
import { HypeRateProvider } from './providers/hyperateProvider';
import { PulsoidProvider } from './providers/pulsoidProvider';
import { CustomProvider } from './providers/customProvider';
import { ConnectionStatus } from './types';
import type {
  HeartRateData,
  HeartSocketConfig,
  HeartRateStats,
  ProviderType,
} from './types';

/** 心率历史记录最大保留数量 */
const MAX_HISTORY_SIZE = 3600; // 约1小时（1条/秒）

export class HeartRateManager {
  private provider: BaseProvider | null = null;
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
   * 切换数据源
   */
  async switchProvider(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      {
        label: 'Health Data Server (HDS)',
        description: 'Apple Watch → WebSocket',
        detail: 'ws://localhost:8080',
        picked: this.config.provider === 'hds',
      },
      {
        label: 'HypeRate',
        description: '需要 API Token + Session ID',
        detail: 'wss://app.hyperate.io',
        picked: this.config.provider === 'hyperate',
      },
      {
        label: 'Pulsoid',
        description: '需要 Access Token',
        detail: 'wss://dev.pulsoid.net',
        picked: this.config.provider === 'pulsoid',
      },
      {
        label: '自定义 WebSocket',
        description: '连接到自定义 WebSocket 服务器',
        detail: '支持 JSON Path 配置',
        picked: this.config.provider === 'custom',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择心率数据源',
      title: 'Heart Socket - 切换数据源',
    });

    if (selected) {
      const providerMap: Record<string, ProviderType> = {
        'Health Data Server (HDS)': 'hds',
        'HypeRate': 'hyperate',
        'Pulsoid': 'pulsoid',
        '自定义 WebSocket': 'custom',
      };

      const newProvider = providerMap[selected.label];
      if (newProvider) {
        const wsConfig = vscode.workspace.getConfiguration('heartSocket');
        await wsConfig.update('provider', newProvider, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Heart Socket: 已切换到 ${selected.label}`);
      }
    }
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
  private createProvider(type: ProviderType): BaseProvider {
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
  private bindProviderEvents(provider: BaseProvider): void {
    provider.on('heartRate', (data: HeartRateData) => {
      this.onHeartRate(data);
    });

    provider.on('statusChange', (status: ConnectionStatus) => {
      this.onStatusChange(status);
    });

    provider.on('error', (error: Error) => {
      this.log(`错误: ${error.message}`);
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

    // 更新状态栏
    this.statusBar.updateHeartRate(data);

    // 检查告警
    this.alertManager.check(data);

    // 日志
    this.log(`❤️ ${data.bpm} BPM (${data.source})`);
  }

  /**
   * 处理连接状态变化
   */
  private onStatusChange(status: ConnectionStatus): void {
    this.statusBar.updateStatus(status);

    const labels: Record<string, string> = {
      disconnected: '已断开',
      connecting: '连接中...',
      connected: '已连接',
      reconnecting: '重连中...',
      error: '连接错误',
    };

    this.log(`状态: ${labels[status] ?? status}`);

    if (status === ConnectionStatus.Connected) {
      vscode.window.showInformationMessage(`Heart Socket: 已连接到 ${this.provider?.name}`);
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
  <div class="footer">
    Heart Socket - Apple Watch Heart Rate Monitor for VS Code
  </div>
</body>
</html>`;
  }
}
