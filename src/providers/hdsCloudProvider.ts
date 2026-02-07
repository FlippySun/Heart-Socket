/**
 * Heart Socket - HDS Cloud Provider
 *
 * HDS Cloud 模式使用 Firebase Realtime Database 接收 Apple Watch 推送的心率数据。
 * Watch 通过 HDS App 的 Cloud 模式将数据发送到 Firebase，本插件监听对应的 Cloud ID。
 *
 * 优点：
 * - 无需 IP 地址或 .local 域名
 * - Cloud ID 永久不变，切换网络无需重新配置
 * - 跨网络工作（Watch 可以用蜂窝数据）
 *
 * 数据流：Apple Watch HDS App (Cloud) → Firebase RTD → 本插件
 *
 * Firebase 项目信息（来自 HDS 开源项目）:
 * - 项目: health-data-server
 * - 数据库: https://health-data-server-default-rtdb.firebaseio.com
 * - API Key: AIzaSyCbbBPvlWvmOvI6Is8PYXNpJ78N03AYcyU
 *
 * @author Heart Socket Team
 * @version 0.1.0
 */
import { EventEmitter } from 'events';
import * as https from 'https';
import * as vscode from 'vscode';
import { ConnectionStatus } from '../types';
import type { HeartRateData, HealthData, HealthDataType, HeartSocketConfig } from '../types';

/** Firebase 配置 */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCbbBPvlWvmOvI6Is8PYXNpJ78N03AYcyU',
  databaseURL: 'https://health-data-server-default-rtdb.firebaseio.com',
  authEndpoint: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
  tokenEndpoint: 'https://securetoken.googleapis.com/v1/token',
};

/** Firebase 认证响应 */
interface FirebaseAuthResponse {
  idToken: string;
  refreshToken: string;
  localId: string;
  expiresIn?: string;
}

/** Firebase Token 刷新响应 */
interface FirebaseTokenRefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
}

/** Firebase RTD 消息格式 */
interface FirebaseMessage {
  s: string; // source (e.g., "watch")
  t: string; // type (e.g., "heartRate")
  v: string; // value (e.g., "72")
}

/** HDS key → HealthDataType 映射 */
const HEALTH_KEY_MAP: Record<string, HealthDataType> = {
  calories: 'calories',
  stepcount: 'stepCount',
  stepCount: 'stepCount',
  distance: 'distance',
  speed: 'speed',
  bloodoxygen: 'bloodOxygen',
  bloodOxygen: 'bloodOxygen',
  bodymass: 'bodyMass',
  bodyMass: 'bodyMass',
  bmi: 'bmi',
};

export class HdsCloudProvider extends EventEmitter {
  readonly name = 'HDS Cloud';
  private config: HeartSocketConfig;
  private context: vscode.ExtensionContext;
  private _isConnected: boolean = false;
  private _status: ConnectionStatus = ConnectionStatus.Disconnected;

  // Firebase 认证信息
  private cloudId: string = '';
  private uid: string = '';
  private idToken: string = '';
  private refreshToken: string = '';

  // SSE 连接
  private sseRequest: any = null;
  private sseResponse: any = null;

  // Token 刷新定时器（每 50 分钟刷新一次，Firebase token 有效期 1 小时）
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  // 重连逻辑
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;

