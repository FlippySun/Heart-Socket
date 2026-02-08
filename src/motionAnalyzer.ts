/**
 * Heart Socket - Motion Analyzer (v3 — 数据修正版)
 *
 * v3 核心修正：HDS Watch 发送的 motion 数据是 userAcceleration（已去除重力），
 * 而非 rawAccelerometer。v2 的 ENMO / EMA 重力估计 / 倾斜角全部失效。
 *
 * v3 算法策略：
 * - 🏋️ 运动强度：VMUA (Vector Magnitude User Acceleration) + 编辑器活动融合
 * - 🪑 久坐检测：VMUA 不活动阈值 + bout 判定 + 活动中断验证
 * - 🤚 姿态感知：多信号融合（加速度模式 × 编辑器活动）→ 5 种状态
 * - 🧘 心流检测：5维信号融合评分 + 滞回设计（沿用 v2 架构，修正信号源）
 * - 🐟 摸鱼指数：EWTR + 四维度评分 + 减免机制（适配新姿态状态）
 * - ⚡ 精力水平：昼夜节律余弦模型 + HR偏差 + 疲劳累积
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

// ─── v3 信号处理常量 ──────────────────────────────

/**
 * VMUA (Vector Magnitude User Acceleration) 缓冲区大小（秒，1Hz 采样）
 * 替代 v2 的 ENMO 缓冲区
 */
const VMUA_BUFFER_SIZE = 600; // 最近 10 分钟

/** 原始 Motion 数据缓冲区大小 */
const MOTION_BUFFER_SIZE = 30; // 最近 30 秒（1Hz）

// ─── 运动强度常量 (v3 — 基于 userAcceleration) ────

/**
 * VMUA 强度阈值 (单位: g)
 *
 * userAcceleration 典型值（来自 heart2.log 实测）：
 *   静止: ~0.003g (传感器噪声底)
 *   打字（非惯用手腕）: 0.003-0.01g (手腕几乎不动)
 *   操作触控板: 0.01-0.03g
 *   手势/伸展: 0.03-0.10g
 *   走路: 0.10-0.50g
 *
 * 由于左手打字时手腕几乎不动，纯加速度无法区分"打字"和"静止"
 * → 需要融合编辑器活动信号进行修正
 */
const VMUA_THRESHOLDS = {
  noise: 0.004,    // 传感器噪声底（低于此视为完全静止）
  slight: 0.010,   // 轻微运动（鼠标/触控板微动）
  moderate: 0.035,  // 中等运动（手势、调整姿势）
  vigorous: 0.100,  // 剧烈运动（走路、大幅手部运动）
};

/** 强度计算滑动窗口大小（秒）— v3: 缩短至 3s 加速响应 */
const INTENSITY_WINDOW_SEC = 3;

// ─── 姿态检测常量 (v3 — 多信号融合) ──────────────

/** 编辑器活动判定阈值（CPS > 此值视为在编辑） */
const EDITOR_ACTIVE_CPS = 0.5;

/** 编辑器近期活动窗口（秒）：在此时间内有编辑活动视为"正在编辑" */
const EDITOR_RECENT_WINDOW_SEC = 8;

/** 姿态评估滑动窗口（秒）— v3: 3s 快速响应 */
const POSTURE_WINDOW_SEC = 3;

/** 步行检测：VMUA 持续高于此值 + 节奏性 */
const WALKING_VMUA_THRESHOLD = 0.08;

/** 步行检测：需要连续 N 秒满足条件 */
const WALKING_SUSTAIN_SEC = 3;

// ─── 久坐检测常量 (v3 — 基于 VMUA) ─────────────

