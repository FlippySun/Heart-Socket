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
import type { HeartRateData, HealthData, HealthDataType, MotionData, Vector3, AttitudeData, HeartSocketConfig } from '../types';

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

        // motion 数据（加速度传感器等，高频）
        if (key === 'motion') {
          this.parseMotionData(value);
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

  // ─── Motion 数据解析 ────────────────────────────

  /**
   * 解析 HDS motion 数据
   *
   * HDS 发送格式（motion: 后面跟 JSON）：
   * motion:{"accelerometer":{"x":0.01,"y":-0.02,"z":-0.98},
   *         "gravity":{"x":0.0,"y":0.0,"z":-1.0},
   *         "rotationRate":{"x":0.0,"y":0.0,"z":0.0},
   *         "attitude":{"roll":0.1,"pitch":0.2,"yaw":0.3}}
   *
   * 也可能是 CSV 格式：
   * motion:0.01,-0.02,-0.98,0.0,0.0,-1.0,0.0,0.0,0.0,0.1,0.2,0.3
   */
  private parseMotionData(raw: string): void {
    try {
      const trimmed = raw.trim();

      // JSON 格式
      if (trimmed.startsWith('{')) {
        const json = JSON.parse(trimmed);
        const motion = this.buildMotionFromJson(json);
        if (motion) {
          this.emit('motionData', motion);
        }
        return;
      }

      // CSV 格式：12 个数值（accel xyz, gravity xyz, rotation xyz, attitude rpy）
      const parts = trimmed.split(',').map(Number);
      if (parts.length >= 12 && parts.every(Number.isFinite)) {
        const motion: MotionData = {
          accelerometer: { x: parts[0], y: parts[1], z: parts[2] },
          gravity: { x: parts[3], y: parts[4], z: parts[5] },
          rotationRate: { x: parts[6], y: parts[7], z: parts[8] },
          attitude: { roll: parts[9], pitch: parts[10], yaw: parts[11] },
          timestamp: Date.now(),
        };
        this.emit('motionData', motion);
      }
    } catch {
      // motion 数据解析失败，静默忽略（高频数据不应阻塞）
    }
  }

  /**
   * 从 JSON 对象构建 MotionData
   */
  private buildMotionFromJson(json: Record<string, unknown>): MotionData | null {
    const accel = this.parseVector3(json.accelerometer ?? json.accel);
    const grav = this.parseVector3(json.gravity ?? json.grav);
    const rot = this.parseVector3(json.rotationRate ?? json.rotation);
    const att = this.parseAttitude(json.attitude ?? json.att);

    // 至少需要加速度数据
    if (!accel) {
      return null;
    }

    return {
      accelerometer: accel,
      gravity: grav ?? { x: 0, y: 0, z: -1 }, // 默认重力向下
      rotationRate: rot ?? { x: 0, y: 0, z: 0 },
      attitude: att ?? { roll: 0, pitch: 0, yaw: 0 },
      timestamp: Date.now(),
    };
  }

  private parseVector3(obj: unknown): Vector3 | null {
    if (!obj || typeof obj !== 'object') { return null; }
    const o = obj as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { return null; }
    return { x, y, z };
  }

  private parseAttitude(obj: unknown): AttitudeData | null {
    if (!obj || typeof obj !== 'object') { return null; }
    const o = obj as Record<string, unknown>;
    const roll = Number(o.roll);
    const pitch = Number(o.pitch);
    const yaw = Number(o.yaw);
    if (!Number.isFinite(roll) || !Number.isFinite(pitch) || !Number.isFinite(yaw)) { return null; }
    return { roll, pitch, yaw };
  }
}
