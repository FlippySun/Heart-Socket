/**
 * Heart Socket - Health Data Server (HDS) Provider
 *
 * HDS 模式使用 WebSocket Server 直接接收 Apple Watch 推送的心率数据。
 * Apple Watch 上的 HDS App 连接到本插件启动的 WebSocket Server，
 * 无需任何中间件。
 *
 * 数据流：Apple Watch HDS App → 本地 Wi-Fi → 本插件 WebSocket Server
 *
 * 数据格式示例：
 * {"heartRate": 75} / {"bpm": 75} / {"hr": 75} / 纯数字 75
 */
import { EventEmitter } from 'events';
import { HeartSocketServer } from '../webSocketServer';
import { ConnectionStatus } from '../types';
import type { HeartRateData, HealthData, HealthDataType, HeartSocketConfig } from '../types';

/** HDS key → HealthDataType 映射 */
const HEALTH_KEY_MAP: Record<string, HealthDataType> = {
  calories: 'calories',
  stepcount: 'stepCount',
  distance: 'distance',
  speed: 'speed',
  bloodoxygen: 'bloodOxygen',
  bodymass: 'bodyMass',
  bmi: 'bmi',
};

export class HdsProvider extends EventEmitter {
  readonly name = 'Health Data Server';
  private server: HeartSocketServer;
  private config: HeartSocketConfig;
  private _isConnected: boolean = false;

  constructor(config: HeartSocketConfig) {
    super();
    this.config = config;
    this.server = new HeartSocketServer();

    // 转发状态变化
    this.server.on('statusChange', (status: ConnectionStatus) => {
      this._isConnected = status === ConnectionStatus.Connected;
      this.emit('statusChange', status);
    });

    // 转发错误
    this.server.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // 处理接收到的消息
    this.server.on('message', (data: string) => {
      this.onMessage(data);
    });

    // 转发日志
    this.server.on('log', (msg: string) => {
      this.emit('log', msg);
    });
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get status(): ConnectionStatus {
    return this.server.status;
  }

  /** 获取当前监听端口 */
  get port(): number {
    return this.server.port;
  }

  /**
   * 启动 WebSocket Server
   */
  connect(): void {
    const port = this.config.serverPort;
    this.server.start(port);
  }

  /**
   * 停止 WebSocket Server
   */
  disconnect(): void {
    this.server.stop();
  }

  updateConfig(config: HeartSocketConfig): void {
    this.config = config;
  }

  dispose(): void {
    this.server.dispose();
    this.removeAllListeners();
  }

  // ─── 数据解析 ───────────────────────────────

  private onMessage(data: string): void {
    try {
      const trimmed = data.trim();

      // 尝试直接解析为数字（某些简化版本直接发送心率数字）
      const directNum = Number(trimmed);
      if (Number.isFinite(directNum) && directNum > 0) {
        this.emitHeartRate(directNum);
        return;
      }

      // ── HDS 原生格式：key:value 文本（如 "heartRate:75"、"calories:120"）──
      if (trimmed.includes(':') && !trimmed.startsWith('{')) {
        const colonIndex = trimmed.indexOf(':');
        const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
        const value = trimmed.substring(colonIndex + 1).trim();

        // 心率数据
        if (key === 'heartrate' || key === 'hr' || key === 'bpm') {
          const bpm = Number(value);
          if (Number.isFinite(bpm)) {
            this.emitHeartRate(bpm);
          }
          return;
        }

        // motion 数据（加速度传感器，非常频繁，忽略不处理）
        if (key === 'motion') {
          return;
        }

        // 其他健康数据（calories, stepCount, distance, speed, bloodOxygen, bodyMass, bmi）
        const healthType = HEALTH_KEY_MAP[key];
        if (healthType) {
          const num = Number(value);
          if (Number.isFinite(num)) {
            this.emitHealthData(healthType, num);
          }
          return;
        }

        // 未知 key，静默忽略
        return;
      }

      // ── JSON 格式（兼容自定义实现）──
      const json = JSON.parse(trimmed);

      // 支持多种可能的字段名
      const bpm =
        json.heartRate ??
        json.heart_rate ??
        json.hr ??
        json.bpm ??
        json.HeartRate ??
        json.value;

      if (typeof bpm === 'number') {
        this.emitHeartRate(bpm);
      }
    } catch {
      // 无法解析的消息，静默忽略
    }
  }

  private emitHeartRate(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 250) {
      return;
    }

    const data: HeartRateData = {
      bpm: Math.round(bpm),
      timestamp: Date.now(),
      source: this.name,
    };

    this.emit('heartRate', data);
  }

  private emitHealthData(type: HealthDataType, value: number): void {
    const data: HealthData = {
      type,
      value,
      timestamp: Date.now(),
      source: this.name,
    };

    this.emit('healthData', data);
  }
}
