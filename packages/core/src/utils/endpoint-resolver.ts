import type { ServiceReference } from '@jeffusion/bungee-types';
type ReferenceOwner = {readonly service_references?:readonly ServiceReference[]};
type IdentifiedService = ReferenceOwner & {readonly id?:string};

/** Traverse configuration for compilation and budgets, never for request selection. */
export function resolveReachableServices<T extends IdentifiedService>(route:ReferenceOwner, services:readonly T[]=[]):(T & {id:string})[] {
  const byId=new Map(services.map(service=>[service.id,service]));
  const visited=new Set<string>();
  const result:(T & {id:string})[]=[];
  const visit=(references:readonly ServiceReference[]|undefined)=>{
    for(const reference of references ?? []){
      if(reference.is_disabled || visited.has(reference.service_id))continue;
      const service=byId.get(reference.service_id);
      if(!service?.id)throw new Error('service_reference_not_found');
      visited.add(reference.service_id);result.push(service as T & {id:string});visit(service.service_references);
    }
  };
  visit(route.service_references);return result;
}

export function resolveReachableEndpoints<E extends {readonly id?:string;readonly is_disabled?:boolean},S extends IdentifiedService & {readonly endpoints:readonly E[]}>(
  owner:ReferenceOwner & {readonly endpoints?:readonly E[]},services:readonly S[]=[]):E[]{
  const endpoints=[...(owner.endpoints ?? []),...resolveReachableServices(owner,services).flatMap(service=>service.endpoints)];
  return [...new Map(endpoints.filter(endpoint=>!endpoint.is_disabled).map((endpoint,index)=>[endpoint.id ?? `positional:${index}`,endpoint])).values()];
}