/** 久坐检测：步数活动阈值 */
const SEDENTARY_STEP_THRESHOLD = 5;
/** 不活动 VMUA 阈值 (g) — 低于此值视为不活动 */
const SEDENTARY_VMUA_THRESHOLD = 0.008;
/** 不活动 bout 容忍度（允许该比例的 epoch 超标） */
const SEDENTARY_BOUT_TOLERANCE = 0.10;
/** 活动中断验证：至少连续 N 秒的活动才重置久坐 */
const ACTIVE_BREAK_DURATION = 60; // 60 秒
/** 活动中断验证：活动 epoch 占比阈值 */
const ACTIVE_BREAK_RATIO = 0.80;
/** 活动中断 VMUA 阈值 (g) — 高于此值的 epoch 视为真正活跃 */
const ACTIVE_BREAK_VMUA = 0.03;
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

  // ── VMUA 缓冲区 (v3 — 替代 ENMO) ──
  private vmuaBuffer: number[] = [];

  // ── 不活动 epoch 缓冲区 (久坐检测用) ──
  private inactiveEpochBuffer: boolean[] = [];

  // ── 编辑器活动缓冲区 (心流检测 + 姿态融合用) ──
  private editorActivityBuffer: number[] = []; // cps 历史

  // ── 行走检测 (v3 新增) ──
  private walkingSustainStart: number | null = null; // 持续行走起始时间

  // ── 心流评分 ──
  private flowScoreHistory: number[] = []; // 最近的 FlowScore 值
  private flowCandidateStartTime: number | null = null;
  private lastFlowScoreTime: number = 0;

  // ── 精力评估 ──
  private personalHRBaseline: number = DEFAULT_HR_BASELINE;
  private sessionStartTime: number = Date.now();

  // ── 分析状态 ──
  private currentIntensity: CodingIntensityLevel = 'idle';
  private currentPosture: PostureState = 'resting';
  private flowState: FlowState = { active: false, duration: 0 };
  private lastAnalysisResult: MotionAnalysisResult | null = null;

  // ── 计时器 ──
  private lastActiveTime: number = Date.now();
  private lastSedentaryAlertTime: number = 0; // 上次久坐提醒时间（冷却用）
  private postureAlertStartTime: number | null = null; // v3: 通用姿态告警
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
   * v3: HDS 发送的是 CMDeviceMotion.userAcceleration（重力已去除）
   * 直接计算 VMUA (Vector Magnitude of User Acceleration)
   */
  feedMotion(data: MotionData): void {
    if (!this.config.enableMotion) {
      return;
    }

    this.hasMotionData = true;

    // ── 1. 计算 VMUA ──
    // VMUA = sqrt(x² + y² + z²)，userAcceleration 已去除重力
    const ua = data.accelerometer;
    const vmua = Math.sqrt(ua.x * ua.x + ua.y * ua.y + ua.z * ua.z);
    this.vmuaBuffer.push(vmua);
    if (this.vmuaBuffer.length > VMUA_BUFFER_SIZE) {
      this.vmuaBuffer.shift();
    }

    // ── 2. 不活动 epoch 判定（久坐检测用） ──
    const isInactive = vmua < SEDENTARY_VMUA_THRESHOLD;
    this.inactiveEpochBuffer.push(isInactive);
    if (this.inactiveEpochBuffer.length > INACTIVE_EPOCH_BUFFER_SIZE) {
      this.inactiveEpochBuffer.shift();
    }

    // ── 3. 行走持续检测 ──
    if (vmua > WALKING_VMUA_THRESHOLD) {
      if (!this.walkingSustainStart) {
        this.walkingSustainStart = Date.now();
      }
    } else {
      this.walkingSustainStart = null;
    }

    // ── 4. 保留原始 motion 缓冲 ──
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
   * v3: 基于 VMUA + 编辑器活动融合（有 Motion 数据时）
   * 或基于编辑器字符变更速率（兼容回退方案）
   */
  private calculateCodingIntensity(): CodingIntensityLevel {
    // 优先使用 Motion 传感器数据（HDS）— v3: VMUA + 编辑器融合
    if (this.hasMotionData && this.vmuaBuffer.length >= 3) {
      return this.calculateIntensityFromMotion();
    }

    // 兼容回退：使用编辑器活动数据
    return this.calculateIntensityFromEditor();
  }

  /**
   * 基于 Motion + 编辑器融合计算强度（HDS 模式 — v3 VMUA 标准）
   *
   * 核心创新：左手戴表打字时手腕几乎不动（VMUA 很低），
   * 但编辑器有持续输入 → 结合编辑器 CPS 修正，避免误判为 idle。
   *
   * 融合逻辑：
   * 1. 纯 VMUA 分级
   * 2. 若 VMUA 低但编辑器活跃 → 提升等级（至少 light）
   */
  private calculateIntensityFromMotion(): CodingIntensityLevel {
    // 取最近 N 秒的 VMUA 均值
    const windowSize = Math.min(INTENSITY_WINDOW_SEC, this.vmuaBuffer.length);
    if (windowSize === 0) {
      return 'idle';
    }

    const recentVmua = this.vmuaBuffer.slice(-windowSize);
    const meanVmua = recentVmua.reduce((sum, v) => sum + v, 0) / recentVmua.length;

    // ── 纯 VMUA 分级 ──
    let motionLevel: CodingIntensityLevel;
    if (meanVmua < VMUA_THRESHOLDS.noise) {
      motionLevel = 'idle';
    } else if (meanVmua < VMUA_THRESHOLDS.slight) {
      motionLevel = 'light';
    } else if (meanVmua < VMUA_THRESHOLDS.moderate) {
      motionLevel = 'moderate';
    } else if (meanVmua < VMUA_THRESHOLDS.vigorous) {
      motionLevel = 'intense';
    } else {
      motionLevel = 'furious';
    }

    // ── 编辑器活动融合修正 ──
    // 检查最近 N 秒内是否有编辑器活动
    const recentEditorWindow = Math.min(
      EDITOR_RECENT_WINDOW_SEC,
      this.editorActivityBuffer.length
    );
    if (recentEditorWindow > 0) {
      const recentEditor = this.editorActivityBuffer.slice(-recentEditorWindow);
      const activeSecs = recentEditor.filter(cps => cps > EDITOR_ACTIVE_CPS).length;
      const editorActiveRatio = activeSecs / recentEditor.length;

      // 编辑器活跃（>30% 时间有打字）且 VMUA 低 → 提升
      if (editorActiveRatio > 0.3 && (motionLevel === 'idle' || motionLevel === 'light')) {
        const avgCps = recentEditor.reduce((s, v) => s + v, 0) / recentEditor.length;
        if (avgCps > 10) {
          motionLevel = 'moderate'; // 高速打字
        } else if (avgCps > 3) {
          motionLevel = 'light'; // 一般打字
        }
        // avgCps <= 3: 保持原 motionLevel（可能在阅读/思考）
      }
    }

    return motionLevel;
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
   * 检测手腕姿态 (v3 — VMUA + 编辑器活动多信号融合)
   *
   * 5 种姿态判定逻辑（优先级从高到低）：
   *
   * 1. walking  — VMUA > 0.08g 持续 ≥3 秒（明确在走路）
   * 2. active   — VMUA 均值 > 0.035g（手臂有明显活动）
   * 3. typing   — VMUA 低 + 近期有编辑器活动（戴表手几乎不动但在打字）
   * 4. mousing  — VMUA 在 slight~moderate 范围 + 无近期编辑器活动
   * 5. resting  — VMUA 极低 + 无近期编辑器活动（静息/阅读）
   */
  private detectPosture(): PostureState {
    if (!this.hasMotionData || this.vmuaBuffer.length < 3) {
      // 兼容回退：无 Motion 数据时，根据编辑器活动判断
      const timeSinceEdit = (Date.now() - this.lastEditorEditTime) / 1000;
      if (this.editorCharsPerSecond > EDITOR_ACTIVE_CPS) {
        return 'typing';
      }
      return timeSinceEdit < EDITOR_RECENT_WINDOW_SEC ? 'typing' : 'resting';
    }

    // ── 1. 行走检测（最高优先级） ──
    if (this.walkingSustainStart) {
      const walkDuration = (Date.now() - this.walkingSustainStart) / 1000;
      if (walkDuration >= WALKING_SUSTAIN_SEC) {
        return 'walking';
      }
    }

    // ── 2. 计算 VMUA 窗口均值 ──
    const windowSize = Math.min(POSTURE_WINDOW_SEC, this.vmuaBuffer.length);
    const recentVmua = this.vmuaBuffer.slice(-windowSize);
    const meanVmua = recentVmua.reduce((s, v) => s + v, 0) / recentVmua.length;

    // ── 3. 检查编辑器近期活动 ──
    const editorWindow = Math.min(
      EDITOR_RECENT_WINDOW_SEC,
      this.editorActivityBuffer.length
    );
    let hasRecentEditorActivity = false;
    if (editorWindow > 0) {
      const recentEditor = this.editorActivityBuffer.slice(-editorWindow);
      const activeSecs = recentEditor.filter(cps => cps > EDITOR_ACTIVE_CPS).length;
      hasRecentEditorActivity = activeSecs / recentEditor.length > 0.2;
    }

    // ── 4. 多信号融合判定 ──
    if (meanVmua > VMUA_THRESHOLDS.moderate) {
      return 'active'; // 手臂明显活动
    }

    if (meanVmua > VMUA_THRESHOLDS.slight) {
      // 中等运动：可能是鼠标操作或轻微手臂调整
      return hasRecentEditorActivity ? 'typing' : 'mousing';
    }

    // VMUA 低（手腕几乎不动）
    if (hasRecentEditorActivity) {
      return 'typing'; // 手腕不动但在打字（左手戴表场景的核心修正）
    }

    // 极低 VMUA + 无编辑器活动
    return 'resting';
  }

  /**
   * 久坐检测 (v3 — VMUA bout 标准)
   *
   * 判定标准：
   * - 不活动 bout: 连续 N 分钟中 ≥90% 的 epoch 的 VMUA < 阈值
   * - 活动中断验证: 至少 60 秒的持续活动（≥80% epoch VMUA > 阈值）才重置计时
   *
   * 渐进式提醒：30分钟→轻提醒, 配置阈值→标准提醒
   */
  private checkSedentary(now: number): void {
    // ── 冷却检查：上次提醒后需等待至少 sedentaryMinutes 才能再次提醒 ──
    if (this.lastSedentaryAlertTime > 0 &&
        now - this.lastSedentaryAlertTime < this.config.sedentaryMinutes * 60_000) {
      return;
    }

    const sedentaryMs = now - this.lastActiveTime;
    const sedentaryMinutes = sedentaryMs / 60_000;

    // ── v3: 基于 VMUA 的 bout 判断 ──
    if (this.hasMotionData && this.inactiveEpochBuffer.length > 0) {
      // 检查最近的活动中断（是否有持续活动 → 重置久坐计时器）
      if (this.inactiveEpochBuffer.length >= ACTIVE_BREAK_DURATION) {
        const recentActive = this.inactiveEpochBuffer.slice(-ACTIVE_BREAK_DURATION);
        const activeCount = recentActive.filter(inactive => !inactive).length;
        const activeRatio = activeCount / recentActive.length;

        // 检查这些活跃 epoch 的 VMUA 是否足够大
        if (activeRatio >= ACTIVE_BREAK_RATIO && this.vmuaBuffer.length >= ACTIVE_BREAK_DURATION) {
          const recentVmua = this.vmuaBuffer.slice(-ACTIVE_BREAK_DURATION);
          const highVmuaCount = recentVmua.filter(v => v > ACTIVE_BREAK_VMUA).length;
          const highVmuaRatio = highVmuaCount / recentVmua.length;

          if (highVmuaRatio >= ACTIVE_BREAK_RATIO) {
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
          this.lastSedentaryAlertTime = now; // 标记提醒时间（冷却），不重置 lastActiveTime
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
      this.lastSedentaryAlertTime = now; // 标记提醒时间（冷却），不重置 lastActiveTime
    }
  }

  /**
   * 姿态告警检测 (v3 — 基于 active/walking 持续时间)
   *
   * 当用户持续处于 active 或 walking 状态超过阈值时发出告警
   * （可能在开会、走神、不在工位等）
   */
  private checkPostureAlert(now: number): void {
    if (this.currentPosture === 'active' || this.currentPosture === 'walking') {
      if (!this.postureAlertStartTime) {
        this.postureAlertStartTime = now;
      }

      const alertDuration = now - this.postureAlertStartTime;
      const thresholdMs = this.config.postureAlertSeconds * 1000;

      if (alertDuration >= thresholdMs) {
        this.emit('postureAlert', {
          duration: alertDuration,
          state: this.currentPosture,
        });

        // 重置计时（避免频繁提醒）
        this.postureAlertStartTime = now;
      }
    } else {
      // 回到工作姿态 → 重置
      this.postureAlertStartTime = null;
    }
  }

  /**
   * 心流状态检测 (v3 — 多信号融合评分 + 滞回设计)
   *
   * 5 维信号融合评分 (0-100):
   *   1. 打字持续性 (35%) — 最近 5 分钟编辑器活动的持续性
   *   2. 动作稳定性 (20%) — VMUA 在打字模式范围内且稳定
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
   * 计算动作稳定性 (0-1) — v3 使用 VMUA
   * 打字时腕部有规律的小幅振动但无大幅运动
   */
  private calculateMotionStillness(): number {
    if (!this.hasMotionData || this.vmuaBuffer.length < 30) {
      return 0.5; // 无数据时给中间值
    }

    const recent = this.vmuaBuffer.slice(-FLOW_TYPING_WINDOW);
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const std = Math.sqrt(variance);

    // v3: VMUA 是用户加速度（无重力），典型打字范围 0.003-0.010g
    // 稳定的低幅运动 = 打字模式
    if (mean < VMUA_THRESHOLDS.slight && std < 0.005) {
      return 1.0; // 极稳定，可能在打字或静息
    }
    if (mean < VMUA_THRESHOLDS.moderate && std < 0.015) {
      return 0.8 - Math.min(0.3, std / 0.015 * 0.3); // 轻微运动
    }
    // 大幅运动 → 低稳定性
    return Math.max(0, 0.3 - mean * 2);
  }

  /**
   * 判断心率稳定性 (0-1)
   * 基于变异系数 (CV)，使用 5 分钟窗口
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
    const postureAlertDuration = this.postureAlertStartTime ? now - this.postureAlertStartTime : 0;

    // 计算摸鱼指数（0-100）
    const slackingIndex = this.calculateSlackingIndex(postureAlertDuration, sedentaryDuration);

    // 计算精力水平（0-100，简化版）
    const energyLevel = this.calculateEnergyLevel();

    const result: MotionAnalysisResult = {
      codingIntensity: this.currentIntensity,
      posture: this.currentPosture,
      flowState: { ...this.flowState }, // 浅拷贝避免引用泄漏
      slackingIndex,
      energyLevel,
      postureAlertDuration,
      sedentaryDuration,
    };

    this.lastAnalysisResult = result;
    this.emit('analysisResult', result);
  }

  /**
   * 计算摸鱼指数 (v3 — EWTR + 四维度评分 + 减免机制)
   *
   * 四维度评分:
   *   1. 工作不活跃度 (0-40) — 基于 EWTR 有效工作时间比率
   *   2. 姿态异常 (0-25) — 非工作姿态（走动/活动/静息等）
   *   3. 久坐程度 (0-20) — 久坐持续时间
   *   4. 编辑器空闲度 (0-15) — 编辑器无操作时间
   *
   * 减免: 心流状态(-30), 高强度工作(-20)
   */
  private calculateSlackingIndex(postureAlertDuration: number, sedentaryDuration: number): number {
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
    // v3: 5 种姿态评分
    let postureScore = 0;
    if (this.hasMotionData) {
      switch (this.currentPosture) {
        case 'walking': postureScore = 25; break;  // 明确不在工位
        case 'active': postureScore = 15; break;    // 手臂大幅活动，可能不在工作
        case 'mousing': postureScore = 5; break;    // 可能在浏览网页
        case 'typing': postureScore = 0; break;     // 正在工作
        case 'resting': postureScore = 10; break;   // 可能在思考也可能在发呆
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
   * 计算精力水平 (昼夜节律 + HR偏差 + 疲劳累积)
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
