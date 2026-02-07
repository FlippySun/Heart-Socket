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
import { EditorActivityTracker } from './editorActivityTracker';
import { HdsProvider } from './providers/hdsProvider';
import { HypeRateProvider } from './providers/hyperateProvider';
import { PulsoidProvider } from './providers/pulsoidProvider';
import { CustomProvider } from './providers/customProvider';
import { DataStore } from './dataStore';
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
  HeartRateZoneName,
} from './types';

/** 心率历史记录最大保留数量（支持最多 12 小时回溯） */
const MAX_HISTORY_SIZE = 43200; // 12小时（1条/秒）

export class HeartRateManager {
  private provider: IHeartRateProvider | null = null;
  private statusBar: StatusBarManager;
  private alertManager: AlertManager;
  private motionAnalyzer: MotionAnalyzer;
  private editorActivityTracker: EditorActivityTracker;
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
  private statsRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private statsPanelReady: boolean = false;
  private lastTimeScale: number = 60; // 默认1分钟，记忆用户上次选择

  // 数据持久化
  private dataStore: DataStore;

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
    this.editorActivityTracker = new EditorActivityTracker();
    this.outputChannel = vscode.window.createOutputChannel('Heart Socket');
    this.dataStore = new DataStore(context);

    // 绑定 MotionAnalyzer 事件
    this.bindMotionAnalyzerEvents();

    // 绑定 EditorActivityTracker 事件（兼容回退方案）
    this.bindEditorActivityEvents();

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

      // 启动编辑器活动追踪（用于兼容回退方案）
      this.editorActivityTracker.start();

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
    this.editorActivityTracker.stop();
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
    const zoneLabels: Record<string, string> = {
      low: '⚠️ 偏低',
      deepRelax: '😪 深度放松',
      relax: '😴 放松',
      calm: '😌 平静',
      lightFocus: '🧘 轻度集中',
      focused: '🧠 专注',
      tense: '😰 紧张',
      stressed: '😤 高压',
      extreme: '🚨 异常',
    };
    const currentZone = this.getHeartRateZone(this.stats.current);
    const zoneLabel = zoneLabels[currentZone] ?? '';

