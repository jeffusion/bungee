type RequestServiceManifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly services?: { readonly consumes?: readonly {
    readonly plugin: string; readonly id: string; readonly version: number;
    readonly process: string; readonly kind?: string;
  }[] };
};
/** The caller's trusted route frame may reach only its declared control RPC.
 * Peer/kernel authorization still enforces the exact endpoint binding and lease.
 */
export function requestServiceDeclared(caller:RequestServiceManifest|undefined,target:{provider:string;service:string;major:number}):boolean {
  if(!caller)return false;
  if(target.provider!==caller.name && !Object.hasOwn(caller.dependencies??{},target.provider))return false;
  return caller.services?.consumes?.some(declaration=>declaration.plugin===target.provider&&declaration.id===target.service
    && declaration.version===target.major&&declaration.process==='worker'&&declaration.kind==='rpc')===true;
}
