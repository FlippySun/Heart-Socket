/**
 * Heart Socket - 状态栏管理器
 *
 * 负责在 VSCode 状态栏显示心率数据，包括：
 * - 心率数值 + 心跳图标
 * - 根据心率区间自动变色
 * - 心跳动画效果
 * - 连接状态指示
 * - 敲代码强度指示器（Motion）
 */
import * as vscode from 'vscode';
import { ConnectionStatus } from './types';
import type {
  HeartRateData,
  HealthSnapshot,
  HeartRateZoneName,
  HeartSocketConfig,
  CodingIntensityLevel,
  MotionAnalysisResult,
} from './types';

/** 心率区间对应的颜色主题（9 级） */
const ZONE_COLORS: Record<HeartRateZoneName, vscode.ThemeColor> = {
  low: new vscode.ThemeColor('charts.blue'),
  deepRelax: new vscode.ThemeColor('charts.blue'),
  relax: new vscode.ThemeColor('charts.blue'),
  calm: new vscode.ThemeColor('charts.green'),
  lightFocus: new vscode.ThemeColor('charts.green'),
  focused: new vscode.ThemeColor('charts.purple'),
  tense: new vscode.ThemeColor('charts.yellow'),
  stressed: new vscode.ThemeColor('charts.orange'),
  extreme: new vscode.ThemeColor('charts.red'),
};

