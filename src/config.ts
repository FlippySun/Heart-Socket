/**
 * Heart Socket - 配置管理
 */
import * as vscode from 'vscode';
import type { HeartSocketConfig, HeartRateZones, ProviderType } from './types';

const CONFIG_SECTION = 'heartSocket';

/** 默认心率区间 */
const DEFAULT_ZONES: HeartRateZones = {
  rest: 60,
  normal: 100,
  moderate: 140,
  high: 170,
};

/**
 * 获取完整配置
 */
export function getConfig(): HeartSocketConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    provider: config.get<ProviderType>('provider', 'hds'),
    websocketUrl: config.get<string>('websocketUrl', 'ws://localhost:8080'),
    apiToken: config.get<string>('apiToken', ''),
    sessionId: config.get<string>('sessionId', ''),
    autoConnect: config.get<boolean>('autoConnect', false),
    serverPort: config.get<number>('serverPort', 8580),
    alertHighBpm: config.get<number>('alertHighBpm', 150),
    alertLowBpm: config.get<number>('alertLowBpm', 50),
    alertCooldown: config.get<number>('alertCooldown', 60),
    heartRateJsonPath: config.get<string>('heartRateJsonPath', 'heartRate'),
    // 自定义数据源 — 健康数据 JSON Path（留空不启用）
    caloriesJsonPath: config.get<string>('caloriesJsonPath', ''),
    stepCountJsonPath: config.get<string>('stepCountJsonPath', ''),
    bloodOxygenJsonPath: config.get<string>('bloodOxygenJsonPath', ''),
    distanceJsonPath: config.get<string>('distanceJsonPath', ''),
    speedJsonPath: config.get<string>('speedJsonPath', ''),
    statusBarPosition: config.get<'left' | 'right'>('statusBarPosition', 'left'),
    showHeartbeatAnimation: config.get<boolean>('showHeartbeatAnimation', true),
    zones: config.get<HeartRateZones>('zones', DEFAULT_ZONES),
    // Motion 功能配置
    enableMotion: config.get<boolean>('enableMotion', true),
    sedentaryMinutes: config.get<number>('sedentaryMinutes', 45),
    postureAlertSeconds: config.get<number>('postureAlertSeconds', 30),
    showCodingIntensity: config.get<boolean>('showCodingIntensity', true),
    showFlowState: config.get<boolean>('showFlowState', true),
    showSlackingIndex: config.get<boolean>('showSlackingIndex', true),
  };
}

/**
 * 监听配置变化
 */
export function onConfigChange(
  callback: (config: HeartSocketConfig) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CONFIG_SECTION)) {
      callback(getConfig());
    }
  });
}
