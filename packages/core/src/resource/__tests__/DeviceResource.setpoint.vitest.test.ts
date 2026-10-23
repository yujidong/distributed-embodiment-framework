/**
 * DeviceResource HVAC multi-command setpoint tests (Fix-8)
 *
 * A semantic 'cooling'/'heating' actuation on an HVAC device expands to
 * set-mode → turn-on → set-temperature. When the caller provides no target
 * temperature the expansion must still set one (comfort default 24°C) —
 * running cooling without a setpoint is formally correct but physically
 * inert (the physics layer only cools/heats toward a target).
 */

import { describe, it, expect } from 'vitest';
import { DeviceResource } from '../DeviceResource.js';
import type { Device } from '@active-collaboration/shared';

interface ExecutedCommand {
  command: string;
  params?: Record<string, unknown>;
}

function makeHvacDevice(executed: ExecutedCommand[]): Device {
  return {
    id: 'hvac-1',
    name: 'Test HVAC',
    type: 'hvac',
    capabilities: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'],
    location: 'zone-a',
    status: 'online',
    executeCommand: async (commandName: string, params?: Record<string, unknown>) => {
      executed.push({ command: commandName, params });
      return { success: true, timestamp: new Date() };
    },
  } as unknown as Device;
}

describe('DeviceResource HVAC setpoint default (Fix-8)', () => {
  it('cooling without an explicit target still sets the comfort setpoint (24°C)', async () => {
    const executed: ExecutedCommand[] = [];
    const resource = new DeviceResource(makeHvacDevice(executed), 'test-owner');

    await resource.execute('cooling');

    expect(executed.map(c => c.command)).toEqual(['set-mode', 'turn-on', 'set-temperature']);
    expect(executed[2].params).toEqual({ temperature: 24 });
  });

  it('cooling with an explicit target keeps the caller value', async () => {
    const executed: ExecutedCommand[] = [];
    const resource = new DeviceResource(makeHvacDevice(executed), 'test-owner');

    await resource.execute('cooling', { target: 22 });

    const setTemp = executed.find(c => c.command === 'set-temperature');
    expect(setTemp?.params).toEqual({ temperature: 22 });
  });

  it('heating without an explicit target also gets the comfort setpoint', async () => {
    const executed: ExecutedCommand[] = [];
    const resource = new DeviceResource(makeHvacDevice(executed), 'test-owner');

    await resource.execute('heating');

    const setTemp = executed.find(c => c.command === 'set-temperature');
    expect(setTemp?.params).toEqual({ temperature: 24 });
  });
});
