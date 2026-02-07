/**
 * Heart Socket - 编辑器活动追踪器
 *
 * 作为 Motion 传感器的 **兼容回退方案**（Fallback），当数据源不支持
 * Motion 传感器（如 Pulsoid、HypeRate、Custom WebSocket）时，
 * 通过 VS Code 编辑器事件提供基础的活动数据。
 *
 * ⚠️ 注意事项：
 * - 此追踪器仅检测编辑器中的文本变更事件，**无法检测 AI 代码生成、
 *   阅读文档、浏览网页、终端操作等非编辑器活动**。
 * - 在 AI 辅助编程场景下（如 GitHub Copilot、Cursor 等），
 *   大部分代码由 AI 生成，编辑器活动数据会**严重偏低**。
 * - 建议使用 HDS 数据源（Apple Watch 直连）获取真实的 Motion 传感器数据，
 *   以获得最准确的分析结果。
 *
 * 功能：
 * - 监听 vscode.workspace.onDidChangeTextDocument 事件
 * - 滑动窗口统计每秒字符数
 * - 追踪最后编辑时间（用于空闲判断）
 */
import * as vscode from 'vscode';
import { EventEmitter } from 'events';

/** 活动数据滑动窗口大小（秒） */
const ACTIVITY_WINDOW_SEC = 5;

/** 采样间隔（ms） */
const SAMPLE_INTERVAL = 1000;

export class EditorActivityTracker extends EventEmitter {
  private disposables: vscode.Disposable[] = [];

  /** 滑动窗口：每秒字符变更数 */
  private charCountBuffer: number[] = [];

  /** 当前采样周期内的字符变更计数 */
  private currentPeriodChars: number = 0;

  /** 最后一次编辑时间 */
  private _lastEditTime: number = 0;

  /** 采样定时器 */
  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  /** 是否已启动 */
  private _isActive: boolean = false;

  constructor() {
    super();
  }

  /**
   * 启动追踪
   */
  start(): void {
    if (this._isActive) { return; }
    this._isActive = true;

    // 监听文档变更事件
    const docChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChangeDisposable);

    // 每秒采样一次
    this.sampleTimer = setInterval(() => {
      this.sample();
    }, SAMPLE_INTERVAL);
  }

  /**
   * 停止追踪
   */
  stop(): void {
    this._isActive = false;

    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.charCountBuffer = [];
    this.currentPeriodChars = 0;
  }

  /**
   * 获取最后编辑时间
   */
  get lastEditTime(): number {
    return this._lastEditTime;
  }

  /**
   * 获取当前每秒平均字符数
   */
  get averageCharsPerSecond(): number {
    if (this.charCountBuffer.length === 0) { return 0; }
    const sum = this.charCountBuffer.reduce((s, v) => s + v, 0);
    return sum / this.charCountBuffer.length;
  }

  /**
   * 销毁
   */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  // ─── 私有方法 ───────────────────────────────────

  /**
   * 处理文档变更事件
   */
  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    // 忽略非用户文件（如 output channel、settings 等）
    if (e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled') {
      return;
    }

    // 累计本周期内的字符变更数
    for (const change of e.contentChanges) {
      // 插入的字符数
      this.currentPeriodChars += change.text.length;
      // 删除的字符数也算活动
      if (change.rangeLength > 0) {
        this.currentPeriodChars += change.rangeLength;
      }
    }

    this._lastEditTime = Date.now();
  }

  /**
   * 每秒采样
   */
  private sample(): void {
    // 将当前周期的字符数加入缓冲区
    this.charCountBuffer.push(this.currentPeriodChars);
    this.currentPeriodChars = 0;

    // 维持滑动窗口大小
    if (this.charCountBuffer.length > ACTIVITY_WINDOW_SEC) {
      this.charCountBuffer.shift();
    }

    // 计算每秒平均字符数
    const avgCps = this.averageCharsPerSecond;

    // 发送活动数据
    this.emit('typingActivity', avgCps);
  }
}
