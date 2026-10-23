/**
 * Service publish/edit form logic (W6) — pure serialization helpers so the
 * sidebar form component stays thin and the wire shape is unit-testable.
 *
 * - The interface params editor is a list of key → description rows; rows
 *   serialize to the `interface_json` object (empty rows are dropped, and an
 *   all-empty editor OMITS the field on creation).
 * - Derived services accept exactly one mutation: the visibility cycle
 *   公开 → 成员 → 隐藏 (everything else is a server-side 409 by design).
 */

import type {
  CreateServiceInput,
  PatchServiceInput,
  ServiceVisibility,
  WorldService,
} from '../api/types';
import i18n from '../i18n/config';

export interface InterfaceRow {
  key: string;
  description: string;
}

/** Prefill rows from an existing service's interface object. */
export function interfaceToRows(iface: Record<string, unknown>): InterfaceRow[] {
  return Object.entries(iface).map(([key, value]) => ({
    key,
    description: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

/**
 * Serialize the rows editor: rows with a blank key are dropped; undefined
 * when nothing usable remains (creation then omits `interface`).
 */
export function rowsToInterface(
  rows: readonly InterfaceRow[],
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    result[key] = row.description.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Derived-service visibility cycle: 公开 → 成员 → 隐藏 → 公开. */
export function nextVisibility(visibility: ServiceVisibility): ServiceVisibility {
  switch (visibility) {
    case 'public':
      return 'members';
    case 'members':
      return 'hidden';
    case 'hidden':
      return 'public';
  }
}

/** One-line explanations under the visibility radio options. */
export const VISIBILITY_EXPLAIN: Record<ServiceVisibility, string> = new Proxy(
  {} as Record<ServiceVisibility, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string') {
        if (prop === 'public') return i18n.t('serviceFormLib:visibilityExplainPublic');
        if (prop === 'members') return i18n.t('serviceFormLib:visibilityExplainMembers');
        if (prop === 'hidden') return i18n.t('serviceFormLib:visibilityExplainHidden');
      }
      return undefined as unknown as string;
    },
  },
);

export interface ServiceFormFields {
  providerAgentId: string;
  name: string;
  semanticType: string;
  description: string;
  rows: InterfaceRow[];
  visibility: ServiceVisibility;
}

export function createServiceFormFields(providerAgentId: string): ServiceFormFields {
  return { providerAgentId, name: '', semanticType: '', description: '', rows: [], visibility: 'public' };
}

/** Prefill the form from an existing published service (edit mode). */
export function serviceFormFieldsFromService(service: WorldService): ServiceFormFields {
  return {
    providerAgentId: service.provider.id,
    name: service.name,
    semanticType: service.semanticType,
    description: service.description,
    rows: interfaceToRows(service.interface),
    visibility: service.visibility,
  };
}

/**
 * R80-1: the duplicate-publish advisory — offers of the same semantic type
 * the chosen provider agent ALREADY lists (any origin). Publish-mode only:
 * non-blocking, the form warns inline and the server echoes the same check
 * as `warnings` on the 201.
 */
export function duplicateServicesOfType(
  services: readonly WorldService[],
  providerAgentId: string,
  semanticType: string,
): WorldService[] {
  const type = semanticType.trim();
  if (providerAgentId.length === 0 || type.length === 0) return [];
  return services.filter(
    service => service.provider.id === providerAgentId && service.semanticType === type,
  );
}

/** Inline validation; null when the form may submit. */
export function serviceFormError(
  fields: ServiceFormFields,
  options: { requireProvider: boolean },
): string | null {
  if (options.requireProvider && fields.providerAgentId.length === 0) {
    return i18n.t('serviceFormLib:providerRequired');
  }
  if (fields.name.trim().length === 0) return i18n.t('serviceFormLib:nameRequired');
  if (fields.semanticType.trim().length === 0) return i18n.t('serviceFormLib:semanticTypeRequired');
  return null;
}

/** POST body for publishing (optional fields omitted when empty). */
export function buildCreateServicePayload(fields: ServiceFormFields): CreateServiceInput {
  const iface = rowsToInterface(fields.rows);
  const description = fields.description.trim();
  return {
    name: fields.name.trim(),
    semanticType: fields.semanticType.trim(),
    ...(description.length > 0 ? { description } : {}),
    ...(iface !== undefined ? { interface: iface } : {}),
    visibility: fields.visibility,
  };
}

/**
 * PATCH body for editing a published service — description and interface are
 * always sent so clearing them in the form clears them server-side.
 *
 * Mechanism D: flow-services (origin='flow') never send `interface` — the
 * server generates it from the backing flow's inputs surface (409
 * SERVICE_FLOW_MANAGED otherwise); name/semanticType/description/visibility
 * edits all ride through.
 */
export function buildPatchServicePayload(
  fields: ServiceFormFields,
  options: { interfaceManaged?: boolean } = {},
): PatchServiceInput {
  return {
    name: fields.name.trim(),
    semanticType: fields.semanticType.trim(),
    description: fields.description.trim(),
    ...(options.interfaceManaged === true ? {} : { interface: rowsToInterface(fields.rows) ?? {} }),
    visibility: fields.visibility,
  };
}
