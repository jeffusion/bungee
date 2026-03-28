import type { AIConverter } from './base';
import { OpenAIToAnthropicConverter as LLMSOpenAIToAnthropicConverter } from '@jeffusion/bungee-llms/plugin-api';

export class OpenAIToAnthropicConverter extends LLMSOpenAIToAnthropicConverter implements AIConverter {}
