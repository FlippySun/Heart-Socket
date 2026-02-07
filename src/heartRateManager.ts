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
import { MotionAnalyzer } from './motionAnalyzer';
import { HdsProvider } from './providers/hdsProvider';
import { HypeRateProvider } from './providers/hyperateProvider';
import { PulsoidProvider } from './providers/pulsoidProvider';
import { CustomProvider } from './providers/customProvider';
import { ConnectionStatus } from './types';
import type {
  HeartRateData,
  HealthData,
  MotionData,
  MotionAnalysisResult,
  HealthSnapshot,
  HeartSocketConfig,
  HeartRateStats,
  ProviderType,
  IHeartRateProvider,
  CodingIntensityLevel,
  PostureState,
  FlowState,
} from './types';

/** 心率历史记录最大保留数量 */
const MAX_HISTORY_SIZE = 3600; // 约1小时（1条/秒）

export class HeartRateManager {
  private provider: IHeartRateProvider | null = null;
  private statusBar: StatusBarManager;
  private alertManager: AlertManager;
  private motionAnalyzer: MotionAnalyzer;
  private sedentaryReminderTimer: ReturnType<typeof setTimeout> | null = null;
  private config: HeartSocketConfig;
  private disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext;

  // 连接状态追踪
  private hasEverConnected: boolean = false;

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
  private guidePanel: vscode.WebviewPanel | null = null;

  // 网络变化监控（HDS 本地模式）
  private lastKnownIp: string | null = null;
  private networkMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly NETWORK_CHECK_INTERVAL = 15_000; // 15秒

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.config = getConfig();
    this.statusBar = new StatusBarManager(this.config);
    this.alertManager = new AlertManager(this.config);
    this.motionAnalyzer = new MotionAnalyzer(this.config);
    this.outputChannel = vscode.window.createOutputChannel('Heart Socket');

    // 绑定 MotionAnalyzer 事件
    this.bindMotionAnalyzerEvents();

