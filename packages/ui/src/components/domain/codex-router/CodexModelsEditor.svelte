<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { getConfigSnapshot } from '$api/config';
  import { api } from '$api/client';
  export let value: any[] = [];
  const dispatch = createEventDispatcher();
  let search = '', models: any[] = [], targets: any[] = [], error = '', page = 1, total = 0;
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout>;
  let generation=0;
  function publish() {value=[...value];dispatch('change',value);}
  async function load() {
    const version=++generation;request?.abort();request=new AbortController();
    try {
      const data:any=await api.get(`/plugins/codex-router/control/catalog?search=${encodeURIComponent(search)}&page=${page}`,{signal:request.signal});
      if(version!==generation) return;
      models=data.models;total=data.total;error='';
    } catch {if(version===generation && !request.signal.aborted) error='目录不可用，请检查 models-dev';}
  }
  function query() {page=1;clearTimeout(timer);timer=setTimeout(load,250);}
  function add(model:any) {value=[...value,{provider:model.provider,model:model.model,target:{type:'route',id:''}}];publish();}
  function targetChanged(index:number, encoded:string) {const [type,id]=encoded.split(':');value[index].target={type,id};publish();}
  onMount(async () => {
    try {const config=(await getConfigSnapshot()).config.logical_configuration;
      targets=[...config.routes.map(route=>({type:'route',id:route.id,label:route.path,protocol:route.llm_protocol})),...config.services.map(service=>({type:'service',id:service.id,label:service.name,protocol:service.llm_protocol}))];
    } catch {error='无法读取目标配置';}
    void load();
  });
  onDestroy(()=>{generation++;request?.abort();clearTimeout(timer);});
</script>
<div class="space-y-3">
  <label class="block text-xs">搜索 models.dev<input aria-label="搜索模型" class="nx-input mt-1 w-full" bind:value={search} on:input={query}/></label>
  {#if error}<p role="alert" class="text-red-300 text-xs">{error}</p>{/if}
  <div class="max-h-48 overflow-auto border border-carbon-600">
    {#each models as model}<button type="button" class="block w-full text-left p-2 text-xs hover:bg-carbon-800" on:click={()=>add(model)}>{model.name} · {model.provider} / {model.model}</button>{/each}
  </div>
  <div class="flex gap-3 text-xs"><button type="button" disabled={page<=1} on:click={()=>{page--;void load();}}>上一页</button><span>{page} / {Math.max(1,Math.ceil(total/50))}</span><button type="button" disabled={page*50>=total} on:click={()=>{page++;void load();}}>下一页</button></div>
  {#each value as model,index}
    <div class="border border-carbon-600 p-3 space-y-2 text-xs">
      <div>{model.provider} / {model.model}</div>
      <label class="block">公开别名（留空使用原始标识）<input class="nx-input w-full" value={model.alias ?? ''} on:input={e=>{const alias=e.currentTarget.value;if(alias) model.alias=alias;else delete model.alias;publish();}}/></label>
      <label class="block">目标<select class="nx-input w-full" value={`${model.target.type}:${model.target.id}`} on:change={e=>targetChanged(index,e.currentTarget.value)}><option value="route:">选择已有路由或服务</option>{#each targets as target}<option value={`${target.type}:${target.id}`}>{target.type} · {target.label} · {target.protocol ?? '尚未声明接收协议'}</option>{/each}</select></label>
      <label class="block">能力修正（JSON，仅填写部署需要限制的能力）<textarea class="nx-input w-full" rows="2" value={JSON.stringify(model.capabilityOverrides ?? {})} on:change={e=>{try {model.capabilityOverrides=JSON.parse(e.currentTarget.value);publish();error='';}catch{error='能力修正需要有效 JSON';}}}></textarea></label>
      <button type="button" on:click={()=>{value=value.filter((_,i)=>i!==index);publish();}}>移除</button>
    </div>
  {/each}
</div>
