const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;
function bufferBytes(value: object): number {
  try { return arrayBufferLength.call(value); }
  catch { return sharedArrayBufferLength.call(value); }
}
/** Bound the clone graph without invoking properties supplied by a plugin. */
export function storageMessageBytes(args: readonly unknown[]): number {
  const ancestors = new Set<object>();
  const measure = (value: unknown, depth: number): number => {
    if (depth > 128) throw new TypeError('storage_message_depth');
    if (value === null || value === undefined) return 4;
    if (['string', 'boolean', 'number'].includes(typeof value)) return Buffer.byteLength(JSON.stringify(value));
    if (typeof value !== 'object') throw new TypeError('storage_message_type');
    if (ArrayBuffer.isView(value)) {
      // Structured clone copies the backing buffer, including bytes outside a view.
      let buffer: object;
      try { buffer = typedArrayBuffer.call(value); }
      catch { buffer = dataViewBuffer.call(value); }
      return bufferBytes(buffer) + 4;
    }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      return bufferBytes(value) + 4;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('storage_message_type');
    if (ancestors.has(value)) throw new TypeError('storage_message_cycle');
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = array ? descriptors.length!.value as number : 0;
      // Account for holes without allocating or walking a potentially huge sparse array.
      let bytes = array ? 2 + Math.max(0, length * 5 - 1) : 2;
      let properties = 0;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new TypeError('storage_message_symbol');
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor)) throw new TypeError('storage_message_accessor');
        if (array && key === 'length') continue;
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) throw new TypeError('storage_message_array_property');
        if (descriptor.enumerable) {
          const cost = measure(descriptor.value, depth + 1);
          if (array) bytes += cost - 4;
          else { bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + cost + (properties++ > 0 ? 1 : 0); }
        }
      }
      return bytes;
    } finally { ancestors.delete(value); }
  };
  return measure(args, 0);
}
