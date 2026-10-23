/**
 * SettlementProvider SPI (Fix-11, service-consumption-design.md §3.4)
 *
 * The core owns contract lifecycle, consumption and metering; value exchange
 * (pricing, payment, clearing) is pushed behind this interface. The default
 * assembly is the NullSettlementProvider: quote is always null (no amounts)
 * and settle only ARCHIVES the batch as a receipt with status 'recorded' —
 * the platform's no-amount mode is the normal mode, settlement is never a
 * precondition of consumption (principles 2/3/6).
 *
 * Compliance boundary (§7): the core ships no token/fiat/blockchain
 * settlement. External settlement backends are implemented by independent
 * projects against this SPI and assembled via SETTLEMENT_PROVIDER — nothing
 * in the default distribution depends on them.
 */

import type { AgreementStore, AgreementTerms, UsageRecordRow } from './db/agreement-store.js';

/** A batch of usage records handed to the provider for quoting/settlement. */
export interface SettlementBatch {
  agreementId: string;
  envId: string;
  terms: AgreementTerms;
  usageRecords: UsageRecordRow[];
}

/** Unit-neutral quote; `null` means "not priced" (the Null default). */
export interface Quote {
  amount: string | null;
  unit: string | null;
}

export interface SettlementReceipt {
  id: string;
  agreementId: string;
  provider: string;
  status: 'recorded';
  usageRecordIds: string[];
  quote: Quote | null;
  createdAt: string;
}

export interface SettlementProvider {
  readonly name: string;
  /** Price a batch (unit-neutral); null = not priced. */
  quote(batch: SettlementBatch, terms: AgreementTerms): Promise<Quote | null>;
  /** Settle a batch; returns the receipt. Default: archive only. */
  settle(batch: SettlementBatch): Promise<SettlementReceipt>;
  /** Settlement history of one agreement. */
  receipts(agreementId: string): Promise<SettlementReceipt[]>;
}

/**
 * The default provider (§3.4): no amounts, no fund movement. quote → null;
 * settle archives the batch as a status='recorded' receipt so every settled
 * batch is auditable alongside the usage records it covers.
 */
export class NullSettlementProvider implements SettlementProvider {
  readonly name = 'recorded-only'; // TASK-018: was 'null' which serialized as "provider":"null" in receipts

  constructor(private readonly store: AgreementStore) {}

  async quote(_batch: SettlementBatch, _terms: AgreementTerms): Promise<Quote | null> {
    return null;
  }

  async settle(batch: SettlementBatch): Promise<SettlementReceipt> {
    const row = this.store.appendReceipt({
      agreementId: batch.agreementId,
      envId: batch.envId,
      provider: this.name,
      status: 'recorded',
      usageRecordIds: batch.usageRecords.map(record => record.id),
      quote: null,
    });
    return {
      id: row.id,
      agreementId: row.agreement_id,
      provider: row.provider,
      status: row.status,
      usageRecordIds: batch.usageRecords.map(record => record.id),
      quote: null,
      createdAt: row.created_at,
    };
  }

  async receipts(agreementId: string): Promise<SettlementReceipt[]> {
    return this.store.receiptsOf(agreementId).map(row => ({
      id: row.id,
      agreementId: row.agreement_id,
      provider: row.provider,
      status: row.status,
      usageRecordIds: JSON.parse(row.usage_record_ids_json) as string[],
      quote: row.quote_json !== null ? (JSON.parse(row.quote_json) as Quote) : null,
      createdAt: row.created_at,
    }));
  }
}
