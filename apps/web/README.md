# @active-collaboration/web

Web console for the Active Collaboration engine（React + Vite）。

## API 类型契约

`src/api/types.ts` 的 DTO 类型派生自 `src/api/generated.ts`，后者由
openapi-typescript 从契约单一事实源 `apps/server/openapi.yaml` 生成：

```bash
npm run sync-types -w @active-collaboration/web
```

**约定：API 变更（openapi.yaml 更新）后必须重跑 `sync-types` 并提交
`generated.ts`。** types.ts 中仅保留纯前端辅助类型（WebSocket 帧、表单
状态等）与少量带注释的补丁（契约暂未覆盖的序列化字段）；契约补齐后应
删除补丁、直接别名生成的 schema。

## 状态管理约定

前端状态分两类，归属不同的库，**新代码必须遵守**：

- **服务端状态 → TanStack Query**（`@tanstack/react-query` v5）。任何来自
  REST API、以"拉取/缓存/失效"为生命周期的数据，一律用 `useQuery` /
  `useMutation`，禁止再手写 fetch-进-store 或 `useEffect` + `useState`
  拉数。Query hooks 集中在 `src/hooks/`（每个资源域一个文件，如
  `useNotifications.ts`）；`QueryClient` 与默认配置集中在
  `src/lib/queryClient.ts`，由 `main.tsx` 挂载。
- **UI / 会话 / 运行期流式状态 → zustand**（`src/store/useAppStore.ts`）。
  auth 会话、世界视图的 WS 增量、仿真 snapshot/stream/replay、主题、
  toast 等留在 store；这些不是可缓存的服务端数据，不要迁进 Query。

### Query key 约定

key 为数组形式，第一段是资源域，后续为作用域/参数，统一从
`lib/queryClient.ts` 的 `queryKeys` factory 取，禁止在组件里手写：

- `['notifications', 'list']` / `['notifications', 'unread-count']`
- `['environments', 'list']`
- `['me', 'overview']`

mutation 完成后按前缀失效（如 `invalidateQueries(['notifications'])`
同时刷新列表与铃铛未读数）；需要即时反馈的写操作（标记已读、取消收藏）
在 `onMutate` 里做乐观更新、`onError` 回滚、`onSettled` 失效。轮询用
`refetchInterval`（如通知未读数 30s），不要手写 `setInterval`。

### 测试

渲染涉及 Query 的组件用 `src/test/testUtils.tsx` 的
`renderWithProviders`（每个测试独立的 QueryClient + MemoryRouter，
retry 关闭）。

### 遗留切片（未迁移，供后续批次参考）

以下仍是 zustand 内的服务端拉取状态，后续批次按同一模式迁移：

- `world` 切片的首屏加载（`openEnvironment`/`reloadWorld` 拉取
  环境详情；WS 增量部分仍留 zustand）
- `scenarios` 切片（legacy 场景浏览器，`loadScenarios`/`openScenario`）
- 其余一次性 mutation（创建仿真、设备/服务表单提交等）可逐步改
  `useMutation`
