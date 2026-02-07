/**
 * Heart Socket - 告警管理器
 *
 * 负责高/低心率告警通知：
 * - 超过高心率阈值时弹窗告警
 * - 低于低心率阈值时弹窗告警
 * - 冷却时间内不重复告警
 */
import * as vscode from 'vscode';
import type { HeartRateData, HeartSocketConfig } from './types';

export class AlertManager {
  private config: HeartSocketConfig;
  /** 高心率告警暂停截止时间 */
  private highAlertPausedUntil: number = 0;
  /** 低心率告警暂停截止时间 */
  private lowAlertPausedUntil: number = 0;

  constructor(config: HeartSocketConfig) {
    this.config = config;
  }

  /**
   * 检查心率是否需要告警
   */
  check(data: HeartRateData): void {
    const now = Date.now();
    const cooldownMs = this.config.alertCooldown * 1000;

    // 高心率告警
    if (data.bpm >= this.config.alertHighBpm) {
      if (now > this.highAlertPausedUntil) {
        this.highAlertPausedUntil = now + cooldownMs;
        this.showHighAlert(data.bpm);
      }
    }

    // 低心率告警
    if (data.bpm <= this.config.alertLowBpm) {
      if (now > this.lowAlertPausedUntil) {
        this.lowAlertPausedUntil = now + cooldownMs;
        this.showLowAlert(data.bpm);
      }
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: HeartSocketConfig): void {
    this.config = config;
  }

  /**
   * 重置告警状态
   */
  reset(): void {
    this.highAlertPausedUntil = 0;
    this.lowAlertPausedUntil = 0;
  }

  // ─── 私有方法 ───────────────────────────────────

  private showHighAlert(bpm: number): void {
    const message = `🚨 高心率警告！当前心率 ${bpm} BPM 超过阈值 ${this.config.alertHighBpm} BPM`;
    vscode.window
      .showWarningMessage(message, '暂停告警', '调整阈值')
      .then((action) => {
        if (action === '调整阈值') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'heartSocket.alertHighBpm'
          );
        } else if (action === '暂停告警') {
          // 暂停 10 分钟
          this.highAlertPausedUntil = Date.now() + 10 * 60 * 1000;
        }
      });
  }

  private showLowAlert(bpm: number): void {
    const message = `⚠️ 低心率提醒！当前心率 ${bpm} BPM 低于阈值 ${this.config.alertLowBpm} BPM`;
    vscode.window
      .showWarningMessage(message, '暂停告警', '调整阈值')
      .then((action) => {
        if (action === '调整阈值') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'heartSocket.alertLowBpm'
          );
        } else if (action === '暂停告警') {
          // 暂停 10 分钟
          this.lowAlertPausedUntil = Date.now() + 10 * 60 * 1000;
        }
      });
  }
}
