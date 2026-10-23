/**
 * Recommendation-to-actuation bridge (DevLoop R28, Mechanism A follow-up).
 *
 * THE PROBLEM (R26 evidence, 0/15+ across models): small models REASON about
 * the budget devices the T-502 inventory shows them ("pausing battery
 * charging would cut 0.4 kW") but will not format the structured
 * `actuations` array — the intent lives in prose and dies there. The trace
 * reads `commandsExecuted: 0` with nothing to distinguish inability-to-format
 * from chose-to-do-nothing.
 *
 * THE FIX (architectural, platform-side and DETERMINISTIC): the actuating
 * delegate prompt now also accepts plain-text `recommendations`; this pure
 * module maps that text onto budget-constrained actuation proposals:
 *   - device matching — budget deviceId literal > full device NAME > device
 *     TYPE synonym (battery/hvac/ups/…), resolved against the SAME T-502
 *     budget-device inventory the prompt renders (one truth for what the
 *     model was shown);
 *   - command matching — the budget's allowedCommands against a curated
 *     keyword table built from the platform's command-surface vocabulary
 *     (T-605/T-607: set-temperature/set-mode/set-charging/set-power families
 *     + the generic turn-on/turn-off toggles). Domain commands (set-*)
 *     outrank generic toggles — "pause battery charging" maps to
 *     set-charging rate:0, not turn-off;
 *   - param extraction — numbers with unit/context (degrees → target
 *     temperature, rate/kW → rate/power), mode words normalized to the
 *     device family's vocabulary, pause+charge → rate 0;
 *   - R33 (Smart F5) param safety — delta prose ("reduce by 1-2 degrees")
 *     resolves against the device's CURRENT setpoint instead of commanding
 *     a negative absolute; every extracted numeric passes the device-safe
 *     ranges (temperature 5–40°C, rate 0–1, power 0–100%): near-range
 *     values clamp (recorded, never silent), impossible values reject
 *     into rejectedActuations with a teaching reason.
 *
 * HONESTY CONTRACTS:
 *   - budget enforcement happens AFTER parsing, in the delegate runner's
 *     EXISTING per-proposal loop (maxCommands/deviceIds/allowedCommands) —
 *     the bridge never widens the budget, it only produces proposals the
 *     same loop would accept from a structured answer;
 *   - every clause that LOOKS like a device-directed action but fails to
 *     map becomes a rejectedActuation with a reason naming what failed —
 *     nothing is guessed and nothing is silently dropped;
 *   - clauses with no action vocabulary at all are narrative, not failed
 *     recommendations — they produce no records (a "hold, do nothing" answer
 *     must not read as a parse failure);
 *   - `actionVocabularySeen` distinguishes "the model DID recommend
 *     something we could not parse" from "the model proposed nothing
 *     action-like" (the T-084 markers consume this).
 *
 * Pure module: no IO, no clock, no LLM — fully deterministic given
 * (text, budget, inventory). Never throws.
 */

import type { DelegateBudgetDevice, DelegateRejectedActuation } from './flow-delegate.js';

// ============================================================================
// Types
// ============================================================================

/** The subset of the delegate budget the bridge reasons over. */
export interface RecommendationBridgeBudget {
  maxCommands: number;
  deviceIds: readonly string[];
  allowedCommands: readonly string[];
  /**
   * R49: the caller's OWN device ids (agent bindings). Name matches in
   * city-scale scenarios hit same-named siblings in every district — the
   * scope breaks the tie. Optional; absent keeps first-match semantics.
   */
  scopeDeviceIds?: ReadonlySet<string>;
}

