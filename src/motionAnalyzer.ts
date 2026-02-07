/**
 * Heart Socket - Motion Analyzer
 *
 * 基于 HDS Motion 数据的深度算法引擎：
 * - 敲代码强度检测（通过加速度抖动频率和幅度）
 * - 久坐提醒（步数 + 加速度综合判断）
 * - 姿态感知（手腕抬起检测）
 * - 心流状态检测
 * - 摸鱼指数计算
 */
import { EventEmitter } from 'events';
import type {
  MotionData,
  Vector3,
  CodingIntensityLevel,
  PostureState,
  FlowState,
  MotionAnalysisResult,
  MotionConfig,
} from './types';

/** 滑动窗口大小（秒） */
const WINDOW_SIZE_SEC = 3;
/** 最大缓冲区大小（按 50Hz 估算） */
const MAX_BUFFER_SIZE = WINDOW_SIZE_SEC * 50;

/** 久坐检测：活动阈值（步数增量） */
const SEDENTARY_STEP_THRESHOLD = 5;
/** 久坐检测：加速度活动阈值（g） */
const SEDENTARY_MOTION_THRESHOLD = 0.3;

/** 姿态检测：抬手角度阈值（rad，约 40 度） */
const RAISED_PITCH_THRESHOLD = 0.7; // ~40 度
/** 姿态检测：摸鱼角度阈值（rad，约 60 度） */
const SLACKING_PITCH_THRESHOLD = 1.05; // ~60 度

/** 心流检测：最低持续时间（ms） */
const FLOW_MIN_DURATION = 15 * 60 * 1000; // 15 分钟

/** 敲代码强度阈值（标准差 g） */
const INTENSITY_THRESHOLDS = {
  idle: 0.01,
  light: 0.05,
  moderate: 0.15,
  intense: 0.3,
};

export class MotionAnalyzer extends EventEmitter {
  private config: MotionConfig;

  // ── 原始数据缓冲 ──
  private motionBuffer: MotionData[] = [];
  private lastStepCount: number = 0;
  private lastHeartRate: number = 0;

  // ── 编辑器活动数据（兼容回退方案） ──
  private editorCharsPerSecond: number = 0;
  private lastEditorEditTime: number = 0;

  // ── 数据源追踪 ──
  private hasMotionData: boolean = false; // 是否有 Motion 传感器数据（HDS）

  // ── 分析状态 ──
  private currentIntensity: CodingIntensityLevel = 'idle';
  private currentPosture: PostureState = 'typing';
  private flowState: FlowState = { active: false, duration: 0 };
  private lastAnalysisResult: MotionAnalysisResult | null = null;

  // ── 计时器 ──
  private lastActiveTime: number = Date.now();
  private raisedStartTime: number | null = null;
  private flowStartTime: number | null = null;
  private lastAnalysisTime: number = Date.now();
  private analysisTimer: ReturnType<typeof setInterval> | null = null;

  // ── 统计累积 ──
  private heartRateHistory: number[] = [];

  /** 分析周期（ms） */
  private static readonly ANALYSIS_INTERVAL = 1000; // 1 秒

  constructor(config: MotionConfig) {
    super();
    this.config = config;
    if (config.enableMotion) {
      this.startAnalysis();
    }
  }

  /**
   * 输入原始 Motion 数据
   */
  feedMotion(data: MotionData): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.hasMotionData = true; // 标记有 Motion 数据
    this.motionBuffer.push(data);

