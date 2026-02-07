/**
 * Heart Socket - 自定义 WebSocket Provider
 *
 * 支持任意 WebSocket 数据源，通过可配置的 JSON 路径提取心率及健康数据。
 *
 * 配置项：
 * - heartSocket.websocketUrl: WebSocket 连接地址
 * - heartSocket.heartRateJsonPath: 心率字段的 JSON 路径（如 "data.heart_rate"）
 * - heartSocket.caloriesJsonPath: 卡路里字段的 JSON 路径（如 "data.calories"，留空不启用）
 * - heartSocket.stepCountJsonPath: 步数字段的 JSON 路径（如 "data.steps"，留空不启用）
 * - heartSocket.bloodOxygenJsonPath: 血氧字段的 JSON 路径（如 "data.spo2"，留空不启用）
 * - heartSocket.distanceJsonPath: 距离字段的 JSON 路径（如 "data.distance"，留空不启用）
 * - heartSocket.speedJsonPath: 速度字段的 JSON 路径（如 "data.speed"，留空不启用）
 *
 * 支持的数据格式：
 * 1. 纯数字: "75" → 视为心率
 * 2. 简单 JSON: {"heartRate": 75}
 * 3. 嵌套 JSON: {"data": {"heart_rate": 75, "calories": 120, "steps": 5000}}
 * 4. 多字段 JSON: 一条消息中可同时包含心率 + 卡路里 + 步数 + 血氧 + 距离 + 速度
 */
import { BaseProvider } from './baseProvider';
import type { HealthDataType } from '../types';

/** 健康数据字段映射定义 */
interface HealthFieldMapping {
  /** 配置中的 JSON Path key */
  configKey: 'caloriesJsonPath' | 'stepCountJsonPath' | 'bloodOxygenJsonPath' | 'distanceJsonPath' | 'speedJsonPath' | 'bodyMassJsonPath' | 'bmiJsonPath';
  /** 对应的 HealthDataType */
  type: HealthDataType;
  /** 数值校验函数（可选） */
  validate?: (v: number) => boolean;
}

/** 所有健康数据字段的映射关系 */
const HEALTH_FIELD_MAPPINGS: HealthFieldMapping[] = [
  { configKey: 'caloriesJsonPath', type: 'calories', validate: (v) => v >= 0 },
  { configKey: 'stepCountJsonPath', type: 'stepCount', validate: (v) => v >= 0 && Number.isInteger(v) },
  { configKey: 'bloodOxygenJsonPath', type: 'bloodOxygen', validate: (v) => v >= 0 && v <= 100 },
  { configKey: 'distanceJsonPath', type: 'distance', validate: (v) => v >= 0 },
  { configKey: 'speedJsonPath', type: 'speed', validate: (v) => v >= 0 },
  { configKey: 'bodyMassJsonPath', type: 'bodyMass', validate: (v) => v > 0 && v < 500 },
  { configKey: 'bmiJsonPath', type: 'bmi', validate: (v) => v > 0 && v < 100 },
];

export class CustomProvider extends BaseProvider {
  readonly name = 'Custom WebSocket';

  protected getWebSocketUrl(): string {
    return this.config.websocketUrl;
  }

  protected onConnected(): void {
    this.log('已连接到自定义 WebSocket 服务端');
  }

  protected onMessage(data: string): void {
    try {
      const trimmed = data.trim();

      // 尝试直接解析为数字（视为心率）
      const directNum = Number(trimmed);
      if (Number.isFinite(directNum) && directNum > 0) {
        this.emitHeartRate(directNum);
        return;
      }

      // 解析 JSON 并提取各字段
      const json = JSON.parse(trimmed);

      // 1. 提取心率
      if (this.config.heartRateJsonPath) {
        const bpm = this.extractValue(json, this.config.heartRateJsonPath);
        if (typeof bpm === 'number') {
          this.emitHeartRate(bpm);
        }
      }

      // 2. 提取健康数据（卡路里、步数、血氧、距离、速度）
      this.extractHealthData(json);
    } catch {
      // 无法解析的消息忽略
    }
  }

  /**
   * 从 JSON 消息中提取健康数据并派发事件
   *
   * 遍历所有已配置的健康数据字段映射，
   * 对每个有效字段 emit 'healthData' 事件。
   */
  private extractHealthData(json: unknown): void {
    for (const { configKey, type, validate } of HEALTH_FIELD_MAPPINGS) {
      const path = this.config[configKey];
      if (!path) {
        continue; // 未配置则跳过
      }

      const value = this.extractValue(json, path);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        continue; // 非有效数字跳过
      }

      if (validate && !validate(value)) {
        continue; // 校验不通过跳过
      }

      this.emitHealthData(type, value);
    }
  }

  /**
   * 通过 JSON 路径提取嵌套值
   *
   * @example
   * extractValue({data: {hr: 75}}, "data.hr") → 75
   * extractValue({heartRate: 75}, "heartRate") → 75
   */
  private extractValue(obj: unknown, path: string): unknown {
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
