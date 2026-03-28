import type { AIConverter, TransformDirection } from './base';

export class ProtocolTransformerRegistry {
  private static converters = new Map<TransformDirection, new () => AIConverter>();

  static register(from: string, to: string, ConverterClass: new () => AIConverter): void {
    const key: TransformDirection = `${from}-${to}`;
    this.converters.set(key, ConverterClass);
  }

  static get(from: string, to: string): AIConverter {
    const key: TransformDirection = `${from}-${to}`;
    const ConverterClass = this.converters.get(key);

    if (!ConverterClass) {
      const availableConverters = Array.from(this.converters.keys()).join(', ');
      throw new Error(
        `No converter found for "${from}" → "${to}".\n`
        + `Available converters: ${availableConverters || 'none'}`
      );
    }

    return new ConverterClass();
  }

  static has(from: string, to: string): boolean {
    const key: TransformDirection = `${from}-${to}`;
    return this.converters.has(key);
  }

  static getAllDirections(): TransformDirection[] {
    return Array.from(this.converters.keys());
  }

  static clear(): void {
    this.converters.clear();
  }
}
