import { describe, expect, test } from 'bun:test';
import { parseNormalizeCompile } from '../../../src/config-storage/compiler';
import { compileRuntimeConfigSnapshot } from '../../../src/config-storage/runtime-config';
import { hashConfigurationContent } from '../../../src/config-storage/content-hash';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = (n: number, target: number, extra = {}) => ({id: id(n), service_id:id(target), ...extra});
const leaf = {id:id(1),name:'leaf',endpoints:[{id:id(11),target:'https://example.com'}]};
const branch = {id:id(2),name:'branch',endpoints:[],service_references:[ref(22,1)]};

describe('service references compiler', () => {
  test('normalizes nested references and preserves stable IDs across a rename in runtime DTOs', () => {
    const parsed = parseNormalizeCompile({services:[leaf,branch],routes:[{id:id(3),path:'/',service_references:[ref(33,2)]}]});
    expect(parsed.ok).toBe(true); if(!parsed.ok) return;
    expect(parsed.value.services[0]!.service_references).toBeUndefined();
    expect(parsed.value.services[1]!.service_references).toEqual([{id:id(22),position:0,service_id:id(1),weight:100,priority:1,is_disabled:false}]);
    const renamed = {...parsed.value,services:parsed.value.services.map(service=>({...service,name:service.id===id(1)?'renamed':service.name}))};
    const dto=compileRuntimeConfigSnapshot({revision:2,content_hash:hashConfigurationContent(renamed),aggregate:{logical_configuration:renamed,plugin_activations:[]}});
    expect(dto.config.services![1]!.service_references![0]!.service_id).toBe(id(1));
    expect(dto.config.routes[0]!.service_references![0]!.service_id).toBe(id(2));
    expect(parsed.value.routes[0]!.endpoints).toBeUndefined();
    expect(dto.config.routes[0]).not.toHaveProperty('service');
  });

  test('uses one position group for endpoints and references and rejects shared collisions', () => {
    const result=parseNormalizeCompile({services:[leaf,{...branch,endpoints:[{id:id(12),target:'https://branch.example',position:0}]}]});
    expect(result.ok).toBe(true);if(result.ok){
      expect(result.value.services[1]!.service_references![0]!.position).toBe(1);
      const dto=compileRuntimeConfigSnapshot({revision:1,content_hash:hashConfigurationContent(result.value),aggregate:{logical_configuration:result.value,plugin_activations:[]}});
      expect(dto.config.services![1]!.endpoints[0]!.position).toBe(0);
      expect(dto.config.services![1]!.service_references![0]!.position).toBe(1);
    }
    expect(parseNormalizeCompile({services:[leaf,{...branch,endpoints:[{id:id(12),target:'https://branch.example',position:0}],service_references:[ref(22,1,{position:0})]}]}).ok).toBe(false);
  });

  test('rejects unknown, duplicate, self, and native cycles without a plugin catalog', () => {
    for(const services of [
      [{...branch,service_references:[ref(22,99)]}],
      [leaf,{...branch,service_references:[ref(22,1),ref(23,1)]}],
      [{...branch,service_references:[ref(22,2)]}],
      [{...branch,service_references:[ref(22,1)]},{...leaf,service_references:[ref(21,2)]}],
    ])expect(parseNormalizeCompile({services}).ok).toBe(false);
    expect(parseNormalizeCompile({services:[branch]}).ok).toBe(false);
  });

  test('rejects route empty references and removed scalar fields while accepting mixed targets', () => {
    for(const target of [{service_references:[]},{service_id:id(1)},{service:'leaf'}]) {
      expect(parseNormalizeCompile({services:[leaf],routes:[{id:id(3),path:'/',...target}]}).ok).toBe(false);
    }
    const mixed=parseNormalizeCompile({services:[leaf],routes:[{id:id(3),path:'/',
      service_references:[ref(33,1)],endpoints:[{id:id(12),target:'https://route.example'}]}]});
    expect(mixed.ok).toBe(true);if(mixed.ok){
      expect(mixed.value.routes[0]!.service_references![0]!.position).toBe(1);
      expect(mixed.value.routes[0]!.endpoints![0]!.position).toBe(0);
    }
    const emptyEndpoints=parseNormalizeCompile({services:[leaf],routes:[{id:id(3),path:'/',
      service_references:[ref(33,1)],endpoints:[]}]});
    expect(emptyEndpoints.ok).toBe(true);
    if(emptyEndpoints.ok)expect(emptyEndpoints.value.routes[0]!.endpoints).toBeUndefined();
    expect(parseNormalizeCompile({services:[leaf],routes:[{id:id(3),path:'/',
      service_references:[ref(33,1,{position:0})],endpoints:[{id:id(12),target:'https://route.example',position:0}]}]}).ok).toBe(false);
  });

  test('validates selection policies and rejects endpoint-health fields on Route failover', () => {
    const route={id:id(3),path:'/',service_references:[ref(33,1)],load_balancing:{policy:'round_robin'},failover:{enabled:true,retry_on:[503],retry_on_response:['busy']}};
    expect(parseNormalizeCompile({services:[leaf],routes:[route]}).ok).toBe(true);
    expect(parseNormalizeCompile({services:[leaf],routes:[{...route,failover:{enabled:true,passive_health:{}}}]}).ok).toBe(false);
    for(const weight of [0,-1,Infinity,'x'])expect(parseNormalizeCompile({services:[leaf, {...branch,service_references:[ref(22,1,{weight})]}]}).ok).toBe(false);
  });

  test('includes gateway_target bindings on services and endpoints in mixed-cycle rejection', () => {
    const catalog={pluginSchemas:new Map([['dispatch',[{name:'target',type:'gateway_target' as const,label:'Target'}]]])};
    const plugin={id:id(44),name:'dispatch',options:{target:{type:'route',id:id(3),protocol:'responses'}}};
    for(const service of [{...leaf,plugins:[plugin]},{...leaf,endpoints:[{...leaf.endpoints[0],plugins:[plugin]}]}]) {
      const result=parseNormalizeCompile({services:[service,branch],routes:[{id:id(3),path:'/',service_references:[ref(33,2)]}]},catalog);
      expect(result.ok).toBe(false);if(!result.ok)expect(result.errors.some(error=>error.message==='Internal dispatch cycle')).toBe(true);
    }
  });
});
