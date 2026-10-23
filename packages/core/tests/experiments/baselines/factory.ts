import { CentralPlanner } from './central-planner.js';
import { RandomPlanner } from './random-planner.js';

type Planner = CentralPlanner | RandomPlanner;

/** 论文实验基线规划器工厂（condition → 具体规划器）。 */
export function createBaselinePlanner(
  agents: ConstructorParameters<typeof CentralPlanner>[0],
  devices: ConstructorParameters<typeof CentralPlanner>[1],
  scenario: ConstructorParameters<typeof CentralPlanner>[2],
  condition: string,
): Planner {
  if (condition === 'central-planner') {
    return new CentralPlanner(agents, devices, scenario);
  }
  return new RandomPlanner(agents, devices, scenario);
}
