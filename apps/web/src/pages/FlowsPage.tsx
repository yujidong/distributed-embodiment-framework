/**
 * FlowsPage — the 业务流 (Flow) canvas editor (/environments/:envId/flows).
 *
 * Left: the env's flow list (trigger-kind badge, enabled toggle, latest-run
 * status dot, create/delete). Right: the reactflow canvas editor — one
 * trigger node card + one action node card per plan node, edges = dependsOn
 * (see lib/flowGraph.ts for the Flow ↔ graph serialization).
 *
 * Save runs the client-side graph validation first (cycles/isolated nodes
 * for immediate feedback), then POSTs/PATCHes; the server's 422 FLOW_INVALID
 * issues merge into the same report and highlight their nodes. Read-only for
 * viewers (the world view links here for everyone who can read the env).
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, SearchX, Wand2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from 'reactflow';
import { useTranslation } from 'react-i18next';

import { ApiClientError } from '../api/client';
import { listSimulations } from '../api/client';
import { activeSimulationsOf } from '../lib/activeSimulations';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateFlowInput, Flow, FlowIssue, FlowPlanAnyNode, FlowTrigger } from '../api/types';
import { FlowCanvas } from '../components/flow/FlowCanvas';
import { FlowEditorContext, type FlowEditorCtx } from '../components/flow/FlowNodeCards';
import { FlowRunsDrawer } from '../components/flow/FlowRunsDrawer';
import { FlowWizard } from '../components/flow/FlowWizard';
import { Icon } from '../components/ui/Icon';
import { EmptyState } from '../components/ui/EmptyState';
import {
  useCreateFlow,
  useDeleteFlow,
  useEnvironmentDetail,
  useFlowList,
  useLatestFlowRun,
  usePatchFlow,
} from '../hooks/useFlows';
import { useCampusSimSnapshot } from '../hooks/useCampusSimSnapshot';
import {
  TRIGGER_NODE_ID,
  flowToGraph,
  graphToFlow,
  type FlowGraphIssue,
} from '../lib/flowGraph';
import { devicePowerFaceOf, offDeviceWarnings } from '../lib/flowWarnings';
import { queryKeys } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';
import { useConfirm } from '../components/ui/ConfirmDialog';

const RUN_STATUS_KEYS = ['success', 'partial', 'failed', 'waiting'] as const;

// UX-09: the per-environment flow cap, mirrored from the server's
// MAX_FLOWS_PER_ENV (apps/server/src/db/flow-store.ts) — the list response
// carries no quota field, so the client keeps the same constant in one place.
const FLOW_QUOTA_PER_ENV = 50;

/** Assignee ids declared on a flow's plan nodes (UX-09 list filtering). */
function flowAssigneeIds(flow: Flow): string[] {
  return flow.plan.nodes
    .map(node => ('assigneeAgentId' in node ? node.assigneeAgentId : undefined))
    .filter((id): id is string => id !== undefined);
}

/**
 * T2 脏状态跟踪：编辑器可保存状态的序列化签名（节点位置取整，避免拖拽
 * 浮点抖动误报）。与「打开/新建/保存成功」时记下的基线比对得出 dirty。
 */
function editorSignature(fields: {
  name: string;
  description: string;
  goal: string;
  nodes: Node[];
  edges: Edge[];
}): string {
  return JSON.stringify({
    name: fields.name,
    description: fields.description,
    goal: fields.goal,
    nodes: fields.nodes.map(node => ({
      id: node.id,
      type: node.type,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      data: node.data,
    })),
    edges: fields.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
  });
}

/** 新建：默认事件触发器 + 一个空动作节点。 */
function blankGraph(seq: () => string): { nodes: Node[]; edges: Edge[] } {
  const { nodes, edges } = flowToGraph({
    trigger: { kind: 'event' },
    plan: { goal: '', nodes: [{ id: seq(), capability: '' }] },
  });
  return { nodes, edges };
}

