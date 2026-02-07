/**
 * Heart Socket - HypeRate Provider
 *
 * HypeRate 使用 Phoenix Channel 协议通过 WebSocket 传输心率数据。
 *
 * 连接流程：
 * 1. 连接到 wss://app.hyperate.io/socket/websocket?token=API_TOKEN
 * 2. 发送 join 消息加入频道 hr:SESSION_ID
 * 3. 定期发送 phoenix heartbeat 保持连接
 * 4. 接收 hr_update 事件获取心率数据
 *
 * 数据格式：
 * {"topic": "hr:SESSION_ID", "event": "hr_update", "payload": {"hr": 75}, "ref": null}
 */
import { BaseProvider } from './baseProvider';

export class HypeRateProvider extends BaseProvider {
  readonly name = 'HypeRate';
  private phoenixHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Phoenix Channel 消息引用计数（实例级别，避免多实例间共享污染） */
  private refCounter = 0;

  private nextRef(): number {
    return ++this.refCounter;
  }

  protected getWebSocketUrl(): string {
    const token = this.config.apiToken;
    if (!token) {
      throw new Error('HypeRate 需要配置 API Token（heartSocket.apiToken）');
    }
    return `wss://app.hyperate.io/socket/websocket?token=${token}`;
  }

  /**
   * 连接成功后加入频道并启动 Phoenix heartbeat
   */
  protected onConnected(): void {
    const sessionId = this.config.sessionId;
    if (!sessionId) {
      this.emit('error', new Error('HypeRate 需要配置 Session ID（heartSocket.sessionId）'));
      return;
    }

    // 加入频道
    const joinMsg = JSON.stringify({
      topic: `hr:${sessionId}`,
      event: 'phx_join',
      payload: {},
      ref: this.nextRef(),
    });
    this.wsClient.send(joinMsg);
    this.log(`正在加入 HypeRate 频道 hr:${sessionId}...`);

    // 启动 Phoenix heartbeat（每30秒）
    this.startPhoenixHeartbeat();
  }

  protected onMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // 处理心率更新事件
      if (msg.event === 'hr_update' && msg.payload) {
        const bpm = msg.payload.hr ?? msg.payload.heartRate ?? msg.payload.bpm;
        if (typeof bpm === 'number') {
          this.emitHeartRate(bpm);
        }
      }

      // 处理 join 回复
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
        this.log('已成功加入 HypeRate 频道');
      }

      // 处理错误
      if (msg.event === 'phx_error' || msg.payload?.status === 'error') {
        this.log(`HypeRate 频道错误: ${JSON.stringify(msg.payload)}`);
        this.emit('error', new Error(`HypeRate channel error: ${JSON.stringify(msg.payload)}`));
      }
    } catch {
      // 解析失败忽略
    }
  }

  /**
   * Phoenix Channel 协议要求定期发送 heartbeat
   */
  private startPhoenixHeartbeat(): void {
    this.stopPhoenixHeartbeat();
    this.phoenixHeartbeatTimer = setInterval(() => {
      const heartbeat = JSON.stringify({
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref: this.nextRef(),
      });
      this.wsClient.send(heartbeat);
    }, 30000);
  }

  private stopPhoenixHeartbeat(): void {
    if (this.phoenixHeartbeatTimer) {
      clearInterval(this.phoenixHeartbeatTimer);
      this.phoenixHeartbeatTimer = null;
    }
  }

  dispose(): void {
    this.stopPhoenixHeartbeat();
    super.dispose();
  }
}
