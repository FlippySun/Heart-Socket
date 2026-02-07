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

/** 心率区间 */
export interface HeartRateZones {
  /** 静息心率上限 */
  rest: number;
  /** 正常心率上限 */
  normal: number;
  /** 中等强度上限 */
  moderate: number;
  /** 高强度上限（超过此值为极高强度） */
  high: number;
}

/** 心率区间名称 */
export type HeartRateZoneName = 'low' | 'rest' | 'normal' | 'moderate' | 'high' | 'extreme';

/** 插件配置 */
export interface HeartSocketConfig {
  provider: ProviderType;
  websocketUrl: string;
  apiToken: string;
  sessionId: string;
  autoConnect: boolean;
  alertHighBpm: number;
  alertLowBpm: number;
  alertCooldown: number;
  heartRateJsonPath: string;
  statusBarPosition: 'left' | 'right';
  showHeartbeatAnimation: boolean;
  zones: HeartRateZones;
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
