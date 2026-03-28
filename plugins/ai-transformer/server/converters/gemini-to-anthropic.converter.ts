import type { AIConverter } from './base';
import { GeminiToAnthropicConverter as LLMSGeminiToAnthropicConverter } from '@jeffusion/bungee-llms/plugin-api';

export class GeminiToAnthropicConverter extends LLMSGeminiToAnthropicConverter implements AIConverter {}
