import type { AIConverter } from './base';
import { OpenAIToGeminiConverter as LLMSOpenAIToGeminiConverter } from '@jeffusion/bungee-llms/plugin-api';

export class OpenAIToGeminiConverter extends LLMSOpenAIToGeminiConverter implements AIConverter {}
