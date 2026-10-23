/**
 * Notification store — the persistent inbox (Fix-16, roadmap Fix-16)
 *
 * R4/R6 反复发现"有收件箱没门铃"：提案裁决、agreement 提案/决定、AC 协作
 * 应答，当事人不轮询就不知道；WS 实时广播掉线即错过。这张表是补拉的落点：
 * 事件发生时写一条通知，客户端上线后 `GET /api/notifications` 拉取。
 *
 * 噪音控制（生产者侧约定，store 只提供机制）：
 * - 自己触发的事件不通知自己（recipient === actor 时生产者跳过）；
 * - 可重复事件（如 invoke 失败）用 `hasUnread` 去重——同一 (user, kind,
 *   refId) 已有未读就不再发，读过之后才允许新的同类提醒。
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  env_id: string;
  kind: string;
  title: string;
  body_json: string;
  ref_id: string | null;
  read_at: string | null;
  created_at: string;
  /** R68: aggregated repeat count (xN badge) — same-key unread merges. */
  repeat_count: number;
}

export interface CreateNotificationInput {
  userId: string;
  envId: string;
  kind: string;
  title: string;
  /** Structured detail, stored as JSON text. */
  body?: Record<string, unknown>;
  /** The object the notification is about (proposal/agreement/collaboration id). */
  refId?: string | null;
}

/**
 * T59 (R6, u1-F8/u2-F-3-1): the STREAMING verdict kinds whose events arrive
 * per-proposal by nature (every auto-applied/delegate-applied/applied
 * proposal rings once). Their aggregation key is (user, kind, ENV) — the
 * R68 (user, kind, refId) key never merges them (refId was per proposal),
 * so a busy shared environment stacked 65 unread rows for one story. Read
 * state stays the aggregation boundary: after reading, the next event opens
 * a fresh row. `reminded` and other per-object kinds keep the refId key.
 */
export const ENV_AGGREGATED_KINDS: ReadonlySet<string> = new Set([
  'proposal.applied',
  'proposal.auto_applied',
  'proposal.delegate-applied',
]);

/** T59: the recent-items digest cap on an env-aggregated row's body. */
export const AGGREGATED_ITEM_CAP = 5;

export class NotificationStore {
  constructor(private readonly db: EafDatabase) {}

  /**
   * Wave-4b: fire-and-forget hook invoked with every persisted row (the
   * outbound webhook dispatcher wires in here). Must never throw — a broken
   * push channel may not break the inbox.
   */
  onCreated?: (row: NotificationRow) => void;

