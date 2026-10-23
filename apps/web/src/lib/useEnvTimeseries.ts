/**
 * useEnvTimeseries — 把 store 的 live snapshot 流累积成环境时序缓冲
 * （lib/timeseries 纯函数的 React 胶水）。
 *
 * 只接 LIVE snapshot（不是回放渲染的 snapshot）：回放游标来回移动不会
 * 污染曲线；重复的 tick 由 appendSnapshot 按 identity 去重，不触发重渲染。
 */

import { useEffect, useState } from 'react';

import type { EngineSnapshot } from '../api/types';
import {
  appendSnapshot,
  createEnvTimeseries,
  type EnvTimeseries,
} from './timeseries';

export function useEnvTimeseries(snapshot: EngineSnapshot | null): EnvTimeseries {
  const [series, setSeries] = useState<EnvTimeseries>(createEnvTimeseries);
  useEffect(() => {
    if (!snapshot) return;
    setSeries(prev => appendSnapshot(prev, snapshot));
  }, [snapshot]);
  return series;
}
