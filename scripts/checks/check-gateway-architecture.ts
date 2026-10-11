import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';

export interface ArchitectureFinding { file: string; line: number; rule: string }
const core = 'packages/core/src/';
// Auxiliary network operations are separate from the proxied HTTP body lifecycle.
const auxiliary = new Set([
  'plugins/chatgpt-oauth/server/oauth.ts', // bounded OAuth token/device exchange
  'plugins/chatgpt-oauth/server/usage.ts', // account usage API
  'plugins/chatgpt-oauth/server/codex-models.ts', // model catalog fetch
  'plugins/models-dev/server/download.ts', // catalog download
  'plugins/models-dev/server/local.ts', // local catalog file
]);
const centralized = new Set([core+'gateway/body-service.ts', core+'gateway/body-events.ts']);
// Exact reader variables within named transport owners; new readers elsewhere still fail.
const transport: Record<string, Record<string, string[]>> = {
  [core+'gateway/forward-plugin.ts']: {trackResponseWire:['wireReader'],drainRetryObservation:['reader']},
  [core+'gateway/request-plugin.ts']: {finalizeStreamingResponse:['reader'],finalizeRootStreamingResponse:['reader']},
  [core+'gateway/response-plugin.ts']: {completionStream:['reader']},
  [core+'gateway/controlled-views.ts']: {readControlledBody:['reader'],controlledBodyHandle:['reader']},
  [core+'gateway/body-observation-stream.ts']: {observeBodyStream:['input','observed'],observeTransportResponse:['reader']},
  [core+'gateway/sse-response.ts']: {sharedSSEResponse:['reader']},
  [core+'worker/request/response-detector.ts']: {checkResponseForFailover:['reader']},
  [core+'worker/response/attempt-observation.ts']: {drain:['r'],createAttemptResponseObserver:['outputReader']},
};
function names(node: ts.Node): string[] {
  const result:string[]=[];
  for(let n:ts.Node|undefined=node;n;n=n.parent) {
    if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isVariableDeclaration(n)||ts.isPropertyAssignment(n))&&n.name) result.push(n.name.getText());
  }
  return result;
}
function member(node: ts.Node): string|undefined {
  if(ts.isPropertyAccessExpression(node))return node.name.text;
  if(ts.isElementAccessExpression(node)&&node.argumentExpression&&ts.isStringLiteral(node.argumentExpression))return node.argumentExpression.text;
}
function receiver(node: ts.Expression): ts.Expression|undefined {
  return ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)?node.expression:undefined;
}
function modules(node: ts.Node): string[] {
  if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))return [node.argument.literal.text];
  if(ts.isExternalModuleReference(node)&&node.expression&&ts.isStringLiteral(node.expression))return [node.expression.text];
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))return [node.moduleSpecifier.text];
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText()==='require')&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))return [node.arguments[0].text];
  return [];
}
const gatewayStages:Record<string,string>={
  'websocket-plugin.ts':'onGatewayWebSocket','request-plugin.ts':'onGatewayRequest','forward-plugin.ts':'onGatewayForward','routing-plugin.ts':'onGatewayRoute',
  'admission-plugin.ts':'onGatewayAdmission','selection-plugin.ts':'onGatewaySelect','retry-plugin.ts':'onGatewayRetry',
  'request-rules-plugin.ts':'onGatewayBodyRules','response-plugin.ts':'onGatewayResponseRules','logging-plugin.ts':'onGatewayLog',
};
const gatewayImplementations=new Set(['executeHttpRequest','executeForward','executeResponseRules','executeBodyRules','executeQueryRules','applyHeaderRules']);
/** Validate call edges rather than the presence of architecture-related words. */
export function checkGatewayAssemblySource(file:string, source:string):ArchitectureFinding[] {
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const calls:ts.CallExpression[]=[];const constructions:string[]=[];
  const walk=(n:ts.Node)=>{if(ts.isCallExpression(n))calls.push(n);if(ts.isNewExpression(n))constructions.push(n.expression.getText());ts.forEachChild(n,walk);};walk(tree);
  const required:Record<string,()=>boolean>={
    [core+'gateway/body-plugin.ts']:()=>calls.some(n=>n.expression.getText()==='hooks.onGatewayBody.tap'&&names(n).includes('register')&&n.arguments.some(a=>{let found=false;const check=(x:ts.Node)=>{if(ts.isNewExpression(x)&&x.expression.getText()==='BodySource')found=true;ts.forEachChild(x,check);};check(a);return found;})),
    [core+'gateway/body-factory.ts']:()=>calls.some(n=>n.expression.getText()==='gatewayHooks().onGatewayBody.call'),
    [core+'gateway/runtime.ts']:()=>constructions.includes('BodyServicePlugin')&&calls.some(n=>n.expression.getText()==='plugin.register')&&calls.some(n=>n.expression.getText()==='validateGatewayProviders'),
  };
  const stage=gatewayStages[file.slice(file.lastIndexOf('/')+1)];
  const registered=!stage||calls.some(n=>names(n).includes('register')&&['tap','tapPromise'].includes(member(n.expression)??'')&&n.expression.getText().includes('.'+stage+'.'));
  return (required[file]&&!required[file]!())||!registered?[{file,line:1,rule:'registered-gateway-provider'}]:[];
}
/** AST policy: inspect source syntax, never strings/comments or JSON business fields. */
export function checkArchitectureSource(file:string, source:string, root=process.cwd()):ArchitectureFinding[] {
  file=file.replaceAll('\\','/');
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const findings:ArchitectureFinding[]=[];
  const pluginSource=file.startsWith('plugins/');
  const plugin=pluginSource&&file.includes('/server/');
  const http=plugin||file.startsWith(core+'gateway/')||file.startsWith(core+'worker/request/')||file.startsWith(core+'worker/response/')||file===core+'logger/body-capture.ts';
  const management=plugin&&file.endsWith('/server/control.ts');
  const add=(node:ts.Node,rule:string)=>findings.push({file,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1,rule});
  const declarations=new Map<string,ts.VariableDeclaration|ts.ParameterDeclaration>();
  const bindings=(n:ts.Node)=>{if((ts.isVariableDeclaration(n)||ts.isParameter(n))&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);ts.forEachChild(n,bindings);};bindings(tree);
  const bodyView=(n:ts.Expression,seen=new Set<string>()):boolean=>{
    if(ts.isNonNullExpression(n)||ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isTypeAssertionExpression(n))return bodyView(n.expression,seen);
    if(ts.isPropertyAccessExpression(n))return ['bodyHandle','bodySource'].includes(n.name.text);

    if(ts.isCallExpression(n))return n.expression.getText()==='createBodySource'||member(n.expression)==='handle';
    if(ts.isBinaryExpression(n))return bodyView(n.left,seen)||bodyView(n.right,seen);
    if(ts.isIdentifier(n)&&!seen.has(n.text)){
      seen.add(n.text);const declaration=declarations.get(n.text);
      if(declaration?.type&&/\b(BodyHandle|BodySource)\b/.test(declaration.type.getText()))return true;
      if(declaration&&ts.isParameter(declaration)&&n.text==='bodyHandle'&&declaration.type&&ts.isTypeLiteralNode(declaration.type)&&declaration.type.members.every(m=>m.name&&['json','decoded','bytes','events'].includes(m.name.getText())))return true;
      if(declaration?.initializer)return bodyView(declaration.initializer,seen);
    }
    return false;
  };
  const websocketMessageView=(node:ts.Expression,seen=new Set<string>()):boolean=>{
    if(ts.isIdentifier(node)&&!seen.has(node.text)) {
      seen.add(node.text);const declaration=declarations.get(node.text);
      if(declaration?.type?.getText()==='WebSocketMessageView')return true;
      if(declaration?.initializer)return websocketMessageView(declaration.initializer,seen);
    }
    if(!ts.isPropertyAccessExpression(node)||node.name.text!=='message'||!ts.isIdentifier(node.expression))return false;
    const declaration=declarations.get(node.expression.text);
    if(declaration?.type?.getText()==='WebSocketObservationEvent')return true;
    if(declaration&&ts.isParameter(declaration)) {
      const callback=declaration.parent;
      const call=callback.parent;
      return (ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))&&ts.isCallExpression(call)
        && ts.isPropertyAccessExpression(call.expression)&&['tap','tapPromise','tapAsync'].includes(call.expression.name.text)
        && ts.isPropertyAccessExpression(call.expression.expression)&&call.expression.expression.name.text==='onWebSocketObservation';
    }
    return false;
  };
  const httpBodyValue=(n:ts.Expression,seen=new Set<string>()):boolean=>{
    if(ts.isNonNullExpression(n)||ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isTypeAssertionExpression(n))return httpBodyValue(n.expression,seen);
    if(ts.isPropertyAccessExpression(n))return n.name.text==='body';
    if(ts.isElementAccessExpression(n)&&ts.isStringLiteral(n.argumentExpression))return n.argumentExpression.text==='body';
    if(ts.isCallExpression(n)&&member(n.expression)==='values') {
      const owner=receiver(n.expression);return !!owner&&httpBodyValue(owner,seen);
    }
    if(ts.isIdentifier(n)&&!seen.has(n.text)){
      seen.add(n.text);const binding=declarations.get(n.text);
      return !!binding?.initializer&&httpBodyValue(binding.initializer,seen);
    }
    return false;
  };
  const importedBodyConstructors=new Set(['BodySource']);
  const importedBodyParsers=new Set(['BodySSEFramer','BodyEventSession']);
  function visit(node:ts.Node):void {
    for(const specifier of modules(node)) {
      if(pluginSource) {
        const resolved=specifier.startsWith('.')?relative(root,resolve(root,dirname(file),specifier)).replaceAll('\\','/'):specifier;
        if((specifier==='@jeffusion/bungee-core'||specifier.startsWith('@jeffusion/bungee-core/')||resolved.startsWith('packages/core/'))&&specifier!=='@jeffusion/bungee-core/plugin')add(node,'plugin-public-entry');
      }
      if(http&&!centralized.has(file)&&!management&&!auxiliary.has(file)&&(specifier==='node:zlib'||specifier==='zlib'||specifier.includes('body-decoder')))add(node,'central-body-decoder');
      if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)) {
        for(const binding of node.importClause.namedBindings.elements) {
          const original=binding.propertyName?.text??binding.name.text;
          if(file.startsWith(core)&&gatewayImplementations.has(original)&&!node.importClause.isTypeOnly&&!binding.isTypeOnly)add(binding,'gateway-provider-bypass');
          if(original==='BodySource')importedBodyConstructors.add(binding.name.text);
          if(['BodySSEFramer','BodyEventSession'].includes(original))importedBodyParsers.add(binding.name.text);
          if(http&&!centralized.has(file)&&original==='decodeStream')add(binding,'central-body-decoder');
        }
      }
    }
    if(file.startsWith(core)&&ts.isNewExpression(node)) {
      const ctor=node.expression.getText();
      if((importedBodyConstructors.has(ctor)||member(node.expression)==='BodySource')&&file!==core+'gateway/body-plugin.ts')add(node,'body-provider-construction');
    }
    if(file.startsWith(core)&&ts.isExportDeclaration(node)&&!node.isTypeOnly) {
      if(node.exportClause&&ts.isNamedExports(node.exportClause)) {
        for(const binding of node.exportClause.elements)if(!binding.isTypeOnly&&gatewayImplementations.has(binding.propertyName?.text??binding.name.text))add(binding,'gateway-provider-bypass');
      }else if(node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&
        /(?:^|\/)(?:request-plugin|forward-plugin|response-plugin|request-rules-plugin)(?:\.[cm]?[jt]s)?$/.test(node.moduleSpecifier.text))add(node,'gateway-provider-bypass');
    }
    if(http&&!centralized.has(file)&&ts.isNewExpression(node) &&
      (importedBodyParsers.has(node.expression.getText()) || ['BodySSEFramer','BodyEventSession'].includes(member(node.expression)??'')))add(node,'central-body-event-parser');
    const exempt=centralized.has(file)||management||auxiliary.has(file);
    if(file.startsWith(core)&&ts.isPropertyAccessExpression(node)&&gatewayImplementations.has(node.name.text))add(node,'gateway-provider-bypass');
    if(file.startsWith(core)&&ts.isElementAccessExpression(node)&&ts.isStringLiteral(node.argumentExpression)&&gatewayImplementations.has(node.argumentExpression.text))add(node,'gateway-provider-bypass');
    if(http&&!exempt&&ts.isForOfStatement(node)&&node.awaitModifier&&httpBodyValue(node.expression))add(node,'native-http-reader');
    if(http&&!exempt&&ts.isCallExpression(node)) {
      const method=member(node.expression);const owner=receiver(node.expression);
      if(['pipeTo','pipeThrough','values'].includes(method??'')&&owner&&httpBodyValue(owner))add(node,'native-http-reader');
      if(node.expression.getText()==='JSON.parse'&&node.arguments[0]&&httpBodyValue(node.arguments[0]))add(node,'central-http-json-parser');
      if(method==='getReader') {
        const chain=names(node);const variable=chain[0];
        if(!Object.entries(transport[file]??{}).some(([scope,vars])=>chain.includes(scope)&&vars.includes(variable!)))add(node,'native-http-reader');
      }
      if(method==='clone'||method==='tee')add(node,'native-http-fork');
      if(['json','text','arrayBuffer','bytes','blob','formData'].includes(method??'')&&owner) {
        const expr=owner.getText();
        // Public BodyHandle/owned source methods and Response.json output assembly are distinct.
        const websocketView = method==='json' && websocketMessageView(owner);
        const allowed=expr==='Response'||bodyView(owner)||websocketView;
        if(!allowed)add(node,'native-http-body-read');
      }
      if(node.expression.getText()==='decodeStream')add(node,'central-body-decoder');
    }
    if(http&&!exempt&&ts.isNewExpression(node)&&node.expression.getText()==='TextDecoder') {
      // Presentation and keyword prefix text are UTF-8 views, never codecs/JSON parsers.
      const textView=file===core+'logger/body-capture.ts'||file===core+'worker/request/response-detector.ts'||file===core+'worker/response/sse-terminal-outcome.ts';
      if(!textView)add(node,'central-body-text-parser');
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);
  return findings;
}
async function filesAt(path:string):Promise<string[]> {
  const entries=await readdir(path,{withFileTypes:true});const lists=await Promise.all(entries.filter(e=>!['node_modules','dist','tests','.git'].includes(e.name)).map(e=>e.isDirectory()?filesAt(resolve(path,e.name)):Promise.resolve(/\.(?:ts|tsx|js|mjs)$/.test(e.name)&&!e.name.endsWith('.test.ts')?[resolve(path,e.name)]:[])));
  return lists.flat();
}
export async function checkGatewayArchitecture(root=process.cwd()):Promise<ArchitectureFinding[]> {
  const paths=(await Promise.all(['packages/core/src','plugins'].map(path=>filesAt(resolve(root,path))))).flat();
  const findings=(await Promise.all(paths.map(async path=>checkArchitectureSource(relative(root,path),await readFile(path,'utf8'),root)))).flat();
  for(const file of [core+'gateway/runtime.ts',core+'gateway/body-plugin.ts',core+'gateway/body-factory.ts',...Object.keys(gatewayStages).map(name=>core+'gateway/'+name)])
    findings.push(...checkGatewayAssemblySource(file,await readFile(resolve(root,file),'utf8')));
  return findings;
}
if(import.meta.main) {
  const findings=await checkGatewayArchitecture();
  for(const finding of findings)console.error(`${finding.file}:${finding.line} ${finding.rule}`);
  if(findings.length)process.exitCode=1;
  else console.log('Gateway architecture checks passed');
}