  /**
   * R68 aggregation: a same-key UNREAD row absorbs the repeat (count++,
   * bubbles to the top, body/title refresh) instead of inserting — a
   * collaboration storm shows as ONE "your request was accepted ×15" row.
   * Rows without ref_id and rows whose prior copy is already read insert
   * fresh (read state is the aggregation boundary — new activity after
   * reading deserves a new row). A light retention prune rides along:
   * per user, read rows older than 30 days and the oldest rows beyond
   * 1000 total are dropped (best-effort, never throws).
   */
  create(input: CreateNotificationInput): NotificationRow {
    const now = new Date().toISOString();
    // T59: env-level aggregation for the streaming verdict kinds — merge on
    // (user, kind, env), accumulate a capped `recent` items digest in the
    // body (latest N proposalIds), keep the newest full body. repeat_count
    // is the ×N badge; the activity feed keeps the full per-proposal audit.
    if (ENV_AGGREGATED_KINDS.has(input.kind)) {
      // Read the current unread row FIRST (its body holds the prior items),
      // then fold everything into one UPDATE — merging via RETURNING would
      // overwrite body_json before the prior items are read.
      const previous = this.findUnreadByEnv(input.userId, input.kind, input.envId);
      const bodyJson = JSON.stringify(this.aggregatedBody(input, previous));
      if (previous !== undefined) {
        const merged = this.db
          .prepare(
            `UPDATE notifications
             SET repeat_count = repeat_count + 1, created_at = ?, title = ?, body_json = ?
             WHERE id = ? RETURNING *`,
          )
          .get(now, input.title, bodyJson, previous.id) as NotificationRow | undefined;
        if (merged !== undefined) {
          const row = { ...merged, body_json: bodyJson };
          try { this.onCreated?.(row); } catch { /* best-effort push */ }
          this.pruneFor(input.userId);
          return row;
        }
      }
    }
    if (input.refId !== undefined && input.refId !== null && input.refId.length > 0) {
      const merged = this.db
        .prepare(
          `UPDATE notifications
           SET repeat_count = repeat_count + 1, created_at = ?, title = ?, body_json = ?
           WHERE id = (
             SELECT id FROM notifications
             WHERE user_id = ? AND kind = ? AND ref_id = ? AND read_at IS NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1
           ) RETURNING *`,
        )
        .get(now, input.title, JSON.stringify(input.body ?? {}), input.userId, input.kind, input.refId) as NotificationRow | undefined;
      if (merged !== undefined) {
        try { this.onCreated?.(merged); } catch { /* best-effort push */ }
        this.pruneFor(input.userId);
        return merged;
      }
    }
    const row: NotificationRow = {
      id: randomUUID(),
      user_id: input.userId,
      env_id: input.envId,
      kind: input.kind,
      title: input.title,
      // T59: an env-aggregated kind's FIRST row already carries the digest
      // shape (recent [item], count 1) so later merges accumulate cleanly.
      body_json: ENV_AGGREGATED_KINDS.has(input.kind)
        ? JSON.stringify(this.aggregatedBody(input, undefined))
        : JSON.stringify(input.body ?? {}),
      ref_id: input.refId ?? null,
      read_at: null,
      created_at: now,
      repeat_count: 1,
    };
    this.db
      .prepare(
        `INSERT INTO notifications
         (id, user_id, env_id, kind, title, body_json, ref_id, read_at, created_at, repeat_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        row.id, row.user_id, row.env_id, row.kind, row.title,
        row.body_json, row.ref_id, row.read_at, row.created_at,
      );
    try {
      this.onCreated?.(row);
    } catch {
      // The push hook is best-effort by contract; the row is already durable.
    }
    this.pruneFor(input.userId);
    return row;
  }

  /** T59: the newest UNREAD row of one (user, kind, env) — the env-merge anchor. */
  private findUnreadByEnv(userId: string, kind: string, envId: string): NotificationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_id = ? AND kind = ? AND env_id = ? AND read_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId, kind, envId) as NotificationRow | undefined;
  }

  /**
   * T59: the body of an env-aggregated row — the LATEST event's full fields
   * plus a capped `recent` digest ({proposalId, proposalKind} per item) and
   * an aggregate `count`. `previous` carries the merged row whose body holds
   * the prior items (undefined = the fresh-insert shape).
   */
  private aggregatedBody(
    input: CreateNotificationInput,
    previous: NotificationRow | undefined,
  ): Record<string, unknown> {
    const body = { ...(input.body ?? {}) };
    const prior = previous !== undefined ? this.parseBody(previous) : {};
    const priorItems = Array.isArray(prior.recent)
      ? (prior.recent as Array<Record<string, unknown>>)
      : [];
    const item: Record<string, unknown> = {};
    if (typeof body.proposalId === 'string') item.proposalId = body.proposalId;
    if (typeof body.proposalKind === 'string') item.proposalKind = body.proposalKind;
    if (typeof body.summary === 'string') item.summary = body.summary;
    const recent =
      Object.keys(item).length > 0
        ? [...priorItems, item].slice(-AGGREGATED_ITEM_CAP)
        : priorItems.slice(-AGGREGATED_ITEM_CAP);
    const priorCount = typeof prior.count === 'number' ? prior.count : previous?.repeat_count ?? 0;
    return { ...body, recent, count: priorCount + 1 };
  }

  /** Parse a stored body_json defensively (corruption never breaks the inbox). */
  private parseBody(row: NotificationRow): Record<string, unknown> {
    try {
      const parsed = JSON.parse(row.body_json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** R68 retention: read rows >30 days old, then anything beyond the newest
   * 1000 rows, disappear. Cheap (two statements) and failure-tolerant. */
  private pruneFor(userId: string): void {
    try {
      this.db
        .prepare(`DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL AND read_at < ?`)
        .run(userId, new Date(Date.now() - 30 * 86_400_000).toISOString());
      this.db
        .prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
          SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1000)`)
        .run(userId, userId);
    } catch {
      // Retention is hygiene, not correctness — never fail the create.
    }
  }

  /**
   * Newest first; `unreadOnly` filters to read_at IS NULL. `before` (ISO) is
   * the T-030 pagination cursor — rows strictly older than it, mirroring the
   * activity feed's `?before=` (Wave-1a) — so the newest-`limit` window is
   * not the only reachable slice of a heavy inbox.
   */
  listForUser(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number; before?: string; kind?: string } = {},
  ): NotificationRow[] {
    const limit = options.limit ?? 50;
    const conds = ['user_id = ?'];
    const params: (string | number)[] = [userId];
    if (options.unreadOnly === true) {
      conds.push('read_at IS NULL');
    }
    // T59: the CLI's `--kind <k>` mute face — server-side so pagination and
    // limits stay honest for the filtered view.
    if (options.kind !== undefined && options.kind.length > 0) {
      conds.push('kind = ?');
      params.push(options.kind);
    }
    if (options.before !== undefined) {
      conds.push('created_at < ?');
      params.push(options.before);
    }
    return this.db
      .prepare(
        // rowid is the insertion-order tiebreak for same-millisecond rows.
        `SELECT * FROM notifications WHERE ${conds.join(' AND ')}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as NotificationRow[];
  }

  /** Fetch one notification of a user (ownership enforced by the caller's id). */
  getForUser(id: string, userId: string): NotificationRow | undefined {
    return this.db
      .prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?')
      .get(id, userId) as NotificationRow | undefined;
  }

  /**
   * T-309: the newest notification of one (user, kind, refId) — the anchor
   * for rate-limited nudges (the remind endpoint re-queries instead of
   * carrying extra columns on agreements).
   */
  latestOfKind(userId: string, kind: string, refId: string): NotificationRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM notifications WHERE user_id = ? AND kind = ? AND ref_id = ? ' +
          'ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(userId, kind, refId) as NotificationRow | undefined;
  }

  /** Mark one notification read; idempotent (an already-read row is returned as-is). */
  markRead(id: string, userId: string): NotificationRow | undefined {
    const existing = this.getForUser(id, userId);
    if (!existing) return undefined;
    if (existing.read_at !== null) return existing;
    const readAt = new Date().toISOString();
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ?')
      .run(readAt, id);
    return { ...existing, read_at: readAt };
  }

  /** Mark every unread notification of the user read; returns how many changed. */
  markAllRead(userId: string): number {
    const readAt = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(readAt, userId);
    return result.changes;
  }

  countUnread(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as { n: number };
    return row.n;
  }

  /**
   * Dedupe handle for repeatable events (e.g. agreement invoke failures):
   * true when an unread notification of the same kind about the same object
   * already exists — the producer should not stack another one.
   */
  hasUnread(userId: string, kind: string, refId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM notifications
         WHERE user_id = ? AND kind = ? AND ref_id = ? AND read_at IS NULL LIMIT 1`,
      )
      .get(userId, kind, refId);
    return row !== undefined;
  }

  /**
   * T39 (R3 u3-F4): the unread twin of hasUnread — the batch coalescer reads
   * the previous row's body to ACCUMULATE per-item digests (the create-time
   * merge overwrites body_json, so the merge-up path needs the old items).
   */
  findUnread(userId: string, kind: string, refId: string): NotificationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_id = ? AND kind = ? AND ref_id = ? AND read_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId, kind, refId) as NotificationRow | undefined;
  }
}
