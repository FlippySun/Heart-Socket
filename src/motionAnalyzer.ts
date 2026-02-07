/**
 * Heart Socket - Motion Analyzer (v2 — 科学优化版)
 *
 * 基于 GGIR/Hildebrand/Borbély 等学术研究的深度算法引擎：
 * - 🏋️ 运动强度检测：EMA 低通滤波器实时估计重力 + ENMO 标准指标
 * - 🪑 久坐检测：ENMO<40mg + 10分钟 bout + 活动中断验证（GGIR 标准）
 * - 🤚 姿态感知：加速度计重力分量推算倾斜角 + 静止守卫
 * - 🧘 心流检测：5维信号融合评分 + 滞回设计（进入≥70/退出<50）
 * - 🐟 摸鱼指数：EWTR 有效工作时间比率 + 四维度评分 + 减免机制
 * - ⚡ 精力水平：昼夜节律余弦模型(Process C) + HR偏差 + 疲劳累积
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

// ─── 信号处理常量 ──────────────────────────────────

/**
 * EMA 低通滤波器系数 (α)
 * 用于从原始加速度中估计重力分量
 * α = 0.1 → 保守值，1Hz 下约 10 秒收敛到真实重力方向
 * 公式: gravity_est[n] = α · raw[n] + (1−α) · gravity_est[n−1]
 */
const EMA_ALPHA = 0.1;

/** ENMO 缓冲区大小（秒，1Hz 采样 → 每秒1条） */
const ENMO_BUFFER_SIZE = 600; // 最近 10 分钟

/** 原始 Motion 数据缓冲区大小 */
const MOTION_BUFFER_SIZE = 30; // 最近 30 秒（1Hz）

// ─── 运动强度常量 (GGIR/Hildebrand 标准) ────────────

/**
 * ENMO 强度阈值 (单位: g)
 * 基于 Hildebrand 非惯用手腕 MVPA 切分点 + GGIR 不活动标准
 * idle:     < 30mg → 几乎不动（发呆/摸鱼）
 * light:    30-60mg → 轻微活动（鼠标/触控板）
 * moderate: 60-100mg → 中等活动（正常打字）
 * intense:  100-200mg → 高强度（快速打字/手势）
 * furious:  > 200mg → 剧烈活动（走动/大幅手部运动）
 */
const ENMO_THRESHOLDS = {
  idle: 0.030,
  light: 0.060,
  moderate: 0.100,
  intense: 0.200,
};

/** 强度计算滑动窗口大小（秒） */
const INTENSITY_WINDOW_SEC = 5;

// ─── 姿态检测常量 ──────────────────────────────────

/**
 * 姿态检测：静止守卫阈值 (g)
 * 仅当高通滤波后加速度幅度 < 此值时，重力估计才可信
 */
const POSTURE_MOTION_TOLERANCE = 0.05;

/** 姿态检测：正常打字上限角度 (rad, ~20°) */
const POSTURE_TYPING_THRESHOLD = 0.35;
/** 姿态检测：轻微抬手上限角度 (rad, ~50°) */
const POSTURE_RAISED_THRESHOLD = 0.87;
/** 姿态 pitch 中位数滤波窗口 (秒) */
const POSTURE_MEDIAN_WINDOW = 5;

// ─── 久坐检测常量 (GGIR bout 标准) ─────────────────

/** 久坐检测：步数活动阈值 */
const SEDENTARY_STEP_THRESHOLD = 5;
/** 不活动 ENMO 阈值 (g) — GGIR 标准 40mg */
const SEDENTARY_ENMO_THRESHOLD = 0.040;
/** 不活动 bout 容忍度（允许该比例的 epoch 超标） */
const SEDENTARY_BOUT_TOLERANCE = 0.10;
/** 活动中断验证：至少连续 N 秒的活动才重置久坐 */
const ACTIVE_BREAK_DURATION = 60; // 60 秒
/** 活动中断验证：活动 epoch 占比阈值 */
const ACTIVE_BREAK_RATIO = 0.80;
/** 活动中断 ENMO 阈值 (g) */
const ACTIVE_BREAK_ENMO = 0.100;
/** 不活动 epoch 缓冲区大小（秒） */
const INACTIVE_EPOCH_BUFFER_SIZE = 3600; // 最近 60 分钟

