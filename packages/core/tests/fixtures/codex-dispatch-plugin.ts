import {CodexRouterPlugin} from '../../../../plugins/codex-router/server/index';
export default class extends CodexRouterPlugin {
  constructor(private readonly fixtureOptions?:any){super(fixtureOptions);}
  async init(context:any){await super.init({...context,services:{consume:()=>({status:()=>({version:1}),model:()=>this.fixtureOptions?.unavailable==='missing'?null:({provider:'p',model:'m',name:'m',contextWindow:this.fixtureOptions?.unavailable==='context'?null:32000,outputLimit:4096,toolCall:true,reasoning:false,inputModalities:this.fixtureOptions?.unavailable==='text'?['audio']:['text']})}),rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}});}
}
