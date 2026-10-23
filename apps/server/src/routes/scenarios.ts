/**
 * Scenario routes — CRUD over the two-source scenario store
 *
 * - `GET    /api/scenarios`      list summaries (id, name, description,
 *                                source, zone/device/agent counts)
 * - `GET    /api/scenarios/:id`  the RAW stored scenario JSON (T-031 —
 *                                verbatim what was POSTed, so geo-tier
 *                                fields survive the round-trip)
 * - `POST   /api/scenarios`      create a user scenario (201); 400 + issues
 *                                on validation failure, 409 on duplicate id
 * - `PUT    /api/scenarios/:id`  replace a USER scenario; 403 for seeds,
 *                                400 when body id ≠ path id
 * - `DELETE /api/scenarios/:id`  delete a user scenario (204); 403 for seeds
 *
 * DEPRECATED (Fix-6, usability F-03): this store is a dead end — a saved
 * scenario cannot be instantiated into a runnable environment from here.
 * The supported path is `POST /api/environments` with a scenario JSON body
 * (import) or `eaf apply` (declarative world documents). These routes stay
 * only for the legacy frontend list page and the replay "save as scenario"
 * flow.
 *
 * AUTH: the reads stay anonymous (the credential-less frontend list page
 * depends on them); the WRITES require authentication since Fix-6 —
 * anonymous disk writes were an open hole.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import type { ScenarioStore } from '../scenario-store.js';

interface IdParams {
  id: string;
}

export function registerScenarioRoutes(app: FastifyInstance, store: ScenarioStore): void {
  app.get('/api/scenarios', async () => ({ scenarios: store.list() }));

  app.get('/api/scenarios/:id', async request => {
    const { id } = request.params as IdParams;
    const stored = store.get(id);
    if (!stored) {
      throw new ApiError(404, 'SCENARIO_NOT_FOUND', `Scenario "${id}" not found`);
    }
    // T-031: serve the RAW stored document verbatim — loader-normalized
    // output used to strip the geo tier (map block, polygons, brand,
    // position) on save+reload. The normalized form stays internal.
    return stored.document;
  });

  app.post('/api/scenarios', { preHandler: app.authenticate }, async (request, reply) => {
    const saved = store.create(request.body);
    return reply.code(201).send(saved.document);
  });

  app.put('/api/scenarios/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    return store.replace(id, request.body).document;
  });

  app.delete('/api/scenarios/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    store.remove(id);
    return reply.code(204).send();
  });
}
