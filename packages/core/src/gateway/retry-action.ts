/** Declarative repair request; the host owns the next upstream attempt. */
const retryActionBrand=Symbol.for('@jeffusion/bungee/request-retry-action');
export class RequestRetryAction extends Error {
  readonly body:unknown;
  constructor(body: unknown, readonly reason: string) {
    super('gateway request repair retry');
    this.name = 'RequestRetryAction';
    Object.defineProperty(this,retryActionBrand,{value:true});
    Object.defineProperty(this,'body',{value:body,enumerable:false});
  }
  /** Plugins and host may bundle the SDK independently in the same process. */
  static [Symbol.hasInstance](value:unknown):boolean {
    return value instanceof Error && (value as unknown as Record<symbol,unknown>)[retryActionBrand]===true;
  }
}
