/**
 * Service marketplace helpers (W3) — pure functions over the world's service
 * list so the panel component stays thin and the grouping/filter semantics
 * are unit-testable.
 *
 * Visibility filtering itself happens server-side (the world detail and the
 * service list endpoint only ever carry what the caller may see); these
 * helpers cover the marketplace's browse-time grouping and filtering.
 */

import type { ServiceOrigin, ServiceVisibility, WorldService } from '../api/types';
import i18n from '../i18n/config';

export interface ServiceFilters {
  semanticType?: string | null;
  providerAgentId?: string | null;
  origin?: ServiceOrigin | null;
  /** Fix-20 (F-09): case-insensitive substring over name/description/semantic type. */
  q?: string | null;
  /**
   * R78-F: exclude services whose PROVIDER OWNER is this user — the
   * collaboration-browsing direction ("what can I consume?"), the inverse
   * of the starred filter. Owner-level (not agent-level): a user with
   * several agents still sees none of their own rows.
   */
  excludeOwnerUserId?: string | null;
  /**
   * R80-2 (DevLoop R80, 809-row marketplace): 「只看我的」 — keep ONLY
   * services whose PROVIDER OWNER is this user. Owner-level like
   * excludeOwnerUserId (its exact inverse); in an oversized marketplace
   * "where are MY offers" is the self-management entry (edit / delete /
   * self-agreement).
   */
  ownerUserId?: string | null;
  /**
   * R80-FW1: the SPATIAL dimension — services whose backing device (or
   * declared zone) sits in this zone. Derived rows inherit the source
   * device's zone; published/flow rows carry their declared zone (null =
   * zone-less, never matches). In a multi-zone world "what's around ME" is
   * the natural collaboration entry, which is why this lives in the ONE
   * filter point every service view shares.
   */
  zoneId?: string | null;
}

/** One marketplace group: every offer of one semantic type. */
export interface ServiceGroup {
  semanticType: string;
  services: WorldService[];
}

/** Distinct semantic types present in the list (sorted, for the filter dropdown). */
export function semanticTypesOf(services: readonly WorldService[]): string[] {
  return [...new Set(services.map(service => service.semanticType))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Distinct provider agents present in the list (sorted by name). */
export function providersOf(
  services: readonly WorldService[],
): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const service of services) byId.set(service.provider.id, service.provider.name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Apply browse-time filters (null/undefined fields match everything). */
export function filterServices(
  services: readonly WorldService[],
  filters: ServiceFilters,
): WorldService[] {
  const needle = filters.q?.trim().toLowerCase();
  return services.filter(service => {
    if (filters.excludeOwnerUserId && service.provider.owner.id === filters.excludeOwnerUserId) return false;
    if (filters.ownerUserId && service.provider.owner.id !== filters.ownerUserId) return false;
    if (filters.zoneId && service.zoneId !== filters.zoneId) return false;
    if (filters.semanticType && service.semanticType !== filters.semanticType) return false;
    if (filters.providerAgentId && service.provider.id !== filters.providerAgentId) return false;
    if (filters.origin && service.origin !== filters.origin) return false;
    if (
      needle &&
      !service.name.toLowerCase().includes(needle) &&
      !service.description.toLowerCase().includes(needle) &&
      !service.semanticType.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Group services by semantic type for the marketplace view: groups sorted by
 * type name, services inside a group sorted by provider then name.
 */
export function groupServicesBySemanticType(services: readonly WorldService[]): ServiceGroup[] {
  const byType = new Map<string, WorldService[]>();
  for (const service of services) {
    const group = byType.get(service.semanticType);
    if (group) group.push(service);
    else byType.set(service.semanticType, [service]);
  }
  return [...byType.entries()]
    .map(([semanticType, groupServices]) => ({
      semanticType,
      services: [...groupServices].sort(
        (a, b) =>
          a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name),
      ),
    }))
    .sort((a, b) => a.semanticType.localeCompare(b.semanticType));
}

/** Services offered by one agent (agent detail "发布的服务"). */
export function servicesOfAgent(
  services: readonly WorldService[],
  agentId: string,
): WorldService[] {
  return services.filter(service => service.provider.id === agentId);
}

/** Services derived from one device (device detail "支撑的服务"). */
export function servicesBackedByDevice(
  services: readonly WorldService[],
  deviceId: string,
): WorldService[] {
  return services.filter(service => service.sourceDeviceId === deviceId);
}

export const SERVICE_ORIGIN_LABEL: Record<ServiceOrigin, string> = new Proxy(
  {} as Record<ServiceOrigin, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string') {
        if (prop === 'derived') return i18n.t('servicesLib:originDerived');
        if (prop === 'published') return i18n.t('servicesLib:originPublished');
        // Mechanism D: a published flow backs the service — the deliverable
        // is one deterministic flow run per invocation.
        if (prop === 'flow') return i18n.t('servicesLib:originFlow');
        // R53: the agent-level semantic offer — derived from the provider's
        // capability BUNDLE (core semantic-offers), not a single device.
        if (prop === 'aggregate') return i18n.t('servicesLib:originAggregate');
      }
      return undefined as unknown as string;
    },
  },
);

export const SERVICE_VISIBILITY_LABEL: Record<ServiceVisibility, string> = new Proxy(
  {} as Record<ServiceVisibility, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string') {
        if (prop === 'public') return i18n.t('servicesLib:visibilityPublic');
        if (prop === 'members') return i18n.t('servicesLib:visibilityMembers');
        if (prop === 'hidden') return i18n.t('servicesLib:visibilityHidden');
      }
      return undefined as unknown as string;
    },
  },
);
