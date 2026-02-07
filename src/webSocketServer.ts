/**
 * Heart Socket - WebSocket Server
 *
 * 创建本地 WebSocket 服务端，接收来自 Apple Watch 等设备的心率数据推送。
 * 用于 HDS 模式：Watch App 直连到本插件，无需中间件。
 */
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { ConnectionStatus } from './types';

export class HeartSocketServer extends EventEmitter {
  private server: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private _status: ConnectionStatus = ConnectionStatus.Disconnected;
  private _port: number = 8580;

  get status(): ConnectionStatus {
    return this._status;
  }

  get port(): number {
    return this._port;
  }

  /**
   * 启动 WebSocket 服务端，监听指定端口
   */
  start(port: number): void {
    if (this.server) {
      this.stop();
    }

    this._port = port;
    this.setStatus(ConnectionStatus.Connecting);

    try {
      this.server = new WebSocketServer({ port });

      this.server.on('listening', () => {
        // 服务端已就绪，等待设备连接
        this.setStatus(ConnectionStatus.Reconnecting); // 复用"重连中"表示"等待设备连接"
        this.emit('listening', port);
      });

      this.server.on('connection', (ws: WebSocket) => {
        // 如果已有客户端连接，关闭旧的
        if (this.client) {
          this.client.removeAllListeners();
          this.client.close();
        }

        this.client = ws;
        this.setStatus(ConnectionStatus.Connected);
        this.emit('clientConnected');

        ws.on('message', (data: Buffer | string) => {
          const message = typeof data === 'string' ? data : data.toString('utf-8');
          this.emit('message', message);
        });

        ws.on('close', () => {
          this.client = null;
          // 设备断开后回到等待状态（服务仍在运行）
          if (this.server) {
            this.setStatus(ConnectionStatus.Reconnecting);
            this.emit('clientDisconnected');
          }
        });

        ws.on('error', (err: Error) => {
          this.emit('error', err);
        });
      });

      this.server.on('error', (err: Error) => {
        this.setStatus(ConnectionStatus.Error);
        this.emit('error', err);
      });
    } catch (err) {
      this.setStatus(ConnectionStatus.Error);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 停止服务端
   */
  stop(): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }

    if (this.server) {
      this.server.removeAllListeners();
      this.server.close();
      this.server = null;
    }

    this.setStatus(ConnectionStatus.Disconnected);
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit('statusChange', status);
    }
  }
}