// ─── 心流检测常量 ──────────────────────────────────

/** 心流检测各维度权重 */
const FLOW_WEIGHTS = {
  typingConsistency: 35,
  motionStillness: 20,
  hrStability: 15,
  durationBonus: 20,
  interruptionPenalty: 10,
};
/** 心流进入阈值 (FlowScore ≥ 此值) */
const FLOW_ENTER_THRESHOLD = 70;
/** 心流退出阈值 (FlowScore < 此值) */
const FLOW_EXIT_THRESHOLD = 50;
/** 心流进入需连续满足次数（每 30 秒计算一次，4次 = 2分钟） */
const FLOW_ENTER_COUNT = 4;
/** 心流退出需连续不满足次数（2次 = 1分钟） */
const FLOW_EXIT_COUNT = 2;
/** 心流评分计算周期（秒） */
const FLOW_SCORE_INTERVAL = 30;
/** 心流评分历史窗口（用于打字持续性计算，5分钟 = 300秒） */
const FLOW_TYPING_WINDOW = 300;

// ─── 精力水平常量 ──────────────────────────────────

/** 精力默认心率基线 (bpm) */
const DEFAULT_HR_BASELINE = 70;
/** 个人心率基线 EMA 系数（缓慢更新） */
const HR_BASELINE_ALPHA = 0.01;

export class MotionAnalyzer extends EventEmitter {
  private config: MotionConfig;

  // ── 原始数据缓冲 ──
  private motionBuffer: MotionData[] = [];
  private lastStepCount: number = 0;
  private lastHeartRate: number = 0;

  // ── 编辑器活动数据（兼容回退方案） ──
  private editorCharsPerSecond: number = 0;
  private lastEditorEditTime: number = Date.now(); // v2 fix: 避免启动初期误判

  // ── 数据源追踪 ──
  private hasMotionData: boolean = false; // 是否有 Motion 传感器数据（HDS）

  // ── EMA 重力估计 (v2 新增) ──
  private gravityEst: Vector3 = { x: 0, y: 0, z: -1 }; // 初始假设手腕平放
  private gravityInitialized: boolean = false;

  // ── ENMO 缓冲区 (v2 新增) ──
  private enmoBuffer: number[] = [];

  // ── 不活动 epoch 缓冲区 (v2 久坐检测用) ──
  private inactiveEpochBuffer: boolean[] = [];

  // ── 编辑器活动缓冲区 (v2 心流检测用) ──
  private editorActivityBuffer: number[] = []; // cps 历史

  // ── 姿态估计 (v2 新增) ──
  private lastReliablePitch: number = 0; // 最后一次可靠的倾斜角
  private orientationReliable: boolean = false; // 当前倾斜估计是否可信
  private pitchHistory: number[] = []; // 中位数滤波缓冲

  // ── 心流评分 (v2 新增) ──
  private flowScoreHistory: number[] = []; // 最近的 FlowScore 值
  private flowCandidateStartTime: number | null = null;
  private lastFlowScoreTime: number = 0;

  // ── 精力评估 (v2 新增) ──
  private personalHRBaseline: number = DEFAULT_HR_BASELINE;
  private sessionStartTime: number = Date.now();

  // ── 分析状态 ──
  private currentIntensity: CodingIntensityLevel = 'idle';
  private currentPosture: PostureState = 'typing';
  private flowState: FlowState = { active: false, duration: 0 };
  private lastAnalysisResult: MotionAnalysisResult | null = null;

  // ── 计时器 ──
  private lastActiveTime: number = Date.now();
  private raisedStartTime: number | null = null;
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
   *
   * v2: 新增 EMA 重力估计 + ENMO 计算 + 不活动 epoch 判定
   */
  feedMotion(data: MotionData): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.hasMotionData = true;

