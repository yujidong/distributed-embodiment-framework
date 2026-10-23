/**
 * FlowsPage render tests (mocked fetch, MemoryRouter): the flow list renders
 * with trigger badges and empty-state guidance; 新建 opens the canvas editor
 * and 创建 POSTs the serialized flow; a 422 FLOW_INVALID response surfaces
 * its issues in the editor's report.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n/config';
import { FlowsPage } from '../pages/FlowsPage';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const ENV_DETAIL = {
  id: 'env-1',
  name: '苏州公寓',
  description: '两室一厅智能公寓',
  mapType: 'grid',
  mapCenter: null,
  mapZoom: null,
  visibility: 'private',
  owner: { id: 'user-a', displayName: '小A' },
  myRole: 'owner',
  viewerNotice: null,
  members: [{ userId: 'user-a', role: 'owner', displayName: '小A' }],
  zones: [{ id: 'zone-a', name: '客厅' }],
  devices: [],
  agents: [
    {
      id: 'agent-1',
      envId: 'env-1',
      name: '能效管家',
      capabilities: ['cooling'],
      boundDeviceIds: [],
      managedZoneIds: ['zone-a'],
      llm: null,
      enabled: true,
      owner: { id: 'user-a', displayName: '小A' },
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  services: [],
  events: [],
  guide: null,
  mySubscriptions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const FLOW = {
  id: 'flow-1',
  envId: 'env-1',
  name: '高温自动降温',
  description: '',
  enabled: true,
  trigger: { kind: 'event', eventType: 'fire', zoneId: 'zone-a' },
  plan: {
    goal: '降温',
    nodes: [
      { id: 'cool', capability: 'cooling' },
      { id: 'notify', capability: 'messaging', dependsOn: ['cool'] },
    ],
  },
  createdBy: 'user-a',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Default fetch mock; `onPost` overrides the create-flow response. */
function mockFetch(
  onPost?: (body: Record<string, unknown>) => Response,
  envDetail: Record<string, unknown> = ENV_DETAIL,
  flowList: Record<string, unknown>[] = [FLOW],
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/environments/env-1' && method === 'GET') return jsonResponse(envDetail);
    if (url === '/api/environments/env-1/flows' && method === 'GET') {
      return jsonResponse({ flows: flowList });
    }
    if (url === '/api/environments/env-1/flows' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return onPost !== undefined
        ? onPost(body)
        : jsonResponse({ ...FLOW, id: 'flow-new', ...(body as object) }, 201);
    }
    if (url === '/api/flows/flow-1' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ ...FLOW, ...(body as object) });
    }
    if (url.startsWith('/api/flows/') && url.includes('/runs')) {
      return jsonResponse({ runs: [] });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
  });
}

function renderPage() {
  // useParams needs a matching Route — mount the page under its real path.
  return renderWithProviders(
    <Routes>
      <Route path="/environments/:envId/flows" element={<FlowsPage />} />
    </Routes>,
    { initialEntries: ['/environments/env-1/flows'] },
  );
}