  constructor(config: HeartSocketConfig, context: vscode.ExtensionContext) {
    super();
    this.config = config;
    this.context = context;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * 获取或生成 Cloud ID
   */
  getCloudId(): string {
    if (this.cloudId) {
      return this.cloudId;
    }

    // 从 globalState 读取
    const stored = this.context.globalState.get<string>('hdsCloudId');
    if (stored) {
      this.cloudId = stored;
      return stored;
    }

    // 生成新的 Cloud ID（6 位小写字母+数字）
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    this.cloudId = id;
    this.context.globalState.update('hdsCloudId', id);
    return id;
  }

  /**
   * 启动连接
   */
  async connect(): Promise<void> {
    this.getCloudId();
    this.updateStatus(ConnectionStatus.Connecting);
    this.log('正在连接到 HDS Cloud...');

    try {
      // 1. Firebase 匿名认证
      await this.signInAnonymously();

      // 2. 注册 Cloud ID（写入 uid）
      await this.registerCloudId();

      // 3. 设置 lastConnected 时间戳
      await this.setLastConnected();

      // 4. 启动 SSE 监听
      await this.startListening();

      // 5. 启动 Token 刷新定时器
      this.startTokenRefreshTimer();

      this.updateStatus(ConnectionStatus.Reconnecting); // HDS Cloud 等待 Watch 推送数据
      this.log(`已连接到 HDS Cloud，Cloud ID: ${this.cloudId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`连接失败: ${msg}`);
      this.emit('error', new Error(msg));
      this.updateStatus(ConnectionStatus.Error);

      // 重连逻辑
      this.scheduleReconnect();
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.log('断开连接');
    this.cleanup();
    this.updateStatus(ConnectionStatus.Disconnected);
  }

  updateConfig(config: HeartSocketConfig): void {
    this.config = config;
  }

  dispose(): void {
    this.cleanup();
    this.removeAllListeners();
  }

  // ─── Firebase 认证 ───────────────────────────────

  /**
   * Firebase 匿名登录
   */
  private async signInAnonymously(): Promise<void> {
    // 尝试从存储中恢复 refreshToken
    const storedRefreshToken = this.context.globalState.get<string>('hdsCloudRefreshToken');
    const storedUid = this.context.globalState.get<string>('hdsCloudUid');

    if (storedRefreshToken && storedUid) {
      this.refreshToken = storedRefreshToken;
      this.uid = storedUid;
      this.log('使用已存储的认证信息');

      try {
        await this.refreshIdToken();
        return;
      } catch (error) {
        this.log('Token 刷新失败，重新登录');
      }
    }

    // 新登录
    this.log('正在进行 Firebase 匿名认证...');
    const url = `${FIREBASE_CONFIG.authEndpoint}?key=${FIREBASE_CONFIG.apiKey}`;
    const data = JSON.stringify({ returnSecureToken: true });

    const response = await this.httpsPost(url, data);
    const auth: FirebaseAuthResponse = JSON.parse(response);

    this.idToken = auth.idToken;
    this.refreshToken = auth.refreshToken;
    this.uid = auth.localId;

    // 持久化存储
    await this.context.globalState.update('hdsCloudRefreshToken', this.refreshToken);
    await this.context.globalState.update('hdsCloudUid', this.uid);

    this.log(`认证成功，UID: ${this.uid}`);
  }

  /**
   * 刷新 ID Token
   */
  private async refreshIdToken(): Promise<void> {
    const url = `${FIREBASE_CONFIG.tokenEndpoint}?key=${FIREBASE_CONFIG.apiKey}`;
    const data = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    const response = await this.httpsPost(url, data);
    const result: FirebaseTokenRefreshResponse = JSON.parse(response);

    this.idToken = result.id_token;
    if (result.refresh_token) {
      this.refreshToken = result.refresh_token;
      await this.context.globalState.update('hdsCloudRefreshToken', this.refreshToken);
    }

    this.log('Token 已刷新');
  }

  /**
   * 启动 Token 自动刷新定时器（每 50 分钟）
   */
  private startTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
    }

    this.tokenRefreshTimer = setInterval(async () => {
      try {
        await this.refreshIdToken();
      } catch (error) {
        this.log(`Token 刷新失败: ${error}`);
        // Token 刷新失败后重新连接
        this.disconnect();
        this.scheduleReconnect();
      }
    }, 50 * 60 * 1000); // 50 分钟
  }

  // ─── Firebase Realtime Database 操作 ───────────────

  /**
   * 注册 Cloud ID（写入 uid）
   * @param retryCount 当前重试次数（内部使用）
   */
  private async registerCloudId(retryCount = 0): Promise<void> {
    const MAX_RETRIES = 10;

    if (retryCount >= MAX_RETRIES) {
      throw new Error('无法生成唯一的 Cloud ID（已达到最大重试次数），请稍后重试');
    }

    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/uid.json?auth=${this.idToken}`;

    // 先检查是否已被占用
    const existingUid = await this.httpsGet(url);

    if (existingUid && existingUid !== `"${this.uid}"`) {
      // Cloud ID 冲突，重新生成
      this.log(`Cloud ID 冲突（尝试 ${retryCount + 1}/${MAX_RETRIES}），重新生成...`);
      this.cloudId = '';
      await this.context.globalState.update('hdsCloudId', undefined);
      this.getCloudId();
      return this.registerCloudId(retryCount + 1);
    }

    // 写入 uid
    await this.httpsPut(url, JSON.stringify(this.uid));
    this.log(`Cloud ID 已注册: ${this.cloudId}`);
  }

  /**
   * 设置 lastConnected 时间戳
   */
  private async setLastConnected(): Promise<void> {
    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/lastConnected.json?auth=${this.idToken}`;
    const timestamp = new Date().toISOString();
    await this.httpsPut(url, JSON.stringify(timestamp));
  }

  /**
   * 启动 SSE 监听
   */
  private async startListening(): Promise<void> {
    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/message.json?auth=${this.idToken}`;

    this.log(`开始监听: ${url.replace(this.idToken, '***')}`);

    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    };

    this.sseRequest = https.request(options, (res) => {
      this.sseResponse = res;

      if (res.statusCode !== 200) {
        this.log(`SSE 连接失败，状态码: ${res.statusCode}`);
        this.scheduleReconnect();
        return;
      }

      this.log('SSE 连接已建立');
      this.reconnectAttempts = 0; // 重置重连次数

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // 处理 SSE 事件（可能一次收到多个事件）
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // 保留未完成的部分

        for (const eventText of lines) {
          this.handleSSEEvent(eventText);
        }
      });

      res.on('end', () => {
        this.log('SSE 连接已关闭');
        this.scheduleReconnect();
      });

      res.on('error', (error) => {
        this.log(`SSE 错误: ${error.message}`);
        this.scheduleReconnect();
      });
    });

    this.sseRequest.on('error', (error: any) => {
      this.log(`SSE 请求错误: ${error.message}`);
      this.scheduleReconnect();
    });

    this.sseRequest.end();
  }