    const items: vscode.QuickPickItem[] = [
      {
        label: '$(graph) 查看心率统计',
        description: this.stats.samples > 0
          ? `当前 ${this.stats.current} BPM ${zoneLabel ? `· ${zoneLabel}` : ''}`
          : '暂无数据',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(gear) 打开设置',
        description: 'Heart Socket 配置项',
      },
      {
        label: '$(output) 查看输出日志',
        description: '调试与连接日志',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
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
    } else if (selected.label.includes('打开设置')) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'heartSocket');
    } else if (selected.label.includes('查看输出日志')) {
      this.outputChannel.show();
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
      this.pushStatsUpdate();
      this.statsPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    // 创建新面板（启用脚本以支持实时更新）
    this.statsPanel = vscode.window.createWebviewPanel(
      'heartSocketStats',
      '💓 Heart Socket Stats',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.statsPanelReady = false;

    // ⚠️ 必须在设置 HTML 之前注册消息监听，否则 ready 消息会因竞态条件丢失
    this.statsPanel.webview.onDidReceiveMessage((msg) => {
      this.log(`[Stats] received webview message: ${msg.type}`);
      if (msg.type === 'ready') {
        this.statsPanelReady = true;
        this.log(`[Stats] webview READY! statsPanelReady=${this.statsPanelReady}, samples=${this.stats.samples}`);
        this.pushStatsUpdate();
        this.startStatsRefreshTimer();
      } else if (msg.type === 'requestUpdate') {
        this.pushStatsUpdate();
      } else if (msg.type === 'requestCalendarData') {
        this.pushCalendarData(msg.year, msg.month);
      } else if (msg.type === 'requestDaySummary') {
        this.pushDaySummary(msg.date);
      } else if (msg.type === 'timeScaleChange') {
        this.lastTimeScale = msg.value;
      }
    });

    // 监听面板关闭，清除引用
    this.statsPanel.onDidDispose(() => {
      this.statsPanel = null;
      this.statsPanelReady = false;
      this.stopStatsRefreshTimer();
    });

    // 设置 HTML（触发 Webview JS 执行，JS 末尾会发送 ready 消息）
    this.statsPanel.webview.html = this.getStatsHtml();
  }

  /**
   * 推送实时数据到 Stats 面板
   * 事件驱动：由 onHeartRate() 和 analysisResult 事件触发，无额外定时器
   */
  private pushStatsUpdate(): void {
    if (!this.statsPanel || !this.statsPanelReady) {
      this.log(`[Stats] pushStatsUpdate SKIPPED: panel=${!!this.statsPanel}, ready=${this.statsPanelReady}`);
      return;
    }

    this.log(`[Stats] pushStatsUpdate: current=${this.stats.current}, samples=${this.stats.samples}, history=${this.stats.history.length}`);

    // 取最后 1800 个数据点（默认半小时，前端按选择的尺度截取）
    const historySlice = this.stats.history.slice(-43200);
    const chartData = historySlice.map(h => ({ bpm: h.bpm, ts: h.timestamp }));

    // 获取最新 Motion 分析结果
    const motionResult = this.motionAnalyzer.getLatestResult();
    const isCompatMode = this.motionAnalyzer.isCompatMode();

    // 9 级心率区间映射
    const zoneLabels: Record<string, string> = {
      low: '⚠️ 偏低', deepRelax: '😪 深度放松', relax: '😴 放松', calm: '😌 平静',
      lightFocus: '🧘 轻度集中', focused: '🧠 专注', tense: '😰 紧张',
      stressed: '😤 高压', extreme: '🚨 异常',
    };
    const zoneColors: Record<string, string> = {
      low: '#5b9bd5', deepRelax: '#7b68ee', relax: '#5b9bd5', calm: '#4caf50',
      lightFocus: '#26a69a', focused: '#9c27b0', tense: '#ff9800',
      stressed: '#ff5722', extreme: '#f44336',
    };
    const currentZone = this.getHeartRateZone(this.stats.current);

    // 计算区间分布（基于历史数据）
    const zoneDistribution = this.calculateZoneDistribution();

    // 安全序列化 min/max（处理 Infinity）
    const safeMin = this.stats.min === Infinity ? null : this.stats.min;
    const safeMax = this.stats.max === -Infinity ? null : this.stats.max;

    // 区间配置（供前端绘制图谱）
    const zoneConfig = {
      alertLowBpm: this.config.alertLowBpm,
      ...this.config.zones,
    };

    this.statsPanel.webview.postMessage({
      type: 'statsUpdate',
      data: {
        // 心率基础数据
        current: this.stats.current,
        min: safeMin,
        max: safeMax,
        avg: this.stats.avg,
        samples: this.stats.samples,
        duration: this.stats.duration,
        durationStr: this.formatDuration(this.stats.duration),

        // 心率区间
        zone: currentZone,
        zoneLabel: zoneLabels[currentZone] ?? '未知',
        zoneColor: zoneColors[currentZone] ?? '#888',
        zoneConfig,

        // 区间分布（饼图数据）
        zoneDistribution,
        zoneLabels,
        zoneColors,

        // 趋势图数据（带时间戳）
        chartData,

        // Motion 分析
        isCompatMode,
        motion: motionResult ? {
          codingIntensity: motionResult.codingIntensity,
          posture: motionResult.posture,
          flowState: motionResult.flowState,
          slackingIndex: motionResult.slackingIndex,
          energyLevel: motionResult.energyLevel,
          sedentaryDuration: motionResult.sedentaryDuration,
          raisedDuration: motionResult.raisedDuration,
        } : null,

        // 健康数据
        healthSnapshot: this.healthSnapshot,

        // 连接信息
        providerName: this.provider?.name ?? '未连接',
        providerType: this.config.provider,
      },
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
    // 清理编辑器活动追踪器
    if (this.editorActivityTracker) {
      this.editorActivityTracker.dispose();
    }
    // 清理久坐提醒定时器
    if (this.sedentaryReminderTimer) {
      clearTimeout(this.sedentaryReminderTimer);
      this.sedentaryReminderTimer = null;
    }
    // 清理 Stats 面板刷新定时器
    this.stopStatsRefreshTimer();
    // 持久化并清理 DataStore
    if (this.dataStore) {
      this.dataStore.dispose();
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
      // 推送到 Stats 面板（Motion 分析结果更新时也刷新）
      this.pushStatsUpdate();
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
   * 绑定 EditorActivityTracker 事件（兼容回退方案）
   *
   * 当数据源不支持 Motion 传感器时（Pulsoid/HypeRate/Custom），
   * 使用编辑器活动数据作为兼容回退。
   *
   * ⚠️ 注意：此方案仅检测编辑器文本变更，无法检测 AI 代码生成、
   * 阅读文档等活动，在 AI 辅助编程场景下结果会偏低。
   */
  private bindEditorActivityEvents(): void {
    this.editorActivityTracker.on('typingActivity', (charsPerSecond: number) => {
      const lastEditTime = this.editorActivityTracker.lastEditTime;
      this.motionAnalyzer.feedTypingActivity(charsPerSecond, lastEditTime);
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

    // 更新状态栏心率统计摘要
    this.statusBar.updateHeartRateStats({
      min: this.stats.min,
      max: this.stats.max,
      avg: this.stats.avg,
    });

    // 检查告警
    this.alertManager.check(data);

    // 转发到 Motion Analyzer（辅助心流检测）
    this.motionAnalyzer.feedHeartRate(data.bpm);

    // 记录到 DataStore（持久化日摘要）
    const zone = this.getHeartRateZone(data.bpm);
    this.dataStore.recordHeartRate(data.bpm, zone);

    // 推送到 Stats 面板（实时更新）
    this.pushStatsUpdate();

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
    const isWaitingForDevice = status === ConnectionStatus.Reconnecting && !this.hasEverConnected;

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
   * 获取心率区间名称（9 级）
   */
  private getHeartRateZone(bpm: number): HeartRateZoneName {
    const zones = this.config.zones;
    if (bpm < this.config.alertLowBpm) { return 'low'; }
    if (bpm < zones.deepRelax) { return 'deepRelax'; }
    if (bpm < zones.relax) { return 'relax'; }
    if (bpm < zones.calm) { return 'calm'; }
    if (bpm < zones.lightFocus) { return 'lightFocus'; }
    if (bpm < zones.focused) { return 'focused'; }
    if (bpm < zones.tense) { return 'tense'; }
    if (bpm < zones.stressed) { return 'stressed'; }
    return 'extreme';
  }

  /**
   * 计算区间分布（基于历史数据）
   */
  private calculateZoneDistribution(): Record<string, number> {
    const dist: Record<string, number> = {
      low: 0, deepRelax: 0, relax: 0, calm: 0,
      lightFocus: 0, focused: 0, tense: 0, stressed: 0, extreme: 0,
    };
    const history = this.stats.history;
    if (history.length === 0) { return dist; }
    for (const h of history) {
      const z = this.getHeartRateZone(h.bpm);
      dist[z] = (dist[z] ?? 0) + 1;
    }
    // 转为百分比
    const total = history.length;
    for (const k of Object.keys(dist)) {
      dist[k] = Math.round((dist[k] / total) * 1000) / 10; // 保留一位小数
    }
    return dist;
  }

  /**
   * 推送日历数据（某月有数据的日期列表）
   */
  private pushCalendarData(year: number, month: number): void {
    if (!this.statsPanel) { return; }
    const dateSet = this.dataStore.getMonthDates(year, month);
    const dates = Array.from(dateSet);
    const summaries = this.dataStore.getMultipleSummaries(dates);
    this.statsPanel.webview.postMessage({
      type: 'calendarData',
      data: { year, month, dates, summaries },
    });
  }

  /**
   * 推送某日的详细摘要
   */
  private pushDaySummary(date: string): void {
    if (!this.statsPanel) { return; }
    const summary = this.dataStore.getSummary(date);

    // 仅当请求的是今天时附带实时 motion 和健康数据
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const isToday = date === todayStr;
    const motionResult = isToday ? this.motionAnalyzer.getLatestResult() : null;
    const healthSnap = isToday ? this.healthSnapshot : null;

    this.statsPanel.webview.postMessage({
      type: 'daySummary',
      data: {
        date,
        summary,
        motion: motionResult ? {
          codingIntensity: motionResult.codingIntensity,
          posture: motionResult.posture,
          flowState: motionResult.flowState,
          slackingIndex: motionResult.slackingIndex,
          energyLevel: motionResult.energyLevel,
          sedentaryDuration: motionResult.sedentaryDuration,
        } : null,
        healthSnapshot: healthSnap,
        isCompatMode: isToday ? this.motionAnalyzer.isCompatMode() : false,
      },
    });
  }

  /**
   * 启动 Stats 面板定时刷新（2 秒）
   */
  private startStatsRefreshTimer(): void {
    this.stopStatsRefreshTimer();
    this.statsRefreshTimer = setInterval(() => {
      if (this.statsPanelReady) {
        this.pushStatsUpdate();
      }
    }, 2000);
  }

  /**
   * 停止 Stats 面板定时刷新
   */
  private stopStatsRefreshTimer(): void {
    if (this.statsRefreshTimer) {
      clearInterval(this.statsRefreshTimer);
      this.statsRefreshTimer = null;
    }
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
   * 生成统计页面 HTML（实时仪表盘）
   * 初始渲染骨架 + JS 通过 postMessage 接收实时数据
   */
  private getStatsHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Heart Socket Stats</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      max-width: 720px;
      margin: 0 auto;
    }

    /* ── 头部：实时心率 ── */
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .header h1 { font-size: 24px; margin-bottom: 8px; }
    .bpm-display {
      font-size: 72px;
      font-weight: bold;
      line-height: 1;
      transition: color 0.3s;
    }
    .zone-badge {
      display: inline-block;
      margin-top: 8px;
      padding: 4px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
      transition: background-color 0.3s;
    }

    /* ── 区间图谱条 ── */
    .zone-spectrum {
      margin: 20px auto 0;
      max-width: 400px;
      position: relative;
    }
    .zone-bar {
      display: flex;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
    }
    .zone-bar .seg { flex: 1; }
    .zone-pointer {
      position: absolute;
      top: -6px;
      transform: translateX(-50%);
      font-size: 12px;
      transition: left 0.4s ease;
    }
    .zone-legend {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      opacity: 0.5;
      margin-top: 2px;
    }

    /* ── 趋势图 ── */
    .chart-section {
      margin: 32px 0;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 12px;
      padding: 16px;
      background: var(--vscode-editorWidget-background);
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .chart-header h3 {
      font-size: 13px;
      opacity: 0.7;
      margin: 0;
    }
    .time-select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .chart-container {
      width: 100%;
      height: 120px;
      position: relative;
    }
    .chart-container svg {
      width: 100%;
      height: 100%;
      transition: opacity 0.22s ease;
    }
    .chart-container svg.chart-transition {
      opacity: 0.15;
    }
    .chart-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .chart-time-axis {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      opacity: 0.45;
      margin-top: 2px;
      padding: 0 2px;
      font-variant-numeric: tabular-nums;
    }
    .chart-coverage {
      font-size: 10px;
      opacity: 0.5;
      margin-left: 8px;
    }

    /* ── 统计网格 ── */
    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin: 34px 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      opacity: 0.8;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      padding: 14px;
      text-align: center;
    }
    .stat-card .value {
      font-size: 26px;
      font-weight: bold;
    }
    .stat-card .label {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 4px;
    }
    .stat-card.highlight {
      border-color: var(--vscode-charts-purple, #9c27b0);
      border-width: 2px;
    }

    /* ── Motion 分析区 ── */
    .motion-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 10px;
    }
    .motion-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
    }
    .motion-item .icon { font-size: 20px; flex-shrink: 0; }
    .motion-item .info { flex: 1; }
    .motion-item .info .name {
      font-size: 12px;
      opacity: 0.6;
    }
    .motion-item .info .val {
      font-size: 16px;
      font-weight: 600;
    }
    .motion-item.unsupported {
      opacity: 0.4;
    }
    .motion-item.unsupported .val {
      color: var(--vscode-disabledForeground, #888);
      font-size: 13px;
    }
    .compat-badge {
      display: inline-block;
      margin-top: 4px;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      background: var(--vscode-editorWidget-border);
      opacity: 0.6;
    }

    /* ── 进度条 ── */
    .progress-bar {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: var(--vscode-editorWidget-border);
      margin-top: 4px;
      overflow: hidden;
    }
    .progress-bar .fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.5s ease;
    }

    /* ── 健康数据 ── */
    .health-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
    }

    /* ── 连接信息 ── */
    .connection-info {
      display: flex;
      justify-content: center;
      gap: 24px;
      margin-top: 24px;
      font-size: 12px;
      opacity: 0.5;
    }

    /* ── 无数据占位 ── */
    .no-data {
      text-align: center;
      padding: 20px;
      opacity: 0.5;
      font-size: 13px;
    }
    .hidden { display: none !important; }

    /* ── 区间分布（环形图） ── */
    .pie-section {
      margin: 32px 0;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 14px;
      padding: 44px 20px 20px;
      background: var(--vscode-editorWidget-background);
      display: flex;
      align-items: center;
      gap: 24px;
      position: relative;
      overflow: hidden;
    }
    .pie-section::before {
      display: none;
    }
    .pie-section .section-label {
      position: absolute;
      top: 12px; left: 20px;
      font-size: 13px;
      font-weight: 600;
      opacity: 0.8;
    }
    .pie-chart-wrap {
      position: relative;
      width: 140px;
      height: 140px;
      flex-shrink: 0;
    }
    .pie-chart {
      width: 140px;
      height: 140px;
      border-radius: 50%;
      background: var(--vscode-editorWidget-border);
    }
    .pie-center {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: var(--vscode-editorWidget-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .pie-center-label { font-size: 10px; opacity: 0.5; }
    .pie-center-value { font-size: 16px; font-weight: 700; }
    .pie-center-pct { font-size: 10px; opacity: 0.6; }
    .pie-legend {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pie-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .pie-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .pie-legend-name { flex: 0 0 70px; font-size: 11px; }
    .pie-legend-bar-bg {
      flex: 1;
      height: 8px;
      border-radius: 4px;
      background: var(--vscode-editorWidget-border);
      overflow: hidden;
    }
    .pie-legend-bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }
    .pie-legend-pct {
      font-size: 11px;
      opacity: 0.7;
      min-width: 40px;
      text-align: right;
    }

    /* ── 历史记录区块 ── */
    .history-section {
      margin-top: 38px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 14px;
      padding: 20px;
      background: var(--vscode-editorWidget-background);
      position: relative;
      overflow: hidden;
    }
    .history-section::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, #5b9bd5, #9c27b0, #ff5722);
      border-radius: 14px 14px 0 0;
    }
    .history-section .section-title {
      margin: 0 0 16px;
      border-bottom: none;
      font-size: 15px;
    }
    .history-layout {
      display: flex;
      gap: 16px;
    }
    .history-left {
      flex: 1;
      min-height: 200px;
      display: flex;
      flex-direction: column;
    }
    .history-right {
      flex: 1;
    }
    .day-placeholder {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1px dashed var(--vscode-editorWidget-border);
      border-radius: 10px;
      padding: 24px 12px;
      opacity: 0.5;
    }
    .placeholder-icon { font-size: 32px; margin-bottom: 8px; }
    .placeholder-text { font-size: 11px; text-align: center; line-height: 1.6; }

    /* 日期摘要卡片 */
    .day-summary-card {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .day-summary-header {
      padding: 12px 14px;
      background: linear-gradient(135deg, rgba(91,155,213,0.15), rgba(156,39,176,0.1));
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      font-size: 13px;
      font-weight: 600;
    }
    .day-summary-body {
      padding: 12px 14px;
    }
    .day-summary-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 14px;
    }
    .day-stat {
      text-align: center;
      padding: 8px 4px;
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
    }
    .day-stat .ds-value {
      font-size: 20px;
      font-weight: bold;
    }
    .day-stat .ds-label {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 2px;
    }
    .day-meta {
      display: flex;
      gap: 12px;
      font-size: 11px;
      opacity: 0.6;
      justify-content: center;
    }
    .day-expand-btn {
      display: block;
      width: 100%;
      padding: 6px;
      margin-top: 12px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      background: none;
      color: var(--vscode-foreground);
      font-size: 11px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .day-expand-btn:hover { opacity: 1; }
    .day-detail-area {
      display: none;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }
    .day-detail-area.expanded { display: block; }

    /* 日历网格 */
    .cal-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 14px;
      font-weight: 600;
    }
    .cal-nav button {
      background: none;
      border: 1px solid var(--vscode-editorWidget-border);
      color: var(--vscode-foreground);
      width: 28px; height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .cal-nav button:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .cal-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 3px;
      text-align: center;
      font-size: 12px;
    }
    .cal-grid .cal-head {
      font-weight: 600;
      opacity: 0.4;
      padding: 4px 0;
      font-size: 10px;
      text-transform: uppercase;
    }
    .cal-grid .cal-day {
      padding: 6px 0 10px;
      border-radius: 8px;
      cursor: pointer;
      position: relative;
      transition: all 0.15s;
      font-weight: 500;
    }
    .cal-grid .cal-day:hover {
      background: var(--vscode-list-hoverBackground);
      transform: scale(1.1);
    }
    .cal-grid .cal-day.has-data {
      font-weight: 700;
    }
    .cal-grid .cal-day.has-data::after {
      content: '';
      position: absolute;
      bottom: 3px;
      left: 50%;
      transform: translateX(-50%);
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--heat-color, rgba(156,39,176,0.55));
    }
    .cal-grid .cal-day.selected {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      outline-offset: -1px;
      transform: scale(1.12);
      z-index: 1;
    }
    /* 展开详情区域样式 */
    .detail-section-label {
      font-size: 11px;
      font-weight: 600;
      opacity: 0.6;
      margin: 14px 0 6px;
    }
    .detail-section-label:first-child { margin-top: 0; }
    .detail-zone-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-size: 11px;
    }
    .detail-zone-name { flex: 0 0 55px; opacity: 0.8; }
    .detail-zone-bar-bg {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: var(--vscode-editorWidget-border);
      overflow: hidden;
    }
    .detail-zone-bar-fill {
      height: 100%;
      border-radius: 3px;
    }
    .detail-zone-pct {
      font-size: 10px;
      opacity: 0.6;
      min-width: 32px;
      text-align: right;
    }
    .detail-hours {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 4px;
    }
    .detail-hour-chip {
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 10px;
      background: var(--vscode-badge-background, rgba(0,120,212,0.15));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
    }
    .detail-stat-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .detail-stat-row:last-child { border-bottom: none; }
    .detail-stat-label { opacity: 0.6; }
    .detail-stat-value { font-weight: 600; }
    .cal-grid .cal-day.today {
      border: 2px solid var(--vscode-focusBorder, #007acc);
    }
    .cal-grid .cal-day.empty { visibility: hidden; }

    /* 右侧日历下方额外数据区 */
    .cal-extra-data {
      margin-top: 14px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 10px;
      padding: 12px 14px;
      background: var(--vscode-editor-background);
    }
    .cal-extra-data .detail-section-label:first-child { margin-top: 0; }
  </style>
</head>
<body>
  <!-- 头部：实时心率 -->
  <div class="header">
    <h1>💓 Heart Socket</h1>
    <div class="bpm-display" id="currentBpm">--</div>
    <div class="zone-badge" id="zoneBadge">等待数据...</div>
    <!-- 9级区间图谱条 -->
    <div class="zone-spectrum" id="zoneSpectrum">
      <div class="zone-pointer" id="zonePointer">▼</div>
      <div class="zone-bar">
        <div class="seg" style="background:#5b9bd5"></div>
        <div class="seg" style="background:#7b68ee"></div>
        <div class="seg" style="background:#5b9bd5"></div>
        <div class="seg" style="background:#4caf50"></div>
        <div class="seg" style="background:#26a69a"></div>
        <div class="seg" style="background:#9c27b0"></div>
        <div class="seg" style="background:#ff9800"></div>
        <div class="seg" style="background:#ff5722"></div>
        <div class="seg" style="background:#f44336"></div>
      </div>
      <div class="zone-legend">
        <span>偏低</span><span>深松</span><span>放松</span><span>平静</span><span>轻集</span><span>专注</span><span>紧张</span><span>高压</span><span>异常</span>
      </div>
    </div>
  </div>

  <!-- 趋势图 -->
  <div class="chart-section">
    <div class="chart-header">
      <h3>📈 心率趋势<span class="chart-coverage" id="chartCoverage"></span></h3>
      <select class="time-select" id="timeScale">
        <option value="60"${this.lastTimeScale === 60 ? ' selected' : ''}>1 分钟</option>
        <option value="300"${this.lastTimeScale === 300 ? ' selected' : ''}>5 分钟</option>
        <option value="600"${this.lastTimeScale === 600 ? ' selected' : ''}>10 分钟</option>
        <option value="1800"${this.lastTimeScale === 1800 ? ' selected' : ''}>30 分钟</option>
        <option value="3600"${this.lastTimeScale === 3600 ? ' selected' : ''}>1 小时</option>
        <option value="7200"${this.lastTimeScale === 7200 ? ' selected' : ''}>2 小时</option>
        <option value="14400"${this.lastTimeScale === 14400 ? ' selected' : ''}>4 小时</option>
        <option value="43200"${this.lastTimeScale === 43200 ? ' selected' : ''}>12 小时</option>
      </select>
    </div>
    <div class="chart-container">
      <svg id="chartSvg" viewBox="0 0 600 120" preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--vscode-charts-red, #e74c3c)" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="var(--vscode-charts-red, #e74c3c)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <polygon id="chartArea" fill="url(#areaGrad)" points="0,120 600,120"/>
        <polyline id="chartLine" fill="none" stroke="var(--vscode-charts-red, #e74c3c)" stroke-width="2" stroke-linejoin="round" points=""/>
      </svg>
    </div>
    <div class="chart-labels">
      <span id="chartMin">--</span>
      <span id="chartMax">--</span>
    </div>
    <div class="chart-time-axis" id="chartTimeAxis"></div>
  </div>

  <!-- 区间分布饼图 -->
  <div class="pie-section" id="pieSection" style="display:none">
    <span class="section-label">📊 心率区间分布</span>
    <div class="pie-chart-wrap">
      <div class="pie-chart" id="pieChart"></div>
      <div class="pie-center">
        <div class="pie-center-label" id="pieCenterLabel">主要</div>
        <div class="pie-center-value" id="pieCenterValue">--</div>
        <div class="pie-center-pct" id="pieCenterPct"></div>
      </div>
    </div>
    <div class="pie-legend" id="pieLegend"></div>
  </div>

  <!-- 心率统计 -->
  <div class="section-title">📊 心率统计</div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="value" id="minBpm">--</div>
      <div class="label">📉 最低心率</div>
    </div>
    <div class="stat-card">
      <div class="value" id="maxBpm">--</div>
      <div class="label">📈 最高心率</div>
    </div>
    <div class="stat-card">
      <div class="value" id="avgBpm">--</div>
      <div class="label">📊 平均心率</div>
    </div>
    <div class="stat-card">
      <div class="value" id="sampleCount">0</div>
      <div class="label">🔢 采样次数</div>
    </div>
    <div class="stat-card">
      <div class="value" id="durationVal">0s</div>
      <div class="label">⏱️ 监测时长</div>
    </div>
  </div>

  <!-- Motion 分析 -->
  <div id="motionSection" class="hidden">
    <div class="section-title">🧠 Motion 分析</div>
    <div class="motion-grid">
      <div class="motion-item">
        <span class="icon" id="intensityIcon">💤</span>
        <div class="info">
          <div class="name">打字强度</div>
          <div class="val" id="intensityVal">空闲</div>
        </div>
      </div>
      <div class="motion-item">
        <span class="icon" id="postureIcon">⌨️</span>
        <div class="info">
          <div class="name">姿态</div>
          <div class="val" id="postureVal">打字中</div>
        </div>
      </div>
      <div class="motion-item">
        <span class="icon">🎯</span>
        <div class="info">
          <div class="name">心流状态</div>
          <div class="val" id="flowVal">未激活</div>
        </div>
      </div>
      <div class="motion-item">
        <span class="icon" id="slackingIcon">🌟</span>
        <div class="info">
          <div class="name">摸鱼指数</div>
          <div class="val" id="slackingVal">0/100</div>
          <div class="progress-bar"><div class="fill" id="slackingBar" style="width:0%;background:var(--vscode-charts-green,#4caf50)"></div></div>
        </div>
      </div>
      <div class="motion-item">
        <span class="icon">🔋</span>
        <div class="info">
          <div class="name">精力水平</div>
          <div class="val" id="energyVal">50%</div>
          <div class="progress-bar"><div class="fill" id="energyBar" style="width:50%;background:var(--vscode-charts-blue,#2196f3)"></div></div>
        </div>
      </div>
      <div class="motion-item">
        <span class="icon" id="sedentaryIcon">🪑</span>
        <div class="info">
          <div class="name">久坐时长</div>
          <div class="val" id="sedentaryVal">0 分钟</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 健康数据 -->
  <div id="healthSection" class="hidden">
    <div class="section-title">💊 健康数据</div>
    <div class="health-grid" id="healthGrid"></div>
  </div>

  <!-- 历史记录 -->
  <div class="history-section" id="historySection">
    <div class="section-title">📅 历史记录</div>
    <div class="history-layout">
      <div class="history-left" id="historyLeft">
        <div class="day-placeholder" id="dayPlaceholder">
          <div class="placeholder-icon">📅</div>
          <div class="placeholder-text">点击右侧日历中有数据的日期<br>查看当日心率摘要</div>
        </div>
        <div id="daySummaryArea" style="display:none"></div>
      </div>
      <div class="history-right">
        <div class="cal-nav">
          <button id="calPrev">◀</button>
          <span id="calTitle">--</span>
          <button id="calNext">▶</button>
        </div>
        <div class="cal-grid" id="calGrid"></div>
        <div id="calExtraData" class="cal-extra-data" style="display:none"></div>
      </div>
    </div>
  </div>

  <!-- 连接信息 -->
  <div class="connection-info">
    <span>📡 <span id="providerName">--</span></span>
    <span>⏱️ <span id="connDuration">--</span></span>
    <span>🔢 <span id="connSamples">0</span> 次采样</span>
  </div>

  <script>
    console.log('[HS-Stats] script loaded');
    const vscode = acquireVsCodeApi();

    // DOM 缓存
    const $ = (id) => document.getElementById(id);

    // 强度映射
    const intensityMap = {
      idle:     { icon: '💤', label: '空闲' },
      light:    { icon: '⌨️', label: '轻度打字' },
      moderate: { icon: '⚡', label: '中等打字' },
      intense:  { icon: '🔥', label: '密集打字' },
      furious:  { icon: '🚀', label: '疯狂打字' },
    };
    const postureMap = {
      typing:   { icon: '⌨️', label: '打字中' },
      raised:   { icon: '🖐️', label: '抬手' },
      slacking: { icon: '🤔', label: '摸鱼' },
    };

    // 当前时间尺度（秒）— 从 select 选中项读取（由 TS 层动态设置 selected）
    var tsEl = $('timeScale');
    var currentTimeScale = tsEl ? parseInt(tsEl.value, 10) : 60;
    var lastChartData = null;
    var chartTransitioning = false;
    if (tsEl) tsEl.addEventListener('change', function(e) {
      currentTimeScale = parseInt(e.target.value, 10);
      vscode.postMessage({ type: 'timeScaleChange', value: currentTimeScale });
      if (lastChartData) {
        var svg = $('chartSvg');
        if (svg && !chartTransitioning) {
          chartTransitioning = true;
          svg.classList.add('chart-transition');
          setTimeout(function() {
            updateChart(lastChartData);
            svg.classList.remove('chart-transition');
            chartTransitioning = false;
          }, 220);
        } else {
          updateChart(lastChartData);
        }
      }
    });

    // 降采样：保留 {bpm, ts} 结构，分桶取均值
    function downsample(arr, maxPts) {
      if (arr.length <= maxPts) return arr;
      var step = arr.length / maxPts;
      var result = [];
      for (var i = 0; i < maxPts; i++) {
        var start = Math.floor(i * step);
        var end = Math.floor((i + 1) * step);
        var sumBpm = 0, sumTs = 0, cnt = end - start;
        for (var j = start; j < end; j++) { sumBpm += arr[j].bpm; sumTs += arr[j].ts; }
        result.push({ bpm: sumBpm / cnt, ts: sumTs / cnt });
      }
      return result;
    }

    // 格式化时间为 HH:MM
    function fmtTime(ms) {
      var d = new Date(ms);
      var h = d.getHours(), m = d.getMinutes();
      return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }
    // 格式化时长
    function fmtDur(sec) {
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60 > 0 ? sec % 60 + 's' : '');
      var h = Math.floor(sec / 3600), rm = Math.floor((sec % 3600) / 60);
      return h + 'h' + (rm > 0 ? rm + 'm' : '');
    }

    // 更新趋势图（chartData = [{bpm, ts}, ...]）
    function updateChart(chartData) {
      if (!chartData || chartData.length === 0) return;
      lastChartData = chartData;

      // 按时间尺度过滤
      var now = Date.now();
      var windowEnd = now;
      var windowStart = now - currentTimeScale * 1000;
      var filtered = chartData.filter(function(d) { return d.ts >= windowStart; });
      if (filtered.length === 0) filtered = chartData.slice(-10);

      // 降采样（最多 600 点，保留 {bpm, ts}）
      var sampled = downsample(filtered, 600);

      var bpmArr = sampled.map(function(d) { return d.bpm; });
      var svgW = 600, svgH = 120;
      var pad = 4;
      var minBpm = Math.max(40, Math.min.apply(null, bpmArr) - 5);
      var maxBpm = Math.max(minBpm + 10, Math.max.apply(null, bpmArr) + 5);

      // 按真实时间比例计算 X 坐标
      var windowSpan = windowEnd - windowStart;
      var points = sampled.map(function(d) {
        var x = ((d.ts - windowStart) / windowSpan) * svgW;
        var y = pad + (1 - (d.bpm - minBpm) / (maxBpm - minBpm)) * (svgH - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');

      $('chartLine').setAttribute('points', points);
      // area 跟随数据实际范围
      var firstX = ((sampled[0].ts - windowStart) / windowSpan) * svgW;
      var lastX = ((sampled[sampled.length - 1].ts - windowStart) / windowSpan) * svgW;
      var areaPoints = firstX.toFixed(1) + ',' + svgH + ' ' + points + ' ' + lastX.toFixed(1) + ',' + svgH;
      $('chartArea').setAttribute('points', areaPoints);

      $('chartMin').textContent = minBpm + ' BPM';
      $('chartMax').textContent = maxBpm + ' BPM';

      // 时间刻度标签（5 个等距刻度）
      var axisEl = $('chartTimeAxis');
      if (axisEl) {
        var ticks = 5;
        var labels = [];
        for (var t = 0; t < ticks; t++) {
          var tickMs = windowStart + (t / (ticks - 1)) * windowSpan;
          labels.push('<span>' + fmtTime(tickMs) + '</span>');
        }
        axisEl.innerHTML = labels.join('');
      }

      // 数据覆盖率指示
      var covEl = $('chartCoverage');
      if (covEl) {
        var dataSpan = filtered.length > 1 ? (filtered[filtered.length - 1].ts - filtered[0].ts) / 1000 : 0;
        var ratio = Math.min(100, Math.round((dataSpan / currentTimeScale) * 100));
        covEl.textContent = '(' + fmtDur(Math.round(dataSpan)) + ' / ' + fmtDur(currentTimeScale) + '  ' + ratio + '%)';
      }
    }

    // 更新饼图（环形 + 纵向图例 + 比例条）
    function updatePieChart(dist, labels, colors) {
      if (!dist || !labels || !colors) return;
      var keys = ['low','deepRelax','relax','calm','lightFocus','focused','tense','stressed','extreme'];
      var segments = [];
      var total = 0;
      for (var k = 0; k < keys.length; k++) {
        var v = dist[keys[k]] || 0;
        if (v > 0) segments.push({ key: keys[k], pct: v, color: colors[keys[k]], label: labels[keys[k]] });
        total += v;
      }
      if (total === 0) { $('pieSection').style.display = 'none'; return; }
      $('pieSection').style.display = 'flex';

      // conic-gradient
      var gradParts = [];
      var angle = 0;
      for (var s = 0; s < segments.length; s++) {
        var seg = segments[s];
        var nextAngle = angle + (seg.pct / total) * 360;
        gradParts.push(seg.color + ' ' + angle.toFixed(1) + 'deg ' + nextAngle.toFixed(1) + 'deg');
        angle = nextAngle;
      }
      $('pieChart').style.background = 'conic-gradient(' + gradParts.join(', ') + ')';

      // 中心 — 显示最大区间
      var dominant = segments.reduce(function(a, b) { return a.pct > b.pct ? a : b; });
      $('pieCenterValue').textContent = dominant.label.replace(/^[^\u4e00-\u9fff]+/, '');
      $('pieCenterPct').textContent = dominant.pct.toFixed(1) + '%';

      // 纵向图例 + 比例条
      $('pieLegend').innerHTML = segments.map(function(seg) {
        var barW = (seg.pct / total * 100).toFixed(1);
        return '<div class="pie-legend-item">' +
          '<span class="pie-legend-dot" style="background:' + seg.color + '"></span>' +
          '<span class="pie-legend-name">' + seg.label + '</span>' +
          '<div class="pie-legend-bar-bg"><div class="pie-legend-bar-fill" style="width:' + barW + '%;background:' + seg.color + '"></div></div>' +
          '<span class="pie-legend-pct">' + seg.pct.toFixed(1) + '%</span>' +
          '</div>';
      }).join('');
    }

    // 更新健康数据（始终显示全部指标，无数据时显示 --）
    function updateHealth(snapshot) {
      var grid = $('healthGrid');
      var section = $('healthSection');
      section.classList.remove('hidden');

      var s = snapshot || {};
      var items = [
        { icon: '🔥', label: '卡路里',  value: s.calories !== undefined ? s.calories + ' kcal' : '--', color: '#ff5722' },
        { icon: '👟', label: '步数',     value: s.stepCount !== undefined ? s.stepCount : '--', color: '#4caf50' },
        { icon: '🩸', label: '血氧',     value: s.bloodOxygen !== undefined ? s.bloodOxygen + '%' : '--', color: '#e91e63' },
        { icon: '📏', label: '距离',     value: s.distance !== undefined ? s.distance.toFixed(2) + ' km' : '--', color: '#2196f3' },
        { icon: '⚡', label: '速度',     value: s.speed !== undefined ? s.speed.toFixed(1) + ' km/h' : '--', color: '#ff9800' },
        { icon: '⚖️', label: '体重',    value: s.bodyMass !== undefined ? s.bodyMass.toFixed(1) + ' kg' : '--', color: '#9c27b0' },
        { icon: '📐', label: 'BMI',      value: s.bmi !== undefined ? s.bmi.toFixed(1) : '--', color: '#00bcd4' },
      ];

      grid.innerHTML = items.map(function(it) {
        var dimClass = it.value === '--' ? ' style="opacity:0.35"' : '';
        return '<div class="stat-card"' + dimClass + '><div class="value">' + it.value + '</div><div class="label">' + it.icon + ' ' + it.label + '</div></div>';
      }).join('');
    }

    // 主更新函数
    function onUpdate(d) {
      try {
      console.log('[HS-Stats] onUpdate called, current=' + d.current + ', samples=' + d.samples);
      // 心率
      $('currentBpm').textContent = d.current || '--';
      $('currentBpm').style.color = d.zoneColor || 'var(--vscode-charts-red, #e74c3c)';
      $('zoneBadge').textContent = d.zoneLabel || '--';
      $('zoneBadge').style.background = d.zoneColor || '#888';
      $('zoneBadge').style.color = '#fff';

      // 图谱条指针 — 精确插值到区间内位置
      if (d.zoneConfig && d.current) {
        var zc = d.zoneConfig;
        var zones = ['low','deepRelax','relax','calm','lightFocus','focused','tense','stressed','extreme'];
        var bounds = [30, zc.alertLowBpm||50, zc.deepRelax||58, zc.relax||65, zc.calm||72, zc.lightFocus||80, zc.focused||90, zc.tense||105, zc.stressed||120, 180];
        var idx = zones.indexOf(d.zone);
        if (idx >= 0) {
          var lo = bounds[idx], hi = bounds[idx + 1];
          var frac = (hi > lo) ? Math.max(0, Math.min(1, (d.current - lo) / (hi - lo))) : 0.5;
          var pct = ((idx + frac) / zones.length) * 100;
          $('zonePointer').style.left = pct + '%';
          $('zonePointer').style.color = d.zoneColor || '#888';
        }
      }

      // 统计
      $('minBpm').textContent = (d.min === Infinity || d.min === null) ? '--' : d.min;
      $('maxBpm').textContent = (d.max === -Infinity || d.max === null) ? '--' : d.max;
      $('avgBpm').textContent = d.avg || '--';
      $('sampleCount').textContent = d.samples || 0;
      $('durationVal').textContent = d.durationStr || '0s';

      // 趋势图
      updateChart(d.chartData);

      // 饼图：区间分布
      updatePieChart(d.zoneDistribution, d.zoneLabels, d.zoneColors);

      // Motion 分析
      if (d.motion) {
        $('motionSection').classList.remove('hidden');
        var compat = d.isCompatMode;

        // 打字强度 — compat mode 下不支持
        var intensityItem = $('intensityIcon').closest('.motion-item');
        if (compat) {
          if (intensityItem) intensityItem.classList.add('unsupported');
          $('intensityIcon').textContent = '✕';
          $('intensityVal').textContent = '不支持';
        } else {
          if (intensityItem) intensityItem.classList.remove('unsupported');
          const intensity = intensityMap[d.motion.codingIntensity] || intensityMap.idle;
          $('intensityIcon').textContent = intensity.icon;
          $('intensityVal').textContent = intensity.label;
        }

        // 姿态 — compat mode 下不支持
        var postureItem = $('postureIcon').closest('.motion-item');
        if (compat) {
          if (postureItem) postureItem.classList.add('unsupported');
          $('postureIcon').textContent = '✕';
          $('postureVal').textContent = '不支持';
        } else {
          if (postureItem) postureItem.classList.remove('unsupported');
          const posture = postureMap[d.motion.posture] || postureMap.typing;
          $('postureIcon').textContent = posture.icon;
          $('postureVal').textContent = posture.label;
        }

        // 心流
        if (d.motion.flowState && d.motion.flowState.active) {
          const mins = Math.floor(d.motion.flowState.duration / 60000);
          $('flowVal').textContent = '🟢 已持续 ' + mins + ' 分钟';
        } else {
          $('flowVal').textContent = '未激活';
        }

        // 摸鱼指数
        const si = Math.round(d.motion.slackingIndex || 0);
        $('slackingVal').textContent = si + '/100';
        $('slackingBar').style.width = si + '%';
        $('slackingBar').style.background = si < 30 ? 'var(--vscode-charts-green,#4caf50)' :
          si < 50 ? 'var(--vscode-charts-blue,#2196f3)' :
          si < 70 ? 'var(--vscode-charts-yellow,#ff9800)' : 'var(--vscode-charts-red,#f44336)';
        $('slackingIcon').textContent = si < 30 ? '🌟' : si < 50 ? '👍' : si < 70 ? '🤔' : '🐟';

        // 精力
        const el = Math.round(d.motion.energyLevel || 50);
        $('energyVal').textContent = el + '%';
        $('energyBar').style.width = el + '%';

        // 久坐
        const sedMin = Math.floor((d.motion.sedentaryDuration || 0) / 60000);
        var sedItem = $('sedentaryIcon').closest('.motion-item');
        if (compat) {
          if (sedItem) sedItem.classList.add('unsupported');
          $('sedentaryIcon').textContent = '✕';
          $('sedentaryVal').textContent = '不支持';
        } else {
          if (sedItem) sedItem.classList.remove('unsupported');
          $('sedentaryVal').textContent = sedMin + ' 分钟';
          $('sedentaryIcon').textContent = sedMin >= 60 ? '🚨' : sedMin >= 30 ? '⚠️' : '🪑';
        }

        // compat mode 提示
        if (compat) {
          var motionTitle = document.querySelector('#motionSection .section-title');
          if (motionTitle && !document.getElementById('compatBadge')) {
            var badge = document.createElement('span');
            badge.id = 'compatBadge';
            badge.className = 'compat-badge';
            badge.textContent = '兼容模式 — 部分项目不支持';
            motionTitle.appendChild(badge);
          }
        }
      } else {
        $('motionSection').classList.add('hidden');
      }

      // 健康数据
      updateHealth(d.healthSnapshot);

      // 连接信息
      $('providerName').textContent = d.providerName || '--';
      $('connDuration').textContent = d.durationStr || '--';
      $('connSamples').textContent = d.samples || 0;
      } catch(err) {
        console.error('[HS-Stats] onUpdate ERROR:', err);
      }
    }

    // ── 日历相关变量与函数 ──
    var now = new Date();
    var calYear = now.getFullYear();
    var calMonth = now.getMonth() + 1;
    var calSummaries = {};

    // 热力图颜色映射（基于平均心率）
    function heatColor(avg) {
      if (!avg || avg <= 0) return '';
      if (avg < 58)  return 'rgba(91,155,213,0.55)';
      if (avg < 65)  return 'rgba(123,104,238,0.5)';
      if (avg < 72)  return 'rgba(76,175,80,0.55)';
      if (avg < 80)  return 'rgba(38,166,154,0.55)';
      if (avg < 90)  return 'rgba(156,39,176,0.55)';
      if (avg < 105) return 'rgba(255,152,0,0.6)';
      if (avg < 120) return 'rgba(255,87,34,0.65)';
      return 'rgba(244,67,54,0.75)';
    }

    function renderCalendar(year, month, dates, summaries) {
      calSummaries = {};
      if (summaries) {
        for (var i = 0; i < dates.length; i++) {
          calSummaries[dates[i]] = summaries[i];
        }
      }
      var calTitle = $('calTitle');
      if (calTitle) calTitle.textContent = year + ' 年 ' + month + ' 月';
      var firstDay = new Date(year, month - 1, 1).getDay();
      var daysInMonth = new Date(year, month, 0).getDate();
      var today = new Date();
      var todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

      var html = '<div class="cal-head">日</div><div class="cal-head">一</div><div class="cal-head">二</div><div class="cal-head">三</div><div class="cal-head">四</div><div class="cal-head">五</div><div class="cal-head">六</div>';
      for (var e = 0; e < firstDay; e++) html += '<div class="cal-day empty"></div>';
      for (var d = 1; d <= daysInMonth; d++) {
        var dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        var hasData = dates && dates.indexOf(dateStr) >= 0;
        var isToday = dateStr === todayStr;
        var cls = 'cal-day' + (hasData ? ' has-data' : '') + (isToday ? ' today' : '');
        var bgStyle = '';
        if (hasData && calSummaries[dateStr]) {
          var hc = heatColor(calSummaries[dateStr].avg);
          if (hc) bgStyle = ' style="--heat-color:' + hc + '"';
        }
        html += '<div class="' + cls + '" data-date="' + dateStr + '"' + bgStyle + '>' + d + '</div>';
      }
      var calGrid = $('calGrid');
      if (calGrid) calGrid.innerHTML = html;
      // 重置左侧摘要区：显示占位，隐藏数据
      var dsArea = $('daySummaryArea');
      if (dsArea) { dsArea.style.display = 'none'; dsArea.innerHTML = ''; }
      var ph = $('dayPlaceholder');
      if (ph) ph.style.display = 'flex';
      // 重置右侧额外数据区
      var calExtra = $('calExtraData');
      if (calExtra) { calExtra.style.display = 'none'; calExtra.innerHTML = ''; }
    }

    function showDay(dateStr) {
      // 高亮选中日期
      document.querySelectorAll('.cal-day.selected').forEach(function(el) { el.classList.remove('selected'); });
      var target = document.querySelector('.cal-day[data-date="' + dateStr + '"]');
      if (target) target.classList.add('selected');
      vscode.postMessage({ type: 'requestDaySummary', date: dateStr });
    }

    // 区间名称/颜色映射
    var zoneNameMap = {low:'\u504f\u4f4e',deepRelax:'\u6df1\u677e',relax:'\u653e\u677e',calm:'\u5e73\u9759',lightFocus:'\u8f7b\u96c6',focused:'\u4e13\u6ce8',tense:'\u7d27\u5f20',stressed:'\u9ad8\u538b',extreme:'\u5f02\u5e38'};
    var zoneColorMap = {low:'#5b9bd5',deepRelax:'#7b68ee',relax:'#5b9bd5',calm:'#4caf50',lightFocus:'#26a69a',focused:'#9c27b0',tense:'#ff9800',stressed:'#ff5722',extreme:'#f44336'};

    function renderDaySummary(date, summary, motion, healthSnapshot, isCompatMode) {
      var area = $('daySummaryArea');
      var placeholder = $('dayPlaceholder');
      var calExtra = $('calExtraData');
      if (!area) return;

      // 重置右侧额外数据区
      if (calExtra) { calExtra.style.display = 'none'; calExtra.innerHTML = ''; }

      if (!summary) {
        area.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
        area.innerHTML = '<div class="day-summary-card"><div class="day-summary-header">' + date + '</div><div class="day-summary-body"><div class="no-data">\u6682\u65e0\u6570\u636e</div></div></div>';
        return;
      }

      area.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';

      var dur = Math.floor((summary.totalDuration || 0) / 60000);
      var fluctuation = (summary.avg && summary.max && summary.min) ? Math.abs(summary.max - summary.min) : '--';

      // 基础统计
      var html = '<div class="day-summary-card">' +
        '<div class="day-summary-header">\ud83d\udccb ' + date + '</div>' +
        '<div class="day-summary-body">' +
        '<div class="day-summary-stats">' +
        '<div class="day-stat"><div class="ds-value">' + (summary.min || '--') + '</div><div class="ds-label">\ud83d\udcc9 \u6700\u4f4e</div></div>' +
        '<div class="day-stat"><div class="ds-value">' + (summary.max || '--') + '</div><div class="ds-label">\ud83d\udcc8 \u6700\u9ad8</div></div>' +
        '<div class="day-stat"><div class="ds-value">' + (summary.avg || '--') + '</div><div class="ds-label">\ud83d\udcca \u5e73\u5747</div></div>' +
        '</div>' +
        '<div class="day-meta"><span>\ud83d\udd22 ' + (summary.samples || 0) + ' \u6b21</span><span>\u23f1\ufe0f ' + dur + ' \u5206\u949f</span></div>' +
        '<button class="day-expand-btn" id="dayExpandBtn">\u5c55\u5f00\u8be6\u60c5 \u25bc</button>' +
        '<div class="day-detail-area" id="dayDetailArea">';

      // 展开详情：统计指标
      html += '<div class="detail-section-label">\ud83d\udcca \u8be6\u7ec6\u6307\u6807</div>';
      html += '<div class="detail-stat-row"><span class="detail-stat-label">\u2764\ufe0f \u5fc3\u7387\u6ce2\u52a8</span><span class="detail-stat-value">' + fluctuation + ' BPM</span></div>';
      html += '<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udd22 \u91c7\u6837\u6b21\u6570</span><span class="detail-stat-value">' + (summary.samples || 0) + '</span></div>';
      html += '<div class="detail-stat-row"><span class="detail-stat-label">\u23f1\ufe0f \u76d1\u6d4b\u65f6\u957f</span><span class="detail-stat-value">' + dur + ' min</span></div>';

      // 监测覆盖率
      var activeHours = 0;
      if (summary.hourlyAvg) {
        for (var h = 0; h < summary.hourlyAvg.length; h++) {
          if (summary.hourlyAvg[h] !== null && summary.hourlyAvg[h] !== undefined) activeHours++;
        }
      }
      html += '<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udcc5 \u8986\u76d6\u7387</span><span class="detail-stat-value">' + activeHours + ' / 24 h</span></div>';

      // 区间分布横条图
      if (summary.zoneDistribution) {
        html += '<div class="detail-section-label">\ud83c\udfaf \u533a\u95f4\u5206\u5e03</div>';
        var zoneKeys = ['low','deepRelax','relax','calm','lightFocus','focused','tense','stressed','extreme'];
        var maxPct = 0;
        for (var zi = 0; zi < zoneKeys.length; zi++) {
          var zv = summary.zoneDistribution[zoneKeys[zi]] || 0;
          if (zv > maxPct) maxPct = zv;
        }
        for (var zi = 0; zi < zoneKeys.length; zi++) {
          var zk = zoneKeys[zi];
          var zpct = summary.zoneDistribution[zk] || 0;
          if (zpct <= 0) continue;
          var barW = maxPct > 0 ? (zpct / maxPct) * 100 : 0;
          html += '<div class="detail-zone-row">' +
            '<span class="detail-zone-name">' + (zoneNameMap[zk] || zk) + '</span>' +
            '<div class="detail-zone-bar-bg"><div class="detail-zone-bar-fill" style="width:' + barW.toFixed(0) + '%;background:' + (zoneColorMap[zk] || '#888') + '"></div></div>' +
            '<span class="detail-zone-pct">' + zpct.toFixed(0) + '%</span>' +
            '</div>';
        }
      }

      // 活跃时段
      if (summary.hourlyAvg && activeHours > 0) {
        html += '<div class="detail-section-label">\ud83d\udd70\ufe0f \u6d3b\u8dc3\u65f6\u6bb5</div><div class="detail-hours">';
        for (var h = 0; h < 24; h++) {
          if (summary.hourlyAvg[h] !== null && summary.hourlyAvg[h] !== undefined) {
            html += '<span class="detail-hour-chip">' + (h < 10 ? '0' : '') + h + ':00 \u2022 ' + Math.round(summary.hourlyAvg[h]) + '</span>';
          }
        }
        html += '</div>';
      }

      html += '</div></div></div>';
      area.innerHTML = html;

      // 展开/收起按钮事件 + 右侧额外数据联动
      var btn = $('dayExpandBtn');
      var detail = $('dayDetailArea');
      // 构建右侧额外数据 HTML（motion + health）
      var extraHtml = buildCalExtraHtml(motion, healthSnapshot, isCompatMode);
      if (calExtra && extraHtml) {
        calExtra.innerHTML = extraHtml;
      }
      if (btn && detail) {
        btn.addEventListener('click', function() {
          var expanded = detail.classList.toggle('expanded');
          btn.textContent = expanded ? '\u6536\u8d77 \u25b2' : '\u5c55\u5f00\u8be6\u60c5 \u25bc';
          // 联动右侧额外数据区
          if (calExtra && extraHtml) {
            calExtra.style.display = expanded ? 'block' : 'none';
          }
        });
      }
    }

    // 构建右侧日历下方的额外数据 HTML
    function buildCalExtraHtml(motion, health, isCompatMode) {
      var parts = [];

      // Motion 分析
      if (motion) {
        var motionRows = [];
        var postureMap = {typing:'\u2328\ufe0f \u6253\u5b57\u4e2d',raised:'\ud83d\udd90\ufe0f \u62ac\u624b',slacking:'\ud83e\udd14 \u6478\u9c7c'};
        var intensityMap = {idle:'\ud83d\udca4 \u7a7a\u95f2',light:'\ud83d\udca1 \u8f7b\u5ea6',moderate:'\u26a1 \u4e2d\u7b49',intense:'\ud83d\udd25 \u9ad8\u5f3a\u5ea6'};

        if (!isCompatMode && motion.codingIntensity) {
          var intLabel = intensityMap[motion.codingIntensity] || motion.codingIntensity;
          motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\u7f16\u7801\u5f3a\u5ea6</span><span class="detail-stat-value">' + intLabel + '</span></div>');
        }
        if (!isCompatMode && motion.posture) {
          var posLabel = postureMap[motion.posture] || motion.posture;
          motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\u59ff\u6001</span><span class="detail-stat-value">' + posLabel + '</span></div>');
        }
        if (motion.flowState && motion.flowState.active) {
          var flowMin = Math.floor(motion.flowState.duration / 60000);
          motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83c\udfaf \u5fc3\u6d41</span><span class="detail-stat-value">\u5df2\u6301\u7eed ' + flowMin + ' \u5206\u949f</span></div>');
        }
        if (typeof motion.slackingIndex === 'number') {
          var sEmoji = motion.slackingIndex < 30 ? '\ud83c\udf1f' : motion.slackingIndex < 50 ? '\ud83d\udc4d' : motion.slackingIndex < 70 ? '\ud83e\udd14' : '\ud83d\udc1f';
          motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">' + sEmoji + ' \u6478\u9c7c\u6307\u6570</span><span class="detail-stat-value">' + Math.round(motion.slackingIndex) + '/100</span></div>');
        }
        if (typeof motion.energyLevel === 'number') {
          motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udd0b \u7cbe\u529b</span><span class="detail-stat-value">' + Math.round(motion.energyLevel) + '%</span></div>');
        }
        if (!isCompatMode && motion.sedentaryDuration > 0) {
          var sedMin = Math.floor(motion.sedentaryDuration / 60000);
          if (sedMin > 0) {
            var sedEmoji = sedMin >= 60 ? '\ud83d\udea8' : sedMin >= 30 ? '\u26a0\ufe0f' : '\ud83e\ude91';
            motionRows.push('<div class="detail-stat-row"><span class="detail-stat-label">' + sedEmoji + ' \u4e45\u5750</span><span class="detail-stat-value">' + sedMin + ' \u5206\u949f</span></div>');
          }
        }
        if (motionRows.length > 0) {
          parts.push('<div class="detail-section-label">\ud83c\udfcb\ufe0f Motion \u5206\u6790</div>' + motionRows.join(''));
        }
      }

      // 健康数据
      if (health) {
        var healthRows = [];
        if (health.calories != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udd25 \u5361\u8def\u91cc</span><span class="detail-stat-value">' + health.calories + ' kcal</span></div>');
        if (health.stepCount != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udc5f \u6b65\u6570</span><span class="detail-stat-value">' + health.stepCount + '</span></div>');
        if (health.bloodOxygen != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83e\ude78 \u8840\u6c27</span><span class="detail-stat-value">' + health.bloodOxygen + '%</span></div>');
        if (health.distance != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udccf \u8ddd\u79bb</span><span class="detail-stat-value">' + health.distance.toFixed(2) + ' km</span></div>');
        if (health.speed != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\u26a1 \u901f\u5ea6</span><span class="detail-stat-value">' + health.speed.toFixed(1) + ' km/h</span></div>');
        if (health.bodyMass != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\u2696\ufe0f \u4f53\u91cd</span><span class="detail-stat-value">' + health.bodyMass + ' kg</span></div>');
        if (health.bmi != null) healthRows.push('<div class="detail-stat-row"><span class="detail-stat-label">\ud83d\udcd0 BMI</span><span class="detail-stat-value">' + health.bmi.toFixed(1) + '</span></div>');
        if (healthRows.length > 0) {
          parts.push('<div class="detail-section-label">\ud83d\udc8a \u5065\u5eb7\u6570\u636e</div>' + healthRows.join(''));
        }
      }

      return parts.length > 0 ? parts.join('') : '';
    }

    // ── 消息通道建立（所有函数已声明完毕，消息到达时可安全调用） ──
    window.addEventListener('message', function(event) {
      var msg = event.data;
      console.log('[HS-Stats] message received:', msg.type);
      if (msg.type === 'statsUpdate' && msg.data) {
        onUpdate(msg.data);
      } else if (msg.type === 'calendarData' && msg.data) {
        renderCalendar(msg.data.year, msg.data.month, msg.data.dates, msg.data.summaries);
      } else if (msg.type === 'daySummary' && msg.data) {
        renderDaySummary(msg.data.date, msg.data.summary, msg.data.motion, msg.data.healthSnapshot, msg.data.isCompatMode);
      }
    });

    // ── DOM 事件绑定（try-catch 保护，不影响消息通道和 ready 信号） ──
    try {
      // 日历导航按钮
      var cpEl = $('calPrev');
      if (cpEl) cpEl.addEventListener('click', function() {
        calMonth--;
        if (calMonth < 1) { calMonth = 12; calYear--; }
        vscode.postMessage({ type: 'requestCalendarData', year: calYear, month: calMonth });
      });
      var cnEl = $('calNext');
      if (cnEl) cnEl.addEventListener('click', function() {
        calMonth++;
        if (calMonth > 12) { calMonth = 1; calYear++; }
        vscode.postMessage({ type: 'requestCalendarData', year: calYear, month: calMonth });
      });

      // 日历日期点击 — 事件委托（避免 inline onclick 转义问题）
      var calGridEl = $('calGrid');
      if (calGridEl) calGridEl.addEventListener('click', function(e) {
        var target = e.target;
        while (target && target !== calGridEl) {
          if (target.classList && target.classList.contains('cal-day') && target.getAttribute('data-date')) {
            showDay(target.getAttribute('data-date'));
            return;
          }
          target = target.parentElement;
        }
      });
    } catch(domInitErr) {
      console.error('[HS-Stats] DOM event bindng error (non-fatal):', domInitErr);
    }

    // ── 通知扩展 Webview 已就绪 ──
    console.log('[HS-Stats] sending ready message');
    vscode.postMessage({ type: 'ready' });
    // 自动加载当月日历数据
    vscode.postMessage({ type: 'requestCalendarData', year: calYear, month: calMonth });
  </script>
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
