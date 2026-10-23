/**
 * deploymentSteps — DeploymentPanel 向导 stepper 的纯函数逻辑（W5）。
 *
 * 四步：① 连接 HA ② 绑定设备 ③ 安全闸 ④ 指令测试。
 * 完成态全部从各 Section 已有的数据推导（不在面板里新增请求）：
 *
 * - connect：HassStatus.configured 且 state === 'ready'；
 * - bind：已绑定 hass:// 的设备数 > 0；
 * - safety：无待审批指令且急停状态已知（SafetySection 的两个状态源）；
 * - test：不设完成态——指令测试是反复使用的工具，不是一道闸。
 */

import type { HassStatus } from '../api/types';

export type DeploymentStepId = 'connect' | 'bind' | 'safety' | 'test';

export interface DeploymentStep {
  id: DeploymentStepId;
  /** 标题的 i18n key（deployment 命名空间下）。 */
  titleKey: string;
}

export const DEPLOYMENT_STEPS: readonly DeploymentStep[] = [
  { id: 'connect', titleKey: 'steps.connect' },
  { id: 'bind', titleKey: 'steps.bind' },
  { id: 'safety', titleKey: 'steps.safety' },
  { id: 'test', titleKey: 'steps.test' },
];

export interface DeploymentStepInput {
  hassStatus: Pick<HassStatus, 'configured' | 'state'> | null;
  /** hass:// 绑定设备数（hassBoundDevices(world.devices).length）。 */
  boundCount: number;
  /** 待审批指令数；null = 尚未加载/加载失败（视为未完成）。 */
  pendingCount: number | null;
  /** 急停状态是否已成功获取（活跃与否都算已知）。 */
  estopKnown: boolean;
}

export function isStepComplete(step: DeploymentStepId, input: DeploymentStepInput): boolean {
  switch (step) {
    case 'connect':
      return input.hassStatus?.configured === true && input.hassStatus.state === 'ready';
    case 'bind':
      return input.boundCount > 0;
    case 'safety':
      return input.pendingCount === 0 && input.estopKnown;
    case 'test':
      return false;
  }
}

/** 建议当前步：前三个闸里第一个未完成的；全部就绪后落到指令测试。 */
export function suggestStep(input: DeploymentStepInput): DeploymentStepId {
  for (const step of DEPLOYMENT_STEPS) {
    if (!isStepComplete(step.id, input)) return step.id;
  }
  return 'test';
}
