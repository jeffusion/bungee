/** Test-only labels: no routing, identity, history, codec, or metering substitution. */
import {appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
export default class CodexRouterProcessProbe {
  static readonly name = 'codex-router-process-probe';
  static readonly version = '1.0.0';
  bodyRequirements() {return {request: 'none' as const};}
  private recordShape(context: any, stage: 'dispatch' | 'outbound'): void {
      if (['org/chat', 'org/anthropic'].includes(context.body?.model) && process.env.BUNGEE_CONFIG_DB_PATH) {
        const body = context.body;
        const shape = {stage, pid: process.pid, requestId: context.requestId, model: body.model, keys: Object.keys(body),
          fieldTypes: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value])),
          controls: Object.fromEntries(['include', 'store', 'stream', 'reasoning', 'text', 'tool_choice', 'parallel_tool_calls', 'background', 'truncation', 'service_tier'].filter(key => key in body).map(key => [key, body[key]])),
          inputShape: Array.isArray(body.input) ? body.input.map((item: any) => ({type: item.type, role: item.role, callId: item.call_id, name: item.name, namespace: item.namespace,
            outputType: typeof item.output, contentTypes: Array.isArray(item.content) ? item.content.map((part: any) => part.type) : typeof item.content})) : typeof body.input,
          toolShape: body.tools?.map((tool: any) => ({type: tool.type, name: tool.name, format: tool.format?.type,
            children: tool.tools?.map((child: any) => ({type: child.type, name: child.name, parameterKeys: Object.keys(child.parameters?.properties ?? {})}))}))};
        appendFileSync(join(dirname(process.env.BUNGEE_CONFIG_DB_PATH), '..', 'cli-input-shapes.jsonl'), `${JSON.stringify(shape)}\n`);
      }
  }
  register(hooks: any): void {
    hooks.onDispatchRequest.tap('codex-router-process-probe', ({context}: any) => {this.recordShape(context, 'dispatch');});
    hooks.onBeforeRequest.tap('codex-router-process-probe', (context: any) => {
      context.headers['x-codex-fixture-pid'] = String(process.pid);
      context.headers['x-codex-fixture-request-id'] = context.requestId;
      this.recordShape(context, 'outbound');
      return context;
    });
  }
}
