/**
 * Heart Socket - 类型定义
 */

/** 心率数据 */
export interface HeartRateData {
  /** 心率值 (BPM) */
  bpm: number;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 数据来源 */
  source: string;
}

/** 健康数据（HDS 扩展数据） */
export interface HealthData {
  /** 数据类型 */
  type: HealthDataType;
  /** 数值 */
  value: number;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 数据来源 */
  source: string;
}

/** 健康数据类型 */
export type HealthDataType =
  | 'calories'
  | 'stepCount'
  | 'distance'
  | 'speed'
  | 'bloodOxygen'
  | 'bodyMass'
  | 'bmi';

// ─── Motion 数据类型 ─────────────────────────────

/** 三维向量 */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** 姿态欧拉角 */
export interface AttitudeData {
  /** 翻滚角 (rad) — 左右倾斜 */
  roll: number;
  /** 俯仰角 (rad) — 前后倾斜（抬手/放下） */
  pitch: number;
  /** 偏航角 (rad) — 水平旋转 */
  yaw: number;
}

/** HDS Motion 原始数据 */
export interface MotionData {
  /** 原始加速度（含重力，单位 g） */
  accelerometer: Vector3;
  /** 重力向量（单位 g） */
  gravity: Vector3;
  /** 陀螺仪角速度 (rad/s) */
  rotationRate: Vector3;
  /** 姿态欧拉角 (rad) */
  attitude: AttitudeData;
  /** 时间戳 (ms) */
  timestamp: number;
}

/** 敲代码强度等级 */
export type CodingIntensityLevel = 'idle' | 'light' | 'moderate' | 'intense' | 'furious';

/** 手腕姿态状态 */
export type PostureState = 'typing' | 'raised' | 'slacking';

/** 心流状态 */
export interface FlowState {
  /** 是否处于心流状态 */
  active: boolean;
  /** 心流持续时间 (ms) */
  duration: number;
}

/** Motion 分析结果（聚合输出） */
export interface MotionAnalysisResult {
  /** 敲代码强度 */
  codingIntensity: CodingIntensityLevel;
  /** 手腕姿态 */
  posture: PostureState;
  /** 心流状态 */
  flowState: FlowState;
  /** 摸鱼指数 (0-100) */
  slackingIndex: number;
  /** 精力水平 (0-100) */
  energyLevel: number;
  /** 抬手持续时间 (ms)，仅 posture=raised/slacking 时有值 */
  raisedDuration: number;
  /** 久坐持续时间 (ms) */
  sedentaryDuration: number;
}

/** Motion 功能配置 */
export interface MotionConfig {
  /** 启用 Motion 功能 */
  enableMotion: boolean;
  /** 久坐提醒时间（分钟） */
  sedentaryMinutes: number;
  /** 抬手摸鱼提醒阈值（秒） */
  postureAlertSeconds: number;
  /** 显示敲代码强度 */
  showCodingIntensity: boolean;
  /** 显示心流状态 */
  showFlowState: boolean;
  /** 显示摸鱼指数 */
  showSlackingIndex: boolean;
}

/** 健康数据快照（用于 tooltip 显示） */
export interface HealthSnapshot {
  calories?: number;
  stepCount?: number;
  distance?: number;
  speed?: number;
  bloodOxygen?: number;
  bodyMass?: number;
  bmi?: number;
}

/** 连接状态 */
export enum ConnectionStatus {
  /** 未连接 */
  Disconnected = 'disconnected',
  /** 连接中 */
  Connecting = 'connecting',
  /** 已连接 */
  Connected = 'connected',
  /** 重连中 */
  Reconnecting = 'reconnecting',
  /** 连接错误 */
  Error = 'error',
}

/** 数据源类型 */
export type ProviderType = 'hds' | 'hyperate' | 'pulsoid' | 'custom';

/** 心率区间（编程场景优化，在静息范围内细粒度划分） */
export interface HeartRateZones {
  /** 放松上限（默认 60） */
  relax: number;
  /** 平静上限（默认 72） */
  calm: number;
  /** 专注上限（默认 85） */
  focused: number;
  /** 紧张上限（默认 100） */
  tense: number;
  /** 高压上限（超过此值为异常，默认 120） */
  stressed: number;
}

/** 心率区间名称 */
export type HeartRateZoneName = 'low' | 'relax' | 'calm' | 'focused' | 'tense' | 'stressed' | 'extreme';

/** 插件配置 */
export interface HeartSocketConfig {
  provider: ProviderType;
  websocketUrl: string;
  apiToken: string;
  sessionId: string;
  autoConnect: boolean;
  /** HDS Server 模式监听端口 */
  serverPort: number;
  alertHighBpm: number;
  alertLowBpm: number;
  alertCooldown: number;
  heartRateJsonPath: string;
  /** 自定义数据源 — 卡路里字段 JSON 路径（留空不启用） */
  caloriesJsonPath: string;
  /** 自定义数据源 — 步数字段 JSON 路径（留空不启用） */
  stepCountJsonPath: string;
  /** 自定义数据源 — 血氧字段 JSON 路径（留空不启用） */
  bloodOxygenJsonPath: string;
  /** 自定义数据源 — 距离字段 JSON 路径（留空不启用） */
  distanceJsonPath: string;
  /** 自定义数据源 — 速度字段 JSON 路径（留空不启用） */
  speedJsonPath: string;
  statusBarPosition: 'left' | 'right';
  showHeartbeatAnimation: boolean;
  zones: HeartRateZones;
  // Motion 功能配置
  enableMotion: boolean;
  sedentaryMinutes: number;
  postureAlertSeconds: number;
  showCodingIntensity: boolean;
  showFlowState: boolean;
  showSlackingIndex: boolean;
}

/**
 * Provider 通用接口
 * BaseProvider（Client 模式）和 HdsProvider（Server 模式）均需实现
 */
export interface IHeartRateProvider {
  readonly name: string;
  readonly isConnected: boolean;
  readonly status: ConnectionStatus;
  connect(): void;
  disconnect(): void;
  updateConfig(config: HeartSocketConfig): void;
  dispose(): void;
  on(event: 'heartRate', listener: (data: HeartRateData) => void): this;
  on(event: 'healthData', listener: (data: HealthData) => void): this;
  on(event: 'motionData', listener: (data: MotionData) => void): this;
  on(event: 'statusChange', listener: (status: ConnectionStatus) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'log', listener: (message: string) => void): this;
}

/** WebSocket 重连配置 */
export interface ReconnectConfig {
  /** 初始重连延迟 (ms) */
  initialDelay: number;
  /** 最大重连延迟 (ms) */
  maxDelay: number;
  /** 退避因子 */
  backoffFactor: number;
  /** 最大重试次数（-1 表示无限） */
  maxRetries: number;
  /** 抖动比例 (0-1) */
  jitter: number;
}

/** Provider 事件回调 */
export interface ProviderEvents {
  heartRate: (data: HeartRateData) => void;
  statusChange: (status: ConnectionStatus) => void;
  error: (error: Error) => void;
}

/** 心率统计数据 */
export interface HeartRateStats {
  current: number;
  min: number;
  max: number;
  avg: number;
  samples: number;
  duration: number;
  history: HeartRateData[];
}