    // ── 1. EMA 低通滤波器：实时估计重力方向 ──
    // gravity_est[n] = α · raw[n] + (1−α) · gravity_est[n−1]
    const raw = data.accelerometer;
    if (!this.gravityInitialized) {
      // 第一个样本直接作为初始重力估计
      this.gravityEst = { x: raw.x, y: raw.y, z: raw.z };
      this.gravityInitialized = true;
    } else {
      this.gravityEst.x = EMA_ALPHA * raw.x + (1 - EMA_ALPHA) * this.gravityEst.x;
      this.gravityEst.y = EMA_ALPHA * raw.y + (1 - EMA_ALPHA) * this.gravityEst.y;
      this.gravityEst.z = EMA_ALPHA * raw.z + (1 - EMA_ALPHA) * this.gravityEst.z;
    }

    // ── 2. 计算 ENMO (Euclidean Norm Minus One) ──
    // ENMO = max(||accel|| - 1.0, 0)
    // 国际标准腕部活动量化指标 (GGIR)
    const vm = Math.sqrt(raw.x * raw.x + raw.y * raw.y + raw.z * raw.z);
    const enmo = Math.max(vm - 1.0, 0);
    this.enmoBuffer.push(enmo);
    if (this.enmoBuffer.length > ENMO_BUFFER_SIZE) {
      this.enmoBuffer.shift();
    }

    // ── 3. 不活动 epoch 判定（久坐检测用） ──
    const isInactive = enmo < SEDENTARY_ENMO_THRESHOLD;
    this.inactiveEpochBuffer.push(isInactive);
    if (this.inactiveEpochBuffer.length > INACTIVE_EPOCH_BUFFER_SIZE) {
      this.inactiveEpochBuffer.shift();
    }

    // ── 4. 倾斜角估计（姿态检测用） ──
    // 仅在相对静止时计算（高通分量 < 阈值 → 重力估计可信）
    const dx = raw.x - this.gravityEst.x;
    const dy = raw.y - this.gravityEst.y;
    const dz = raw.z - this.gravityEst.z;
    const hpfvm = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (hpfvm < POSTURE_MOTION_TOLERANCE) {
      // 设备相对静止，重力估计可信
      const gnorm = Math.sqrt(
        this.gravityEst.x * this.gravityEst.x +
        this.gravityEst.y * this.gravityEst.y +
        this.gravityEst.z * this.gravityEst.z
      );
      if (gnorm > 0.5) { // 安全校验：重力幅度应接近 1g
        // 倾斜角: 设备平面与水平面的夹角（坐标系无关）
        // arccos(|gz| / ||g||) → 0°=平放, 90°=竖直
        // 不依赖具体坐标轴方向，左右手佩戴均正确
        const tiltAngle = Math.acos(
          Math.min(1, Math.abs(this.gravityEst.z) / gnorm)
        );
        this.pitchHistory.push(tiltAngle);
        if (this.pitchHistory.length > POSTURE_MEDIAN_WINDOW) {
          this.pitchHistory.shift();
        }
        this.orientationReliable = true;
      }
    } else {
      this.orientationReliable = false;
    }

