/**
 * mapData.governance 输入校验（R6-C-F02 从 routes/environments.ts 抽出的纯移动
 * —— arch-guard 文件行数预算）。
 *
 * Owner-authored governance block：humanReview 阈值（S1）、ownershipPlan
 * 枚举（C3/R42-B）、contractReachabilityCheck 布尔（R6-C-F02 签约时合约
 * zone 可达性门禁的 env 级开关，默认开）。已知字段形状错误一律 400 教学
 * 报错（standing silent-drop 教训），未知子字段忽略以便未来扩展。
 */

import type { EnvMapData } from './db/environment-store.js';
import { ApiError } from './errors.js';

/**
 * S1 (Task 3): validate `mapData.governance` — the owner-authored
 * human-review breadth thresholds. Known fields must be non-negative
 * integers; a typo'd shape is REJECTED with a teaching message (the
 * standing silent-drop lesson), unknown sub-fields are ignored so future
 * governance fields stay loadable. C3 (R42-B) adds the closed
 * `ownershipPlan` enum ('importer' | 'members') — the owner may flip a
 * legacy world into claimable members mode without re-importing.
 * R6-C-F02 adds the `contractReachabilityCheck` boolean (false disarms the
 * signing-time contract zone-reachability gate env-wide; absent/true keeps
 * it enforced).
 */
export function parseGovernanceInput(raw: unknown): NonNullable<EnvMapData['governance']> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.governance" must be an object');
  }
  const humanReviewRaw = (raw as { humanReview?: unknown }).humanReview;
  const ownershipPlanRaw = (raw as { ownershipPlan?: unknown }).ownershipPlan;
  const contractReachabilityCheckRaw = (raw as { contractReachabilityCheck?: unknown }).contractReachabilityCheck;
  if (humanReviewRaw === undefined && ownershipPlanRaw === undefined && contractReachabilityCheckRaw === undefined) return undefined;
  let humanReview: NonNullable<NonNullable<EnvMapData['governance']>['humanReview']> | undefined;
  if (humanReviewRaw !== undefined) {
    if (typeof humanReviewRaw !== 'object' || humanReviewRaw === null || Array.isArray(humanReviewRaw)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.governance.humanReview" must be an object');
    }
    const fields: Array<[keyof NonNullable<NonNullable<EnvMapData['governance']>['humanReview']>, string]> = [
      ['maxAgentsPerProposal', 'max agents per install-agents proposal before owner review'],
      ['maxEventsPerProposal', 'max events per inject-scenario proposal before owner review'],
      ['maxZonesTouched', 'max distinct zones one proposal may touch before owner review'],
    ];
    humanReview = {};
    for (const [field, meaning] of fields) {
      const value = (humanReviewRaw as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "mapData.governance.humanReview.${field}" must be a non-negative integer ` +
            `(${meaning}; 0 disarms the class) — got ${JSON.stringify(value)}`,
        );
      }
      humanReview[field] = value;
    }
  }
  let ownershipPlan: NonNullable<NonNullable<EnvMapData['governance']>['ownershipPlan']> | undefined;
  if (ownershipPlanRaw !== undefined) {
    if (ownershipPlanRaw !== 'importer' && ownershipPlanRaw !== 'members') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "mapData.governance.ownershipPlan" must be "importer" | "members" — got ` +
          `${JSON.stringify(ownershipPlanRaw)} ("members" lets builder members claim unassigned objects via ` +
          'ownership-transfer proposals; the claims themselves still escalate to the owner)',
      );
    }
    ownershipPlan = ownershipPlanRaw;
  }
  // R6-C-F02: the reachability-gate escape hatch — a plain boolean; a typo'd
  // shape is REJECTED (silent fallback would hide a demo misconfiguration).
  let contractReachabilityCheck: boolean | undefined;
  if (contractReachabilityCheckRaw !== undefined) {
    if (typeof contractReachabilityCheckRaw !== 'boolean') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "mapData.governance.contractReachabilityCheck" must be a boolean — got ' +
          `${JSON.stringify(contractReachabilityCheckRaw)} (false disarms the signing-time contract ` +
          'zone-reachability gate env-wide; absent/true keeps it enforced)',
      );
    }
    contractReachabilityCheck = contractReachabilityCheckRaw;
  }
  return {
    ...(humanReview !== undefined ? { humanReview } : {}),
    ...(ownershipPlan !== undefined ? { ownershipPlan } : {}),
    ...(contractReachabilityCheck !== undefined ? { contractReachabilityCheck } : {}),
  };
}

/**
 * Validate `mapData.derivedServiceVisibility`: 'members' (explicitly retracts
 * the env-following default) or 'public' (explicit opt-in; redundant on
 * public envs, INERT on non-public envs — the knob only tightens). Absent =
 * follow the environment: public envs default 'public', others 'members'.
 * Anything else is rejected with the accepted list, never silently dropped.
 */
export function parseDerivedServiceVisibilityInput(raw: unknown): 'members' | 'public' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'members' && raw !== 'public') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "mapData.derivedServiceVisibility" must be "members" | "public", got ${JSON.stringify(raw)} — ` +
        'absent follows the environment (public envs default to opening members-visible DERIVED/AGGREGATE ' +
        'services to anonymous visitors); "members" retracts that default; published offers and hidden ' +
        'derived services are never affected',
    );
  }
  return raw;
}