export function FlowsPage() {
  const { envId } = useParams<{ envId: string }>();
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { t } = useTranslation('flows');

  const envQuery = useEnvironmentDetail(envId);
  const flowsQuery = useFlowList(envId);
  const createFlow = useCreateFlow(envId);
  const patchFlow = usePatchFlow(envId);
  const deleteFlow = useDeleteFlow(envId);

  const env = envQuery.data;
  // R41-C1: the manual-trigger target — the env's attachable simulation.
  const simsQuery = useQuery({ queryKey: ['simulations'], queryFn: listSimulations });
  const attachableSim = env !== undefined
    ? activeSimulationsOf(simsQuery.data ?? [], env.id)[0]
    : undefined;
  // UX-12: latest world-session snapshot — the live device power face behind
  // the save-time "target device is off" warning.
  const snapshot = useCampusSimSnapshot(envId);
  const flows = flowsQuery.data ?? [];
  const canBuild = env?.myRole === 'owner' || env?.myRole === 'builder';

  // Editor state — rebuilt wholesale when another flow is selected.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [issues, setIssues] = useState<FlowGraphIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  /** R14 P1-1: the guided builder (R2-UX-20「引导式造 Flow」, teaching main path). */
  const [wizardOpen, setWizardOpen] = useState(false);
  // UX-09: client-side list filters — name substring + declared assignee.
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');

  const assigneeOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const flow of flows) {
      for (const id of flowAssigneeIds(flow)) ids.add(id);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [flows]);

  const visibleFlows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return flows.filter(flow => {
      if (needle !== '' && !flow.name.toLowerCase().includes(needle)) return false;
      if (assigneeFilter !== '' && !flowAssigneeIds(flow).includes(assigneeFilter)) return false;
      return true;
    });
  }, [flows, search, assigneeFilter]);

  const assigneeName = (id: string) =>
    env?.agents.find(agent => agent.id === id)?.name ?? id;

  const seqRef = useRef(1);
  const nextNodeId = () => {
    let id = `n${seqRef.current++}`;
    const taken = new Set(nodes.map(node => node.id));
    while (taken.has(id)) id = `n${seqRef.current++}`;
    return id;
  };

  const editing = isNew || selectedId !== null;

  // T2 脏状态：基线签名在 selectFlow/startNew/保存成功时重置。
  const savedSignatureRef = useRef('');
  const currentSignature = editorSignature({ name, description, goal, nodes, edges });
  const dirty =
    editing && savedSignatureRef.current !== '' && currentSignature !== savedSignatureRef.current;
  /** 切换 flow/新建/打开向导/离开页面前的未保存确认（Promise 化）。 */
  const confirmDiscard = async () =>
    !dirty || (await confirm({ body: t('discardConfirm'), tone: 'warn' }));

  const selectFlow = (flow: Flow) => {
    const graph = flowToGraph(flow);
    setSelectedId(flow.id);
    setIsNew(false);
    setName(flow.name);
    setDescription(flow.description);
    setGoal(flow.plan.goal);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setIssues([]);
    setRunsOpen(false);
    setWizardOpen(false);
    savedSignatureRef.current = editorSignature({
      name: flow.name,
      description: flow.description,
      goal: flow.plan.goal,
      nodes: graph.nodes,
      edges: graph.edges,
    });
  };

  const selectFlowGuarded = (flow: Flow) => {
    if (!dirty) {
      selectFlow(flow);
      return;
    }
    void confirmDiscard().then(ok => {
      if (ok) selectFlow(flow);
    });
  };

  const startNew = () => {
    const graph = blankGraph(nextNodeId);
    setSelectedId(null);
    setIsNew(true);
    setName('');
    setDescription('');
    setGoal('');
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setIssues([]);
    setRunsOpen(false);
    setWizardOpen(false);
    savedSignatureRef.current = editorSignature({
      name: '',
      description: '',
      goal: '',
      nodes: graph.nodes,
      edges: graph.edges,
    });
  };

  const startNewGuarded = () => {
    if (!dirty) {
      startNew();
      return;
    }
    void confirmDiscard().then(ok => {
      if (ok) startNew();
    });
  };

  const openWizard = () => {
    setWizardOpen(true);
    setSelectedId(null);
    setIsNew(false);
  };

  const openWizardGuarded = () => {
    if (!dirty) {
      openWizard();
      return;
    }
    void confirmDiscard().then(ok => {
      if (ok) openWizard();
    });
  };

  /** Wizard create path: same mutation as the canvas save, then open it. */
  const wizardCreate = (input: CreateFlowInput) => createFlow.mutateAsync(input);
  const wizardCreated = (flow: Flow) => {
    pushToast(t('flowSavedToast', { name: flow.name }), 'success');
    selectFlow(flow);
    // UX-16: same non-blocking authoring warnings as the canvas save —
    // selectFlow cleared the issue list, so they are re-surfaced here.
    const warnings = (flow.validationWarnings ?? []).map(message => ({ level: 'warning' as const, message }));
    if (warnings.length > 0) setIssues(warnings);
  };

  const updateTrigger = (trigger: FlowTrigger) => {
    setNodes(current =>
      current.map(node =>
        node.id === TRIGGER_NODE_ID ? { ...node, data: { ...node.data, trigger } } : node,
      ),
    );
  };

  const updatePlanNode = (id: string, planNode: FlowPlanAnyNode) => {
    setNodes(current =>
      current.map(node => (node.id === id ? { ...node, data: { ...node.data, planNode } } : node)),
    );
  };

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const id = `${connection.source}->${connection.target}`;
    setEdges(current =>
      current.some(edge => edge.id === id) ? current : addEdge({ ...connection, id }, current),
    );
  };

  const addActionNode = () => {
    const id = nextNodeId();
    const maxX = Math.max(0, ...nodes.map(node => node.position.x));
    setNodes(current => [
      ...current,
      {
        id,
        type: 'action',
        position: { x: maxX + 460, y: 0 },
        data: { planNode: { id, capability: '' } },
      },
    ]);
  };

  /** R2-FEAT-06: 画布创作入口——通知节点（默认发给环境 owner）。 */
  const addNotifyNode = () => {
    const id = nextNodeId();
    const maxX = Math.max(0, ...nodes.map(node => node.position.x));
    setNodes(current => [
      ...current,
      {
        id,
        type: 'notify',
        position: { x: maxX + 460, y: 0 },
        data: { planNode: { id, notify: { to: 'owner', message: '' } } },
      },
    ]);
  };

  /** R2-FEAT-06: 画布创作入口——等待节点（默认 60 仿真秒）。 */
  const addWaitNode = () => {
    const id = nextNodeId();
    const maxX = Math.max(0, ...nodes.map(node => node.position.x));
    setNodes(current => [
      ...current,
      {
        id,
        type: 'wait',
        position: { x: maxX + 460, y: 0 },
        data: { planNode: { id, wait: { simSec: 60 } } },
      },
    ]);
  };

  const save = async () => {
    if (!envId || saving) return;
    const { trigger, planNodes, issues: graphIssues } = graphToFlow(nodes, edges);
    const clientIssues: FlowGraphIssue[] = [...graphIssues];
    if (name.trim().length === 0) clientIssues.push({ level: 'error', message: t('validationNameRequired') });
    if (goal.trim().length === 0) clientIssues.push({ level: 'error', message: t('validationGoalRequired') });
    if (planNodes.length === 0) {
      clientIssues.push({ level: 'error', message: t('validationActionRequired') });
    }
    for (const planNode of planNodes) {
      // Delegate nodes carry a `delegate` block instead of a capability.
      if ('capability' in planNode && planNode.capability.trim().length === 0) {
        clientIssues.push({ level: 'error', nodeId: planNode.id, message: t('validationCapabilityRequired') });
      }
      // R2-FEAT-06: notify/wait nodes are canvas-authored now — same
      // client-side precheck family as the capability check (the server
      // re-validates with 422 FLOW_INVALID regardless).
      if ('notify' in planNode) {
        if (planNode.notify.message.trim().length === 0) {
          clientIssues.push({ level: 'error', nodeId: planNode.id, message: t('validationNotifyMessageRequired') });
        }
        if (planNode.notify.to !== 'owner' && (planNode.notify.target ?? '').trim().length === 0) {
          clientIssues.push({ level: 'error', nodeId: planNode.id, message: t('validationNotifyTargetRequired') });
        }
      }
      if ('wait' in planNode && !(planNode.wait.simSec > 0)) {
        clientIssues.push({ level: 'error', nodeId: planNode.id, message: t('validationWaitSimSecRequired') });
      }
    }
    // UX-12: advisory (non-blocking) — an action node actuating a device that
    // is currently OFF with no turn-on in the flow's command surface
    // (set-brightness on a dark lamp has no visible effect).
    const faceById = new Map(
      (snapshot?.devices ?? []).map(device => [device.id, devicePowerFaceOf(device)]),
    );
    for (const warning of offDeviceWarnings(planNodes, id => faceById.get(id) ?? 'unknown')) {
      const deviceName =
        env?.devices.find(device => device.id === warning.deviceId)?.name ?? warning.deviceId;
      clientIssues.push({
        level: 'warning',
        nodeId: warning.nodeId,
        message: t('validationDeviceOff', { device: deviceName, capability: warning.capability }),
      });
    }
    setIssues(clientIssues);
    if (clientIssues.some(issue => issue.level === 'error') || trigger === null) return;

    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description,
        trigger,
        plan: { goal: goal.trim(), nodes: planNodes },
      };
      const saved = isNew
        ? await createFlow.mutateAsync({ ...body, enabled: true })
        : await patchFlow.mutateAsync({ id: selectedId!, patch: body });
      pushToast(t('flowSavedToast', { name: saved.name }), 'success');
      selectFlow(saved);
      // selectFlow clears the issue list; re-surface the non-blocking
      // warnings so they stay visible after a successful save.
      // UX-16: the server's non-blocking authoring warnings (条件路径 lint、
      // 「同设备多流/合约写」contention 等）ride the save response — they
      // join the client-side warnings instead of being dropped silently.
      const warnings = [
        ...clientIssues.filter(issue => issue.level === 'warning'),
        ...(saved.validationWarnings ?? []).map(message => ({ level: 'warning' as const, message })),
      ];
      if (warnings.length > 0) setIssues(warnings);
    } catch (error) {
      // F3: 以「本次客户端 issues + 本次 server issues」整体替换，避免连续
      // 失败时 server issues 在旧列表上 append 堆叠重复。
      if (error instanceof ApiClientError) {
        const serverIssues = Array.isArray(error.issues) ? (error.issues as FlowIssue[]) : [];
        setIssues([
          ...clientIssues,
          ...(serverIssues.length > 0
            ? serverIssues
            : [{ level: 'error' as const, message: `${error.code}: ${error.message}` }]),
        ]);
      } else {
        setIssues([...clientIssues, { level: 'error', message: String(error) }]);
      }
    } finally {
      setSaving(false);
    }
  };

  const removeFlow = async (flow: Flow) => {
    if (!(await confirm({ body: t('deleteConfirm', { name: flow.name }), tone: 'danger' }))) return;
    try {
      await deleteFlow.mutateAsync(flow.id);
      if (selectedId === flow.id) {
        setSelectedId(null);
        setIsNew(false);
        setIssues([]);
        savedSignatureRef.current = '';
      }
      pushToast(t('flowDeletedToast', { name: flow.name }), 'success');
    } catch (error) {
      pushToast(t('deleteFailedToast', { error: error instanceof Error ? error.message : String(error) }), 'error');
    }
  };

  // T5: 启用开关失败曾有零反馈（checkbox 由缓存驱动，看起来「没反应」）——
  // toast 说明原因并 invalidate 回滚到服务端真值。
  const queryClient = useQueryClient();
  const toggleFlowEnabled = (flow: Flow, enabled: boolean) => {
    patchFlow.mutate(
      { id: flow.id, patch: { enabled } },
      {
        onError: error => {
          pushToast(
            t('toggleFailedToast', {
              name: flow.name,
              error: error instanceof Error ? error.message : String(error),
            }),
            'error',
          );
          void queryClient.invalidateQueries({ queryKey: queryKeys.flows.list(envId ?? '') });
        },
      },
    );
  };

  // Capability vocabulary: agents ∪ devices.
  const capabilities = useMemo(() => {
    const all = new Set<string>();
    for (const agent of env?.agents ?? []) {
      for (const capability of agent.capabilities) all.add(capability);
    }
    for (const device of env?.devices ?? []) {
      for (const capability of device.capabilities) all.add(capability);
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [env]);

  const errorNodeIds = useMemo(
    () => new Set(issues.filter(i => i.level === 'error' && i.nodeId).map(i => i.nodeId!)),
    [issues],
  );
  const warningNodeIds = useMemo(
    () => new Set(issues.filter(i => i.level === 'warning' && i.nodeId).map(i => i.nodeId!)),
    [issues],
  );

  const editorCtx: FlowEditorCtx = {
    zones: env?.zones ?? [],
    agents: env?.agents ?? [],
    devices: env?.devices ?? [],
    capabilities,
    nodeIds: nodes.filter(node => node.type === 'action').map(node => node.id),
    readOnly: !canBuild,
    errorNodeIds,
    warningNodeIds,
    updateTrigger,
    updatePlanNode,
  };

  if (envQuery.isLoading || flowsQuery.isLoading) {
    return <p className="page-note">{t('loadingFlows')}</p>;
  }
  if (envQuery.isError || !env) {
    return (
      <div className="page-note page-note--error">
        <p>{t('envLoadFailed')}</p>
        <Link to="/environments">{t('backToEnvironments')}</Link>
      </div>
    );
  }

  return (
    <div className="detail-page flows-page">
      <header className="detail-header">
        <Link
          className="link-button"
          to={`/environments/${env.id}`}
          onClick={event => {
            // 脏编辑器离开需确认：先拦导航，确认后程序化跳转。
            if (!dirty) return;
            event.preventDefault();
            void confirmDiscard().then(ok => {
              if (ok) navigate(`/environments/${env.id}`);
            });
          }}
        >
          <Icon icon={ArrowLeft} size={14} /> {t('backToWorld')}
        </Link>
        <div className="detail-header__meta">
          <h2>{env.name} · {t('titleSuffix')}</h2>
          <span className="detail-header__id">{env.id}</span>
          {!canBuild && <span className="badge badge--readonly">{t('readOnlyBadge')}</span>}
        </div>
        <p className="detail-header__description">
          {t('description')}
        </p>
      </header>
      <div className="flows-page__body">
        <aside className="flow-list">
          {canBuild && (
            <button
              className="primary-button world-sidebar__create"
              onClick={openWizardGuarded}
            >
              <Icon icon={Wand2} size={14} /> {t('wizard.entry')}
            </button>
          )}
          {canBuild && (
            <button className="world-sidebar__create" onClick={startNewGuarded}>
              <Icon icon={Plus} size={14} /> {t('newFlow')}
            </button>
          )}
          {flows.length === 0 && (
            <p className="page-note">
              {t('emptyHasFlows')}
              {canBuild ? t('emptyCanBuildHint') : t('emptyNoBuildHint')}
            </p>
          )}
          {flows.length > 0 && (
            <div className="flow-list__filters">
              <input
                className="flow-list__search"
                aria-label={t('searchAria')}
                placeholder={t('searchPlaceholder')}
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
              {assigneeOptions.length > 0 && (
                <select
                  aria-label={t('filterAssigneeAria')}
                  value={assigneeFilter}
                  onChange={event => setAssigneeFilter(event.target.value)}
                >
                  <option value="">{t('filterAssigneeAll')}</option>
                  {assigneeOptions.map(id => (
                    <option key={id} value={id}>{assigneeName(id)}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {flows.length >= FLOW_QUOTA_PER_ENV - 1 && (
            <p className="page-note" data-testid="flow-quota-hint">
              {t('quotaHint', { count: flows.length, quota: FLOW_QUOTA_PER_ENV })}
            </p>
          )}
          {flows.length > 0 && visibleFlows.length === 0 && (
            <EmptyState compact icon={SearchX} title={t('filterNoMatch')} />
          )}
          {visibleFlows.map(flow => (
            <FlowListItem
              key={flow.id}
              flow={flow}
              selected={!isNew && selectedId === flow.id}
              canBuild={canBuild}
              onSelect={() => selectFlowGuarded(flow)}
              onToggle={enabledValue => toggleFlowEnabled(flow, enabledValue)}
              onDelete={() => void removeFlow(flow)}
            />
          ))}
        </aside>

        <main className="flow-editor">
          {wizardOpen && canBuild ? (
            <FlowWizard
              env={env}
              onCreate={wizardCreate}
              onCreated={wizardCreated}
              onClose={() => setWizardOpen(false)}
            />
          ) : !editing ? (
            /* F5: 未选 flow 时给引导空态（CTA 直达向导/手工新建），而不是
               一行小字 + 大片空白。 */
            <div className="flow-editor__empty">
              <p className="flow-editor__empty-title">
                {t('placeholderSelect')}
                {canBuild ? t('placeholderCanBuildSuffix') : t('placeholderNoBuildSuffix')}
              </p>
              {canBuild && (
                <div className="flow-editor__empty-actions">
                  <button className="primary-button" onClick={openWizardGuarded}>
                    <Icon icon={Wand2} size={14} /> {t('wizard.entry')}
                  </button>
                  <button onClick={startNewGuarded}>
                    <Icon icon={Plus} size={14} /> {t('newFlow')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <FlowEditorContext.Provider value={editorCtx}>
              <div className="flow-editor__toolbar">
                <input
                  className="flow-editor__name"
                  aria-label={t('nameLabel')}
                  placeholder={t('namePlaceholder')}
                  value={name}
                  disabled={!canBuild}
                  onChange={event => setName(event.target.value)}
                />
                <input
                  className="flow-editor__description"
                  aria-label={t('descriptionAria')}
                  placeholder={t('descriptionPlaceholder')}
                  value={description}
                  disabled={!canBuild}
                  onChange={event => setDescription(event.target.value)}
                />
                <input
                  className="flow-editor__goal"
                  aria-label={t('goalAria')}
                  placeholder={t('goalPlaceholder')}
                  value={goal}
                  disabled={!canBuild}
                  onChange={event => setGoal(event.target.value)}
                />
                {canBuild && (
                  <>
                    <button onClick={addActionNode}>{t('addActionNode')}</button>
                    <button onClick={addNotifyNode}>{t('addNotifyNode')}</button>
                    <button onClick={addWaitNode}>{t('addWaitNode')}</button>
                    <button className="primary-button" disabled={saving} onClick={() => void save()}>
                      {saving ? t('saving') : isNew ? t('create') : t('save')}
                    </button>
                  </>
                )}
                {/* R2-BUG-03(b): dirty chip 槽位常驻挂载、visibility 切换——
                    旧写法 `{dirty && <span>}` 在 mousedown blur 提交期间首次
                    插入 DOM，Chromium 因此不再把 click 派发给保存按钮。 */}
                <span
                  className={`badge badge--dirty${dirty ? '' : ' badge--dirty--hidden'}`}
                  title={t('dirtyBadgeTitle')}
                  aria-hidden={!dirty}
                >
                  {t('dirtyBadge')}
                </span>
                {!isNew && selectedId !== null && (
                  <button onClick={() => setRunsOpen(open => !open)}>
                    {runsOpen ? t('hideRunHistory') : t('showRunHistory')}
                  </button>
                )}
              </div>
              {issues.length > 0 && (
                <ul className="flow-issues" data-testid="flow-issues">
                  {issues.map((issue, index) => (
                    <li
                      key={`${issue.nodeId ?? ''}-${index}`}
                      className={`flow-issues__item flow-issues__item--${issue.level}`}
                    >
                      {issue.level === 'error' ? t('issueError') : t('issueWarning')}
                      {issue.nodeId ? t('issueNode', { nodeId: issue.nodeId }) : ''}：{issue.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flow-editor__main">
                <FlowCanvas
                  nodes={nodes}
                  edges={edges}
                  readOnly={!canBuild}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                />
                {runsOpen && !isNew && selectedId !== null && (
                  <FlowRunsDrawer flowId={selectedId} onClose={() => setRunsOpen(false)} simId={attachableSim?.id} />
                )}
              </div>
            </FlowEditorContext.Provider>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow list item
// ---------------------------------------------------------------------------

function FlowListItem({
  flow,
  selected,
  canBuild,
  onSelect,
  onToggle,
  onDelete,
}: {
  flow: Flow;
  selected: boolean;
  canBuild: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('flows');
  const latestRun = useLatestFlowRun(flow.id);
  const run = latestRun.data ?? null;
  const runStatusLabel = (status: string) =>
    RUN_STATUS_KEYS.includes(status as (typeof RUN_STATUS_KEYS)[number])
      ? t(`runStatus.${status}`)
      : status;
  // Mechanism C: a read-only caution badge when the flow declares a policy
  // envelope (the canvas does not edit flow-level metadata yet — authoring
  // goes through the REST/CLI policy field, same as the MI-D inputs surface).
  const policy = flow.policy;
  const policySummary = policy
    ? [
        policy.maxDelegationsPerRun !== undefined
          ? `maxDelegationsPerRun=${policy.maxDelegationsPerRun}` : null,
        policy.minConfidenceToActuate !== undefined
          ? `minConfidenceToActuate=${policy.minConfidenceToActuate}` : null,
        policy.onBudgetExhausted !== undefined
          ? `onBudgetExhausted=${policy.onBudgetExhausted}` : null,
      ].filter(part => part !== null).join(', ')
    : '';
  return (
    <div
      className={`flow-list__item${selected ? ' flow-list__item--selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter') onSelect();
      }}
    >
      <div className="flow-list__row">
        <span className="object-list__name" title={flow.name}>{flow.name}</span>
        {run !== null && (
          <span
            className={`flow-dot flow-dot--${run.status}`}
            title={t('latestRunTitle', { status: runStatusLabel(run.status) })}
          />
        )}
      </div>
      <div className="flow-list__row">
        <span className="badge">{t(`triggerKind.${flow.trigger.kind}`)}</span>
        {policy && (
          <span
            className="badge"
            title={t('policyBadgeTitle', { summary: policySummary })}
          >
            {t('policyBadge')}
          </span>
        )}
        {flow.agentInvocable && (
          <span className="badge" title={t('agentInvocableBadgeTitle')}>
            {t('agentInvocableBadge')}
          </span>
        )}
        <span className="object-list__meta">{t('actionCount', { count: flow.plan.nodes.length })}</span>
        {canBuild && (
          <label
            className="flow-list__toggle"
            onClick={event => event.stopPropagation()}
            title={flow.enabled ? t('enabledHint') : t('disabledHint')}
          >
            <input
              type="checkbox"
              checked={flow.enabled}
              onChange={event => onToggle(event.target.checked)}
            />
            {flow.enabled ? t('toggleEnabled') : t('toggleDisabled')}
          </label>
        )}
        {canBuild && (
          <button
            className="link-button flow-list__delete"
            onClick={event => {
              event.stopPropagation();
              onDelete();
            }}
          >
            {t('delete')}
          </button>
        )}
      </div>
    </div>
  );
}