    // ── 5. 保留原始 motion 缓冲（用于调试和后续分析） ──
    this.motionBuffer.push(data);
    if (this.motionBuffer.length > MOTION_BUFFER_SIZE) {
      this.motionBuffer.shift();
    }
  }

  /**
   * 输入编辑器活动数据（兼容回退方案 + 心流检测信号）
   *
   * v2: 编辑器活动缓冲区改由 analyze() 每秒主动追加，此处仅更新瞬时值
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
   * 输入心率（辅助心流检测 + 精力评估）
   *
   * v2: 新增个人心率基线 EMA 估计
   */
  feedHeartRate(bpm: number): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.lastHeartRate = bpm;
    this.heartRateHistory.push(bpm);

    // 保留最近 5 分钟心率（按每 5 秒 1 条估算）
    if (this.heartRateHistory.length > 300) {
      this.heartRateHistory.shift();
    }

    // v2: 更新个人心率基线（EMA 缓慢跟踪）
    // 只在静息状态下更新基线（intensity 为 idle/light 时）
    if (this.currentIntensity === 'idle' || this.currentIntensity === 'light') {
      this.personalHRBaseline =
        HR_BASELINE_ALPHA * bpm + (1 - HR_BASELINE_ALPHA) * this.personalHRBaseline;
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

    // v2 fix: 每秒主动补充编辑器活动缓冲区，确保时间序列连续
    // （feedTypingActivity 可能不是每秒都触发）
    this.editorActivityBuffer.push(this.editorCharsPerSecond);
    if (this.editorActivityBuffer.length > FLOW_TYPING_WINDOW) {
      this.editorActivityBuffer.shift();
    }

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
   * v2: 基于 ENMO 滑动窗口均值（有 Motion 数据时）
   * 或基于编辑器字符变更速率（兼容回退方案）
   */
  private calculateCodingIntensity(): CodingIntensityLevel {
    // 优先使用 Motion 传感器数据（HDS）— v2: 改用 ENMO 缓冲区判断
    if (this.hasMotionData && this.enmoBuffer.length >= 3) {
      return this.calculateIntensityFromMotion();
    }

    // 兼容回退：使用编辑器活动数据
    return this.calculateIntensityFromEditor();
  }

  /**
   * 基于 Motion 传感器计算强度（HDS 模式 — v2 ENMO 标准）
   *
   * 使用 ENMO (Euclidean Norm Minus One) 作为国际标准腕部活动指标
   * 阈值基于 GGIR/Hildebrand 研究为编程场景微调
   */
  private calculateIntensityFromMotion(): CodingIntensityLevel {
    // 取最近 N 秒的 ENMO 均值
    const windowSize = Math.min(INTENSITY_WINDOW_SEC, this.enmoBuffer.length);
    if (windowSize === 0) {
      return 'idle';
    }

    const recentEnmo = this.enmoBuffer.slice(-windowSize);
    const meanEnmo = recentEnmo.reduce((sum, v) => sum + v, 0) / recentEnmo.length;

    // 根据 ENMO 均值分级（阈值单位: g）
    if (meanEnmo < ENMO_THRESHOLDS.idle) {
      return 'idle';
    } else if (meanEnmo < ENMO_THRESHOLDS.light) {
      return 'light';
    } else if (meanEnmo < ENMO_THRESHOLDS.moderate) {
      return 'moderate';
    } else if (meanEnmo < ENMO_THRESHOLDS.intense) {
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
   * 检测手腕姿态 (v2 — 基于 EMA 重力向量推算倾斜角)
   *
   * 原理：当腕部相对静止时，加速度计读数 ≈ 重力。
   * EMA 低通滤波后的加速度 ≈ 重力向量方向，可反推手腕倾斜角。
   *
   * 守卫条件：仅在设备相对静止时（HPFVM < 阈值）计算倾斜角，
   * 运动时保持上一次可靠读数。
   *
   * 使用 5 秒滑动中位数滤波消除噪声。
   */
  private detectPosture(): PostureState {
    if (!this.hasMotionData || this.pitchHistory.length === 0) {
      return 'typing'; // 兼容回退：默认为正常打字姿势
    }

    // 中位数滤波：取 pitchHistory 的中位数作为当前 pitch
    const sorted = [...this.pitchHistory].sort((a, b) => a - b);
    const medianPitch = sorted[Math.floor(sorted.length / 2)];

    // 更新最后可靠读数（仅在可靠时）
    if (this.orientationReliable) {
      this.lastReliablePitch = medianPitch;
    }

    // 使用最后可靠的 pitch 判断姿态
    const pitch = this.lastReliablePitch;

    if (pitch > POSTURE_RAISED_THRESHOLD) {
      return 'slacking'; // > 50° — 手腕大幅抬起
    } else if (pitch > POSTURE_TYPING_THRESHOLD) {
      return 'raised'; // 20°-50° — 手腕轻微抬起
    } else {
      return 'typing'; // < 20° — 手腕平放
    }
  }

  /**
   * 久坐检测 (v2 — GGIR bout 标准)
   *
   * 判定标准（基于 GGIR 国际标准）：
   * - 不活动 bout: 连续 N 分钟中 ≥90% 的 epoch 的 ENMO < 40mg
   * - 活动中断验证: 至少 60 秒的持续活动（≥80% epoch ENMO > 100mg）才重置计时
   *
   * 渐进式提醒：30分钟→轻提醒, 配置阈值→标准提醒
   */
  private checkSedentary(now: number): void {
    const sedentaryMs = now - this.lastActiveTime;
    const sedentaryMinutes = sedentaryMs / 60_000;

    // ── v2: 基于 ENMO 的 bout 判断 ──
    if (this.hasMotionData && this.inactiveEpochBuffer.length > 0) {
      // 检查最近的活动中断（是否有持续活动 → 重置久坐计时器）
      if (this.inactiveEpochBuffer.length >= ACTIVE_BREAK_DURATION) {
        const recentActive = this.inactiveEpochBuffer.slice(-ACTIVE_BREAK_DURATION);
        // inactive=false 意味着 ENMO > 阈值 → 活跃
        const activeCount = recentActive.filter(inactive => !inactive).length;
        const activeRatio = activeCount / recentActive.length;

        // 检查这些活跃 epoch 的 ENMO 是否足够大（区分打字和真正走动）
        if (activeRatio >= ACTIVE_BREAK_RATIO && this.enmoBuffer.length >= ACTIVE_BREAK_DURATION) {
          const recentEnmo = this.enmoBuffer.slice(-ACTIVE_BREAK_DURATION);
          const highEnmoCount = recentEnmo.filter(e => e > ACTIVE_BREAK_ENMO).length;
          const highEnmoRatio = highEnmoCount / recentEnmo.length;

          if (highEnmoRatio >= ACTIVE_BREAK_RATIO) {
            // 确认是真正的活动中断 → 重置
            this.lastActiveTime = now;
            return;
          }
        }
      }

      // 检查是否满足久坐 bout 条件
      const boutDuration = Math.min(
        this.config.sedentaryMinutes * 60,
        this.inactiveEpochBuffer.length
      );

      if (boutDuration >= this.config.sedentaryMinutes * 60) {
        const boutEpochs = this.inactiveEpochBuffer.slice(-boutDuration);
        const inactiveCount = boutEpochs.filter(inactive => inactive).length;
        const inactiveRatio = inactiveCount / boutEpochs.length;

        if (inactiveRatio >= (1 - SEDENTARY_BOUT_TOLERANCE)) {
          // 满足 bout 条件 → 发出久坐提醒
          const isHighHr = this.lastHeartRate > 0 && this.lastHeartRate >= 100;
          this.emit('sedentaryAlert', {
            duration: sedentaryMs,
            highHeartRate: isHighHr,
          });
          this.lastActiveTime = now;
          return;
        }
      }
    }

    // ── 兼容回退：无 Motion 数据时，仅依赖编辑器活动时间 ──
    if (sedentaryMinutes >= this.config.sedentaryMinutes) {
      const isHighHr = this.lastHeartRate > 0 && this.lastHeartRate >= 100;
      this.emit('sedentaryAlert', {
        duration: sedentaryMs,
        highHeartRate: isHighHr,
      });
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
   * 心流状态检测 (v2 — 多信号融合评分 + 滞回设计)
   *
   * 5 维信号融合评分 (0-100):
   *   1. 打字持续性 (35%) — 最近 5 分钟编辑器活动的持续性
   *   2. 动作稳定性 (20%) — ENMO 在打字模式范围内且稳定
   *   3. 心率稳定性 (15%) — 心率变异系数
   *   4. 持续时间加成 (20%) — 持续满足条件越久分数越高
   *   5. 中断惩罚 (10%) — 编辑器空闲中断
   *
   * 滞回设计：进入 ≥70 (连续 2 分钟), 退出 <50 (连续 1 分钟)
   */
  private checkFlowState(now: number, _deltaTime: number): void {
    // 每 30 秒计算一次 FlowScore
    if (now - this.lastFlowScoreTime < FLOW_SCORE_INTERVAL * 1000) {
      // 非计算周期：仅更新心流持续时间
      if (this.flowState.active && this.flowCandidateStartTime) {
        this.flowState.duration = now - this.flowCandidateStartTime;
      }
      return;
    }
    this.lastFlowScoreTime = now;

    // ── 1. 打字持续性 (0-1) ──
    const typingConsistency = this.calculateTypingConsistency();

    // ── 2. 动作稳定性 (0-1) ──
    const motionStillness = this.calculateMotionStillness();

    // ── 3. 心率稳定性 (0-1) ──
    const hrStability = this.calculateHRStability();

    // ── 4. 持续时间加成 (0-1) ──
    const candidateMinutes = this.flowCandidateStartTime
      ? (now - this.flowCandidateStartTime) / 60_000
      : 0;
    const durationBonus = Math.max(0, Math.min(1, (candidateMinutes - 10) / 15));
    // 10 分钟开始计分，25 分钟满分

    // ── 5. 中断惩罚 (0-1) ──
    const idleSeconds = (now - this.lastEditorEditTime) / 1000;
    const interruptionPenalty = Math.min(1, idleSeconds / 300);
    // 5 分钟无编辑 → 满惩罚

    // ── 综合评分 ──
    const flowScore =
      FLOW_WEIGHTS.typingConsistency * typingConsistency +
      FLOW_WEIGHTS.motionStillness * motionStillness +
      FLOW_WEIGHTS.hrStability * hrStability +
      FLOW_WEIGHTS.durationBonus * durationBonus -
      FLOW_WEIGHTS.interruptionPenalty * interruptionPenalty;

    const clampedScore = Math.max(0, Math.min(100, Math.round(flowScore)));

    // 记录 FlowScore 历史
    this.flowScoreHistory.push(clampedScore);
    if (this.flowScoreHistory.length > 10) {
      this.flowScoreHistory.shift();
    }

    // ── 滞回状态机 ──
    if (!this.flowState.active) {
      // 未在心流中：检查是否进入
      if (clampedScore >= FLOW_ENTER_THRESHOLD) {
        if (!this.flowCandidateStartTime) {
          this.flowCandidateStartTime = now;
        }

        // 检查最近 N 次评分是否都 ≥ 阈值
        const recentScores = this.flowScoreHistory.slice(-FLOW_ENTER_COUNT);
        const allAbove = recentScores.length >= FLOW_ENTER_COUNT &&
          recentScores.every(s => s >= FLOW_ENTER_THRESHOLD);

        if (allAbove) {
          this.flowState.active = true;
          this.flowState.duration = now - this.flowCandidateStartTime;
          this.emit('flowStateChange', { active: true, duration: this.flowState.duration });
        }
      } else {
        // 未达标 → 重置候选时间
        this.flowCandidateStartTime = null;
      }
    } else {
      // 已在心流中：检查是否退出
      const recentScores = this.flowScoreHistory.slice(-FLOW_EXIT_COUNT);
      const allBelow = recentScores.length >= FLOW_EXIT_COUNT &&
        recentScores.every(s => s < FLOW_EXIT_THRESHOLD);

      if (allBelow) {
        // 退出心流
        this.flowState.active = false;
        this.emit('flowStateChange', { active: false, duration: this.flowState.duration });
        this.flowCandidateStartTime = null;
        this.flowState.duration = 0;
      } else {
        // 维持心流
        if (this.flowCandidateStartTime) {
          this.flowState.duration = now - this.flowCandidateStartTime;
        }
      }
    }
  }

  /**
   * 计算打字持续性 (0-1)
   * 最近 5 分钟内有编辑活动的时间占比
   */
  private calculateTypingConsistency(): number {
    if (this.editorActivityBuffer.length === 0) {
      return 0;
    }
    const window = this.editorActivityBuffer.slice(-FLOW_TYPING_WINDOW);
    const activeCount = window.filter(cps => cps > 1).length;
    // 70% 以上时间在打字 → 满分
    return Math.min(1, activeCount / (window.length * 0.7));
  }

  /**
   * 计算动作稳定性 (0-1)
   * 打字时腕部有规律的小幅振动但无大幅运动
   */
  private calculateMotionStillness(): number {
    if (!this.hasMotionData || this.enmoBuffer.length < 30) {
      return 0.5; // 无数据时给中间值
    }

    const recent = this.enmoBuffer.slice(-FLOW_TYPING_WINDOW);
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const std = Math.sqrt(variance);

    // 有轻微但稳定的动作 = 打字模式
    // ENMO 均值在 0.02-0.15g 且 标准差 < 0.05g
    if (mean > 0.02 && mean < 0.15 && std < 0.05) {
      return 1.0 - Math.min(1, Math.max(0, (std - 0.01) / 0.04));
    }
    // v2 fix: 极静止场景（ENMO < 0.02g）可能是深度思考/阅读，给中间分数
    if (mean <= 0.02 && std < 0.02) {
      return 0.5;
    }
    return 0;
  }

  /**
   * 判断心率稳定性 (0-1)
   * v2: 基于变异系数 (CV)，使用 5 分钟窗口
   */
  private calculateHRStability(): number {
    if (this.heartRateHistory.length < 10) {
      return 0.5; // 数据不足时给中间值
    }

    const recent = this.heartRateHistory.slice(-60); // 最近 60 个样本
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    if (mean === 0) { return 0; }
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const std = Math.sqrt(variance);
    const cv = std / mean; // 变异系数

    // CV < 5% → 满分 (1.0)；CV > 10% → 0 分
    return Math.max(0, Math.min(1, 1.0 - cv / 0.10));
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
   * 计算摸鱼指数 (v2 — EWTR + 四维度评分 + 减免机制)
   *
   * 四维度评分:
   *   1. 工作不活跃度 (0-40) — 基于 EWTR 有效工作时间比率
   *   2. 姿态异常 (0-25) — 抬手/摸鱼姿态
   *   3. 久坐程度 (0-20) — 久坐持续时间
   *   4. 编辑器空闲度 (0-15) — 编辑器无操作时间
   *
   * 减免: 心流状态(-30), 高强度工作(-20)
   */
  private calculateSlackingIndex(raisedDuration: number, sedentaryDuration: number): number {
    // ── 维度 1: 工作不活跃度 (0-40) ──
    // 基于 EWTR (Effective Work Time Ratio)
    let inactivityScore = 0;
    if (this.editorActivityBuffer.length > 0) {
      const window = this.editorActivityBuffer.slice(-600); // 最近 10 分钟
      const activeCount = window.filter(cps => cps > 0).length;
      // 增加宽容度：最近 30 秒内有活动也算（允许短暂思考）
      let effectiveActive = activeCount;
      for (let i = 0; i < window.length; i++) {
        if (window[i] === 0) {
          // 往后找 30 秒内是否有活动
          const lookAhead = Math.min(30, window.length - i);
          for (let j = 1; j < lookAhead; j++) {
            if (window[i + j] > 0) {
              effectiveActive++;
              break;
            }
          }
        }
      }
      const ewtr = Math.min(1, effectiveActive / window.length);
      // EWTR < 30% → 满分 40；EWTR > 70% → 0 分
      inactivityScore = Math.max(0, Math.min(40, (1 - ewtr) * 40 / 0.7));
    }

    // ── 维度 2: 姿态异常 (0-25) ──
    // 仅在姿态数据可靠时计分；无 motion 数据时（兼容模式）姿态默认 typing，不计分
    // 有 motion 但倾斜角不可靠时（设备运动中）也不计分，避免误判
    let postureScore = 0;
    if (this.hasMotionData && this.orientationReliable) {
      if (this.currentPosture === 'slacking') {
        postureScore = 25;
      } else if (this.currentPosture === 'raised') {
        postureScore = 15;
      }
    }

    // ── 维度 3: 久坐程度 (0-20) ──
    const sedentaryMinutes = sedentaryDuration / 60_000;
    const sedentaryScore = Math.max(0, Math.min(1, (sedentaryMinutes - 20) / 40)) * 20;
    // 20 分钟以下 = 0; 60 分钟 = 满分 20

    // ── 维度 4: 编辑器空闲度 (0-15) ──
    const idleMinutes = (Date.now() - this.lastEditorEditTime) / 60_000;
    const editorIdleScore = Math.min(1, idleMinutes / 10) * 15;
    // 10 分钟无编辑 → 满分 15

    // ── 合计 ──
    let total = inactivityScore + postureScore + sedentaryScore + editorIdleScore;

    // ── 减免机制 ──
    if (this.flowState.active) {
      total = Math.max(0, total - 30); // 心流中大幅减免
    }
    if (this.currentIntensity === 'intense' || this.currentIntensity === 'furious') {
      total = Math.max(0, total - 20); // 高强度工作时减免
    }

    return Math.min(100, Math.round(total));
  }

  /**
   * 计算精力水平 (v2 — 昼夜节律 + HR偏差 + 疲劳累积)
   *
   * 四因子模型:
   *   1. 昼夜节律基线 (Process C 简化版) — 基于 Borbély 双过程模型
   *   2. 心率偏差修正 — 相对个人基线的偏离
   *   3. 活动模式修正 — 打字强度、心流状态
   *   4. 疲劳累积修正 — 连续工作时长衰减 (Process S 简化)
   */
  private calculateEnergyLevel(): number {
    // ── 1. 昼夜节律基线 (0-100) ──
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const circadian = this.circadianAlertness(hour) * 100;

    // ── 2. 心率偏差修正 (-20 to +5) ──
    let hrFactor = 0;
    if (this.lastHeartRate > 0 && this.personalHRBaseline > 0) {
      const deviation = (this.lastHeartRate - this.personalHRBaseline) / this.personalHRBaseline;
      if (deviation < -0.15) { hrFactor = -20; }         // 心率过低 → 可能嗜睡
      else if (deviation < -0.05) { hrFactor = -10; }    // 心率偏低
      else if (deviation < 0.10) { hrFactor = 0; }       // 正常范围
      else if (deviation < 0.20) { hrFactor = 5; }       // 偏高 → 可能专注/兴奋
      else { hrFactor = -5; }                             // 过高 → 可能焦虑/压力
    }

    // ── 3. 活动模式修正 (-25 to +30) ──
    let actFactor = 0;
    if (this.flowState.active) { actFactor += 15; }
    switch (this.currentIntensity) {
      case 'furious': actFactor += 15; break;
      case 'intense': actFactor += 10; break;
      case 'moderate': actFactor += 5; break;
      case 'light': actFactor += 0; break;
      case 'idle': actFactor -= 10; break;
    }
    // 长时间无活动
    const idleMinutes = (Date.now() - this.lastActiveTime) / 60_000;
    if (idleMinutes > 30) { actFactor -= 15; }
    else if (idleMinutes > 15) { actFactor -= 10; }

    // ── 4. 疲劳累积修正 (Process S 简化) ──
    // 连续工作 > 2 小时后开始衰减，每小时 -3，最多 -18
    const workHours = (Date.now() - this.sessionStartTime) / 3_600_000;
    const fatiguePenalty = -Math.min(18, Math.max(0, workHours - 2) * 3);

    // ── 合成 ──
    const energy = Math.max(0, Math.min(100,
      Math.round(circadian + hrFactor + actFactor + fatiguePenalty)
    ));

    return energy;
  }

  /**
   * 昼夜节律清醒度模型 (Process C 简化版)
   * 基于 Borbély 双过程模型的余弦近似
   *
   * 双峰模型：上午峰值 ~10:00, 午后低谷 ~14:00, 傍晚次峰 ~17:00
   *
   * @param hour - 24小时制小时数（含分钟小数）
   * @returns 清醒度 (0-1)
   */
  private circadianAlertness(hour: number): number {
    // 主节律 (24h) — 10:00 达峰
    const primary = 0.5 * Math.cos(2 * Math.PI * (hour - 10) / 24);

    // 餐后低谷 (12h 谐波) — 14:00 达谷
    const postprandial = 0.2 * Math.cos(2 * Math.PI * (hour - 14) / 12);

    // 合成 (归一化到 0-1)
    const raw = 0.5 + primary - postprandial;
    return Math.max(0, Math.min(1, raw));
  }
}
