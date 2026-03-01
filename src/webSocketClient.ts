/**
 * Heart Socket - 通用 WebSocket 客户端
 *
 * 特性：
 * - 指数退避自动重连
 * - 心跳检测
 * - 连接状态管理
 * - 安全的资源释放
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { ConnectionStatus, WebSocketError } from './types';
import type { ReconnectConfig } from './types';

/** 默认重连配置 */
const DEFAULT_RECONNECT: ReconnectConfig = {
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxRetries: -1, // 无限重连
  jitter: 0.2,
};

export interface WebSocketClientEvents {
  message: (data: string) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (error: Error) => void;
  statusChange: (status: ConnectionStatus) => void;
}

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string = '';
  private reconnectConfig: ReconnectConfig;
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _status: ConnectionStatus = ConnectionStatus.Disconnected;
  private isManualClose: boolean = false;
  private isDisposed: boolean = false;
  /** 标记当前错误是否不可重试（如 HTTP 4xx），阻止自动重连 */
  private _nonRetryable: boolean = false;

  constructor(reconnectConfig?: Partial<ReconnectConfig>) {
    super();
    this.reconnectConfig = { ...DEFAULT_RECONNECT, ...reconnectConfig };
  }

  /** 当前连接状态 */
  get status(): ConnectionStatus {
    return this._status;
  }

  /** 是否已连接 */
  get connected(): boolean {
    return this._status === ConnectionStatus.Connected;
  }

  /**
   * 连接到 WebSocket 服务器
   */
  connect(url: string): void {
    if (this.isDisposed) {
      return;
    }

    this.url = url;
    this.isManualClose = false;
    this._nonRetryable = false;
    this.reconnectAttempt = 0;
    this.doConnect();
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.isManualClose = true;
    this._nonRetryable = false;
    this.clearTimers();
    this.closeSocket();
    this.setStatus(ConnectionStatus.Disconnected);
  }

  /**
   * 发送消息
   */
  send(data: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  /**
   * 销毁客户端，释放所有资源
   */
  dispose(): void {
    this.isDisposed = true;
    this.disconnect();
    this.removeAllListeners();
  }

  // ─── 私有方法 ───────────────────────────────────

  private doConnect(): void {
    if (this.isDisposed || this.isManualClose) {
      return;
    }

    this.closeSocket();
    this.setStatus(ConnectionStatus.Connecting);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.reconnectAttempt = 0;
        this.setStatus(ConnectionStatus.Connected);
        this.startPing();
        this.emit('open');
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const message = data.toString();
        this.emit('message', message);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        this.stopPing();
        this.emit('close', code, reasonStr);

        if (!this.isManualClose && !this.isDisposed && !this._nonRetryable) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        this.emit('error', error);
        // WebSocket 错误后通常会触发 close 事件，由 close 处理重连
      });

      // 拦截 HTTP 非 101 响应（如 401/402/403），提取状态码和响应体
      this.ws.on('unexpected-response', (_req: unknown, res: IncomingMessage) => {
        const statusCode = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let handled = false;

        const processResponse = () => {
          if (handled) return;
          handled = true;
          if (this.isDisposed) return;

          const body = Buffer.concat(chunks).toString('utf-8');
          const wsError = this.createHttpError(statusCode, body);
          this.emit('error', wsError);

          if (wsError.nonRetryable) {
            this._nonRetryable = true;
            this.setStatus(ConnectionStatus.Error);
            this.closeSocket();
          } else {
            // 可重试错误（429/5xx）：关闭后走正常重连
            this.closeSocket();
            this.scheduleReconnect();
          }
        };

        // 5 秒超时兜底：防止响应体永远不结束
        const bodyTimeout = setTimeout(processResponse, 5000);

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(bodyTimeout);
          processResponse();
        });
      });

      this.ws.on('pong', () => {
        // 服务器响应了 ping，连接正常
      });
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      if (!this.isManualClose && !this.isDisposed) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * 安排重连（指数退避 + 抖动）
   */
  private scheduleReconnect(): void {
    const { maxRetries, initialDelay, maxDelay, backoffFactor, jitter } =
      this.reconnectConfig;

    // 检查是否超过最大重试次数
    if (maxRetries !== -1 && this.reconnectAttempt >= maxRetries) {
      this.setStatus(ConnectionStatus.Error);
      this.emit('error', new Error(`已达到最大重连次数 (${maxRetries})，请检查网络连接`));
      return;
    }

    this.setStatus(ConnectionStatus.Reconnecting);
    this.reconnectAttempt++;

    // 计算延迟：指数退避
    let delay = initialDelay * Math.pow(backoffFactor, this.reconnectAttempt - 1);
    delay = Math.min(delay, maxDelay);

    // 添加抖动
    const jitterAmount = delay * jitter;
    delay += (Math.random() * 2 - 1) * jitterAmount;
    delay = Math.max(0, Math.round(delay));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  /**
   * 启动心跳 ping（每30秒）
   */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      try {
        // 逐事件移除，避免影响 ws 库内部可能的监听器
        this.ws.removeAllListeners('open');
        this.ws.removeAllListeners('message');
        this.ws.removeAllListeners('close');
        this.ws.removeAllListeners('error');
        this.ws.removeAllListeners('unexpected-response');
        this.ws.removeAllListeners('pong');
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        // 忽略关闭时的错误
      }
      this.ws = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit('statusChange', status);
    }
  }

  /**
   * 根据 HTTP 状态码和响应体构造 WebSocketError
   * - 4xx（除 429）：不可重试，用户需要手动修复（如更换 Token、升级订阅）
   * - 429 / 5xx：可重试，自动重连
   */
  private createHttpError(statusCode: number, body: string): WebSocketError {
    const is4xx = statusCode >= 400 && statusCode < 500;
    const nonRetryable = is4xx && statusCode !== 429;

    let userMessage: string;
    switch (statusCode) {
      case 401:
        userMessage = '认证失败：Token 无效或已过期，请检查配置';
        break;
      case 402:
        userMessage = '需要付费订阅才能使用实时心率 API';
        break;
      case 403:
        userMessage = '访问被拒绝：Token 权限不足';
        break;
      case 404:
        userMessage = 'API 地址不存在，请检查配置或数据源是否正确';
        break;
      case 429:
        userMessage = '请求过于频繁，稍后将自动重试';
        break;
      default:
        if (statusCode >= 500) {
          userMessage = `服务器暂时不可用 (HTTP ${statusCode})，正在自动重试…`;
        } else {
          userMessage = `连接被拒绝 (HTTP ${statusCode})`;
        }
    }

    return new WebSocketError({
      httpStatus: statusCode,
      responseBody: body,
      nonRetryable,
      userMessage,
    });
  }
}