/** One bridge-produced actuation proposal — same shape as a structured one. */
export interface BridgedActuationProposal {
  deviceId: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface RecommendationBridgeResult {
  /** Parsed, in-budget-vocabulary proposals (budget enforced downstream). */
  proposals: BridgedActuationProposal[];
  /** Clauses that looked actionable but failed to map — recorded honestly. */
  rejected: DelegateRejectedActuation[];
  /**
   * R33 (Smart F5): teaching notes for values CLAMPED into the device-safe
   * ranges (the actuation still happened — the note keeps the clamp visible
   * instead of silently rewriting the model's number).
   */
  clamped: string[];
  /**
   * R99 (zhao-07): disambiguation notes — a generic TYPE-word clause that
   * matched several devices lists every candidate (readable names) and
   * states the choice basis (the requester's bound device, else first
   * match). Never interactive: the answer DECLARES its mapping.
   */
  notes: string[];
  /**
   * True when the text carried action vocabulary (a command keyword or a
   * directive verb) anywhere — the T-084 parseFailed vs noActionProposed
   * discriminator.
   */
  actionVocabularySeen: boolean;
}

export interface RecommendationBridgeInput {
  text: string;
  budget: RecommendationBridgeBudget;
  /** The SAME T-502 inventory lookup the actuating prompt renders from. */
  budgetDeviceOf?: (deviceId: string) => DelegateBudgetDevice | undefined;
}

// ============================================================================
// Vocabulary (curated from the platform's command surface)
// ============================================================================

/** Bounded: a hostile/chatty answer cannot flood the parse. */
const MAX_CLAUSES = 16;
const CLAUSE_CAP = 240;

/**
 * Directive verbs that make a clause ACTION-LOOKING even when no allowed
 * command keyword matched (the clause then rejects with "could not map", not
 * narrative silence). Deliberately excludes "recommend"/"should"/"action" —
 * "recommend doing nothing" is a no-op proposal, not a parse failure.
 * R46-P0: zh directive verbs too — a Chinese clause used to look like
 * narrative prose to this table and vanished without a record.
 */
const DIRECTIVE_VERB =
  /\b(turn|switch|set|adjust|configure|increase|decrease|raise|lower|start|stop|pause|resume|halt|enable|disable|activate|deactivate|open|close|shut|power)\b|打开|关闭|开启|设置|调成|调整|调节|启动|停止|把|请帮?我?/i;

interface CommandKeywords {
  /** Domain commands outrank generic toggles within one clause. */
  domain: boolean;
  patterns: RegExp[];
}

/** Hyphen/space-insensitive literal for a command name, e.g. 'set-charging'. */
function commandLiteral(command: string): RegExp {
  const words = command.split('-').filter(w => w.length > 0);
  if (words.length === 0) return /$a^/;
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${escaped.join('[ -]?')}\\b`, 'i');
}

/**
 * The curated keyword table. Keys are the platform's canonical command
 * names; `set-*`/toggle families come from the simulation command surface
 * (GenericSetCommandHandler accepted params: target/targetTemp/mode/
 * charging/enable/rate/chargingRate; ClimateModeCommandHandler enum
 * cooling|heating|auto scoped to climate types per T-607). Commands outside
 * the table fall back to a literal name match.
 */
const COMMAND_KEYWORDS: Record<string, CommandKeywords> = {
  'turn-on': {
    domain: false,
    patterns: [
      /\b(?:turn|switch|power|spin|bring)(?:ing|ed)?\s+(?:it\s+|them\s+)?(?:on|up)\b/i,
      /\b(?:start|enable|activate|resume|boot|energize)\w*\b/i,
      // R46-P0: zh toggle vocabulary — "把泵全部打开" used to look like
      // narrative prose here (no keyword hit → no record at all).
      /打开|开启|启动|通电|投入运行/,
    ],
  },
  'turn-off': {
    domain: false,
    patterns: [
      /\b(?:turn|switch|power|shut)(?:ing|ed)?\s+(?:it\s+|them\s+)?off\b/i,
      /\bshut(?:ting)?\s*down\b/i,
      /\b(?:stop|stopping|halt|halting|disable|disabling|deactivate|deactivating|kill)\w*\b/i,
      /\bpaus(?:e|es|ed|ing)\b/i,
      /关闭|关掉|切断|停用|停止|断电|断开/,
    ],
  },
  open: {
    domain: true,
    patterns: [
      /\bopen(?:ing|ed|s)?\b/i,
      // Valves and dampers: "打开" is their DOMAIN verb — outranks the
      // generic turn-on toggle so a smart-valve gets `open`, not `turn-on`.
      /打开|开启/,
    ],
  },
  'set-temperature': {
    domain: true,
    patterns: [
      /temperat|thermostat|setpoint/i,
      /\bdegre(?:e|es)\b|\bdeg\b|°|\bcelsius\b|\bcentigrade\b/i,
      /温度|恒温|采暖|制冷|采暖|摄氏|℃/,
      // T2 (R2, u1-F1): the zh RELATIVE shapes — 「空调调高 2 度」 carries no
      // 温度 keyword, so the clause used to look like narrative and the ask
      // died unmapped. A delta verb + explicit degree unit IS a temperature
      // ask (the same unit requirement keeps 「湿度降低 10」 out — and that
      // clause lacks 度 entirely).
      /(?:调高|调低|升高|降低|提高|增加|减少|上升|下降)\s*-?\d+(?:\.\d+)?\s*(?:度|℃|°)/,
    ],
  },
  'set-mode': {
    domain: true,
    patterns: [/\bmod(?:e|es)\b/i, /模式/],
  },
  'set-charging': {
    domain: true,
    patterns: [/\bcharg(?:e|es|ed|ing|er)\b/i, /充电/],
  },
  'set-power': {
    domain: true,
    patterns: [
      // Bare "power" as a NOUN (a wattage target) — the verb phrases
      // "power on/off" belong to the toggles and are excluded.
      /\bpower\b\s*(?!on\b|off\b)(?:to|at|=|:)?/i,
      /\bwattage\b/i,
      /功率/,
    ],
  },
};

/**
 * Device-type synonyms for name-less references ("pause the battery").
 * R46-P0: zh synonyms for the platform's zh-heavy scenarios — "阀门" must
 * reach a smart-valve, "空调" an hvac, without the full device name.
 */
const TYPE_SYNONYMS: Record<string, readonly string[]> = {
  battery: ['battery', 'batteries', 'storage', '电池'],
  // T26 (R3, u1-F3): 'ac' — the standard EN abbreviation u1's questions use
  // ("raise AC setpoint", "the AC unit"). Matched word-bounded (see
  // typeSynonymHits) so "trace"/"face" never hit.
  hvac: ['hvac', 'ac', 'air conditioner', 'air-conditioner', 'aircon', 'air conditioning', 'climate', 'thermostat', 'ahu', '空调', '冷气', '暖气'],
  thermostat: ['thermostat', 'hvac', 'climate', '温控器'],
  // T90 (R12, u1-F-1) vocabulary parity: this row carries the zh 空调 but
  // used to miss the EN abbreviation 'ac' — an "AC"-typed ask matched hvac
  // rows only, so EN and ZH candidate sets diverged on worlds that type
  // their units 'air-conditioner'. Same EN coverage as the hvac row now.
  'air-conditioner': ['air conditioner', 'air-conditioner', 'aircon', 'air conditioning', 'ac', 'hvac', '空调'],
  'smart-valve': ['smart valve', 'valve', '阀门', '阀'],
  valve: ['valve', '阀门', '阀'],
  pump: ['pump', '泵', '泵站'],
  'backup-generator': ['backup generator', 'generator', '发电机', '备用电源'],
  generator: ['generator', '发电机'],
  ups: ['ups', 'uninterruptible', '不间断电源'],
  inverter: ['inverter', '逆变器'],
  tracker: ['tracker', 'solar tracker', '跟踪支架'],
  'solar-panel': ['solar', 'pv array', 'panel', 'panels', '光伏', '太阳能板'],
  'pv-array': ['solar', 'pv array', 'pv', 'array', '光伏'],
  'charge-controller': ['charge controller', 'controller', '充电控制器'],
  meter: ['meter', '电表', '表计'],
  'export-meter': ['export meter', 'meter'],
  breaker: ['breaker', '断路器', '开关'],
  light: ['light', 'lights', 'lamp', 'lighting', '灯', '照明'],
  'smart-light': ['light', 'lights', 'lamp', 'lighting', '智能灯', '灯'],
  'emergency-light': ['emergency light', 'emergency lighting', '应急灯', '照明', '灯'],
  display: ['display', 'screen', '显示屏', '屏幕'],
  purifier: ['purifier', 'air purifier', '净化器'],
  camera: ['camera', 'cctv', '摄像头', '监控'],
  'surveillance-camera': ['surveillance camera', 'camera', 'cctv', '摄像头', '监控'],
  sensor: ['sensor', '传感器'],
  'pos-terminal': ['pos', 'terminal', 'checkout'],
  kiosk: ['kiosk', '自助终端'],
};

/** Climate-family device types (T-607): closed mode enum cooling|heating|auto. */
const CLIMATE_TYPES = new Set(['hvac', 'thermostat', 'air-conditioner', 'air-conditioning', 'climate']);

/**
 * THE shared zh/EN device-type vocabulary (R1 B1-3 discipline: ONE word
 * table — the predictor's error-hygiene ranking and any future consumer
 * import this; never a second matcher). Exported read-only.
 */
export function typeSynonymsOf(type: string): readonly string[] {
  return TYPE_SYNONYMS[type] ?? (type.length > 0 ? [type] : []);
}

/**
 * T26 (R3, u1-F3): THE shared synonym-hit semantics — word-bounded for
 * pure-latin tokens (so the hvac 'ac' cannot match "trace"/"face", and the
 * already-short 'pv'/'ups'/'pos' stop colliding inside longer words), plain
 * substring for CJK (no word boundaries exist). One table, one matcher —
 * the predictor's type-word lane imports this instead of re-deriving it.
 */
export function typeSynonymHits(lowerText: string, synonym: string): boolean {
  if (/^[a-z0-9][a-z0-9 ]*$/i.test(synonym)) {
    const escaped = synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(lowerText);
  }
  return lowerText.includes(synonym);
}

/** R49 CJK-aware folding (lowercase, strip non [a-z0-9 CJK]). */
export function foldForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/** Subsequence containment on folded strings: 「d栋图书馆」 is a
 * subsequence of 「d栋ai与物联网图书馆空调机组」 (the official device name
 * interleaves department words the user's phrase skips). */
export function isFoldingSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack.charCodeAt(j) === needle.charCodeAt(i)) i++;
  }
  return i === needle.length;
}

/**
 * T104 (R16, u4-F3): a DEGREE-ATTACHED number is a VALUE, never a place
 * word — 「调到 24 度」/「to 24 degrees」 states a setpoint. Stripped before
 * location/digit-token extraction so the setpoint slot's digits cannot pose
 * as a zhao-12 room number: u4's 「M栋多功能厅 的空调调到 24 度会怎样」
 * parsed or 400'd depending on whether "24" happened to be a substring of
 * some device's UUID (digitSurvivors scattered the type/zone candidate set
 * by id noise; 26 passed on her world purely by UUID luck). Room numbers
 * ("101 的空调") carry NO unit and keep their lane.
 *
 * T117 (zhao-16 replay): DURATION-ATTACHED numbers are values on the same
 * principle — 「关 30 分钟」/"off for 30 min" left a bare "30" in the digit
 * lane, and ~1-in-9 random hex device ids contain "30", so the R101
 * disambiguation pin (the meeting-202 unit stays out of the candidate set)
 * flapped on UUID luck exactly the way T104 fixed for degrees.
 */
const DEGREE_VALUE_NUMBER = /\d+(?:\.\d+)?\s*(?:℃|°\s*[cf]?|度|degre(?:e|es)\b|celsius\b|centigrade\b|分钟?|秒|min(?:ute)?s?\b|sec(?:ond)?s?\b|h(?:ou)?rs?\b)/gi;

/** The clause with degree-attached numbers removed (location/digit lanes only). */
function clauseWithoutDegreeValues(clause: string): string {
  return clause.replace(DEGREE_VALUE_NUMBER, ' ');
}

/**
 * Location phrases carried by a clause: the clause segmented on particles,
 * punctuation, DIRECTIVE VERBS and type words, with (a) pure TYPE words (the
 * shared synonym table over the referenced devices' types), (b) segments
 * without any CJK/digit character (English filler "the/of/turn/off" cannot
 * be a zh location), and (c) bare directive verbs dropped. What remains —
 * 「D栋图书馆」, 「图书馆」 — are the place words a type-word match is scoped by.
 *
 * T48 (R5, u1-F2): the split also consumes zh DIRECTIVE VERBS *inside* a
 * run and splits zh TYPE WORDS out of their segments. Without this, the
 * verb-less-的连写 shape glued the ask onto one segment — 「D栋图书馆空调调到」
 * — whose trailing 调到 (and its 空调) no device name or zone name contains,
 * so both the subsequence ranking and the zone resolver missed the very
 * building the question named. Segments are PLACE words: the verbs and the
 * type vocabulary are not place.
 */
const SEGMENT_SPLIT = new RegExp(
  '[\\s，。！？、；：,.!?;:()（）\\[\\]「」『』【】·—…+/\\\\|]+|的|把|将|请|帮我|我|在|都|会怎样|会怎么样|怎么办|如果|假设|假如|要是|什么|怎么|哪些|哪个|多少' +
    '|调到|调至|调成|调整为?|调高|调低|升高|降低|提高|减少|增加|上升|下降|设定|设为|设置|改成|打开|开启|关闭|关掉|停用|启动|停止|断开',
  'i',
);

/** zh type words split OUT of segments (T48): a location segment must not
 * carry the device-type vocabulary — 「图书馆空调」 is place 图书馆 + type 空调. */
function zhTypeWords(typeWords: readonly string[]): string[] {
  return typeWords.filter(word => /[\u4e00-\u9fff]/.test(word) && word.length > 0);
}

export function clauseLocationSegments(clause: string, typeWords: readonly string[]): string[] {
  const typeWordFolds = new Set(typeWords.map(w => foldForMatch(w)).filter(w => w.length > 0));
  const zhWords = zhTypeWords(typeWords).sort((a, b) => b.length - a.length);
  const segments: string[] = [];
  // T104: degree-attached numbers are values, not places — strip before the
  // split so 「调到 24 度」 cannot leave a "24度" place-word segment behind.
  const placeClause = clauseWithoutDegreeValues(clause);
  for (const raw of placeClause.split(SEGMENT_SPLIT)) {
    // T48: strip the zh type vocabulary from within the segment so the
    // place word stands alone (「栋图书馆空调」 → 「栋图书馆」).
    const stripped = zhWords.reduce(
      (acc, word) => acc.split(word).join(' '),
      raw,
    );
    for (const piece of stripped.split(/\s+/)) {
      const folded = foldForMatch(piece);
      if (folded.length === 0) continue;
      if (typeWordFolds.has(folded)) continue; // the type word itself
      // A location phrase carries content: at least one CJK char. A PURE
      // digit run is not a place word — setpoints ("to 26 degrees"), counts
      // and durations ride the question text, and room numbers already have
      // their own lane (the zhao-12 digitTokens match, EXACT containment).
      // T90 (R12, u1-F-1): a pure-digit segment entered the subsequence lane
      // below and matched device-id UUID digit noise ("26" ⊂ ~half of all
      // hex ids), so the EN official example's candidate set lost the real
      // D-building unit while the zh twin (whose segments also carry 「D栋」)
      // kept it — same question shape, different candidates per language.
      if (!/[\u4e00-\u9fff]/.test(folded)) continue;
      if (/^(?:turn|on|off|set|to|for|the|of|and|in|at|is|are|was|were|will|would|what|if|happen|happens)$/.test(raw.toLowerCase())) continue;
      if (segments.includes(folded)) continue;
      segments.push(folded);
    }
  }
  return segments;
}

/** Every zh/EN synonym of the referenced devices' types (segment exclusion). */
function typeWordsOf(candidates: ReadonlyArray<Pick<DeviceReference, 'type'>>): string[] {
  const words = new Set<string>();
  for (const candidate of candidates) {
    for (const synonym of typeSynonymsOf(candidate.type)) words.add(synonym);
  }
  return [...words];
}

const MODE_WORD_MAP: Record<string, string> = {
  cooling: 'cooling', cool: 'cooling',
  heating: 'heating', heat: 'heating',
  auto: 'auto', automatic: 'auto',
  eco: 'eco', turbo: 'turbo', boost: 'boost',
  dry: 'dry', sleep: 'sleep', night: 'night',
  fan: 'fan', track: 'track', tracking: 'track',
};

// ============================================================================
// Clause splitting
// ============================================================================

function splitClauses(text: string): string[] {
  const raw = text
    .replace(/\r/g, '')
    .split(/[\n;]+|(?:^|\s)(?:[-•*·]|\d+[.)])\s+/g)
    .flatMap(part => part.split(/(?<=[.!?])\s+/));
  const clauses: string[] = [];
  for (const part of raw) {
    const trimmed = part.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (trimmed.length === 0) continue;
    if (clauses.length >= MAX_CLAUSES) break;
    clauses.push(trimmed.length > CLAUSE_CAP ? `${trimmed.slice(0, CLAUSE_CAP)}…` : trimmed);
  }
  return clauses;
}

// ============================================================================
// Device matching
// ============================================================================

interface DeviceReference {
  deviceId: string;
  /** How the clause referenced the device (for rejection reasons). */
  via: 'id' | 'name' | 'type';
  name: string;
  type: string;
  /** Device zone when the inventory knows it (R101 location scoping). */
  zoneId?: string;
}

function deviceTypeOf(
  deviceId: string,
  budgetDeviceOf: RecommendationBridgeInput['budgetDeviceOf'],
): { name: string; type: string; zoneId?: string } {
  const device = budgetDeviceOf?.(deviceId);
  if (device !== undefined) {
    return {
      name: device.name,
      type: device.type,
      ...(device.zoneId !== undefined ? { zoneId: device.zoneId } : {}),
    };
  }
  return { name: '', type: '' };
}

function matchDevices(
  clause: string,
  budget: RecommendationBridgeBudget,
  budgetDeviceOf: RecommendationBridgeInput['budgetDeviceOf'],
): { picked: DeviceReference[]; candidates: DeviceReference[] } {
  // R49: CJK-aware folding — 「排涝智能阀 1」 (name, spaced) must match
  // 「排涝智能阀1」 (clause, unspaced); the old plain includes failed and
  // the clause fell through to the generic TYPE word, matching every
  // valve in the city (the R46 wrong-device bug).
  const foldedClause = foldForMatch(clause);
  const lower = clause.toLowerCase();
  const matches: DeviceReference[] = [];
  const nameFoldById = new Map<string, string>();
  for (const deviceId of budget.deviceIds) {
    const { name, type, zoneId } = deviceTypeOf(deviceId, budgetDeviceOf);
    const ref = { name, type, ...(zoneId !== undefined ? { zoneId } : {}) };
    if (deviceId.length > 0 && foldedClause.includes(foldForMatch(deviceId))) {
      matches.push({ deviceId, via: 'id', ...ref });
      continue;
    }
    const foldedName = foldForMatch(name);
    nameFoldById.set(deviceId, foldedName);
    if (foldedName.length > 1 && foldedClause.includes(foldedName)) {
      matches.push({ deviceId, via: 'name', ...ref });
      continue;
    }
    const synonyms = TYPE_SYNONYMS[type] ?? (type.length > 0 ? [type] : []);
    if (synonyms.some(s => typeSynonymHits(lower, s))) {
      matches.push({ deviceId, via: 'type', ...ref });
    }
  }
  // A SPECIFIC reference (id or full name) anywhere in the clause beats the
  // generic type word — "set HVAC B1 to 18 degrees" names b1 and must not
  // also drag in every other hvac-type budget device ("HVAC" alone is the
  // generic reference and keeps the type behavior).
  const specific = matches.filter(m => m.via !== 'type');
  let picked = specific.length > 0 ? specific : matches;

  // R101 (zhao-12) + R1 (u1 replay): a LOCATION mention in the clause scopes
  // generic TYPE matches — the shared scoping (one matcher with the
  // predictor's natural-reference lane, T26) lives in
  // scopeTypeCandidatesByLocation below.
  if (picked.some(m => m.via === 'type')) {
    const scoped = scopeTypeCandidatesByLocation(clause, picked.filter(m => m.via === 'type'));
    if (scoped.length > 0 && scoped.length < picked.length) picked = scoped;
  }

  // R49 disambiguation for name matches: drop prefix-shadowed siblings
  // (阀 1 must not win when the clause names 阀 11).
  if (picked.length > 1 && picked.every(m => m.via === 'name')) {
    const surviving = picked.filter(m => !picked.some(other => other.deviceId !== m.deviceId
      && (nameFoldById.get(other.deviceId) ?? '').startsWith(nameFoldById.get(m.deviceId) ?? '')
      && (nameFoldById.get(other.deviceId) ?? '').length > (nameFoldById.get(m.deviceId) ?? '').length));
    if (surviving.length > 0) picked = surviving;
  }
  // R49 (R98: extended to generic TYPE-word matches): the caller's OWN
  // devices win any multi-candidate tie. 「101 的空调」 matches every AC in
  // the room via the 空调 type word — silently taking the first simulated a
  // colleague's (powered-off) AC and produced a misleading "no effect"
  // verdict (R98 zhao-05). No own match → the full candidate set rides on
  // and the caller surfaces the ambiguity.
  const candidates = picked;
  const scope = budget.scopeDeviceIds;
  if (scope !== undefined && picked.length > 1) {
    const own = picked.filter(m => scope.has(m.deviceId));
    if (own.length > 0 && own.length < picked.length) picked = own;
  }
  return { picked, candidates };
}

/** A type-via candidate the location scoping may filter (structural — the
 *  predictor's device views satisfy it without importing the internal shape). */
export interface LocationScopedCandidate {
  deviceId: string;
  name: string;
  type: string;
  zoneId?: string;
}

/**
 * R101 (zhao-12) + R1 (u1 replay): a LOCATION mention in the clause scopes
 * generic TYPE matches — an AC in another building/room must not candidate
 * for a question that names a place. Three mention shapes are recognized:
 *   - digit runs ≥2 (room numbers 「101」) held in the candidate's folded
 *     name/id/zoneId (zhao-12);
 *   - zone-id tokens (「bldg-d-f1」): the candidate's folded zoneId appears
 *     in the folded clause;
 *   - zh location phrases: the clause segmented on particles, with type
 *     words excluded, matched SUBSEQUENCE-wise against the candidate's
 *     folded name/id/zoneId — 「D栋图书馆」 hits the device name
 *     「D栋（AI与物联网·图书馆） 空调机组」 despite the interleaved
 *     official words (u1 F2: every cross-building what-if collapsed to the
 *     first-listed building's unit).
 * Only TYPE-via candidates are filtered (id/name references are specific).
 * An empty survivor set keeps the FULL candidate list — the ambiguity note
 * still declares everything (never a silent narrowing).
 *
 * T26 (R3): exported so the predictor's natural-reference lane (u1-F3, "the
 * AC unit in building D") scopes with the SAME matcher — one location
 * vocabulary, never a second one.
 */
export function scopeTypeCandidatesByLocation<T extends LocationScopedCandidate>(
  clause: string,
  candidates: ReadonlyArray<T>,
): T[] {
  if (candidates.length === 0) return [];
  const foldedClause = foldForMatch(clause);
  // zhao-12 digit tokens — T104: degree-attached numbers are stripped first
  // (a setpoint is a value, not a room number; its digits used to scatter
  // the candidate set by UUID substring luck).
  const digitTokens = clauseWithoutDegreeValues(clause).match(/\d{2,}/g) ?? [];
  const digitSurvivors = candidates.filter(m =>
    digitTokens.some(token =>
      foldForMatch(m.name).includes(token) ||
      foldForMatch(m.deviceId).includes(token) ||
      (m.zoneId !== undefined && foldForMatch(m.zoneId).includes(token)),
    ),
  );
  // Zone-id tokens: the candidate's own folded zoneId appears in the clause.
  const zoneIdSurvivors = candidates.filter(
    m => m.zoneId !== undefined && foldForMatch(m.zoneId).length >= 3 &&
      foldedClause.includes(foldForMatch(m.zoneId)),
  );
  // zh location phrases (subsequence over segmented particles).
  const segments = clauseLocationSegments(clause, typeWordsOf(candidates));
  const segmentSurvivors = segments.length > 0
    ? candidates.filter(m => {
        const haystacks = [foldForMatch(m.name), foldForMatch(m.deviceId)];
        if (m.zoneId !== undefined) haystacks.push(foldForMatch(m.zoneId));
        return segments.some(seg => haystacks.some(hay => isFoldingSubsequence(seg, hay)));
      })
    : [];
  return digitSurvivors.length > 0 ? digitSurvivors
    : zoneIdSurvivors.length > 0 ? zoneIdSurvivors
    : segmentSurvivors;
}

// ============================================================================
// Command matching + param extraction
// ============================================================================

function commandMatches(clause: string, command: string): { matched: boolean; domain: boolean } {
  const keywords = COMMAND_KEYWORDS[command];
  if (keywords !== undefined) {
    return { matched: keywords.patterns.some(p => p.test(clause)), domain: keywords.domain };
  }
  // Generic fallback: the command's own name words ("set-brightness" →
  // "brightness"). Never domain — the curated table owns domain ranking.
  return { matched: commandLiteral(command).test(clause), domain: false };
}

/** camelCase a command's last segment: 'target-temperature' → targetTemperature. */
function camelCase(command: string): string {
  const words = command.split('-').filter(w => w.length > 0);
  if (words.length === 0) return 'value';
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('')
    .replace(/^(.)/, c => c.toLowerCase());
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

// ============================================================================
// Param safety (R33, Smart F5): delta prose + device-safe ranges
// ============================================================================

/**
 * Device-safe ranges for the numeric params the platform's set-* commands
 * carry. R33 (Smart F5) evidence: the bridge mapped "reduce by 1-2 degrees"
 * onto ABSOLUTE targetTemperature:-1/-2 and the climate handler accepted
 * them — devices were commanded to -1°C in a living world. Policy per value:
 *   - inside [min, max] → passes through untouched;
 *   - NEAR the range → clamps to the boundary (the intent survives — the
 *     clamp is recorded in `clamped`, never silent);
 *   - in the impossible band (a misparse, not an ask — e.g. -1°C absolute,
 *     rate 150) → REJECTED with a teaching reason naming the range and the
 *     relative-change phrasing.
 */
const PARAM_SAFE_RANGES: Record<string, {
  min: number;
  max: number;
  /** Beyond these the number is a misread, not a device ask — reject it. */
  impossibleBelow: number;
  impossibleAbove: number;
  /** Human range label for teaching messages. */
  label: string;
  /** How to phrase a valid absolute, for teaching messages. */
  absoluteHint: string;
}> = {
  targetTemperature: {
    min: 5, max: 40, impossibleBelow: 0, impossibleAbove: 60, label: '5–40°C',
    absoluteHint: 'state an absolute setpoint within range (e.g. "set to 24 degrees") or a relative change ("lower by 2 degrees" offsets the device\'s current setpoint)',
  },
  rate: {
    min: 0, max: 1, impossibleBelow: 0, impossibleAbove: 1.5, label: '0–1',
    absoluteHint: 'state a rate within 0–1 (percent prose like "50%" converts automatically)',
  },
  power: {
    min: 0, max: 100, impossibleBelow: 0, impossibleAbove: 150, label: '0–100%',
    absoluteHint: 'state a power level within 0–100%',
  },
};

/** Delta verbs — "reduce/lower/... by N" is a RELATIVE ask, not an absolute. */
const DELTA_DOWN_VERB = /\b(?:reduc\w*|lower\w*|decreas\w*|drop\w*|cut\w*|cool\w*|colder|cooler)\b/i;
const DELTA_UP_VERB = /\b(?:rais\w*|increas\w*|boost\w*|warm\w*|heat\w*|hotter|warmer)\b/i;

/**
 * Parse a relative temperature change ("reduce ... by 2 degrees"). Requires
 * degree context (a unit OR temperature vocabulary) so "reduce load by 20
 * percent" never becomes a setpoint. `by N` (never `to N`) is the delta cue.
 * R46-P0: the zh shape "温度降低 2 度" is a delta too (direction verb +
 * explicit degree unit — the unit requirement keeps "湿度降低 10" out).
 * T2 (R2, u1-F1): the post-quantity shapes — "2 degrees higher/lower",
 * "2 degrees warmer/cooler", and the "+2" / "-2" degree suffix — are the
 * same relative ask (u1's "set 2 degrees higher" used to parse as an
 * ABSOLUTE 2 and clamp to 5°C).
 */
function temperatureDeltaOf(clause: string): { direction: 'down' | 'up'; amount: number } | undefined {
  const zhDelta = clause.match(/(降低|调低|下降|减少|升高|调高|提高|增加)\s*(-?\d+(?:\.\d+)?)\s*(?:度|℃|°|摄氏度)/);
  if (zhDelta !== null) {
    const down = /降低|调低|下降|减少/.test(zhDelta[1]);
    return { direction: down ? 'down' : 'up', amount: Math.abs(Number(zhDelta[2])) };
  }
  const postQuantity = clause.match(
    new RegExp(String.raw`${NUMBER}\s*(?:°\s*[cf]?|degre(?:e|es)\b|deg\b|celsius|centigrade)?\s*(higher|lower|warmer|cooler|hotter|colder)\b`, 'i'),
  );
  if (postQuantity !== null) {
    return {
      direction: /higher|warmer|hotter/i.test(postQuantity[2]) ? 'up' : 'down',
      amount: Math.abs(Number(postQuantity[1])),
    };
  }
  // The SIGNED degree form ("setpoint +2 degrees", "lower it -2°C") is a
  // delta — but NOT "1-2 degrees" (a range: a digit right before the sign)
  // and NOT "set to -2 degrees" (an absolute: the to/at/=/: markers right
  // before the sign — the impossible-absolute rejection must keep firing).
  const signedDegree = clause.match(
    /(?<![\d])(?<!\bto\s)(?<!\bat\s)(?<!=)(?<!:)([+-])\s*(\d+(?:\.\d+)?)\s*(?:°\s*[cf]?|degre(?:e|es)\b|deg\b|℃|度)/i,
  );
  if (signedDegree !== null) {
    return { direction: signedDegree[1] === '-' ? 'down' : 'up', amount: Number(signedDegree[2]) };
  }
  const match = clause.match(
    new RegExp(String.raw`\bby\s+${NUMBER}(\s*(?:°\s*[cf]?|degre(?:e|es)\b|deg\b|celsius|centigrade))?`, 'i'),
  );
  if (match === null) return undefined;
  const hasDegreeUnit = match[2] !== undefined;
  const hasTempVocab = /temperat|thermostat|setpoint|degre|°|celsius|centigrade|温度|恒温/i.test(clause);
  if (!hasDegreeUnit && !hasTempVocab) return undefined;
  const down = DELTA_DOWN_VERB.test(clause);
  const up = DELTA_UP_VERB.test(clause);
  if (!down && !up) return undefined;
  return { direction: down ? 'down' : 'up', amount: Number(match[1]) };
}

/** The device's current setpoint (the delta base), from the budget inventory. */
function currentSetpointOf(device: DelegateBudgetDevice | undefined): number | undefined {
  const state = device?.state;
  if (state === undefined) return undefined;
  for (const key of ['targetTemperature', 'setpoint', 'temperature']) {
    const value = state[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Extraction outcome: pass-through params, a teaching rejection, or clamps. */
interface ParamOutcome {
  params?: Record<string, unknown>;
  rejectReason?: string;
  clampNotes?: string[];
}

/**
 * Apply the device-safe range policy to one extracted numeric param.
 * `relative` marks delta-resolved values (base ± amount): their intent is
 * known, so they CLAMP to the boundary; absolute values in the impossible
 * band reject — clamping a misread "-1" to 5°C would command heating a
 * building on garbage.
 */
function applyRangePolicy(
  key: string,
  value: number,
  context: { command: string; deviceName: string; clause: string; relative: boolean },
): ParamOutcome {
  const range = PARAM_SAFE_RANGES[key];
  if (range === undefined || !Number.isFinite(value)) {
    return Number.isFinite(value) ? { params: { [key]: value } } : {};
  }
  if (!context.relative && (value < range.impossibleBelow || value > range.impossibleAbove)) {
    return {
      rejectReason:
        `recommendation bridge: "${context.clause}" — ${key} ${value} is outside the ` +
        `device-safe range ${range.label} and cannot be a literal ${key} (likely a relative ` +
        `change or a misparse read as absolute); NOT actuated — ${range.absoluteHint}`,
    };
  }
  if (value < range.min) {
    return {
      params: { [key]: range.min },
      clampNotes: [`${context.deviceName}: ${context.command} ${key} ${value} → ${range.min} (clamped to device-safe ${range.label})`],
    };
  }
  if (value > range.max) {
    return {
      params: { [key]: range.max },
      clampNotes: [`${context.deviceName}: ${context.command} ${key} ${value} → ${range.max} (clamped to device-safe ${range.label})`],
    };
  }
  return { params: { [key]: value } };
}

function extractTemperature(
  clause: string,
  device: DelegateBudgetDevice | undefined,
  deviceName: string,
): ParamOutcome {
  // R33 (Smart F5): delta prose FIRST — "reduce by 1-2 degrees" used to fall
  // through to the absolute patterns and command -1/-2°C. A delta resolves
  // against the device's CURRENT setpoint; a device without one cannot be
  // offset and rejects honestly (never guessed).
  const delta = temperatureDeltaOf(clause);
  if (delta !== undefined) {
    const base = currentSetpointOf(device);
    if (base === undefined) {
      return {
        rejectReason:
          `recommendation bridge: "${clause}" asks for a RELATIVE change ` +
          `(${delta.direction} by ${delta.amount}°) but ${deviceName} exposes no current ` +
          `setpoint (targetTemperature/setpoint/temperature) to offset — state the ABSOLUTE ` +
          `target ("set to 24 degrees") instead`,
      };
    }
    const resolved = delta.direction === 'down' ? base - delta.amount : base + delta.amount;
    return applyRangePolicy('targetTemperature', resolved, {
      command: 'set-temperature', deviceName, clause, relative: true,
    });
  }
  const byContext = clause.match(new RegExp(String.raw`(?:temperat\w*|thermostat|setpoint|温度|恒温)\D{0,24}?${NUMBER}`, 'i'));
  if (byContext !== null) {
    return applyRangePolicy('targetTemperature', Number(byContext[1]), {
      command: 'set-temperature', deviceName, clause, relative: false,
    });
  }
  const byUnit = clause.match(new RegExp(String.raw`${NUMBER}\s*(?:°\s*[cf]?|degre(?:e|es)\b|deg\b|celsius|centigrade|℃|度)`, 'i'));
  if (byUnit !== null) {
    return applyRangePolicy('targetTemperature', Number(byUnit[1]), {
      command: 'set-temperature', deviceName, clause, relative: false,
    });
  }
  const toNumber = clause.match(new RegExp(String.raw`\b(?:to|at|=|:)\s*${NUMBER}\s*(?:°|deg)`, 'i'));
  if (toNumber !== null) {
    return applyRangePolicy('targetTemperature', Number(toNumber[1]), {
      command: 'set-temperature', deviceName, clause, relative: false,
    });
  }
  return {};
}

function extractMode(
  clause: string,
  deviceType: string,
): Record<string, unknown> | undefined {
  const afterMode = clause.match(/\bmod(?:e|es)\w*\s*(?:to|=|:|is|should be)?\s*["']?([A-Za-z-]+)/i);
  const word = afterMode !== null ? afterMode[1] : (clause.match(/\b(cooling|heating|cool|heat|auto|automatic|eco|turbo|boost|dry|sleep|night|fan|track(?:ing)?)\b/i)?.[1]);
  if (word === undefined) return undefined;
  const mapped = MODE_WORD_MAP[word.toLowerCase()] ?? word.toLowerCase();
  // T-607: climate-family devices accept only the closed enum — normalize
  // loose synonyms onto it; non-climate devices take the word verbatim
  // (generic set-* semantics).
  if (CLIMATE_TYPES.has(deviceType.toLowerCase())) {
    const normalized =
      mapped === 'cool' || mapped === 'cooling' ? 'cooling'
      : mapped === 'heat' || mapped === 'heating' ? 'heating'
      : mapped === 'auto' ? 'auto'
      : undefined;
    if (normalized === undefined) return undefined; // not a climate mode — no params
    return { mode: normalized };
  }
  return { mode: mapped };
}

function extractCharging(clause: string, deviceName: string): ParamOutcome {
  const policy = (value: number): ParamOutcome =>
    applyRangePolicy('rate', value, { command: 'set-charging', deviceName, clause, relative: false });
  const byRateWord = clause.match(new RegExp(String.raw`(?:rate|chargingRate)\w*\s*(?:to|=|:)?\s*${NUMBER}`, 'i'));
  if (byRateWord !== null) return policy(Number(byRateWord[1]));
  const byUnit = clause.match(new RegExp(String.raw`${NUMBER}\s*(kw\b|kilowatt|watts?\b|%|percent)`, 'i'));
  if (byUnit !== null) {
    // R33: percent prose is a 0–100 scale — convert BEFORE the range policy
    // ("50%" is rate 0.5, not a rejected 50).
    const value = Number(byUnit[1]);
    return policy(/%|percent/i.test(byUnit[2]) ? value / 100 : value);
  }
  // "pause/stop charging" → rate 0 (the R26 grid-battery acceptance shape).
  if (/\bpaus(?:e|ing)\b|\bstop(?:ping)?\b|\bhalt(?:ing)?\b/i.test(clause)) return { params: { rate: 0 } };
  return {};
}

function extractPower(clause: string, deviceName: string): ParamOutcome {
  const policy = (value: number): ParamOutcome =>
    applyRangePolicy('power', value, { command: 'set-power', deviceName, clause, relative: false });
  const byUnit = clause.match(new RegExp(String.raw`(?:power|wattage)\w*\s*(?:to|=|:)?\s*${NUMBER}\s*(?:kw|kilowatt|watts?\b|w\b)?`, 'i'));
  if (byUnit !== null) return policy(Number(byUnit[1]));
  const bare = clause.match(new RegExp(String.raw`\bto\s*${NUMBER}\s*(?:kw|kilowatt|watts?\b|w\b)`, 'i'));
  if (bare !== null) return policy(Number(bare[1]));
  return {};
}

function extractGeneric(command: string, clause: string): Record<string, unknown> | undefined {
  const segments = command.split('-');
  const isSet = segments[0] === 'set';
  const paramKey = camelCase(segments.slice(1).join('-') || command);
  const toNumber = clause.match(new RegExp(String.raw`\b(?:to|at|=|:)\s*${NUMBER}`, 'i'));
  if (toNumber !== null) return { [paramKey]: Number(toNumber[1]) };
  if (isSet && segments.length > 1) {
    const body = segments.slice(1).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const word = clause.match(new RegExp(`${body}\\s+(?:to|=|:)?\\s*["']?([A-Za-z-]+)`, 'i'));
    if (word !== null) return { [paramKey]: word[1].toLowerCase() };
  }
  return undefined;
}

function extractParams(
  command: string,
  clause: string,
  device: DelegateBudgetDevice | undefined,
): ParamOutcome {
  const deviceName =
    device !== undefined && typeof device.name === 'string' && device.name.length > 0
      ? device.name
      : 'the device';
  switch (command) {
    case 'set-temperature': return extractTemperature(clause, device, deviceName);
    case 'set-mode': {
      const params = extractMode(clause, device?.type ?? '');
      return params !== undefined ? { params } : {};
    }
    case 'set-charging': return extractCharging(clause, deviceName);
    case 'set-power': return extractPower(clause, deviceName);
    case 'turn-on':
    case 'turn-off': return {};
    default: {
      const params = extractGeneric(command, clause);
      return params !== undefined ? { params } : {};
    }
  }
}

// ============================================================================
// The bridge
// ============================================================================

/**
 * Map plain-text recommendation clauses onto budget-constrained actuation
 * proposals. Pure, deterministic, never throws. See the module header for
 * the matching/extraction rules and honesty contracts.
 */
export function bridgeRecommendationsToActuations(
  input: RecommendationBridgeInput,
): RecommendationBridgeResult {
  const proposals: BridgedActuationProposal[] = [];
  const rejected: DelegateRejectedActuation[] = [];
  const clamped: string[] = [];
  const notes: string[] = [];
  let actionVocabularySeen = false;
  const seen = new Set<string>();
  const allowedList = input.budget.allowedCommands.join(', ');

  const addProposal = (deviceId: string, command: string, clause: string): void => {
    const key = `${deviceId}::${command}`;
    if (seen.has(key)) return; // repeated recommendation — one execution
    seen.add(key);
    // R33 (Smart F5): extraction now resolves delta prose against the
    // device's current setpoint and applies the device-safe ranges — a
    // teaching rejection lands in `rejected`, a clamp is recorded in
    // `clamped` (never silent), in-range values pass through untouched.
    const outcome = extractParams(command, clause, input.budgetDeviceOf?.(deviceId));
    if (outcome.rejectReason !== undefined) {
      rejected.push({ deviceId, command, reason: outcome.rejectReason });
      return;
    }
    if (outcome.clampNotes !== undefined) clamped.push(...outcome.clampNotes);
    proposals.push({ deviceId, command, ...(outcome.params !== undefined ? { params: outcome.params } : {}) });
  };

  for (const clause of splitClauses(input.text)) {
    // 1. Which allowed commands does this clause name?
    const hits: Array<{ command: string; domain: boolean }> = [];
    for (const command of input.budget.allowedCommands) {
      const hit = commandMatches(clause, command);
      if (hit.matched) hits.push({ command, domain: hit.domain });
    }
    const directive = DIRECTIVE_VERB.test(clause);
    if (hits.length === 0 && !directive) continue; // narrative — no record
    actionVocabularySeen = actionVocabularySeen || hits.length > 0 || directive;

    // 2. Which budget devices does this clause reference?
    const { picked: devices, candidates } = matchDevices(clause, input.budget, input.budgetDeviceOf);

    if (hits.length === 0) {
      // Action-looking but no allowed command matched.
      rejected.push({
        reason:
          `recommendation bridge: could not map "${clause}" to any allowed command ` +
          `(allowed: ${allowedList}) — name the command or use the actuations array`,
      });
      continue;
    }
    if (devices.length === 0) {
      if (input.budget.deviceIds.length === 1) {
        // Degenerate budget: exactly one device, no ambiguity to resolve.
        const sole = input.budget.deviceIds[0];
        for (const hit of hits) addProposal(sole, hit.command, clause);
        continue;
      }
      rejected.push({
        ...(hits.length === 1 ? { command: hits[0].command } : {}),
        reason:
          `recommendation bridge: no budget device matched "${clause}" ` +
          `(budget devices: ${input.budget.deviceIds.join(', ')}) — name the device`,
      });
      continue;
    }

    // R99 (zhao-07): a generic TYPE-word clause matching several devices is
    // AMBIGUOUS — declare the full candidate list and the choice basis
    // (bound-device win vs first match), never a silent pick. Deliberate
    // multi-target clauses (collective markers 全部/all, or naming several
    // devices by name) are intentional, not noted.
    if (candidates.length > 1 && candidates.some(m => m.via === 'type') &&
        !/全部|所有|一律|\b(?:all|every)\b/i.test(clause)) {
      const label = (ref: DeviceReference): string =>
        (ref.name.length > 0 ? `${ref.name} (${ref.deviceId})` : ref.deviceId) +
        (ref.zoneId !== undefined ? `@${ref.zoneId}` : '');
      notes.push(
        `ambiguous target — the clause matches ${candidates.length} devices ` +
        `(${candidates.map(label).join(', ')}); using ${devices.map(label).join(', ')}` +
        (devices.length < candidates.length
          ? ` — the requester's own bound device wins; name a device explicitly to choose another`
          : ` — first match; name the device explicitly to choose another`),
      );
    }

    // 3. Domain commands outrank generic toggles ("pause battery charging"
    //    is set-charging rate:0, not turn-off) — but a toggle survives when
    //    no domain command matched.
    const domainHits = hits.filter(h => h.domain);
    const chosen = domainHits.length > 0 ? domainHits : hits;

    // 4. One proposal per (device, command); multiple referenced devices
    //    each get the command ("battery and ups off" → two proposals). The
    //    downstream budget loop enforces maxCommands on EXECUTION.
    for (const hit of chosen) {
      for (const device of devices) {
        addProposal(device.deviceId, hit.command, clause);
      }
    }
  }

  return { proposals, rejected, clamped, notes, actionVocabularySeen };
}

// ============================================================================
// Phase 1 (cognitive architecture §14.1): STRUCTURED device actions lane
// ============================================================================

/**
 * One structured device action from a CognitiveDecision's action plan —
 * {deviceId, command, params?} named directly by the model (not recovered
 * from prose). Same shape as BridgedActuationProposal pre-validation.
 */
export interface CognitiveDeviceAction {
  deviceId: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface CognitiveDeviceBridgeInput {
  /** The model's structured deviceActions (already schema-shaped). */
  deviceActions: readonly CognitiveDeviceAction[];
  budget: RecommendationBridgeBudget;
}

/**
 * Validate STRUCTURED device actions through the SAME bridge machinery the
 * text lane uses (Phase 1, task: "device actions ride the recommendation
 * bridge"): exact own-device id membership, allowed-command membership, and
 * the R33 device-safe param ranges. The model naming commands directly gets
 * NO free pass the prose path lacks — an unbound device or unknown command
 * rejects with a teaching reason, an out-of-range numeric clamps (recorded)
 * or rejects (impossible band) exactly like a text recommendation would.
 *
 * Honesty contracts identical to bridgeRecommendationsToActuations: the
 * bridge never widens the budget; maxCommands is enforced downstream by the
 * executor's loop; nothing is silently dropped. Pure, deterministic, never
 * throws.
 */
export function bridgeCognitiveDeviceActions(
  input: CognitiveDeviceBridgeInput,
): RecommendationBridgeResult {
  const proposals: BridgedActuationProposal[] = [];
  const rejected: DelegateRejectedActuation[] = [];
  const clamped: string[] = [];
  const seen = new Set<string>();
  const allowedList = input.budget.allowedCommands.join(', ');

  for (const action of input.deviceActions) {
    if (typeof action !== 'object' || action === null) continue;
    const { deviceId, command, params } = action;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      rejected.push({ reason: 'recommendation bridge (structured): deviceActions entry carries no deviceId — name your OWN device' });
      continue;
    }
    if (typeof command !== 'string' || command.length === 0) {
      rejected.push({ deviceId, reason: 'recommendation bridge (structured): deviceActions entry carries no command' });
      continue;
    }

    // Device matching: EXACT device id only (case-insensitive). Unlike the
    // text lane, a structured action has no ambiguity excuse — the prompt
    // says "deviceId: your-own-device-id", so a wrong/unbound id is a
    // teaching rejection, never a name/type-synonym rescue onto a DIFFERENT
    // device than the model named.
    const resolvedId = input.budget.deviceIds.find(id => id.toLowerCase() === deviceId.toLowerCase());
    if (resolvedId === undefined) {
      rejected.push({
        deviceId,
        reason:
          `recommendation bridge (structured): device "${deviceId}" is not one of your bound devices ` +
          `(yours: ${input.budget.deviceIds.join(', ') || 'none'}) — deviceActions may only name your OWN devices by exact id`,
      });
      continue;
    }

    const normalizedCommand = command.toLowerCase();
    if (!input.budget.allowedCommands.includes(normalizedCommand)) {
      rejected.push({
        deviceId: resolvedId,
        command: normalizedCommand,
        reason:
          `recommendation bridge (structured): command "${normalizedCommand}" is not in the device's allowed command surface ` +
          `(allowed: ${allowedList || 'none'})`,
      });
      continue;
    }

    const key = `${resolvedId}::${normalizedCommand}`;
    if (seen.has(key)) continue; // repeated action — one execution
    seen.add(key);

    // Param safety (R33): known numeric params pass the device-safe ranges;
    // unknown params ride verbatim (generic set-* semantics, same as the
    // text bridge's extractGeneric).
    let outcomeParams: Record<string, unknown> | undefined =
      params !== undefined && typeof params === 'object' && !Array.isArray(params)
        ? { ...params }
        : undefined;
    if (outcomeParams !== undefined) {
      for (const key2 of Object.keys(outcomeParams)) {
        const value = outcomeParams[key2];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const outcome = applyRangePolicy(key2, value, {
          command: normalizedCommand,
          deviceName: resolvedId,
          clause: `deviceActions ${normalizedCommand} ${key2}=${value}`,
          relative: false,
        });
        if (outcome.rejectReason !== undefined) {
          rejected.push({ deviceId: resolvedId, command: normalizedCommand, reason: outcome.rejectReason });
          outcomeParams = undefined;
          break;
        }
        if (outcome.clampNotes !== undefined) clamped.push(...outcome.clampNotes);
        if (outcome.params !== undefined && outcome.params[key2] !== undefined) {
          outcomeParams[key2] = outcome.params[key2];
        }
      }
      if (outcomeParams === undefined) continue; // rejected above
      if (Object.keys(outcomeParams).length === 0) outcomeParams = undefined;
    }

    proposals.push({
      deviceId: resolvedId,
      command: normalizedCommand,
      ...(outcomeParams !== undefined ? { params: outcomeParams } : {}),
    });
  }

  return {
    proposals,
    rejected,
    clamped,
    // Structured actions name their devices directly — no ambiguity to note.
    notes: [],
    // Structured actions are explicit intent — always action vocabulary.
    actionVocabularySeen: input.deviceActions.length > 0,
  };
}
