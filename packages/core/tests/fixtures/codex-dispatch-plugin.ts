import {CodexRouterPlugin} from '../../../../plugins/codex-router/server/index';
export default class extends CodexRouterPlugin {
  async init(context:any){await super.init({...context,services:{consume:()=>({status:()=>({version:1}),model:()=>({provider:'p',model:'m',name:'m',contextWindow:32000,outputLimit:4096,toolCall:true,reasoning:false,inputModalities:['text']})}),rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}});}
}