/** 心率区间对应的描述（9 级） */
const ZONE_LABELS: Record<HeartRateZoneName, string> = {
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

/** 心跳动画图标交替 */
const HEART_ICONS = ['♥', '♡'];

/** 敲代码强度对应的图标和描述 */
const CODING_INTENSITY_ICONS: Record<CodingIntensityLevel, string> = {
  idle: '💤',
  light: '⌨️',
  moderate: '⚡',
  intense: '🔥',
  furious: '🚀',
};

const CODING_INTENSITY_LABELS: Record<CodingIntensityLevel, string> = {
  idle: '空闲',
  light: '轻度打字',
  moderate: '中等打字',
  intense: '密集打字',
  furious: '疯狂打字',
};

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private animationFrame: number = 0;
  private lastBpm: number = 0;
  private lastZone: HeartRateZoneName = 'calm';
  private connectionStatus: ConnectionStatus = ConnectionStatus.Disconnected;
  private config: HeartSocketConfig;
  private healthSnapshot: HealthSnapshot = {};

  // Motion 相关状态
  private codingIntensity: CodingIntensityLevel = 'idle';
  private motionAnalysis: MotionAnalysisResult | null = null;

  // 心率统计摘要（用于 tooltip 显示）
  private heartRateStats: { min: number; max: number; avg: number } | null = null;

  /** 节流：最小更新间隔 (ms) */
  private lastUpdateTime: number = 0;
  private readonly UPDATE_THROTTLE = 500;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;

  constructor(config: HeartSocketConfig) {
    this.config = config;

    // 创建状态栏项
    const alignment =
      config.statusBarPosition === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;

    this.statusBarItem = vscode.window.createStatusBarItem(
      alignment,
      config.statusBarPosition === 'left' ? 100 : 0
    );

    this.statusBarItem.command = 'heartSocket.quickActions';
    this.showDisconnected();
    this.statusBarItem.show();
  }

  /**
   * 更新心率显示
   */
  updateHeartRate(data: HeartRateData, healthSnapshot?: HealthSnapshot): void {
    this.lastBpm = data.bpm;
    this.lastZone = this.getZone(data.bpm);
    if (healthSnapshot) {
      this.healthSnapshot = healthSnapshot;
    }
    this.throttledUpdate();
  }

  /**
   * 更新健康数据快照（仅刷新 tooltip）
   */
  updateHealthSnapshot(snapshot: HealthSnapshot): void {
    this.healthSnapshot = snapshot;
    // 只更新 tooltip，不触发主文本重渲染
    if (this.lastBpm > 0) {
      this.statusBarItem.tooltip = this.buildTooltip();
    }
  }

  /**
   * 更新连接状态
   * @param context 可选上下文：waitingForDevice 表示首次等待设备连接（而非断开后重连）
   */
  updateStatus(status: ConnectionStatus, context?: { waitingForDevice?: boolean }): void {
    this.connectionStatus = status;

    switch (status) {
      case ConnectionStatus.Disconnected:
        this.stopAnimation();
        this.showDisconnected();
        break;
      case ConnectionStatus.Connecting:
        this.stopAnimation();
        this.showConnecting();
        break;
      case ConnectionStatus.Connected:
        this.statusBarItem.command = 'heartSocket.quickActions';
        if (this.config.showHeartbeatAnimation) {
          this.startAnimation();
        }
        break;
      case ConnectionStatus.Reconnecting:
        this.stopAnimation();
        if (context?.waitingForDevice) {
          this.showWaitingForDevice();
        } else {
          this.showReconnecting();
        }
        break;
      case ConnectionStatus.Error:
        this.stopAnimation();
        this.showError();
        break;
    }
  }

  /**
   * 更新敲代码强度
   */
  updateCodingIntensity(level: CodingIntensityLevel): void {
    this.codingIntensity = level;
    this.throttledUpdate();
  }

  /**
   * 更新 Motion 分析结果
   */
  updateMotionAnalysis(result: MotionAnalysisResult): void {
    this.motionAnalysis = result;
    // 仅更新 tooltip，不触发主文本重渲染
    if (this.lastBpm > 0) {
      this.statusBarItem.tooltip = this.buildTooltip();
    }
  }

  /**
   * 更新心率统计摘要（用于 tooltip 显示 min/max/avg）
   */
  updateHeartRateStats(stats: { min: number; max: number; avg: number }): void {
    this.heartRateStats = stats;
  }

  /**
   * 更新配置
   */
  updateConfig(config: HeartSocketConfig): void {
    this.config = config;
    // 重新渲染当前状态
    if (this.lastBpm > 0) {
      this.renderHeartRate();
    }
  }

  /**
   * 销毁
   */
  dispose(): void {
    this.stopAnimation();
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
    this.statusBarItem.dispose();
  }

  // ─── 私有方法 ───────────────────────────────────

  /**
   * 节流更新
   */
  private throttledUpdate(): void {
    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;

    if (elapsed >= this.UPDATE_THROTTLE) {
      this.lastUpdateTime = now;
      this.renderHeartRate();
    } else if (!this.pendingUpdate) {
      this.pendingUpdate = setTimeout(() => {
        this.pendingUpdate = null;
        this.lastUpdateTime = Date.now();
        this.renderHeartRate();
      }, this.UPDATE_THROTTLE - elapsed);
    }
  }

  /**
   * 渲染心率显示
   */
  private renderHeartRate(): void {
    const icon = this.config.showHeartbeatAnimation
      ? HEART_ICONS[this.animationFrame % HEART_ICONS.length]
      : HEART_ICONS[0];

    // 主显示：心率 + 敲代码强度（可选）
    let text = `${icon} ${this.lastBpm} BPM`;
    if (this.config.showCodingIntensity && this.codingIntensity !== 'idle') {
      const intensityIcon = CODING_INTENSITY_ICONS[this.codingIntensity];
      text += ` ${intensityIcon}`;
    }

    this.statusBarItem.text = text;
    this.statusBarItem.color = ZONE_COLORS[this.lastZone];
    this.statusBarItem.tooltip = this.buildTooltip();
  }

  /**
   * 构建 tooltip 信息
   */
  private buildTooltip(): string {
    const zoneLabel = ZONE_LABELS[this.lastZone];
    const lines = [
      `Heart Socket - ${zoneLabel}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💓 当前心率: ${this.lastBpm} BPM`,
      `📊 心率区间: ${zoneLabel}`,
    ];

    // 添加心率统计摘要（min/max/avg）
    if (this.heartRateStats) {
      const { min, max, avg } = this.heartRateStats;
      const minDisplay = min === Infinity ? '--' : min;
      const maxDisplay = max === -Infinity ? '--' : max;
      lines.push(`📉 最低/最高/平均: ${minDisplay} / ${maxDisplay} / ${avg} BPM`);
    }

    // 添加敲代码强度
    if (this.config.showCodingIntensity) {
      const intensityIcon = CODING_INTENSITY_ICONS[this.codingIntensity];
      const intensityLabel = CODING_INTENSITY_LABELS[this.codingIntensity];
      lines.push(`⌨️ 打字强度: ${intensityIcon} ${intensityLabel}`);
    }

    // 添加 Motion 分析结果
    if (this.motionAnalysis) {
      if (this.config.showFlowState && this.motionAnalysis.flowState.active) {
        const flowMinutes = Math.floor(this.motionAnalysis.flowState.duration / 60000);
        lines.push(
          `🎯 心流状态: 已持续 ${flowMinutes} 分钟`
        );
      }

      if (this.config.showSlackingIndex) {
        const slackingEmoji =
          this.motionAnalysis.slackingIndex < 30
            ? '🌟'
            : this.motionAnalysis.slackingIndex < 50
              ? '👍'
              : this.motionAnalysis.slackingIndex < 70
                ? '🤔'
                : '🐟';
        lines.push(
          `${slackingEmoji} 摸鱼指数: ${Math.round(this.motionAnalysis.slackingIndex)}/100`
        );
      }

      // 精力水平
      lines.push(
        `🔋 精力水平: ${Math.round(this.motionAnalysis.energyLevel)}%`
      );

      // 姿态状态（中文翻译）
      const postureMap: Record<string, { emoji: string; label: string }> = {
        typing: { emoji: '⌨️', label: '打字中' },
        raised: { emoji: '🖐️', label: '抬手' },
        slacking: { emoji: '🤔', label: '摸鱼' },
      };
      const postureInfo = postureMap[this.motionAnalysis.posture] ?? { emoji: '❓', label: this.motionAnalysis.posture };
      lines.push(`${postureInfo.emoji} 姿态: ${postureInfo.label}`);

      // 久坐时长
      if (this.motionAnalysis.sedentaryDuration > 0) {
        const sedentaryMinutes = Math.floor(this.motionAnalysis.sedentaryDuration / 60000);
        if (sedentaryMinutes > 0) {
          const sedentaryEmoji = sedentaryMinutes >= 60 ? '🚨' : sedentaryMinutes >= 30 ? '⚠️' : '🪑';
          lines.push(`${sedentaryEmoji} 久坐时长: ${sedentaryMinutes} 分钟`);
        }
      }
    }

    // 添加健康数据
    const healthLines = this.buildHealthLines();
    if (healthLines.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(...healthLines);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🔗 连接状态: ${this.getStatusLabel()}`);
    lines.push(``);
    lines.push(`点击断开连接`);

    return lines.join('\n');
  }

  /**
   * 构建健康数据行
   */
  private buildHealthLines(): string[] {
    const lines: string[] = [];
    const s = this.healthSnapshot;

    if (s.calories !== undefined) {
      lines.push(`🔥 卡路里: ${s.calories} kcal`);
    }
    if (s.stepCount !== undefined) {
      lines.push(`👟 步数: ${s.stepCount}`);
    }
    if (s.bloodOxygen !== undefined) {
      lines.push(`🩸 血氧: ${s.bloodOxygen}%`);
    }
    if (s.distance !== undefined) {
      lines.push(`📏 距离: ${s.distance.toFixed(2)} km`);
    }
    if (s.speed !== undefined) {
      lines.push(`⚡ 速度: ${s.speed.toFixed(1)} km/h`);
    }
    if (s.bodyMass !== undefined) {
      lines.push(`⚖️ 体重: ${s.bodyMass} kg`);
    }
    if (s.bmi !== undefined) {
      lines.push(`📐 BMI: ${s.bmi.toFixed(1)}`);
    }

    return lines;
  }

  private getStatusLabel(): string {
    const labels: Record<string, string> = {
      disconnected: '未连接',
      connecting: '连接中...',
      connected: '已连接',
      reconnecting: '重连中...',
      error: '连接错误',
    };
    return labels[this.connectionStatus] ?? '未知';
  }

  /**
   * 获取心率区间
   */
  private getZone(bpm: number): HeartRateZoneName {
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
   * 启动心跳动画
   */
  private startAnimation(): void {
    this.stopAnimation();
    this.animationFrame = 0;
    this.animationTimer = setInterval(() => {
      this.animationFrame++;
      if (this.lastBpm > 0) {
        this.renderHeartRate();
      }
    }, 800); // 每 800ms 切换一次图标，模拟心跳
  }

  private stopAnimation(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  // ─── 状态显示 ───────────────────────────────────

  private showDisconnected(): void {
    this.statusBarItem.text = `$(heart) Heart Socket`;
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = 'Heart Socket - 点击连接心率监测';
    this.statusBarItem.command = 'heartSocket.connect';
  }

  private showConnecting(): void {
    this.statusBarItem.text = `$(loading~spin) 连接中...`;
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = 'Heart Socket - 正在连接...';
  }

  private showWaitingForDevice(): void {
    this.statusBarItem.text = `$(watch) 等待连接...`;
    this.statusBarItem.color = new vscode.ThemeColor('charts.green');
    this.statusBarItem.tooltip = 'Heart Socket - 服务已启动，等待设备连接...\n\n请确保设备与电脑在同一网络';
  }

  private showReconnecting(): void {
    this.statusBarItem.text = `$(sync~spin) 重连中...`;
    this.statusBarItem.color = new vscode.ThemeColor('charts.yellow');
    this.statusBarItem.tooltip = 'Heart Socket - 设备断开，正在等待重新连接...';
  }

  private showError(): void {
    this.statusBarItem.text = `$(error) Heart Socket`;
    this.statusBarItem.color = new vscode.ThemeColor('charts.red');
    this.statusBarItem.tooltip = 'Heart Socket - 连接失败，点击重试';
    this.statusBarItem.command = 'heartSocket.connect';
  }
}
