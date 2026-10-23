/**
 * R79-logi (A3): the wizard's 绑定设备 list was never truncated, but rows
 * showed only the device NAME — in a 100+ device template world the one
 * device covering the capability declared at step 0 was unfindable (the R79
 * probe gave up after scanning the first 5–10 rows: "N 台内未找到", then the
 * step-1 backing gate blocked 下一步). Devices providing a declared
 * capability now sort first and carry a match chip, and the expanded details
 * list the device's capabilities.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, PublicUser, WorldDevice } from '../api/types';
import { AgentWizard } from '../components/world/AgentWizard';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

// The wizard loads the capability catalog on mount — stub it empty.
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, listCatalog: vi.fn(async () => []) };
});

const USER: PublicUser = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

function makeDevice(id: string, name: string, capabilities: string[]): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name,
    type: 'meter',
    brand: null,
    capabilities,
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as WorldDevice;
}

/**
 * A dozen own devices; the ONLY one covering `cooling-control` sits LAST in
 * server order — the R79-logi findability trap.
 */
function makeWorld(): EnvironmentDetail {
  const fillers = Array.from({ length: 11 }, (_, index) =>
    makeDevice(`dev-${index}`, `噪音设备 ${index}`, ['energy-monitoring']),
  );
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    visibility: 'public',
    myRole: 'builder',
    owner: { id: 'owner-1', displayName: 'Owner' },
    zones: [{ id: 'zone-1', name: '一区' }],
    devices: [...fillers, makeDevice('dev-cover', '冷却空调', ['cooling-control'])],
    agents: [],
    services: [],
    events: [],
    members: [],
  } as unknown as EnvironmentDetail;
}

/** Walk the wizard from step 0 to the 绑定设备 step with one capability. */
function advanceToBindStep() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Building energy butler'), {
    target: { value: '温控管家' },
  });
  const capabilityInput = screen.getByPlaceholderText('Custom capability, press Enter to add');
  fireEvent.change(capabilityInput, { target: { value: 'cooling-control' } });
  fireEvent.keyDown(capabilityInput, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

describe('AgentWizard bind-step findability (R79-logi)', () => {
  beforeEach(() => {
    void i18n.changeLanguage('en-US');
    useAppStore.setState({ user: USER });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ user: null });
  });

  it('sorts the capability-providing device first and marks it', () => {
    const { container } = renderWithProviders(
      <AgentWizard world={makeWorld()} agent={null} onClose={() => {}} />,
    );
    advanceToBindStep();

    const rows = container.querySelectorAll('.check-list__item');
    expect(rows.length).toBe(12);
    // The covering device (LAST in server order) now leads the list…
    expect(rows[0].textContent).toContain('冷却空调');
    expect(rows[0].textContent).toContain('Provides a declared capability');
    // …and the non-matching rows keep their original relative order.
    expect(rows[1].textContent).toContain('噪音设备 0');
    expect(rows[11].textContent).toContain('噪音设备 10');
    expect(container.querySelectorAll('.check-list__match').length).toBe(1);
  });

  it('lists the device capabilities in the expanded row details', () => {
    const { container } = renderWithProviders(
      <AgentWizard world={makeWorld()} agent={null} onClose={() => {}} />,
    );
    advanceToBindStep();

    const firstRow = container.querySelector('.check-list__item');
    expect(firstRow).not.toBeNull();
    fireEvent.click(firstRow!.querySelector('.check-list__toggle')!);
    expect(firstRow!.textContent).toContain('Capabilities: cooling-control');
  });
});
