/**
 * Heart Socket - Provider 抽象基类
 *
 * 所有数据源适配器继承此基类，使用 EventEmitter 模式
 * 派发 heartRate / statusChange / error 事件
 */
import { EventEmitter } from 'events';
import { WebSocketClient } from '../webSocketClient';
import { ConnectionStatus } from '../types';
import type { HeartRateData, HeartSocketConfig } from '../types';

export abstract class BaseProvider extends EventEmitter {
  protected wsClient: WebSocketClient;
  protected config: HeartSocketConfig;
  private _isConnected: boolean = false;

  /** 数据源名称 */
  abstract readonly name: string;

  constructor(config: HeartSocketConfig) {
    super();
    this.config = config;
    this.wsClient = new WebSocketClient();

    // 转发 WebSocket 状态变化
    this.wsClient.on('statusChange', (status: ConnectionStatus) => {
      this._isConnected = status === ConnectionStatus.Connected;
      this.emit('statusChange', status);
    });

    // 转发错误
    this.wsClient.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // 消息处理由子类实现
    this.wsClient.on('message', (data: string) => {
      this.onMessage(data);
    });

    // 连接打开后的初始化（子类可覆盖）
    this.wsClient.on('open', () => {
      this.onConnected();
    });
  }

  /** 是否已连接 */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /** 当前连接状态 */
  get status(): ConnectionStatus {
    return this.wsClient.status;
  }

  /**
   * 连接数据源
   */
  connect(): void {
    const url = this.getWebSocketUrl();
    this.wsClient.connect(url);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.wsClient.disconnect();
  }

  /**
   * 更新配置
   */
  updateConfig(config: HeartSocketConfig): void {
    this.config = config;
  }

  /**
   * 销毁，释放资源
   */
  dispose(): void {
    this.wsClient.dispose();
    this.removeAllListeners();
  }

  /**
   * 派发心率数据事件
   */
  protected emitHeartRate(bpm: number): void {
    // 心率有效性校验
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

  // ─── 子类需要实现的方法 ───────────────────────

  /** 获取 WebSocket 连接 URL */
  protected abstract getWebSocketUrl(): string;

  /** 处理收到的 WebSocket 消息 */
  protected abstract onMessage(data: string): void;

  /** 连接建立后的初始化操作（可选覆盖） */
  protected onConnected(): void {
    // 默认无操作，子类可覆盖
  }
}