    // 限制缓冲区大小（滑动窗口）
    if (this.motionBuffer.length > MAX_BUFFER_SIZE) {
      this.motionBuffer.shift();
    }
  }

  /**
   * 输入编辑器活动数据（兼容回退方案）
   *
   * 当数据源不支持 Motion 传感器时使用此方法。
   *
   * @param charsPerSecond - 每秒字符变更数（插入+删除）
   * @param lastEditTime - 最后编辑时间戳
   */
  feedTypingActivity(charsPerSecond: number, lastEditTime: number): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.editorCharsPerSecond = charsPerSecond;
    this.lastEditorEditTime = lastEditTime;

    // 有编辑活动 → 更新活动时间（用于久坐检测）
    if (charsPerSecond > 0) {
      this.lastActiveTime = Date.now();
    }
  }

  /**
   * 输入步数（用于久坐检测）
   */
  feedStepCount(count: number): void {
    if (!this.config.enableMotion) {
      return;
    }

    const deltaSteps = count - this.lastStepCount;
    this.lastStepCount = count;

    // 步数明显增长 → 视为活动
    if (deltaSteps >= SEDENTARY_STEP_THRESHOLD) {
      this.lastActiveTime = Date.now();
    }
  }

  /**
   * 输入心率（辅助心流检测）
   */
  feedHeartRate(bpm: number): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.lastHeartRate = bpm;
    this.heartRateHistory.push(bpm);

    // 保留最近 5 分钟心率（按每秒 1 条估算）
    if (this.heartRateHistory.length > 300) {
      this.heartRateHistory.shift();
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: MotionConfig): void {
    this.config = config;

    if (!config.enableMotion && this.analysisTimer) {
      this.stopAnalysis();
    } else if (config.enableMotion && !this.analysisTimer) {
      this.startAnalysis();
    }
  }

  /**
   * 获取最新的分析结果（供外部直接读取，不依赖事件）
   */
  getLatestResult(): MotionAnalysisResult | null {
    return this.lastAnalysisResult;
  }

  /**
   * 是否处于兼容模式（无 Motion 传感器数据）
   *
   * 当使用 Pulsoid/HypeRate/Custom Provider 时，
   * 没有 Apple Watch Motion 传感器数据，
   * 部分功能使用编辑器活动回退方案。
   */
  isCompatMode(): boolean {
    return !this.hasMotionData;
  }

  /**
   * 销毁
   */
  dispose(): void {
    this.stopAnalysis();
    this.removeAllListeners();
  }

  // ─── 私有方法：定时分析 ───────────────────────────

  private startAnalysis(): void {
    if (this.analysisTimer) {
      return;
    }

    this.analysisTimer = setInterval(() => {
      this.analyze();
    }, MotionAnalyzer.ANALYSIS_INTERVAL);
  }

  private stopAnalysis(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
  }

  /**
   * 主分析逻辑（每秒执行一次）
   *
   * 支持双数据源：
   * - HDS 模式：使用 Motion 传感器数据（加速度、姿态）
   * - 兼容模式：使用编辑器活动数据（Pulsoid/HypeRate/Custom）
   */
  private analyze(): void {
    // 兼容回退：即使没有 Motion 数据，也可以基于编辑器活动分析
    // （仅在 AI 辅助编程场景下结果会偏低）

    const now = Date.now();
    const deltaTime = now - this.lastAnalysisTime;
    this.lastAnalysisTime = now;

    // 1. 计算敲代码强度
    const newIntensity = this.calculateCodingIntensity();
    if (newIntensity !== this.currentIntensity) {
      this.currentIntensity = newIntensity;
      this.emit('codingIntensityChange', newIntensity);
    }

    // 2. 检测手腕姿态
    const newPosture = this.detectPosture();
    if (newPosture !== this.currentPosture) {
      this.currentPosture = newPosture;
      this.emit('postureChange', newPosture);
    }

    // 3. 久坐检测
    this.checkSedentary(now);

    // 4. 姿态告警检测
    this.checkPostureAlert(now);

    // 5. 心流状态检测
    this.checkFlowState(now, deltaTime);

    // 6. 发送聚合分析结果
    this.emitAnalysisResult(now);
  }

  // ─── 算法实现 ─────────────────────────────────────

  /**
   * 计算敲代码强度
   * 基于去重力后加速度的标准差和过零率（有 Motion 数据时）
   * 或基于编辑器字符变更速率（兼容回退方案）
   */
  private calculateCodingIntensity(): CodingIntensityLevel {
    // 优先使用 Motion 传感器数据（HDS）
    if (this.hasMotionData && this.motionBuffer.length >= 10) {
      return this.calculateIntensityFromMotion();
    }

    // 兼容回退：使用编辑器活动数据
    return this.calculateIntensityFromEditor();
  }

  /**
   * 基于 Motion 传感器计算强度（HDS 模式）
   */
  private calculateIntensityFromMotion(): CodingIntensityLevel {
    // 计算用户加速度（去除重力分量）
    const userAccels = this.motionBuffer.map((m) => {
      const ux = m.accelerometer.x - m.gravity.x;
      const uy = m.accelerometer.y - m.gravity.y;
      const uz = m.accelerometer.z - m.gravity.z;
      return Math.sqrt(ux * ux + uy * uy + uz * uz);
    });

    // 计算标准差
    const mean = userAccels.reduce((sum, v) => sum + v, 0) / userAccels.length;
    const variance = userAccels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / userAccels.length;
    const std = Math.sqrt(variance);

    // 根据标准差分级
    if (std < INTENSITY_THRESHOLDS.idle) {
      return 'idle';
    } else if (std < INTENSITY_THRESHOLDS.light) {
      return 'light';
    } else if (std < INTENSITY_THRESHOLDS.moderate) {
      return 'moderate';
    } else if (std < INTENSITY_THRESHOLDS.intense) {
      return 'intense';
    } else {
      return 'furious';
    }
  }

  /**
   * 基于编辑器活动计算强度（兼容回退方案）
   *
   * ⚠️ 注意：此方法仅检测编辑器文本变更，无法检测 AI 代码生成、
   * 阅读文档、浏览网页等活动，结果会偏低。
   */
  private calculateIntensityFromEditor(): CodingIntensityLevel {
    const cps = this.editorCharsPerSecond;

    // 字符数/秒 → 强度映射（经验阈值）
    if (cps < 1) {
      return 'idle';
    } else if (cps < 5) {
      return 'light';
    } else if (cps < 15) {
      return 'moderate';
    } else if (cps < 30) {
      return 'intense';
    } else {
      return 'furious';
    }
  }

  /**
   * 检测手腕姿态
   * 基于 pitch 角判断抬手状态
   *
   * ⚠️ 仅在有 Motion 传感器数据时可用（HDS）
   */
  private detectPosture(): PostureState {
    if (!this.hasMotionData || this.motionBuffer.length === 0) {
      return 'typing'; // 兼容回退：默认为正常打字姿势
    }

    // 取最近数据的平均 pitch
    const recentCount = Math.min(10, this.motionBuffer.length);
    const recentMotions = this.motionBuffer.slice(-recentCount);
    const avgPitch =
      recentMotions.reduce((sum, m) => sum + Math.abs(m.attitude.pitch), 0) / recentCount;

    // 判断姿态
    if (avgPitch > SLACKING_PITCH_THRESHOLD) {
      return 'slacking';
    } else if (avgPitch > RAISED_PITCH_THRESHOLD) {
      return 'raised';
    } else {
      return 'typing';
    }
  }

  /**
   * 久坐检测
   */
  private checkSedentary(now: number): void {
    const sedentaryMs = now - this.lastActiveTime;
    const sedentaryMinutes = sedentaryMs / 60_000;

    // 如果有 Motion 数据，检测加速度活动（大幅移动）
    if (this.hasMotionData && this.motionBuffer.length > 20) {
      const recentMotions = this.motionBuffer.slice(-20);
      const motionMagnitudes = recentMotions.map((m) => {
        const ux = m.accelerometer.x - m.gravity.x;
        const uy = m.accelerometer.y - m.gravity.y;
        const uz = m.accelerometer.z - m.gravity.z;
        return Math.sqrt(ux * ux + uy * uy + uz * uz);
      });

      const avgMagnitude = motionMagnitudes.reduce((s, v) => s + v, 0) / motionMagnitudes.length;

      // 大幅移动（如走路）→ 重置计时
      if (avgMagnitude > SEDENTARY_MOTION_THRESHOLD) {
        this.lastActiveTime = now;
        return;
      }
    }

    // 兼容回退：无 Motion 数据时，仅依赖编辑器活动时间
    // （lastActiveTime 在 feedTypingActivity 中更新）

    // 达到久坐提醒阈值
    if (sedentaryMinutes >= this.config.sedentaryMinutes) {
      const isHighHr = this.lastHeartRate > 0 && this.lastHeartRate >= 100;
      this.emit('sedentaryAlert', {
        duration: sedentaryMs,
        highHeartRate: isHighHr,
      });

      // 重置计时（避免频繁提醒）
      this.lastActiveTime = now;
    }
  }

  /**
   * 姿态告警检测（抬手摸鱼）
   */
  private checkPostureAlert(now: number): void {
    if (this.currentPosture === 'raised' || this.currentPosture === 'slacking') {
      if (!this.raisedStartTime) {
        this.raisedStartTime = now;
      }

      const raisedDuration = now - this.raisedStartTime;
      const thresholdMs = this.config.postureAlertSeconds * 1000;

      if (raisedDuration >= thresholdMs) {
        this.emit('postureAlert', {
          duration: raisedDuration,
          state: this.currentPosture,
        });

        // 重置计时（避免频繁提醒）
        this.raisedStartTime = now;
      }
    } else {
      // 放下手腕 → 重置
      this.raisedStartTime = null;
    }
  }

  /**
   * 心流状态检测
   * 条件：稳定打字 + 心率稳定 + 持续时间足够
   */
  private checkFlowState(now: number, deltaTime: number): void {
    const isTyping = this.currentIntensity === 'moderate' || this.currentIntensity === 'intense';
    const isStableHr = this.isHeartRateStable();

    if (isTyping && isStableHr) {
      if (!this.flowStartTime) {
        this.flowStartTime = now;
      }

      const flowDuration = now - this.flowStartTime;

      if (flowDuration >= FLOW_MIN_DURATION) {
        if (!this.flowState.active) {
          this.flowState.active = true;
          this.emit('flowStateChange', { active: true, duration: flowDuration });
        }

        // 更新心流持续时间
        this.flowState.duration = flowDuration;
      }
    } else {
      // 心流中断
      if (this.flowState.active) {
        this.flowState.active = false;
        this.emit('flowStateChange', { active: false, duration: this.flowState.duration });
      }

      this.flowStartTime = null;
      this.flowState.duration = 0;
    }
  }

  /**
   * 判断心率是否稳定（变异系数 < 5%）
   */
  private isHeartRateStable(): boolean {
    if (this.heartRateHistory.length < 30) {
      return false;
    }

    const recent = this.heartRateHistory.slice(-30);
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    if (mean === 0) { return false; }
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const std = Math.sqrt(variance);
    const cv = std / mean; // 变异系数

    return cv < 0.05;
  }

  /**
   * 发送聚合分析结果
   */
  private emitAnalysisResult(now: number): void {
    const sedentaryDuration = now - this.lastActiveTime;
    const raisedDuration = this.raisedStartTime ? now - this.raisedStartTime : 0;

    // 计算摸鱼指数（0-100）
    const slackingIndex = this.calculateSlackingIndex(raisedDuration, sedentaryDuration);

    // 计算精力水平（0-100，简化版）
    const energyLevel = this.calculateEnergyLevel();

    const result: MotionAnalysisResult = {
      codingIntensity: this.currentIntensity,
      posture: this.currentPosture,
      flowState: { ...this.flowState }, // 浅拷贝避免引用泄漏
      slackingIndex,
      energyLevel,
      raisedDuration,
      sedentaryDuration,
    };

    this.lastAnalysisResult = result;
    this.emit('analysisResult', result);
  }

  /**
   * 计算摸鱼指数
   * 综合姿态、打字强度、步数活动
   */
  private calculateSlackingIndex(raisedDuration: number, sedentaryDuration: number): number {
    let score = 0;

    // 姿态评分（抬手 = 摸鱼）+ 持续时间加权
    if (this.currentPosture === 'slacking') {
      score += 30 + Math.min(20, Math.floor(raisedDuration / 10_000)); // 每10秒+1, 最多+20
    } else if (this.currentPosture === 'raised') {
      score += 20 + Math.min(10, Math.floor(raisedDuration / 10_000)); // 每10秒+1, 最多+10
    }

    // 打字强度评分（不打字 = 摸鱼）
    if (this.currentIntensity === 'idle') {
      score += 30;
    } else if (this.currentIntensity === 'light') {
      score += 20;
    }

    // 久坐评分（久坐 = 摸鱼）
    if (sedentaryDuration > 30 * 60_000) {
      score += 20;
    }

    return Math.min(100, score);
  }

  /**
   * 计算精力水平（简化版）
   * 基于心率趋势、活动量、当前时段
   */
  private calculateEnergyLevel(): number {
    let energy = 50; // 基础值

    // 心率偏低 → 精力可能不足
    if (this.lastHeartRate > 0 && this.lastHeartRate < 60) {
      energy -= 20;
    }

    // 打字强度高 → 精力充沛
    if (this.currentIntensity === 'intense' || this.currentIntensity === 'furious') {
      energy += 30;
    }

    // 心流状态 → 高精力
    if (this.flowState.active) {
      energy += 20;
    }

    // 时段因素（简化：下午精力下降）
    const hour = new Date().getHours();
    if (hour >= 14 && hour <= 16) {
      energy -= 10;
    }

    return Math.max(0, Math.min(100, energy));
  }
}
