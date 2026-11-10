export type Value = null | boolean | number | bigint | string | Uint8Array | Value[] | Dict | Map<string | number | bigint, Value>;
export interface Dict { [key: string]: Value }
export type Packet = [string, ...Value[]];

export function dict(value: Value | undefined): Dict {
  if (value instanceof Map) {
    const result: Dict = Object.create(null);
    for (const [key, item] of value) result[String(key)] = item;
    return result;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) return value;
  throw new Error('Expected a map');
}

/** Literal dotted keys take precedence at every nesting level. */
export function capability(map: Dict, name: string): Value | undefined {
  let value: Value | undefined;
  if (Object.hasOwn(map, name)) value = map[name];
  else {
    const dot = name.indexOf('.');
    if (dot < 0) return undefined;
    const child = map[name.slice(0, dot)];
    if (!child || typeof child !== 'object' || Array.isArray(child) || child instanceof Uint8Array) return undefined;
    return capability(dict(child), name.slice(dot + 1));
  }
  if (value instanceof Map) return value.get('');
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) return value[''];
  return value;
}

export function integer(value: Value | undefined, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected integer in ${min}..${max}`);
  return value;
}
export function text(value: Value | undefined): string {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
}
export function bytes(value: Value | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('Expected binary data');
  return value;
}
export function list(value: Value | undefined): Value[] {
  if (!Array.isArray(value)) throw new Error('Expected a list');
  return value;
}
