/**
 * Heart Socket - Pulsoid Provider
 *
 * Pulsoid 提供 WebSocket API 实时接收心率数据。
 *
 * 连接 URL: wss://dev.pulsoid.net/api/v1/data/real_time?access_token=TOKEN
 *
 * 数据格式：
 * {
 *   "measured_at": 1234567890,
 *   "data": {
 *     "heart_rate": 75
 *   }
 * }
 */
import { BaseProvider } from './baseProvider';

export class PulsoidProvider extends BaseProvider {
  readonly name = 'Pulsoid';

  protected getWebSocketUrl(): string {
    const token = this.config.apiToken;
    if (!token) {
      throw new Error('Pulsoid 需要配置 Access Token（heartSocket.apiToken）');
    }
    return `wss://dev.pulsoid.net/api/v1/data/real_time?access_token=${token}`;
  }

  protected onMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // Pulsoid 标准格式
      if (msg.data && typeof msg.data.heart_rate === 'number') {
        this.emitHeartRate(msg.data.heart_rate);
        return;
      }

      // 兼容其他可能的格式
      const bpm =
        msg.heart_rate ??
        msg.heartRate ??
        msg.hr ??
        msg.bpm;

      if (typeof bpm === 'number') {
        this.emitHeartRate(bpm);
      }
    } catch {
      // 解析失败忽略
    }
  }
}
