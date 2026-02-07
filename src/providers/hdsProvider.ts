/**
 * Heart Socket - Health Data Server (HDS) Provider
 *
 * Health Data Server 是一个 Apple Watch App，
 * 通过 WebSocket 将心率数据发送到指定 IP:PORT。
 *
 * 数据格式示例：
 * {
 *   "heartRate": 75,
 *   "timestamp": 1234567890,
 *   "calories": 150,
 *   "activeCalories": 100
 * }
 *
 * 也可能是简单格式：
 * {"bpm": 75}
 * 或纯数字：
 * 75
 */
import { BaseProvider } from './baseProvider';

export class HdsProvider extends BaseProvider {
  readonly name = 'Health Data Server';

  protected getWebSocketUrl(): string {
    return this.config.websocketUrl;
  }

  protected onMessage(data: string): void {
    try {
      const trimmed = data.trim();

      // 尝试直接解析为数字（某些简化版本直接发送心率数字）
      const directNum = Number(trimmed);
      if (Number.isFinite(directNum) && directNum > 0) {
        this.emitHeartRate(directNum);
        return;
      }

      // 尝试解析为 JSON
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
}
