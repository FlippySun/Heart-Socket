/**
 * Heart Socket - HDS Server（HTTP + WebSocket 混合服务器）
 *
 * 接收来自 Apple Watch HDS App 的心率数据推送。
 *
 * HDS Watch App 通过 HTTP PUT 请求发送心率数据（而非 WebSocket）。
 * 数据格式：PUT / → {"data": "heartRate:75"}
 *
 * 同时保留 WebSocket 支持，用于未来 Overlay 连接或自定义客户端。
 */
import { EventEmitter } from 'events';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ConnectionStatus } from './types';

export class HeartSocketServer extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private wsClient: WebSocket | null = null;
  private _status: ConnectionStatus = ConnectionStatus.Disconnected;
  private _port: number = 8580;

  /** 是否有 Watch 通过 HTTP 发送过数据（用于判断连接状态） */
  private httpActive: boolean = false;
  private httpTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  /** HTTP 数据超时时间：超过此时间没收到数据视为 Watch 断开 */
  private static readonly HTTP_TIMEOUT_MS = 15_000;

  get status(): ConnectionStatus {
    return this._status;
  }

  get port(): number {
    return this._port;
  }

  /**
   * 启动 HTTP + WebSocket 混合服务端
   */
  start(port: number): void {
    if (this.httpServer) {
      this.stop();
    }

    this._port = port;
    this.setStatus(ConnectionStatus.Connecting);

    try {
      // 创建 HTTP 服务器（处理 Watch 的 PUT 请求）
      this.httpServer = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      // 在 HTTP 服务器上附加 WebSocket 支持（用于未来 Overlay 连接）
      this.wsServer = new WebSocketServer({ server: this.httpServer });
      this.wsServer.on('connection', (ws: WebSocket) => {
        this.handleWsConnection(ws);
      });

      this.httpServer.on('listening', () => {
        // 服务端已就绪，等待设备连接
        this.setStatus(ConnectionStatus.Reconnecting);
        this.emit('listening', port);
      });

      this.httpServer.on('error', (err: Error) => {
        this.setStatus(ConnectionStatus.Error);
        this.emit('error', err);
      });

      this.httpServer.listen(port, '0.0.0.0');
    } catch (err) {
      this.setStatus(ConnectionStatus.Error);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 停止服务端
   */
  stop(): void {
    this.clearHttpTimeout();
    this.httpActive = false;

    if (this.wsClient) {
      this.wsClient.removeAllListeners();
      this.wsClient.close();
      this.wsClient = null;
    }

    if (this.wsServer) {
      this.wsServer.removeAllListeners();
      this.wsServer.close();
      this.wsServer = null;
    }

    if (this.httpServer) {
      this.httpServer.removeAllListeners();
      this.httpServer.close();
      this.httpServer = null;
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

  // ─── HTTP 请求处理（HDS Watch App 使用 PUT 发送数据）───

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 记录所有请求（调试用）
    this.emit('log', `[HTTP] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    // OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // HDS Watch App 使用 PUT / 发送心率数据
    if (req.method === 'PUT' && req.url === '/') {
      this.handlePutRequest(req, res);
      return;
    }

    // 也支持 POST（某些 HDS 版本可能用 POST）
    if (req.method === 'POST' && req.url === '/') {
      this.handlePutRequest(req, res);
      return;
    }

    // GET / 返回状态页（方便浏览器验证服务是否运行）
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Heart Socket Server is running 💓');
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handlePutRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';

    req.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    req.on('end', () => {
      this.emit('log', `[HTTP] Body received: ${body.substring(0, 200)}`);

      try {
        // HDS 发送格式：{"data": "heartRate:75"}
        const json = JSON.parse(body);
        const data = json.data ?? json.Data ?? body;

        // 标记 Watch 已连接
        if (!this.httpActive) {
          this.httpActive = true;
          this.setStatus(ConnectionStatus.Connected);
          this.emit('clientConnected');
        }

        // 重置超时计时器
        this.resetHttpTimeout();

        // 发射数据事件
        if (typeof data === 'string') {
          this.emit('message', data);
        } else if (typeof data === 'object') {
          this.emit('message', JSON.stringify(data));
        }

        res.writeHead(200);
        res.end();
      } catch {
        // 解析失败也尝试把原始 body 发出去
        if (body.trim()) {
          if (!this.httpActive) {
            this.httpActive = true;
            this.setStatus(ConnectionStatus.Connected);
            this.emit('clientConnected');
          }
          this.resetHttpTimeout();
          this.emit('message', body.trim());
        }
        res.writeHead(200);
        res.end();
      }
    });

    req.on('error', (err: Error) => {
      this.emit('error', err);
      res.writeHead(500);
      res.end();
    });
  }

  // ─── HTTP 超时检测（判断 Watch 是否断开）───

  private resetHttpTimeout(): void {
    this.clearHttpTimeout();
    this.httpTimeoutTimer = setTimeout(() => {
      if (this.httpActive && this.httpServer) {
        this.httpActive = false;
        this.setStatus(ConnectionStatus.Reconnecting);
        this.emit('clientDisconnected');
      }
    }, HeartSocketServer.HTTP_TIMEOUT_MS);
  }

  private clearHttpTimeout(): void {
    if (this.httpTimeoutTimer) {
      clearTimeout(this.httpTimeoutTimer);
      this.httpTimeoutTimer = null;
    }
  }

  // ─── WebSocket 连接处理（未来 Overlay 用）───

  private handleWsConnection(ws: WebSocket): void {
    if (this.wsClient) {
      this.wsClient.removeAllListeners();
      this.wsClient.close();
    }

    this.wsClient = ws;

    if (!this.httpActive) {
      this.setStatus(ConnectionStatus.Connected);
      this.emit('clientConnected');
    }

    ws.on('message', (data: Buffer | string) => {
      const message = typeof data === 'string' ? data : data.toString('utf-8');
      this.emit('message', message);
    });

    ws.on('close', () => {
      this.wsClient = null;
      if (!this.httpActive && this.httpServer) {
        this.setStatus(ConnectionStatus.Reconnecting);
        this.emit('clientDisconnected');
      }
    });

    ws.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit('statusChange', status);
    }
  }
}
