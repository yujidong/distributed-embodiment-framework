/**
 * QA script (P3d): city sim + fault injection narration.
 *
 * Scenario: suzhou-city with a mock LLM (same pattern as the EngineRuntime
 * tests — canned 'collaborate' decisions drive real Layer-2 AC initiation,
 * no LLM backend needed). A humidity-spike in taihu-new-town triggers an AC by
 * emergency-mgmt, whose executor commands its pa-jinji-01 actuator. The
 * moment the AC starts, the script offlines that actuator MID-COLLABORATION:
 * every subsequent command fails with 'device offline', and the event stream
 * narrates it (device.fault_changed + device.operation_executed failures) —
 * exactly what the console's episode panel renders.
 *
 * Run from the repo root:
 *   npx tsx packages/core/scripts/qa-city-fault-injection.ts
 *
 * Exit 0 when the narration contains ≥1 offline-caused command failure;
 * exit 1 otherwise (the QA property regressed).
 */

import { resolve } from 'node:path';

import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { loadScenarioFromFile } from '../src/scenario/index.js';
import { EngineRuntime } from '../src/runtime/index.js';

configureLogger({ level: LoggerLevel.ERROR });

const FAULTED_DEVICE = 'pa-jinji-01';

/** Mock LLM: every AC-necessity assessment decides 'collaborate'. */
class MockLLM {
  setLoggingCallback(): void { /* no-op */ }
  setContextProvider(): void { /* no-op */ }
  getProviderName(): string { return 'mock'; }
  async healthCheck(): Promise<boolean> { return true; }
  async quickChat(): Promise<{
    content: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    return {
      content: JSON.stringify({ decision: 'collaborate', reasoning: 'mock QA client' }),
      model: 'mock-qa',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    return this.quickChat();
  }
}

interface NarrationLine {
  t: number;
  text: string;
}

async function main(): Promise<void> {
  const scenario = loadScenarioFromFile(resolve(process.cwd(), 'config/scenarios/suzhou-city.json'));
  // Strip scheduled events: this QA drives one controlled incident.
  const runtime = new EngineRuntime(
    { ...scenario, events: [] },
    { llmClient: new MockLLM() as never },
  );

  const narration: NarrationLine[] = [];
  let offlineFailures = 0;
  let faultInjected = false;

  runtime.subscribe(event => {
    const t = runtime.getSimTimeSec();
    const p = event.payload as Record<string, unknown>;

    if (event.type === 'device.fault_changed') {
      narration.push({ t, text: `⚠ 故障注入 ${p.deviceId}: ${JSON.stringify(p.profile)}` });
      return;
    }
    if (event.type === 'device.error') {
      const offline = typeof p.error === 'string' && p.error.includes('offline');
      if (offline) offlineFailures += 1;
      narration.push({ t, text: `✗ 设备错误 ${p.deviceName ?? p.deviceId} ${p.commandName ?? ''} → ${p.error}` });
      return;
    }
    if (event.type === 'device.operation_executed') {
      const failed = p.success === false || p.error !== undefined;
      narration.push({
        t,
        text: `设备操作 ${p.deviceName ?? p.deviceId} ${p.commandName} → ` +
          (failed ? `失败 (${p.error})` : '成功'),
      });
      return;
    }
    if (event.type.startsWith('collaboration.')) {
      narration.push({
        t,
        text: `${event.type} ${p.collaborationName ?? p.acName ?? p.collaborationId ?? ''}`.trim(),
      });
      // The QA hook: the moment an AC starts, offline its actuator.
      if (event.type === 'collaboration.started' && !faultInjected) {
        faultInjected = true;
        runtime.setDeviceFault(FAULTED_DEVICE, { offline: true });
      }
    }
  });

  runtime.start(30); // 30 sim-s per tick
  runtime.pause();   // manual stepping

  console.log('--- 注入 humidity-spike @ taihu-new-town (severity high) ---');
  await runtime.injectEvent({ type: 'humidity-spike', zoneId: 'taihu-new-town', severity: 'high' });

  for (let i = 0; i < 6; i++) await runtime.step(1);

  console.log('--- 清除故障，恢复执行器 ---');
  runtime.setDeviceFault(FAULTED_DEVICE, null);
  // After recovery a manual command succeeds again.
  const recovered = await runtime.executeDeviceCommand(FAULTED_DEVICE, 'power-control', {});
  console.log(`恢复后手动命令 power-control → success=${recovered.success}`);

  console.log('\n=== 叙事（事件流）===');
  for (const line of narration) {
    console.log(`[t=${String(line.t).padStart(4)}s] ${line.text}`);
  }
  console.log(`\n离线导致的命令失败: ${offlineFailures}`);

  runtime.stop();
  if (offlineFailures === 0) {
    console.error('QA FAILED: no offline-caused command failure was narrated');
    process.exit(1);
  }
  console.log('QA OK: 故障注入在协作期间被叙事记录');
  process.exit(0);
}

main().catch(error => {
  console.error('QA run failed:', error);
  process.exit(1);
});
