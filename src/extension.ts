/**
 * Heart Socket - VSCode Extension Entry Point
 *
 * Apple Watch 心率实时监测 VSCode 插件
 *
 * 功能：
 * - 通过 WebSocket 连接心率数据源（HDS / HypeRate / Pulsoid / 自定义）
 * - 在状态栏实时显示心率 BPM
 * - 根据心率区间自动变色
 * - 高/低心率告警通知
 * - 自动重连机制
 */
import * as vscode from 'vscode';
import { HeartRateManager } from './heartRateManager';
import { getConfig } from './config';

let manager: HeartRateManager | null = null;

/**
 * 插件激活
 */
export function activate(context: vscode.ExtensionContext): void {
  // 创建核心管理器（传入 context 用于 globalState）
  manager = new HeartRateManager(context);

  // 注册命令
  const commands: Array<{ id: string; handler: () => void | Promise<void> }> = [
    {
      id: 'heartSocket.connect',
      handler: () => manager?.connect(),
    },
    {
      id: 'heartSocket.disconnect',
      handler: () => manager?.disconnect(),
    },
    {
      id: 'heartSocket.switchProvider',
      handler: () => manager?.switchProvider(),
    },
    {
      id: 'heartSocket.showStats',
      handler: () => manager?.showStats(),
    },
    {
      id: 'heartSocket.quickActions',
      handler: () => manager?.quickActions(),
    },
  ];

  for (const cmd of commands) {
    const disposable = vscode.commands.registerCommand(cmd.id, cmd.handler);
    context.subscriptions.push(disposable);
  }

  // 将管理器加入 disposable 列表
  context.subscriptions.push({
    dispose: () => {
      manager?.dispose();
      manager = null;
    },
  });

  // 自动连接（如果配置了）
  const config = getConfig();
  if (config.autoConnect) {
    // 延迟 2 秒，等 VSCode 完全加载
    setTimeout(() => {
      manager?.connect();
    }, 2000);
  }
}

/**
 * 插件停用
 */
export function deactivate(): void {
  if (manager) {
    manager.dispose();
    manager = null;
  }
}
