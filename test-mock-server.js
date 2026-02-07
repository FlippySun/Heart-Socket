/**
 * Heart Socket 模拟测试服务器
 *
 * 通过 WebSocket 发送模拟心率 + 健康数据，
 * 用于测试 Custom Provider 及所有展示层功能。
 *
 * 使用方法：
 *   node test-mock-server.js
 *
 * 然后在 VS Code 中：
 *   1. 点击状态栏 Heart Socket → 切换数据源 → 自定义 WebSocket
 *   2. 地址填 ws://localhost:9999
 *   3. 心率字段路径填 heartRate
 *   4. 连接后观察状态栏、tooltip、Stats 面板
 */

const { WebSocketServer } = require('ws');

const PORT = 9999;
const wss = new WebSocketServer({ port: PORT });

console.log(`\n💓 Heart Socket Mock Server 已启动`);
console.log(`📡 WebSocket 地址: ws://localhost:${PORT}`);
console.log(`\n🔧 VS Code 配置：`);
console.log(`   heartSocket.websocketUrl = "ws://localhost:${PORT}"`);
console.log(`   heartSocket.heartRateJsonPath = "heartRate"`);
console.log(`   heartSocket.caloriesJsonPath = "calories"`);
console.log(`   heartSocket.stepCountJsonPath = "stepCount"`);
console.log(`   heartSocket.bloodOxygenJsonPath = "bloodOxygen"`);
console.log(`   heartSocket.bodyMassJsonPath = "bodyMass"`);
console.log(`   heartSocket.bmiJsonPath = "bmi"`);
console.log(`\n⏳ 等待连接...\n`);

// 模拟场景：程序员的一天
const scenarios = [
  { name: '☕ 早晨平静',       bpmRange: [62, 70],  duration: 15, calories: 80,  steps: 200,  spo2: 98 },
  { name: '⌨️ 开始编码',       bpmRange: [68, 78],  duration: 15, calories: 120, steps: 250,  spo2: 97 },
  { name: '🧠 进入专注',       bpmRange: [72, 82],  duration: 20, calories: 180, steps: 280,  spo2: 98 },
  { name: '🔥 密集编码',       bpmRange: [78, 90],  duration: 15, calories: 250, steps: 300,  spo2: 97 },
  { name: '😰 遇到 Bug!',      bpmRange: [88, 105], duration: 10, calories: 300, steps: 310,  spo2: 96 },
  { name: '🎯 心流状态',       bpmRange: [75, 85],  duration: 20, calories: 350, steps: 320,  spo2: 98 },
  { name: '😴 午后犯困',       bpmRange: [58, 66],  duration: 10, calories: 380, steps: 330,  spo2: 97 },
  { name: '🚀 下午冲刺',       bpmRange: [76, 92],  duration: 15, calories: 450, steps: 500,  spo2: 97 },
  { name: '😌 收工放松',       bpmRange: [60, 70],  duration: 10, calories: 500, steps: 600,  spo2: 98 },
];

let scenarioIndex = 0;
let tickInScenario = 0;

function getCurrentScenario() {
  return scenarios[scenarioIndex % scenarios.length];
}

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 平滑心率变化（避免跳变）
let lastBpm = 70;
function getSmoothedBpm(min, max) {
  const target = randomInRange(min, max);
  // 每次最多变化 ±3 BPM
  const delta = Math.max(-3, Math.min(3, target - lastBpm));
  lastBpm = lastBpm + delta;
  return lastBpm;
}

wss.on('connection', (ws) => {
  console.log('✅ 客户端已连接！开始发送模拟数据...\n');

  scenarioIndex = 0;
  tickInScenario = 0;
  lastBpm = 68;

  const interval = setInterval(() => {
    const scenario = getCurrentScenario();
    const bpm = getSmoothedBpm(scenario.bpmRange[0], scenario.bpmRange[1]);

    // 步数随时间缓慢增长
    const stepGrowth = Math.floor(Math.random() * 3);
    const currentSteps = scenario.steps + tickInScenario * stepGrowth;

    // 卡路里缓慢增长
    const calGrowth = +(Math.random() * 0.5).toFixed(1);
    const currentCal = +(scenario.calories + tickInScenario * calGrowth).toFixed(1);

    const data = {
      heartRate: bpm,
      calories: currentCal,
      stepCount: currentSteps,
      bloodOxygen: scenario.spo2 + (Math.random() > 0.8 ? -1 : 0),
      bodyMass: 72.5,
      bmi: 23.1,
    };

    ws.send(JSON.stringify(data));

    // 每 5 秒输出一次状态
    if (tickInScenario % 5 === 0) {
      console.log(`${scenario.name} | ❤️ ${bpm} BPM | 🔥 ${currentCal} kcal | 👟 ${currentSteps} 步 | 🩸 ${data.bloodOxygen}%`);
    }

    tickInScenario++;

    // 切换场景
    if (tickInScenario >= scenario.duration) {
      tickInScenario = 0;
      scenarioIndex++;
      const next = getCurrentScenario();
      console.log(`\n━━━ 场景切换 → ${next.name} (${next.bpmRange[0]}-${next.bpmRange[1]} BPM) ━━━\n`);
    }
  }, 1000); // 每秒发送一次

  ws.on('close', () => {
    clearInterval(interval);
    console.log('\n❌ 客户端断开连接\n⏳ 等待重新连接...\n');
  });

  ws.on('error', (err) => {
    clearInterval(interval);
    console.error('错误:', err.message);
  });
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 Mock Server 关闭');
  wss.close();
  process.exit(0);
});