describe('FlowsPage', () => {
  beforeEach(() => {
    // This test asserts Chinese copy (the original hard-coded wording); pin
    // i18next to zh-CN so the t() calls render Chinese regardless of the
    // language other tests in the suite may have left on the shared instance.
    void i18n.changeLanguage('zh-CN');
    useAppStore.setState({ user: { id: 'user-a', email: 'a@x.com', displayName: '小A', createdAt: '' }, toasts: [] });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the flow list with trigger badge and enabled toggle', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderPage();

    expect(await screen.findByText('高温自动降温')).toBeTruthy();
    expect(screen.getByText('事件触发')).toBeTruthy();
    expect(screen.getByText('2 个动作')).toBeTruthy();
    const toggle = screen.getByRole('checkbox');
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it('creates a new flow from the canvas editor', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '定时巡检' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '巡检所有区域' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });

    fireEvent.click(await screen.findByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post![1]?.body));
      expect(body.name).toBe('定时巡检');
      expect(body.plan.goal).toBe('巡检所有区域');
      expect(body.plan.nodes).toEqual([{ id: 'n1', capability: 'cooling' }]);
      expect(body.trigger).toEqual({ kind: 'event' });
    });
    // 创建成功后选中新流（isNew → false），工具栏出现「运行历史」入口。
    expect(await screen.findByText('运行历史')).toBeTruthy();
  });

  it('blocks save on client-side validation errors', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    // 名称/能力留空 → 客户端校验直接拦截，不发 POST。
    fireEvent.click(await screen.findByText('创建'));

    const issues = await screen.findByTestId('flow-issues');
    expect(issues.textContent).toContain('请填写名称。');
    expect(issues.textContent).toContain('请填写目标（goal）。');
    expect(issues.textContent).toContain('请填写能力。');
    expect(
      fetchMock.mock.calls.some(call => call[1]?.method === 'POST'),
    ).toBe(false);
  });

  it('shows the 422 FLOW_INVALID issues on save failure', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        jsonResponse(
          {
            error: {
              code: 'FLOW_INVALID',
              message: 'failed validation',
              issues: [{ level: 'error', nodeId: 'n1', message: 'UNSAT: 没有 agent 具备该能力' }],
            },
          },
          422,
        ),
      ),
    );
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '坏流' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'nonexistent' } });

    fireEvent.click(await screen.findByText('创建'));

    const issues = await screen.findByTestId('flow-issues');
    await waitFor(() => {
      expect(issues.textContent).toContain('UNSAT: 没有 agent 具备该能力');
      expect(issues.textContent).toContain('节点 n1');
    });
  });

  /** R14 P1-1: zone-a gets an agent-bound actuator so the wizard offers it. */
  const ENV_WITH_ACTUATOR = {
    ...ENV_DETAIL,
    devices: [
      {
        id: 'dev-1',
        envId: 'env-1',
        name: '客厅空调',
        type: 'hvac',
        brand: null,
        capabilities: ['cooling'],
        commands: ['set-temperature'],
        zoneId: 'zone-a',
        position: null,
        initialState: null,
        binding: 'sim://dev-1',
        owner: { id: 'user-a', displayName: '小A' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    agents: [{ ...ENV_DETAIL.agents[0], boundDeviceIds: ['dev-1'] }],
  };

  it('builds a flow end-to-end through the guided wizard', async () => {
    const fetchMock = mockFetch(undefined, ENV_WITH_ACTUATOR);
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('引导式造 Flow'))[0]);

    // ① 触发：区域/参数取默认值（客厅 + temperature 回退词表），只填阈值。
    expect(await screen.findByText('① 什么时候触发')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('阈值'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('下一步'));

    // ② 动作：区域内可执行能力只有 cooling（客厅空调）。
    expect(await screen.findByText('② 执行什么动作')).toBeTruthy();
    expect(screen.getByText(/cooling/)).toBeTruthy();
    fireEvent.click(screen.getByText('下一步'));

    // ③ 预览：名称自动生成，直接创建。
    expect(await screen.findByText('③ 确认并创建')).toBeTruthy();
    expect((screen.getByLabelText('Flow 名称') as HTMLInputElement).value).toContain('cooling');
    fireEvent.click(screen.getByText('创建 Flow'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post![1]?.body));
      expect(body.enabled).toBe(true);
      expect(body.trigger).toEqual({
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
      });
      expect(body.plan.nodes).toEqual([{ id: 'n1', capability: 'cooling' }]);
      expect(body.plan.goal).toContain('cooling');
    });
    // 创建成功后在画布编辑器中打开该 Flow。
    expect(await screen.findByText('运行历史')).toBeTruthy();
  });

  /** T-051(b): two tenants' agents with distinct bound devices for pinning. */
  const ENV_WITH_PINS = {
    ...ENV_DETAIL,
    devices: [
      {
        id: 'dev-ac',
        envId: 'env-1',
        name: '客厅空调',
        type: 'hvac',
        brand: null,
        capabilities: ['cooling'],
        commands: ['set-temperature'],
        zoneId: 'zone-a',
        position: null,
        initialState: null,
        binding: 'sim://dev-ac',
        owner: { id: 'user-a', displayName: '小A' },
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'dev-fan',
        envId: 'env-1',
        name: '客厅风扇',
        type: 'fan',
        brand: null,
        capabilities: ['ventilation'],
        commands: ['turn-on'],
        zoneId: 'zone-a',
        position: null,
        initialState: null,
        binding: 'sim://dev-fan',
        owner: { id: 'user-a', displayName: '小A' },
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'dev-lock',
        envId: 'env-1',
        name: '门锁',
        type: 'lock',
        brand: null,
        capabilities: ['access-control'],
        commands: ['unlock'],
        zoneId: 'zone-a',
        position: null,
        initialState: null,
        binding: 'sim://dev-lock',
        owner: { id: 'user-a', displayName: '小A' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    agents: [
      { ...ENV_DETAIL.agents[0], name: '能效管家', boundDeviceIds: ['dev-ac', 'dev-fan'] },
      { ...ENV_DETAIL.agents[0], id: 'agent-2', name: '安防管家', boundDeviceIds: ['dev-lock'] },
    ],
  };

  it('T-051: the canvas editor authors deviceId pins (assignee-scoped dropdown)', async () => {
    const fetchMock = mockFetch(undefined, ENV_WITH_PINS);
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);

    // Auto-assigned node: the pin dropdown offers every AGENT-BOUND device.
    const pinSelect = (await screen.findByLabelText('设备钉定')) as HTMLSelectElement;
    expect(Array.from(pinSelect.options).map(option => option.value)).toEqual([
      '',
      'dev-ac',
      'dev-fan',
      'dev-lock',
    ]);

    // Pinning an explicit assignee narrows the options to THEIR bound
    // devices — dev-lock belongs to the other agent and must not be offered.
    fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'agent-1' } });
    await waitFor(() => {
      expect(Array.from(pinSelect.options).map(option => option.value)).toEqual([
        '',
        'dev-ac',
        'dev-fan',
      ]);
    });

    fireEvent.change(pinSelect, { target: { value: 'dev-ac' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '钉定降温' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.click(await screen.findByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post![1]?.body));
      expect(body.plan.nodes).toEqual([
        { id: 'n1', capability: 'cooling', assigneeAgentId: 'agent-1', deviceId: 'dev-ac' },
      ]);
    });
  });

  it('T-051: switching the assignee drops a pin the new assignee is not bound to', async () => {
    const fetchMock = mockFetch(undefined, ENV_WITH_PINS);
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    const pinSelect = (await screen.findByLabelText('设备钉定')) as HTMLSelectElement;

    fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'agent-1' } });
    await waitFor(() => {
      expect(Array.from(pinSelect.options).map(option => option.value)).toEqual(['', 'dev-ac', 'dev-fan']);
    });
    fireEvent.change(pinSelect, { target: { value: 'dev-ac' } });
    expect(pinSelect.value).toBe('dev-ac');

    // agent-2 is not bound to dev-ac — the pin resets to auto instead of
    // authoring a flow the server would 422.
    fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'agent-2' } });
    await waitFor(() => expect(pinSelect.value).toBe(''));
    expect(Array.from(pinSelect.options).map(option => option.value)).toEqual(['', 'dev-lock']);
  });

  it('blocks the wizard at the action step when the zone has no actuator', async () => {
    // 默认 ENV_DETAIL：区域里没有设备 —— 向导提示缺执行器而不是静默建空转 Flow。
    vi.stubGlobal('fetch', mockFetch());
    renderPage();

    fireEvent.click((await screen.findAllByText('引导式造 Flow'))[0]);
    fireEvent.change(await screen.findByLabelText('阈值'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('下一步'));

    expect(await screen.findByText(/没有已绑定 Agent 的执行器设备/)).toBeTruthy();
    expect(screen.getByText('去「设备」页添加')).toBeTruthy();
    expect((screen.getByText('下一步') as HTMLButtonElement).disabled).toBe(true);
  });

  /** UX-09: `count` flows with zero-padded names （巡检流-01 … 巡检流-NN). */
  function makeFlows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      ...FLOW,
      id: `flow-${i + 1}`,
      name: `巡检流-${String(i + 1).padStart(2, '0')}`,
    }));
  }

  it('UX-09: 23 flows filter by name search', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, ENV_DETAIL, makeFlows(23)));
    renderPage();

    expect(await screen.findByText('巡检流-23')).toBeTruthy();
    // 23 < quota-1 — no quota hint yet.
    expect(screen.queryByTestId('flow-quota-hint')).toBeNull();

    fireEvent.change(screen.getByLabelText('搜索业务流'), { target: { value: '巡检流-07' } });
    await waitFor(() => {
      expect(screen.getByText('巡检流-07')).toBeTruthy();
      expect(screen.queryByText('巡检流-08')).toBeNull();
      expect(screen.queryByText('巡检流-17')).toBeNull();
    });
  });

  it('UX-09: the assignee filter keeps only flows pinned to that agent', async () => {
    const flows = [
      {
        ...FLOW,
        id: 'flow-a',
        name: '降温流',
        plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'cooling', assigneeAgentId: 'agent-1' }] },
      },
      { ...FLOW, id: 'flow-b', name: '巡检流' },
    ];
    vi.stubGlobal('fetch', mockFetch(undefined, ENV_DETAIL, flows));
    renderPage();

    expect(await screen.findByText('降温流')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('按执行 Agent 筛选'), { target: { value: 'agent-1' } });
    await waitFor(() => {
      expect(screen.getByText('降温流')).toBeTruthy();
      expect(screen.queryByText('巡检流')).toBeNull();
    });
  });

  it('UX-09: the quota hint appears at quota-1 (49 flows) with the count/limit', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, ENV_DETAIL, makeFlows(49)));
    renderPage();

    const hint = await screen.findByTestId('flow-quota-hint');
    expect(hint.textContent).toContain('49/50');
  });

  // ---------------------------------------------------------------------
  // R2 批次 2（flow 编辑器）
  // ---------------------------------------------------------------------

  const dirtyChipHidden = () =>
    document.querySelector('.badge--dirty')?.classList.contains('badge--dirty--hidden');

  it('R2-BUG-03: params JSON commits on change (dirty chip visible before the save gesture)', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click(await screen.findByText('高温自动降温'));

    // 参数 JSON 原为唯一「失焦才提交」字段——现在 onChange 即提交，dirty
    // chip 在用户伸手点保存之前已挂载（旧机制下首次插入发生在保存手势的
    // mousedown blur 期间，click 被吞；jsdom 抓不到 DOM 插入吞 click，
    // 这里钉的是提交时机 + chip 常驻，真手势回归见 Playwright 探针）。
    expect(dirtyChipHidden()).toBe(true);
    const params = (await screen.findAllByLabelText('参数 JSON'))[0];
    fireEvent.change(params, { target: { value: '{"target": 24}' } });
    await waitFor(() => expect(dirtyChipHidden()).toBe(false));

    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/flows/flow-1' && call[1]?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String(patch![1]?.body));
      expect(body.plan.nodes[0].params).toEqual({ target: 24 });
    });
  });

  it('R2-BUG-03: invalid params JSON flags red and never commits', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderPage();

    fireEvent.click(await screen.findByText('高温自动降温'));
    const params = (await screen.findAllByLabelText('参数 JSON'))[0];
    fireEvent.change(params, { target: { value: '{"target":' } });

    expect(await screen.findByText('参数必须是合法 JSON 对象')).toBeTruthy();
    expect(dirtyChipHidden()).toBe(true);
  });

  it('R2-FEAT-06: authors a notify node on the canvas and saves it', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.click(screen.getByText('+ 通知节点'));

    // 默认收件方为环境 owner（不带 target）；填写消息。
    fireEvent.change(screen.getByLabelText('通知消息'), { target: { value: '喷淋已启动' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '告警通知' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post![1]?.body));
      expect(body.plan.nodes).toEqual([
        { id: 'n1', capability: 'cooling' },
        { id: 'n2', notify: { to: 'owner', message: '喷淋已启动' } },
      ]);
    });
  });

  it('R2-FEAT-06: authors an agent-targeted notify node (to/target form)', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.click(screen.getByText('+ 通知节点'));

    // 收件方切到「指定 Agent」→ target 默认落到第一个 agent。
    fireEvent.change(screen.getByLabelText('通知收件方类型'), { target: { value: 'agent' } });
    fireEvent.change(screen.getByLabelText('通知消息'), { target: { value: '请处理' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      const body = JSON.parse(String(post![1]?.body));
      expect(body.plan.nodes[1]).toEqual({
        id: 'n2',
        notify: { to: 'agent', target: 'agent-1', message: '请处理' },
      });
    });
  });

  it('R2-FEAT-06: blocks save when a notify node has no message', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.click(screen.getByText('+ 通知节点'));
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.click(screen.getByText('创建'));

    const issues = await screen.findByTestId('flow-issues');
    expect(issues.textContent).toContain('通知节点请填写消息。');
    expect(fetchMock.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false);
  });

  it('R2-FEAT-06: authors a wait node on the canvas and saves it', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.click(screen.getByText('+ 等待节点'));

    // 默认 60 仿真秒；改为 120。
    fireEvent.change(screen.getByLabelText('延迟（仿真秒）'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      const body = JSON.parse(String(post![1]?.body));
      expect(body.plan.nodes).toEqual([
        { id: 'n1', capability: 'cooling' },
        { id: 'n2', wait: { simSec: 120 } },
      ]);
    });
  });

  it('R2-UX-14: schedule trigger time-of-day edits as an HH:MM clock', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);
    fireEvent.change(screen.getByLabelText('触发方式'), { target: { value: 'schedule' } });

    const timeInput = (await screen.findByLabelText('日内时刻（HH:MM）')) as HTMLInputElement;
    fireEvent.change(timeInput, { target: { value: '23:30' } });

    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'cooling' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: 'g' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        call => String(call[0]) === '/api/environments/env-1/flows' && call[1]?.method === 'POST',
      );
      const body = JSON.parse(String(post![1]?.body));
      expect(body.trigger).toEqual({ kind: 'schedule', atTimeOfDaySec: 84600 });
    });
  });

  it('R2-UX-15: pinning a device narrows the capability datalist to that device', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, ENV_WITH_PINS));
    renderPage();

    fireEvent.click((await screen.findAllByText('新建业务流'))[0]);

    // 未钉定：候选 = 全环境能力并集（agents ∪ devices）。
    const optionsOf = () =>
      Array.from(document.querySelectorAll('#flow-capability-options-n1 option')).map(
        option => (option as HTMLOptionElement).value,
      );
    await waitFor(() => {
      expect(optionsOf()).toEqual(['access-control', 'cooling', 'ventilation']);
    });

    // 钉定 dev-ac（hvac，只有 cooling）后候选收窄。
    fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'agent-1' } });
    fireEvent.change(await screen.findByLabelText('设备钉定'), { target: { value: 'dev-ac' } });
    await waitFor(() => {
      expect(optionsOf()).toEqual(['cooling']);
    });
  });
});

