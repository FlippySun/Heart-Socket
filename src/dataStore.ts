/**
 * Heart Socket - 数据持久化模块
 *
 * 使用 VS Code ExtensionContext.globalState 存储每日心率摘要，
 * 支持最近 30 天的历史数据浏览和日历展示。
 *
 * 存储结构：
 * - key: `dailyStats-YYYY-MM-DD`
 * - value: DailySummary 对象
 */
import * as vscode from 'vscode';
import type { DailySummary, HeartRateZoneName } from './types';

/** 最大保留天数 */
const MAX_RETENTION_DAYS = 90;
/** 持久化间隔 (ms) — 每 5 分钟自动保存 */
const PERSIST_INTERVAL = 5 * 60 * 1000;
/** globalState key 前缀 */
const KEY_PREFIX = 'dailyStats-';

export class DataStore {
  private context: vscode.ExtensionContext;
  private currentDate: string;
  private currentSummary: DailySummary;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private dirty: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.currentDate = this.getTodayString();
    this.currentSummary = this.loadOrCreate(this.currentDate);
    this.startAutoPersist();
  }

  /**
   * 记录一条心率数据
   */
  recordHeartRate(bpm: number, zone: HeartRateZoneName): void {
    // 检查是否跨日
    const today = this.getTodayString();
    if (today !== this.currentDate) {
      // 保存昨天的数据
      this.persist();
      this.currentDate = today;
      this.currentSummary = this.loadOrCreate(today);
    }

    const s = this.currentSummary;
    s.samples++;
    s.bpmSum += bpm;
    s.min = Math.min(s.min, bpm);
    s.max = Math.max(s.max, bpm);
    s.avg = Math.round(s.bpmSum / s.samples);

    // 更新每小时统计
    const hour = new Date().getHours();
    s.hourlySamples[hour] = (s.hourlySamples[hour] || 0) + 1;
    s.hourlyBpmSum[hour] = (s.hourlyBpmSum[hour] || 0) + bpm;
    s.hourlyAvg[hour] = Math.round(s.hourlyBpmSum[hour] / s.hourlySamples[hour]);

    // 更新区间分布（增量计算）
    s.zoneDistribution[zone] = (s.zoneDistribution[zone] || 0) + 1;

    this.dirty = true;
  }

  /**
   * 更新监测时长
   */
  updateDuration(totalDuration: number): void {
    this.currentSummary.totalDuration = totalDuration;
    this.dirty = true;
  }

  /**
   * 获取当前日摘要
   */
  getCurrentSummary(): DailySummary {
    return this.currentSummary;
  }

  /**
   * 获取指定日期的摘要
   */
  getSummary(date: string): DailySummary | null {
    const key = KEY_PREFIX + date;
    return this.context.globalState.get<DailySummary>(key) ?? null;
  }

  /**
   * 获取有数据的所有日期列表
   */
  getAvailableDates(): string[] {
    const keys = this.context.globalState.keys();
    return keys
      .filter(k => k.startsWith(KEY_PREFIX))
      .map(k => k.substring(KEY_PREFIX.length))
      .sort();
  }

  /**
   * 获取指定月份有数据的日期集合
   */
  getMonthDates(year: number, month: number): Set<string> {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const allDates = this.getAvailableDates();
    return new Set(allDates.filter(d => d.startsWith(prefix)));
  }

  /**
   * 获取今日实时摘要（已规范化区间分布为百分比）
   * 用于需要最新数据的场景（如日详情面板），避免读取可能过时的持久化数据
   */
  getLiveSummary(): DailySummary | null {
    if (this.currentSummary.samples === 0) { return null; }
    return this.normalizeZoneDistribution(this.currentSummary);
  }

  /**
   * 获取多个日期的摘要（日历视图用）
   */
  getMultipleSummaries(dates: string[]): Record<string, DailySummary> {
    const result: Record<string, DailySummary> = {};
    for (const date of dates) {
      let summary: DailySummary | null;
      if (date === this.currentDate) {
        // 今天：返回规范化后的实时数据（百分比而非原始计数）
        summary = this.getLiveSummary();
      } else {
        summary = this.getSummary(date);
      }
      if (summary) {
        result[date] = summary;
      }
    }
    return result;
  }

  /**
   * 强制持久化
   */
  persist(): void {
    if (!this.dirty && this.currentSummary.samples === 0) { return; }

    // 规范化区间分布（转换为百分比）
    const normalized = this.normalizeZoneDistribution(this.currentSummary);

    const key = KEY_PREFIX + this.currentDate;
    this.context.globalState.update(key, normalized);
    this.dirty = false;

    // 清理过期数据
    this.cleanupOldData();
  }

  /**
   * 销毁
   */
  dispose(): void {
    this.persist();
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  // ─── 私有方法 ───────────────────────────────────

  private getTodayString(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private loadOrCreate(date: string): DailySummary {
    const existing = this.getSummary(date);
    if (existing) { return existing; }

    return {
      date,
      totalDuration: 0,
      samples: 0,
      min: Infinity,
      max: -Infinity,
      avg: 0,
      bpmSum: 0,
      zoneDistribution: {},
      hourlyAvg: new Array(24).fill(null),
      hourlySamples: new Array(24).fill(0),
      hourlyBpmSum: new Array(24).fill(0),
    };
  }

  private normalizeZoneDistribution(summary: DailySummary): DailySummary {
    // 创建一个副本，将 zoneDistribution 中的计数转换为百分比
    const copy = { ...summary };
    if (copy.samples > 0) {
      const dist: Record<string, number> = {};
      // 第一遍：计算精确百分比并取整（保留两位小数）
      const entries: [string, number][] = [];
      for (const [zone, count] of Object.entries(copy.zoneDistribution)) {
        const exact = (count as number / copy.samples) * 100;
        const rounded = Math.round(exact * 100) / 100; // 保留两位小数
        dist[zone] = rounded;
        entries.push([zone, exact - rounded]); // 保存余数
      }
      // 第二遍：最大余额法修正，确保总和为 100%
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      const diff = Math.round((100 - total) * 100) / 100;
      if (diff !== 0 && entries.length > 0) {
        // 按余数降序排序，将差值分配给余数最大的区间
        entries.sort((a, b) => b[1] - a[1]);
        dist[entries[0][0]] = Math.round((dist[entries[0][0]] + diff) * 100) / 100;
      }
      copy.zoneDistribution = dist;
    }
    // 处理 Infinity 值（JSON 不支持）
    if (copy.min === Infinity) { copy.min = 0; }
    if (copy.max === -Infinity) { copy.max = 0; }
    return copy;
  }

  private startAutoPersist(): void {
    this.persistTimer = setInterval(() => {
      this.persist();
    }, PERSIST_INTERVAL);
  }

  private cleanupOldData(): void {
    const allDates = this.getAvailableDates();
    if (allDates.length <= MAX_RETENTION_DAYS) { return; }

    // 删除超出保留期限的旧数据
    const cutoff = allDates.length - MAX_RETENTION_DAYS;
    for (let i = 0; i < cutoff; i++) {
      this.context.globalState.update(KEY_PREFIX + allDates[i], undefined);
    }
  }
}
