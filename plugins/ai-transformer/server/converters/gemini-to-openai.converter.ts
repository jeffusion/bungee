import type { AIConverter } from './base';
import { GeminiToOpenAIConverter as LLMSGeminiToOpenAIConverter } from '@jeffusion/bungee-llms/plugin-api';

export class GeminiToOpenAIConverter extends LLMSGeminiToOpenAIConverter implements AIConverter {}
