import type { Gauge } from '@shared/model/schema'

/**
 * One operation of an `apply` batch. Bodies, wires and cables are named by
 * designator / cable name and end references (`refs.ts`), never by id.
 */
export type Op =
  | { op: 'place'; kind: 'connector' | 'terminal' | 'splice'; partNumber: string; designator?: string; landsOn?: string }
  | { op: 'wire'; from: string; to: string; partNumber: string; color: string; gauge?: Gauge }
  | {
      op: 'cable'
      partNumber: string
      name: string
      cores: { core: string; from: string; to: string }[]
      drain?: { end: 'a' | 'b'; to: string }
    }
  | { op: 'cavity'; at: string; status: 'empty' | 'plugged' | 'populated'; plugPartNumber?: string }
  | { op: 'set-wire'; from: string; to: string; color?: string; partNumber?: string }
  | { op: 'unwire'; from: string; to: string }
  | { op: 'remove'; ref: string }

export type OpName = Op['op']

type Rec = Record<string, unknown>
export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Field spec: required / optional, and a validator returning an error or null. */
export type Check = (v: unknown) => string | null
/** A field: required or optional, and its check. */
export type FieldSpec = [required: boolean, Check]
export const str: Check = (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'must be a non-empty string')
export const oneOf =
  (...xs: string[]): Check =>
  (v) =>
    typeof v === 'string' && xs.includes(v) ? null : `must be one of ${xs.map((x) => `'${x}'`).join(', ')}`
const gauge: Check = (v) =>
  isRec(v) && typeof v.value === 'number' && Number.isFinite(v.value) && v.value > 0 && (v.unit === 'mm2' || v.unit === 'AWG') &&
  Object.keys(v).every((k) => k === 'value' || k === 'unit')
    ? null
    : "must be { value: <number>, unit: 'mm2' | 'AWG' }"
export const obj =
  (fields: Record<string, FieldSpec>): Check =>
  (v) => {
    if (!isRec(v)) return 'must be an object'
    return checkFields(v, fields)
  }
const cores: Check = (v) => {
  if (!Array.isArray(v) || v.length === 0) return 'must be a non-empty array'
  const each = obj({ core: [true, str], from: [true, str], to: [true, str] })
  for (let i = 0; i < v.length; i++) {
    const e = each(v[i])
    if (e) return `[${i}] ${e}`
  }
  return null
}

function checkFields(v: Rec, fields: Record<string, FieldSpec>): string | null {
  for (const k of Object.keys(v)) if (!(k in fields)) return `unknown field '${k}'`
  for (const [k, [required, check]] of Object.entries(fields)) {
    if (v[k] === undefined) {
      if (required) return `missing '${k}'`
      continue
    }
    const e = check(v[k])
    if (e) return `'${k}' ${e}`
  }
  return null
}

/** The grammar's field table — also what the app's MCP `apply_ops` JSON Schema is checked against. */
export const SPECS: Record<OpName, Record<string, FieldSpec>> = {
  place: {
    kind: [true, oneOf('connector', 'terminal', 'splice')],
    partNumber: [true, str],
    designator: [false, str],
    landsOn: [false, str]
  },
  wire: { from: [true, str], to: [true, str], partNumber: [true, str], color: [true, str], gauge: [false, gauge] },
  cable: {
    partNumber: [true, str],
    name: [true, str],
    cores: [true, cores],
    drain: [false, obj({ end: [true, oneOf('a', 'b')], to: [true, str] })]
  },
  cavity: { at: [true, str], status: [true, oneOf('empty', 'plugged', 'populated')], plugPartNumber: [false, str] },
  'set-wire': { from: [true, str], to: [true, str], color: [false, str], partNumber: [false, str] },
  unwire: { from: [true, str], to: [true, str] },
  remove: { ref: [true, str] }
}

/** Shape-check a JSON batch (an array of ops). Semantics are `applyOps`'s job. */
export function parseOps(json: unknown): Op[] | { error: string } {
  return parseBatch<Op>(json, SPECS)
}

/**
 * Shape-check an array of `{ op, ...fields }` against a field table: unknown op names and
 * unknown fields are refused, and the first problem is reported as `op #N (name): …`. Shared
 * with the app's MCP layout grammar so both read the same way.
 */
export function parseBatch<T>(json: unknown, specs: Record<string, Record<string, FieldSpec>>): T[] | { error: string } {
  if (!Array.isArray(json)) return { error: 'the batch must be a JSON array of operations' }
  const out: T[] = []
  for (let i = 0; i < json.length; i++) {
    const raw = json[i]
    const at = `op #${i + 1}`
    if (!isRec(raw)) return { error: `${at}: must be an object` }
    const name = raw.op
    if (typeof name !== 'string' || !(name in specs))
      return { error: `${at}: 'op' must be one of ${Object.keys(specs).join(', ')}` }
    const { op: _op, ...rest } = raw
    const e = checkFields(rest, specs[name])
    if (e) return { error: `${at} (${name}): ${e}` }
    out.push(raw as unknown as T)
  }
  return out
}
