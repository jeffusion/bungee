# @jeffusion/bungee-llms

Pure protocol sessions, canonical messages/tools, streaming state machines and token accounting for Bungee.

Gateway plugins consume `llm-protocol-adapter` public services. The adapter executes the codec locally in each worker; generation bodies never go through control RPC. Provider runtime abstractions remain available to other package consumers, but are not a second gateway conversion path.

```ts
import {createProtocolSession, describeProtocolConversion} from '@jeffusion/bungee-llms/plugin-api';
const session = createProtocolSession({sourceProtocol: 'responses', targetProtocol: 'chat_completions', model: 'model'});
const request = session.convertRequest({input: 'Hello'});
// Feed the target JSON response or parsed SSE events into the same session.
session.dispose();
```

The matrix has four passthrough pairs, ten direct conversions and two rejected Responses/Gemini pairs. Explicit reasoning controls require a verified wire policy. Tools, history and output constraints fail with a safe reason and param when their semantics cannot be preserved. See [LLM Protocol Adapter](../../docs/llm-protocol-adapter.md).
