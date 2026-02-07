/**
 * Heart Socket - 自定义 WebSocket Provider
 *
 * 支持任意 WebSocket 数据源，通过可配置的 JSON 路径提取心率值。
 *
 * 配置项：
 * - heartSocket.websocketUrl: WebSocket 连接地址
 * - heartSocket.heartRateJsonPath: 心率字段的 JSON 路径（如 "data.heart_rate"）
 *
 * 支持的数据格式：
 * 1. 纯数字: "75"
 * 2. 简单 JSON: {"heartRate": 75}
 * 3. 嵌套 JSON: {"data": {"heart_rate": 75}}（配置路径为 "data.heart_rate"）
 */
import { BaseProvider } from './baseProvider';

export class CustomProvider extends BaseProvider {
  readonly name = 'Custom WebSocket';

  protected getWebSocketUrl(): string {
    return this.config.websocketUrl;
  }

  protected onMessage(data: string): void {
    try {
      const trimmed = data.trim();

      // 尝试直接解析为数字
      const directNum = Number(trimmed);
      if (Number.isFinite(directNum) && directNum > 0) {
        this.emitHeartRate(directNum);
        return;
      }

      // 解析 JSON 并使用配置的路径提取心率
      const json = JSON.parse(trimmed);
      const bpm = this.extractValue(json, this.config.heartRateJsonPath);

      if (typeof bpm === 'number') {
        this.emitHeartRate(bpm);
      }
    } catch {
      // 无法解析的消息忽略
    }
  }

  /**
   * 通过 JSON 路径提取嵌套值
   *
   * @example
   * extractValue({data: {hr: 75}}, "data.hr") → 75
   * extractValue({heartRate: 75}, "heartRate") → 75
   */
  private extractValue(obj: Record<string, unknown>, path: string): unknown {
    const keys = path.split('.');
    let current: unknown = obj;

    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }

    return current;
  }
}