    // 监听配置变更
    const configDisposable = onConfigChange((newConfig) => {
      this.onConfigChanged(newConfig);
    });
    this.disposables.push(configDisposable);
  }

  /**
   * 连接心率监测
   * 首次使用时引导用户选择数据源
   */
  async connect(): Promise<void> {
    // 首次使用：引导选择数据源
    const hasConfigured = this.context.globalState.get<boolean>('hasConfiguredProvider', false);
    if (!hasConfigured) {
      await this.switchProvider();
      return; // switchProvider 完成后会自动询问是否连接
    }

    // 如果已有连接，先断开
    if (this.provider) {
      this.disconnect();
    }

    try {
      this.hasEverConnected = false; // 重置连接标志
      this.provider = this.createProvider(this.config.provider);
      this.bindProviderEvents(this.provider);
      this.resetStats();
      this.log(`正在连接到 ${this.provider.name}...`);
      this.provider.connect();

      // HDS 本地模式：启动网络变化监控
      if (this.config.provider === 'hds') {
        this.startNetworkMonitor();
      }
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
    this.stopNetworkMonitor();
    if (this.provider) {
      this.log('断开连接');
      this.provider.dispose();
      this.provider = null;
    }
    this.hasEverConnected = false;
    this.statusBar.updateStatus(ConnectionStatus.Disconnected);
  }

  /**
   * 快速操作菜单（已连接时点击状态栏）
   */
  async quickActions(): Promise<void> {
    const isConnected = this.provider && this.provider.isConnected;
    const isActive = !!this.provider; // provider 已创建但可能还没连上

    if (!isActive) {
      // ── 未连接：右下角弹出模式选择 ──
      const action = await vscode.window.showInformationMessage(
        '💓 Heart Socket: 选择连接模式',
        'HDS 直连 (推荐)',
        '更多选项...'
      );

      if (!action) {
        return;
      }

      if (action === 'HDS 直连 (推荐)') {
        // 设置为 HDS 本地模式并连接
        const wsConfig = vscode.workspace.getConfiguration('heartSocket');
        await wsConfig.update('provider', 'hds', vscode.ConfigurationTarget.Global);
        await this.context.globalState.update('hasConfiguredProvider', true);
        await this.connect();
      } else if (action === '更多选项...') {
        // 弹出完整的 QuickPick 选择
        await this.switchProvider();
      }
      return;
    }

    // ── 已连接 / 正在连接：使用 QuickPick（功能多） ──
    const items: vscode.QuickPickItem[] = [
      {
        label: '$(graph) 查看心率统计',
        description: this.stats.samples > 0 ? `当前 ${this.stats.current} BPM` : '暂无数据',
      },
      {
        label: '$(debug-disconnect) 断开连接',
        description: this.provider?.name ?? '',
      },
      {
        label: '$(settings-gear) 切换数据源',
        description: `当前: ${this.getProviderLabel(this.config.provider)}`,
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Heart Socket — 选择操作',
    });

    if (!selected) {
      return;
    }

    if (selected.label.includes('查看心率统计')) {
      await this.showStats();
    } else if (selected.label.includes('断开连接')) {
      this.disconnect();
    } else if (selected.label.includes('切换数据源')) {
      await this.switchProvider();
    }
  }

  /**
   * 切换数据源（引导式向导）
   */
  async switchProvider(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      {
        label: '$(heart) Health Data Server (HDS)',
        description: '⭐⭐ 强烈推荐 — Apple Watch 本地直连',
        detail: '纯局域网通信，零延迟，不依赖互联网，需要同一 WiFi',
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

    // 标记已配置过（后续点击状态栏将直接连接）
    await this.context.globalState.update('hasConfiguredProvider', true);

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
    this.stopNetworkMonitor();
    this.disconnect();
    this.statusBar.dispose();
    this.outputChannel.dispose();
    if (this.guidePanel) {
      this.guidePanel.dispose();
      this.guidePanel = null;
    }
    // 清理 Motion 分析器
    if (this.motionAnalyzer) {
      this.motionAnalyzer.dispose();
    }
    // 清理久坐提醒定时器
    if (this.sedentaryReminderTimer) {
      clearTimeout(this.sedentaryReminderTimer);
      this.sedentaryReminderTimer = null;
    }
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

    provider.on('motionData', (data: MotionData) => {
      this.onMotionData(data);
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
   * 绑定 MotionAnalyzer 事件
   */
  private bindMotionAnalyzerEvents(): void {
    this.motionAnalyzer.on('codingIntensityChange', (level: CodingIntensityLevel) => {
      this.statusBar.updateCodingIntensity(level);
    });

    this.motionAnalyzer.on('analysisResult', (result: MotionAnalysisResult) => {
      this.statusBar.updateMotionAnalysis(result);
    });

    this.motionAnalyzer.on('sedentaryAlert', (data: { duration: number; highHeartRate: boolean }) => {
      this.showSedentaryAlert(data.duration, data.highHeartRate);
    });

    this.motionAnalyzer.on('postureAlert', (data: { duration: number; state: PostureState }) => {
      this.showPostureAlert(data.duration, data.state);
    });

    this.motionAnalyzer.on('flowStateChange', (state: FlowState) => {
      this.onFlowStateChange(state);
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

    // 转发到 Motion Analyzer（辅助心流检测）
    this.motionAnalyzer.feedHeartRate(data.bpm);

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

    // 步数数据转发到 Motion Analyzer（久坐检测）
    if (data.type === 'stepCount') {
      this.motionAnalyzer.feedStepCount(data.value);
    }
  }

  /**
   * 处理 Motion 数据
   */
  private onMotionData(data: MotionData): void {
    if (!this.config.enableMotion) { return; }
    // 转发到 Motion Analyzer
    this.motionAnalyzer.feedMotion(data);
  }

  /**
   * 处理连接状态变化
   */
  private onStatusChange(status: ConnectionStatus): void {
    // 区分首次等待连接 vs 断开后重连
    const isHds = this.config.provider === 'hds';
    const isWaitingForDevice = status === ConnectionStatus.Reconnecting && isHds && !this.hasEverConnected;

    this.statusBar.updateStatus(status, isWaitingForDevice ? { waitingForDevice: true } : undefined);

    const labels: Record<string, string> = {
      disconnected: '已断开',
      connecting: '启动中...',
      connected: '已连接',
      reconnecting: isWaitingForDevice ? '等待设备连接...' : '重连中...',
      error: '连接错误',
    };

    this.log(`状态: ${labels[status] ?? status}`);

    if (status === ConnectionStatus.Connected) {
      this.hasEverConnected = true;
      vscode.window.showInformationMessage(`Heart Socket: 已连接到 ${this.provider?.name}`);

      // 连接成功后关闭引导面板
      if (this.guidePanel) {
        this.guidePanel.dispose();
        this.guidePanel = null;
      }
    }

    // HDS 本地模式：等待设备连接时显示引导面板
    if (isWaitingForDevice && isHds) {
      this.showHdsGuide();
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

    // 更新 Motion 分析器配置
    if (this.motionAnalyzer) {
      this.motionAnalyzer.updateConfig({
        enableMotion: newConfig.enableMotion,
        sedentaryMinutes: newConfig.sedentaryMinutes,
        postureAlertSeconds: newConfig.postureAlertSeconds,
        showCodingIntensity: newConfig.showCodingIntensity,
        showFlowState: newConfig.showFlowState,
        showSlackingIndex: newConfig.showSlackingIndex,
      });
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
   * 获取本机 Bonjour LocalHostName（不含 .local 后缀）
   * 注意：使用 scutil 获取的是真正的 Bonjour 注册名，
   * 可能与系统偏好设置中的"电脑名称"不同
   */
  private getLocalHostname(): string | null {
    try {
      const { execSync } = require('child_process');
      const localHostName = execSync('scutil --get LocalHostName', { encoding: 'utf-8' }).trim();
      return localHostName || null;
    } catch (error) {
      return null;
    }
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

  // ─── Network Change Detection ─────────────────────────────────

  /**
   * 启动网络变化监控（仅 HDS 模式）
   * 每 15 秒检测一次本机 IP，若发生变化则提醒用户更新 Watch 地址
   */
  private startNetworkMonitor(): void {
    this.stopNetworkMonitor(); // 防止重复启动
    this.lastKnownIp = this.getLocalIp();
    this.networkMonitorTimer = setInterval(() => {
      const currentIp = this.getLocalIp();
      if (currentIp !== this.lastKnownIp) {
        const oldIp = this.lastKnownIp;
        this.lastKnownIp = currentIp;
        this.notifyIpChanged(oldIp, currentIp);
      }
    }, HeartRateManager.NETWORK_CHECK_INTERVAL);
  }

  /**
   * 停止网络变化监控
   */
  private stopNetworkMonitor(): void {
    if (this.networkMonitorTimer) {
      clearInterval(this.networkMonitorTimer);
      this.networkMonitorTimer = null;
    }
  }

  /**
   * IP 变化时通知用户
   */
  private notifyIpChanged(oldIp: string | null, newIp: string | null): void {
    const oldDisplay = oldIp ?? '未知';
    const newDisplay = newIp ?? '网络已断开';
    const message = newIp
      ? `⚠️ WiFi 网络已变化！IP: ${oldDisplay} → ${newDisplay}，请在 Apple Watch HDS App 中更新服务器地址。`
      : `⚠️ 网络连接已断开（原 IP: ${oldDisplay}），Apple Watch 将无法发送心率数据。`;

    vscode.window
      .showWarningMessage(message, '查看新地址')
      .then((action) => {
        if (action === '查看新地址') {
          this.showHdsGuide();
        }
      });

    this.log(`[NetworkMonitor] IP changed: ${oldDisplay} → ${newDisplay}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * 获取数据源显示名称
   */
  private getProviderLabel(type: ProviderType): string {
    const labels: Record<ProviderType, string> = {
      hds: 'HDS (Apple Watch 本地直连)',
      pulsoid: 'Pulsoid',
      hyperate: 'HypeRate',
      custom: '自定义 WebSocket',
    };
    return labels[type] ?? type;
  }

  /**
   * 打开 HDS 设备连接引导面板
   */
  private showHdsGuide(): void {
    const port = (this.provider as HdsProvider)?.port ?? this.config.serverPort;
    const hostname = this.getLocalHostname();
    const ip = this.getLocalIp();

    // 单例模式
    if (this.guidePanel) {
      this.guidePanel.webview.html = this.getHdsGuideHtml(port, hostname, ip);
      this.guidePanel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.guidePanel = vscode.window.createWebviewPanel(
      'heartSocketGuide',
      '💓 Heart Socket — 设备连接引导',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.guidePanel.webview.html = this.getHdsGuideHtml(port, hostname, ip);

    this.guidePanel.onDidDispose(() => {
      this.guidePanel = null;
    });
  }

  /**
   * 生成 HDS 引导页 HTML
   */
  private getHdsGuideHtml(port: number, hostname: string | null, ip: string | null): string {
    const localUrl = hostname ? `http://${hostname}.local:${port}/` : null;
    const ipUrl = ip ? `http://${ip}:${port}/` : null;

    const localSection = localUrl
      ? `
      <div class="url-section">
        <div class="url-label">🏠 Bonjour 地址 <span class="badge">切换 WiFi 无需修改</span></div>
        <div class="url-box">
          <code id="localUrl">${localUrl}</code>
          <button class="copy-btn" onclick="copyUrl('localUrl')">📋 复制</button>
        </div>
        <div class="url-hint">⚠️ 需确保 Watch 直连 WiFi — 请在 iPhone 上<strong>关闭蓝牙</strong>或开启<strong>飞行模式</strong>，否则 .local 无法解析</div>
      </div>`
      : '';

    const ipSection = ipUrl
      ? `
      <div class="url-section">
        <div class="url-label">🔌 IP 地址 <span class="badge secondary">任何模式可用</span></div>
        <div class="url-box">
          <code id="ipUrl">${ipUrl}</code>
          <button class="copy-btn" onclick="copyUrl('ipUrl')">📋 复制</button>
        </div>
        <div class="url-hint">⚠️ 切换 WiFi 后 IP 会改变，届时 VSCode 会弹窗提醒您更新地址</div>
      </div>`
      : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Heart Socket — 设备连接引导</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 32px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      max-width: 720px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      margin-bottom: 40px;
    }
    .header h1 {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .header .subtitle {
      font-size: 14px;
      opacity: 0.6;
    }
    .status-badge {
      display: inline-block;
      margin-top: 12px;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .url-section {
      margin-bottom: 24px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 12px;
      padding: 20px;
      background: var(--vscode-editorWidget-background);
    }
    .url-section.recommended {
      border-color: var(--vscode-charts-green, #4caf50);
      border-width: 2px;
    }
    .url-label {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-charts-green, #4caf50);
      color: white;
      font-weight: 500;
    }
    .badge.secondary {
      background: var(--vscode-charts-yellow, #ff9800);
    }
    .url-box {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .url-box code {
      flex: 1;
      font-size: 18px;
      font-weight: bold;
      padding: 12px 16px;
      border-radius: 8px;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-editorWidget-border);
      word-break: break-all;
      user-select: all;
    }
    .copy-btn {
      padding: 10px 18px;
      border: none;
      border-radius: 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 14px;
      white-space: nowrap;
      transition: opacity 0.2s;
    }
    .copy-btn:hover {
      opacity: 0.85;
    }
    .copy-btn.copied {
      background: var(--vscode-charts-green, #4caf50);
    }
    .url-hint {
      font-size: 12px;
      opacity: 0.6;
      line-height: 1.5;
    }
    .steps {
      margin-top: 32px;
    }
    .steps h2 {
      font-size: 18px;
      margin-bottom: 16px;
    }
    .step-list {
      list-style: none;
      counter-reset: step;
    }
    .step-list li {
      counter-increment: step;
      padding: 12px 16px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      font-size: 14px;
      line-height: 1.6;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .step-list li::before {
      content: counter(step);
      min-width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .faq {
      margin-top: 32px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      padding-top: 24px;
    }
    .faq h2 {
      font-size: 16px;
      margin-bottom: 12px;
      opacity: 0.8;
    }
    .faq-item {
      margin-bottom: 12px;
      padding: 10px 14px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      font-size: 13px;
      line-height: 1.6;
    }
    .faq-item strong {
      color: var(--vscode-charts-orange, #ff9800);
    }
    .footer {
      text-align: center;
      margin-top: 32px;
      font-size: 12px;
      opacity: 0.4;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>💓 Heart Socket</h1>
    <div class="subtitle">Apple Watch 心率实时监测</div>
    <div class="status-badge">⏳ 等待设备连接中...</div>
  </div>

  ${localSection}
  ${ipSection}

  <div class="steps">
    <h2>📋 配置步骤</h2>
    <ol class="step-list">
      <li>确保 Apple Watch 与 Mac 连接<strong>同一个 WiFi 网络</strong></li>
      <li>在 Apple Watch 上打开 <strong>HDS App</strong></li>
      <li>关闭 <strong>HDS Cloud</strong> 开关（如果有）</li>
      <li>打开 <strong>Advanced IP entry</strong> 开关（否则无法输入 http 等英文字符）</li>
      <li>在 <strong>Overlay IDs</strong> 输入框中 <strong>粘贴</strong> 上方复制的地址</li>
      <li>点击 <strong>Start</strong> 按钮 → VSCode 状态栏将显示实时心率 ♥</li>
    </ol>
  </div>

  <div class="faq">
    <h2>⚠️ 常见问题</h2>
    <div class="faq-item">
      <strong>🚫 Bad URL</strong> — URL 必须以 <code>http://</code> 开头且以 <code>/</code> 结尾，缺一不可
    </div>
    <div class="faq-item">
      <strong>🔄 .local 地址连不上</strong> — Watch 可能通过 iPhone 蓝牙桥接上网，mDNS 多播包被桥接层丢弃。<br>👉 解决：在 iPhone 上<strong>关闭蓝牙</strong>或开启<strong>飞行模式</strong>，让 Watch 直连 WiFi
    </div>
    <div class="faq-item">
      <strong>🔄 IP 地址连不上</strong> — 检查 Watch 和 Mac 是否在同一 WiFi；如果用了 VPN 请关闭
    </div>
    <div class="faq-item">
      <strong>📶 换了 WiFi / IP 变了</strong> — VSCode 会自动检测 IP 变化并弹窗提醒，点击「查看新地址」即可获取最新地址
    </div>
    <div class="faq-item">
      <strong>📱 没有 HDS App？</strong> — 在 App Store 搜索 <a href="https://apps.apple.com/us/app/health-data-server/id1496042074">Health Data Server</a>（需 watchOS 8+）
    </div>
  </div>

  <div class="footer">
    设备连接成功后，此面板会自动关闭 · 端口 ${port}
  </div>

  <script>
    function copyUrl(elementId) {
      const el = document.getElementById(elementId);
      if (!el) return;
      const text = el.textContent || '';
      navigator.clipboard.writeText(text).then(() => {
        const btns = el.parentElement?.querySelectorAll('.copy-btn');
        if (btns) {
          btns.forEach(btn => {
            btn.textContent = '✅ 已复制';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = '📋 复制';
              btn.classList.remove('copied');
            }, 2000);
          });
        }
      });
    }
  </script>
</body>
</html>`;
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

  // ============================================================================
  // Motion Analysis Handlers
  // ============================================================================

  private showSedentaryAlert(duration: number, highHeartRate: boolean): void {
    const durationMinutes = Math.floor(duration / 60000);
    const message = highHeartRate
      ? `🪑 已久坐 ${durationMinutes} 分钟，且检测到心率异常偏高。建议起身活动一下！`
      : `🪑 已久坐 ${durationMinutes} 分钟。建议起身活动一下！`;

    vscode.window
      .showWarningMessage(message, '稍后提醒', '我知道了')
      .then((selection) => {
        if (selection === '稍后提醒') {
          // 清理之前的提醒定时器
          if (this.sedentaryReminderTimer) {
            clearTimeout(this.sedentaryReminderTimer);
          }
          // 延迟 10 分钟后再次弹窗提醒
          this.sedentaryReminderTimer = setTimeout(() => {
            this.sedentaryReminderTimer = null;
            if (this.motionAnalyzer) {
              // 直接再弹一次提醒（此时 duration 已经更长了）
              this.showSedentaryAlert(duration + 10 * 60 * 1000, false);
            }
          }, 10 * 60 * 1000);
        }
      });
  }

  private showPostureAlert(duration: number, state: PostureState): void {
    const durationSeconds = Math.floor(duration / 1000);
    let message = '';

    switch (state) {
      case 'raised':
        message = `🖐️ 检测到您的手腕持续抬起 ${durationSeconds} 秒。注意保持正确的打字姿势！`;
        break;
      case 'slacking':
        message = `🤔 检测到可能的摸鱼姿势持续 ${durationSeconds} 秒。适当休息后记得回到工作状态哦~`;
        break;
      default:
        return; // 正常打字姿势不提醒
    }

    vscode.window.showInformationMessage(message, '收到');
  }

  private onFlowStateChange(state: FlowState): void {
    this.log(
      `Flow state changed: active=${state.active}, duration=${state.duration}ms`
    );

    if (state.active && state.duration >= 15 * 60 * 1000) {
      // 进入心流状态超过 15 分钟
      vscode.window.showInformationMessage(
        `🎯 检测到您已进入心流状态 ${Math.floor(state.duration / 60000)} 分钟！保持专注！`,
        '太棒了'
      );
    } else if (!state.active && state.duration >= 15 * 60 * 1000) {
      // 曾经的心流状态结束
      vscode.window.showInformationMessage(
        `🎯 心流状态结束（持续 ${Math.floor(state.duration / 60000)} 分钟）。适当休息一下吧！`,
        '好的'
      );
    }
  }
}
