import {describe,expect,test} from 'bun:test';
import type {Service} from '@jeffusion/bungee-types';
import {resolveReachableEndpoints,resolveReachableServices} from '../../src/utils/endpoint-resolver';
import {resolveEffectiveRoute} from '../../src/gateway/routing-plugin';

describe('Service reference endpoint ownership', () => {
  const reference=(id:string)=>({id:`ref-${id}`,service_id:id,position:0,weight:100,priority:1,is_disabled:false});
  test('runtime endpoints retain their owner layer',()=>{
    const services:Service[]=[{id:'a',name:'same-name',endpoints:[{id:'free',target:'https://chatgpt.com'}]}];
    expect(resolveEffectiveRoute({routes:[],services},{path:'/api',service_references:[reference('a')]}).endpoints).toEqual([]);
    const direct={id:'paid',target:'https://chatgpt.com'};
    expect(resolveEffectiveRoute({routes:[],services},{path:'/direct',endpoints:[direct]}).endpoints).toEqual([direct]);
  });
  test('compilation visits the DAG by stable ID and counts shared Endpoint entities once',()=>{
    const services:Service[]=[{id:'a',name:'a',endpoints:[],service_references:[reference('shared')]},
      {id:'b',name:'b',endpoints:[],service_references:[reference('shared')]},
      {id:'shared',name:'shared',endpoints:[{id:'shared-endpoint',target:'http://shared'}]}];
    const route={path:'/api',service_references:[reference('a'),reference('b')]};
    expect(resolveReachableServices(route,services).map(service=>service.id)).toEqual(['a','shared','b']);
    expect(resolveReachableEndpoints(route,services).map(endpoint=>endpoint.id)).toEqual(['shared-endpoint']);
  });
});
