import type { AdmissionTarget } from '../plugin-extensions';

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
/** Anonymous request RPCs use only protections confirmed by ingress publication. */
export class RequestRouteProtections {
  private publication = 0;
  private protectedRoutes: ReadonlySet<string> | null = null;

  beginPublication(): number {
    this.protectedRoutes = null;
    return ++this.publication;
  }

  confirmPublication(publication: number, requirements: readonly {readonly routeIds: readonly string[]}[]): void {
    // A queued publication or ingress boot change invalidates an older ACK.
    if (publication < 1 || publication !== this.publication) return;
    this.protectedRoutes = new Set(requirements.flatMap(requirement => [...requirement.routeIds]));
  }

  allowsAnonymous(target: Pick<AdmissionTarget, 'principal' | 'routeId' | 'entryRouteId'>): boolean {
    const {principal, routeId, entryRouteId} = target;
    return principal.domain === 'anonymous' && principal.keyId === '' && principal.credentialVersion === 0
      && this.protectedRoutes !== null && !this.protectedRoutes.has(routeId)
      && (entryRouteId === undefined || !this.protectedRoutes.has(entryRouteId));
  }
}