describe('FlowRunsDrawer sim attribution (T-714, R29 F8)', () => {
  // Flows are environment-level: every sim of the env fires them. Each run
  // row must name WHICH simulation executed it (run.simulationId).
  const useFlowRunsMock = vi.hoisted(() => vi.fn());

  vi.mock('../hooks/useFlows', async importOriginal => {
    const actual = await importOriginal<typeof import('../hooks/useFlows')>();
    return { ...actual, useFlowRuns: useFlowRunsMock };
  });

  function makeRun(simulationId: string | null) {
    return {
      id: 'run-1',
      flowId: 'flow-1',
      simulationId,
      triggerKind: 'event' as const,
      status: 'success' as const,
      summary: 'ok',
      nodeResults: {},
      startedAt: '2026-08-25T23:59:20.438Z',
      finishedAt: '2026-08-25T23:59:21.000Z',
      durationMs: 562,
    };
  }

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('each run row names the sim that executed it', async () => {
    useFlowRunsMock.mockReturnValue({
      data: [makeRun('sim-env-1-physics-mt9bhn2v-7')],
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    void i18n.changeLanguage('zh-CN');
    const { FlowRunsDrawer } = await import('../components/flow/FlowRunsDrawer');
    renderWithProviders(<FlowRunsDrawer flowId="flow-1" onClose={() => {}} />);

    const row = await screen.findByText(/仿真 sim-env-1-physics-mt9bhn2v-7/);
    expect(row.getAttribute('title')).toContain('环境级');
  });

  it('runs without a sim id (legacy rows) render without the chip', async () => {
    useFlowRunsMock.mockReturnValue({
      data: [makeRun(null)],
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    const { FlowRunsDrawer } = await import('../components/flow/FlowRunsDrawer');
    renderWithProviders(<FlowRunsDrawer flowId="flow-1" onClose={() => {}} />);

    expect(await screen.findByText(/事件触发/)).toBeTruthy();
    expect(screen.queryByText(/仿真 /)).toBeNull();
  });
});
