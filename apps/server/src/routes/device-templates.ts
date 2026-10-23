/**
 * Device-template route (UX wave-3) — read-only pass-through of the
 * simulation package's built-in DeviceTemplateRegistry (73+ entries: smart
 * city, mobility, office, safety, …), so the device-add UI can offer
 * template cards without hard-coding its own copy.
 *
 * - `GET /api/device-templates` — `{templates: [{id, name, type, category?,
 *   description, capabilities, defaultBehaviors, environmentEffects?,
 *   visualization?}]}`, sorted by id. `id` is the registry key (the
 *   lower-cased template name) — the value accepted anywhere a device
 *   `type`/template is named. Auth-required, same posture as
 *   /api/scenario-templates (bundled read-only content).
 */

import type { FastifyInstance } from 'fastify';

import { DeviceTemplateRegistry } from '@active-collaboration/simulation';

export function registerDeviceTemplateRoutes(app: FastifyInstance): void {
  app.get('/api/device-templates', { preHandler: app.authenticate }, async () => ({
    templates: DeviceTemplateRegistry.listTemplates()
      .map(template => ({
        id: template.name.toLowerCase(),
        name: template.name,
        type: template.type,
        ...(template.category !== undefined ? { category: template.category } : {}),
        description: template.description,
        capabilities: template.capabilities,
        defaultBehaviors: template.defaultBehaviors,
        ...(template.environmentEffects !== undefined
          ? { environmentEffects: template.environmentEffects }
          : {}),
        ...(template.visualization !== undefined ? { visualization: template.visualization } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
}
