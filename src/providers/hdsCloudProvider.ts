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
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
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
      // 检查是否为旧格式（含字母），如果是则清除重新生成
      if (/[a-zA-Z]/.test(stored)) {
        this.log('检测到旧格式 Cloud ID（含字母），将重新生成纯数字 ID');
        this.context.globalState.update('hdsCloudId', undefined);
      } else {
        this.cloudId = stored;
        return stored;
      }
    }

    // 生成新的 Cloud ID（6 位纯数字，100000~999999）
    const id = String(Math.floor(100000 + Math.random() * 900000));

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
      this.log('[connect] Step 1/5: Firebase 匿名认证...');
      await this.signInAnonymously();
      this.log(`[connect] Step 1/5: 认证成功, uid=${this.uid}, token长度=${this.idToken.length}`);

      // 2. 注册 Cloud ID（写入 uid）
      this.log('[connect] Step 2/5: 注册 Cloud ID...');
      await this.registerCloudId();
      this.log('[connect] Step 2/5: Cloud ID 注册完成');

      // 3. 设置 lastConnected 时间戳
      this.log('[connect] Step 3/5: 设置 lastConnected...');
      await this.setLastConnected();
      this.log('[connect] Step 3/5: lastConnected 设置完成');

      // 4. 启动 SSE 监听
      this.log('[connect] Step 4/5: 启动 SSE 监听...');
      await this.startListening();
      this.log('[connect] Step 4/5: SSE 监听已启动');

      // 5. 启动 Token 刷新定时器
      this.log('[connect] Step 5/5: 启动 Token 刷新定时器...');
      this.startTokenRefreshTimer();

      this.updateStatus(ConnectionStatus.Reconnecting); // HDS Cloud 等待 Watch 推送数据
      this.log(`[connect] 全部完成，已连接到 HDS Cloud，Cloud ID: ${this.cloudId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`连接失败: ${msg}`);

      // 401 Permission denied → 清除缓存的认证信息，下次重连会重新登录
      if (msg.includes('401') || msg.includes('Permission denied') || msg.includes('Unauthorized')) {
        this.log('检测到认证失败，清除缓存的认证信息...');
        this.idToken = '';
        this.refreshToken = '';
        this.uid = '';
        await this.context.globalState.update('hdsCloudRefreshToken', undefined);
        await this.context.globalState.update('hdsCloudUid', undefined);
      }

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
  /**
   * 构建 Firebase RTD 认证 headers（使用 Authorization Bearer 代替 URL ?auth= 参数）
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.idToken}`,
    };
  }

  private async registerCloudId(retryCount = 0): Promise<void> {
    const MAX_RETRIES = 10;

    if (retryCount >= MAX_RETRIES) {
      throw new Error('无法生成唯一的 Cloud ID（已达到最大重试次数），请稍后重试');
    }

    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/uid.json`;

    // 先检查是否已被占用
    this.log(`[registerCloudId] 检查 Cloud ID ${this.cloudId} 是否可用...`);
    const existingUid = await this.httpsGet(url, this.getAuthHeaders());

    if (existingUid && existingUid !== 'null' && existingUid !== `"${this.uid}"`) {
      // Cloud ID 冲突，重新生成
      this.log(`Cloud ID 冲突（尝试 ${retryCount + 1}/${MAX_RETRIES}），重新生成...`);
      this.cloudId = '';
      await this.context.globalState.update('hdsCloudId', undefined);
      this.getCloudId();
      return this.registerCloudId(retryCount + 1);
    }

    // 写入 uid
    this.log(`[registerCloudId] 写入 uid 到 Cloud ID ${this.cloudId}...`);
    await this.httpsPut(url, JSON.stringify(this.uid), this.getAuthHeaders());
    this.log(`Cloud ID 已注册: ${this.cloudId}`);
  }

  /**
   * 设置 lastConnected 时间戳
   */
  private async setLastConnected(): Promise<void> {
    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/lastConnected.json`;
    const timestamp = new Date().toISOString();
    this.log('[setLastConnected] 更新连接时间戳...');
    await this.httpsPut(url, JSON.stringify(timestamp), this.getAuthHeaders());
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

  // ─── 代理支持 ───────────────────────────────────

  /** 请求超时（毫秒） */
  private static readonly REQUEST_TIMEOUT = 20000;

  /**
   * 获取代理 URL（从 VSCode 配置或环境变量）
   */
  private getProxyUrl(): string | null {
    // 优先读取 VSCode http.proxy 配置
    const vscodeProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
    if (vscodeProxy) {
      this.log(`使用 VSCode 代理: ${vscodeProxy}`);
      return vscodeProxy;
    }

    // 其次读取环境变量
    const envProxy =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy;
    if (envProxy) {
      this.log(`使用环境变量代理: ${envProxy}`);
      return envProxy;
    }

    return null;
  }

  /**
   * 通过 HTTP CONNECT 隧道建立 TLS 连接
   * 返回一个 TLS socket，可用于 HTTPS 请求
   */
  private connectViaProxy(
    proxyUrl: string,
    targetHost: string,
    targetPort: number
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const proxy = new URL(proxyUrl);
      const proxyHost = proxy.hostname;
      const proxyPort = parseInt(proxy.port, 10) || (proxy.protocol === 'https:' ? 443 : 80);

      // 设置代理认证（如果有）
      const headers: Record<string, string> = {
        'Host': `${targetHost}:${targetPort}`,
      };
      if (proxy.username && proxy.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
        headers['Proxy-Authorization'] = `Basic ${auth}`;
      }

      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers,
      });

      const timeout = setTimeout(() => {
        connectReq.destroy();
        reject(new Error(`代理连接超时（${HdsCloudProvider.REQUEST_TIMEOUT / 1000}s）`));
      }, HdsCloudProvider.REQUEST_TIMEOUT);

      connectReq.on('connect', (_res, socket) => {
        clearTimeout(timeout);

        if (_res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`代理 CONNECT 失败: HTTP ${_res.statusCode}`));
          return;
        }

        // 返回原始 TCP socket（CONNECT 隧道）
        // 让 https.request 自己在隧道上建立 TLS，避免双重 TLS
        resolve(socket);
      });

      connectReq.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`代理连接失败: ${err.message}`));
      });

      connectReq.end();
    });
  }

  /**
   * 增强的 HTTPS 请求错误处理
   */
  private enhanceError(error: Error, url: string): Error {
    const hostname = new URL(url).hostname;
    const msg = error.message;

    // TLS 断开 / 连接重置 — 大概率是网络受限（GFW）
    if (
      msg.includes('TLS') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('socket disconnected') ||
      msg.includes('socket hang up')
    ) {
      const proxyUrl = this.getProxyUrl();
      const hint = proxyUrl
        ? `（已检测到代理 ${proxyUrl}，但连接仍然失败）`
        : `\n💡 提示: 无法连接到 ${hostname}。如果你在中国大陆，Google 服务可能被屏蔽。\n` +
          `   请在 VSCode 设置中配置 http.proxy，或设置环境变量 HTTPS_PROXY，例如:\n` +
          `   "http.proxy": "http://127.0.0.1:7890"`;
      return new Error(`${msg}${hint}`);
    }

    return error;
  }

  /**
   * HTTPS POST 请求（支持代理 + 超时）
   */
  private httpsPost(url: string, data: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const parsedUrl = new URL(url);
      const proxyUrl = this.getProxyUrl();

      const requestHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Referer': 'https://hds.dev/',
      };

      try {
        let req: http.ClientRequest;

        if (proxyUrl) {
          // 通过代理隧道
          const tunnelSocket = await this.connectViaProxy(proxyUrl, parsedUrl.hostname, 443);

          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'POST',
              headers: requestHeaders,
              createConnection: () => tunnelSocket, // 让 https 在隧道上建立 TLS
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        } else {
          // 直连
          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'POST',
              headers: requestHeaders,
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        }

        // 超时
        req.setTimeout(HdsCloudProvider.REQUEST_TIMEOUT, () => {
          req.destroy();
          reject(this.enhanceError(new Error(`请求超时（${HdsCloudProvider.REQUEST_TIMEOUT / 1000}s）`), url));
        });

        req.on('error', (err) => reject(this.enhanceError(err, url)));
        req.write(data);
        req.end();
      } catch (err) {
        reject(this.enhanceError(err instanceof Error ? err : new Error(String(err)), url));
      }
    });
  }

  /**
   * HTTPS PUT 请求（支持代理 + 超时）
   */
  private httpsPut(url: string, data: string, extraHeaders?: Record<string, string>): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const parsedUrl = new URL(url);
      const proxyUrl = this.getProxyUrl();

      const requestHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Referer': 'https://hds.dev/',
        ...extraHeaders,
      };

      try {
        let req: http.ClientRequest;

        if (proxyUrl) {
          const tunnelSocket = await this.connectViaProxy(proxyUrl, parsedUrl.hostname, 443);

          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'PUT',
              headers: requestHeaders,
              createConnection: () => tunnelSocket,
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        } else {
          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'PUT',
              headers: requestHeaders,
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        }

        req.setTimeout(HdsCloudProvider.REQUEST_TIMEOUT, () => {
          req.destroy();
          reject(this.enhanceError(new Error(`请求超时（${HdsCloudProvider.REQUEST_TIMEOUT / 1000}s）`), url));
        });

        req.on('error', (err) => reject(this.enhanceError(err, url)));
        req.write(data);
        req.end();
      } catch (err) {
        reject(this.enhanceError(err instanceof Error ? err : new Error(String(err)), url));
      }
    });
  }

  /**
   * HTTPS GET 请求（支持代理 + 超时）
   */
  private httpsGet(url: string, extraHeaders?: Record<string, string>): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const parsedUrl = new URL(url);
      const proxyUrl = this.getProxyUrl();

      const requestHeaders: Record<string, string> = {
        'Referer': 'https://hds.dev/',
        ...extraHeaders,
      };

      try {
        let req: http.ClientRequest;

        if (proxyUrl) {
          const tunnelSocket = await this.connectViaProxy(proxyUrl, parsedUrl.hostname, 443);

          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'GET',
              headers: requestHeaders,
              createConnection: () => tunnelSocket,
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        } else {
          req = https.request(
            {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'GET',
              headers: requestHeaders,
            },
            (res) => this.handleResponse(res, resolve, reject)
          );
        }

        req.setTimeout(HdsCloudProvider.REQUEST_TIMEOUT, () => {
          req.destroy();
          reject(this.enhanceError(new Error(`请求超时（${HdsCloudProvider.REQUEST_TIMEOUT / 1000}s）`), url));
        });

        req.on('error', (err) => reject(this.enhanceError(err, url)));
        req.end();
      } catch (err) {
        reject(this.enhanceError(err instanceof Error ? err : new Error(String(err)), url));
      }
    });
  }

  /**
   * 处理 HTTP 响应
   */
  private handleResponse(
    res: http.IncomingMessage,
    resolve: (value: string) => void,
    reject: (reason: Error) => void
  ): void {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve(data);
      } else {
        // 详细记录错误信息，帮助诊断 401 等认证问题
        if (res.statusCode === 401 || res.statusCode === 403) {
          this.log(`[Auth Error] HTTP ${res.statusCode}`);
          this.log(`[Auth Error] Response body: ${data}`);
          this.log(`[Auth Error] Token length: ${this.idToken?.length ?? 0}`);
          this.log(`[Auth Error] UID: ${this.uid}`);
        }
        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      }
    });
  }

  /**
   * 启动 SSE 监听（支持代理 + 超时）
   */
  private async startListening(): Promise<void> {
    const url = `${FIREBASE_CONFIG.databaseURL}/overlays/${this.cloudId}/message.json`;

    this.log(`[startListening] 开始监听 Cloud ID: ${this.cloudId}`);

    const parsedUrl = new URL(url);
    const proxyUrl = this.getProxyUrl();

    const sseHeaders: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Referer': 'https://hds.dev/',
      'Authorization': `Bearer ${this.idToken}`,
    };

    const handleSseResponse = (res: http.IncomingMessage) => {
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
    };

    try {
      if (proxyUrl) {
        // 通过代理隧道建立 SSE 连接
        const tunnelSocket = await this.connectViaProxy(proxyUrl, parsedUrl.hostname, 443);

        this.sseRequest = https.request(
          {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: sseHeaders,
            createConnection: () => tunnelSocket,
          },
          handleSseResponse
        );
      } else {
        // 直连 SSE
        this.sseRequest = https.request(
          {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: sseHeaders,
          },
          handleSseResponse
        );
      }

      // SSE 连接超时（30 秒，比普通请求长）
      this.sseRequest.setTimeout(30000, () => {
        this.log('SSE 连接超时');
        this.sseRequest?.destroy();
        this.scheduleReconnect();
      });

      this.sseRequest.on('error', (error: any) => {
        const enhanced = this.enhanceError(error, url);
        this.log(`SSE 请求错误: ${enhanced.message}`);
        this.scheduleReconnect();
      });

      this.sseRequest.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`SSE 建立失败: ${msg}`);
      this.scheduleReconnect();
    }
  }
}
