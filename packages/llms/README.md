# @jeffusion/bungee-llms

Independent LLM adapters and protocol conversion package for Bungee.

## Scope

- Provider-agnostic protocol conversion abstractions
- Adapter registry and conversion service
- Provider catalog and runtime container
- OpenAI/Anthropic/Gemini protocol converters (request/response/stream) centralized in `src/protocol-converters`
- Runtime registration helper `registerDefaultProtocolConverters()` for plugin/wrapper layers

## Usage

```ts
import {
  LLMProtocolAdapterRegistry,
  LLMProtocolConversionService,
  LLMSRuntime,
  registerDefaultProtocolConverters
} from '@jeffusion/bungee-llms';

registerDefaultProtocolConverters();
```

### Plugin/Wrapper Stable Facade

For plugin and wrapper layers, prefer the dedicated stable entrypoint to reduce coupling to internal file layout:

```ts
import {
  type AIConverter,
  ProtocolTransformerRegistry,
  registerDefaultProtocolConverters,
  OpenAIProtocolConversion,
  OpenAIMessagesCompatibilityNormalizer
} from '@jeffusion/bungee-llms/plugin-api';
```
