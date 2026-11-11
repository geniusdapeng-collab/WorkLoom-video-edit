import { isDeepStrictEqual } from "node:util";

type RecordValue = Record<string, unknown>;
function fail(): never { throw new Error("PRD_FIELD_REPAIR_SCOPE: 原生字段修复的实际写值与本批许可或来源不一致"); }
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : fail();
const same = isDeepStrictEqual;
const camel = (field: string): string => field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const criticalNegative = (value: unknown): value is string =>
  typeof value === "string" && /\bno\s+text\b/iu.test(value) && /\bno\s+watermark\b/iu.test(value);

export interface NativeFieldRepairSynchronizer {
  /** Only the current native parser's successful repaired_fields object is observed. */
  observeNativeFields(value: unknown): void;
  finish(resultValue: unknown): unknown;
}

/**
 * The native batch owns its authored values and action log. Synchronize only
 * proven applied actions, after the native parser and before another consumer
 * can read a stale copy. This factory also snapshots the request before I/O.
 */
export function nativeFieldRepairSynchronizer(
  sourceValue: unknown, requestedFields: unknown, fieldNames: readonly string[],
): NativeFieldRepairSynchronizer {
  const source = record(sourceValue), sourceFields = source.fields === undefined ? {} : record(source.fields);
  const aliases = new Map<string, string>();
  for (const field of fieldNames) {
    if (aliases.has(field) || (aliases.has(camel(field)) && aliases.get(camel(field)) !== field)) fail();
    aliases.set(field, field); aliases.set(camel(field), field);
  }
  if (!Array.isArray(requestedFields) || requestedFields.length === 0) fail();
  const allowed = new Set<string>();
  for (const field of requestedFields) {
    const canonical = typeof field === "string" ? aliases.get(field) : undefined;
    if (!canonical || allowed.has(canonical)) fail();
    allowed.add(canonical);
  }
  const identity = structuredClone({ shotId: source.shotId, shot_id: source.shot_id, duration: source.duration });
  const values = (shot: RecordValue, fields: RecordValue, key: string) => [shot[key], shot[camel(key)], fields[key], fields[camel(key)]];
  const original = new Map(fieldNames.map(key => [key, structuredClone(values(source, sourceFields, key))]));
  let observed: Map<string, unknown> | undefined;
  const observeNativeFields = (value: unknown): void => {
    if (observed) fail();
    const returned = record(value), fields = new Map<string, unknown>();
    for (const [key, body] of Object.entries(returned)) {
      const canonical = aliases.get(key);
      if (!canonical || !allowed.has(canonical)) fail();
      if (fields.has(canonical) && !same(fields.get(canonical), body)) fail();
      fields.set(canonical, structuredClone(body));
    }
    observed = fields;
  };
  const finish = (resultValue: unknown): unknown => {
    const result = record(resultValue);
    if (!Array.isArray(result.actions)) fail();
    const actions = result.actions as unknown[];
    const currentSourceFields = source.fields === undefined ? {} : record(source.fields);
    if (!same(identity, { shotId: source.shotId, shot_id: source.shot_id, duration: source.duration })) fail();
    for (const field of fieldNames) {
      if (!same(original.get(field), values(source, currentSourceFields, field))) fail();
    }
    // A provider or native parse failure never manufactures an accepted value.
    if (result.repaired === null) {
      if (actions.length) fail();
      return resultValue;
    }
    const repaired = record(result.repaired);
    const repairedFields = repaired.fields === undefined ? undefined : record(repaired.fields);
    if (!same(identity, { shotId: repaired.shotId, shot_id: repaired.shot_id, duration: repaired.duration })) fail();
    const applied = new Map<string, unknown>();
    const rejected = new Set<unknown>();
    let restoreNegative = false;
    let priorNegative: string | undefined;
    for (const value of actions) {
      const action = record(value);
      const canonical = typeof action.fieldEn === "string" ? aliases.get(action.fieldEn) : undefined;
      if (action.method !== "llm" || !canonical || !allowed.has(canonical)
        || !observed?.has(canonical)
        || action.after === undefined || action.after === null
        || (typeof action.after === "string" && !action.after.trim())) fail();
      if (applied.has(canonical) && !same(applied.get(canonical), action.after)) fail();
      const priorValues = original.get(canonical)!;
      // Native missing-value reads use ''. Existing aliases can be different,
      // but the before value must actually come from this current batch input.
      if (![...priorValues, ...(priorValues.every(value => !value) ? [""] : []),
        ...(applied.has(canonical) ? [applied.get(canonical)] : [])].some(value => same(value, action.before))) fail();
      if (!values(repaired, repairedFields ?? {}, canonical).some(value => same(value, action.after))) fail();
      if (canonical === "negative") {
        const present = priorValues.filter((value): value is string =>
          typeof value === "string" && Boolean(value.trim()));
        const baseline = present.length > 0 && present.every(value => value === present[0]) ? present[0] : undefined;
        // The frozen silent path already has a verified baseline negative
        // policy. A model may add detail, but cannot replace it with an audio
        // instruction and erase the required text/watermark exclusions.
        if (baseline && criticalNegative(baseline) && !criticalNegative(action.after)) {
          rejected.add(value);
          restoreNegative = true;
          priorNegative = baseline;
          continue;
        }
      }
      applied.set(canonical, action.after);
    }
    if (restoreNegative && priorNegative !== undefined) {
      for (const key of ["negative", camel("negative")]) {
        if (Object.hasOwn(repaired, key)) repaired[key] = priorNegative;
        if (repairedFields && Object.hasOwn(repairedFields, key)) repairedFields[key] = priorNegative;
      }
      result.actions = actions.filter(value => !rejected.has(value));
    }
    for (const field of fieldNames) {
      // The pinned native function clones rather than edits its input. Refuse
      // an asynchronous mutation or an undeclared write before synchronizing.
      if (!applied.has(field) && !same(original.get(field), values(repaired, repairedFields ?? {}, field))) fail();
      if (allowed.has(field) && !applied.has(field)) {
        const present = original.get(field)!.filter(value => value !== undefined);
        // Native equality against one preferred alias is not evidence that the
        // other current copies were accepted. Never invent an applied action.
        if (present.some(value => !same(value, present[0]))) fail();
      }
    }
    if (!applied.size) return resultValue;
    for (const [field, value] of applied) {
      const alternate = camel(field);
      repaired[field] = structuredClone(value);
      if (repairedFields) repairedFields[field] = structuredClone(value);
      if (alternate !== field && Object.hasOwn(repaired, alternate)) repaired[alternate] = structuredClone(value);
      if (repairedFields && alternate !== field && Object.hasOwn(repairedFields, alternate)) repairedFields[alternate] = structuredClone(value);
    }
    return resultValue;
  };
  return { observeNativeFields, finish };
}