  /**
   * 处理 SSE 事件
   */
  private handleSSEEvent(eventText: string): void {
    if (!eventText.trim()) {
      return;
    }

    // SSE 格式:
    // event: put
    // data: {"path":"/","data":{"s":"watch","t":"heartRate","v":"72"}}
    const lines = eventText.split('\n');
    let eventType = '';
    let dataJson = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        dataJson = line.substring(5).trim();
      }
    }

    if (eventType !== 'put' && eventType !== 'patch') {
      return; // 只处理 put/patch 事件
    }

    if (!dataJson) {
      return;
    }

    try {
      const event = JSON.parse(dataJson);
      const message: FirebaseMessage = event.data;

      if (!message || typeof message !== 'object') {
        return;
      }

      // 首次收到消息，标记为已连接
      if (!this._isConnected) {
        this._isConnected = true;
        this.updateStatus(ConnectionStatus.Connected);
      }

      this.handleMessage(message);
    } catch (error) {
      // 忽略解析错误
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(message: FirebaseMessage): void {
    const { s: source, t: type, v: value } = message;

    // 心率数据
    if (type === 'heartRate' || type === 'hr' || type === 'bpm') {
      const bpm = Number(value);
      if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 250) {
        this.emitHeartRate(bpm, source);
      }
      return;
    }

    // motion 数据（忽略）
    if (type === 'motion') {
      return;
    }

    // 其他健康数据
    const healthType = HEALTH_KEY_MAP[type];
    if (healthType) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        this.emitHealthData(healthType, num, source);
      }
    }
  }

  // ─── 数据发射 ───────────────────────────────────

  private emitHeartRate(bpm: number, source: string): void {
    const data: HeartRateData = {
      bpm: Math.round(bpm),
      timestamp: Date.now(),
      source: `${this.name} (${source})`,
    };

    this.emit('heartRate', data);
  }

  private emitHealthData(type: HealthDataType, value: number, source: string): void {
    const data: HealthData = {
      type,
      value,
      timestamp: Date.now(),
      source: `${this.name} (${source})`,
    };

    this.emit('healthData', data);
  }

  // ─── 重连逻辑 ───────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // 已有重连任务
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('已达到最大重连次数，停止重连');
      this.updateStatus(ConnectionStatus.Error);

      // 显示友好的用户提示
      vscode.window.showErrorMessage(
        'HDS Cloud 连接失败，已达到最大重试次数。',
        '切换到本地 HDS',
        '重新连接'
      ).then(action => {
        if (action === '重新连接') {
          this.reconnectAttempts = 0;
          this.connect();
        } else if (action === '切换到本地 HDS') {
          vscode.commands.executeCommand('heart-socket.switchProvider');
        }
      });

      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(5000 * this.reconnectAttempts, 60000); // 最多延迟 60 秒

    this.log(`${delay / 1000} 秒后重连（${this.reconnectAttempts}/${this.maxReconnectAttempts}）`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.cleanup();
      this.connect();
    }, delay);
  }

  // ─── 工具方法 ───────────────────────────────────

  private cleanup(): void {
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }
    if (this.sseResponse) {
      this.sseResponse.destroy();
      this.sseResponse = null;
    }
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._isConnected = false;
  }

  private updateStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit('statusChange', status);
  }

  private log(message: string): void {
    this.emit('log', message);
  }

  /**
   * HTTPS POST 请求
   */
  private httpsPost(url: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * HTTPS PUT 请求
   */
  private httpsPut(url: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * HTTPS GET 请求
   */
  private httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', reject);
    });
  }
}
