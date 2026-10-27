import { expect, test } from 'bun:test';
import { targetPath } from '../../server';

test('Gemini conversion owns its API version and preserves the gateway mount prefix', () => {
  for (const path of ['/responses', '/v1/responses', '/v1beta/responses']) {
    for (const prefix of ['', '/gemini']) for (const streaming of [false, true]) {
      expect(targetPath(prefix + path, 'gemini_generate_content', 'org/model', streaming))
        .toBe(prefix + `/v1beta/models/org%2Fmodel:${streaming ? 'streamGenerateContent' : 'generateContent'}`);
    }
  }
  expect(targetPath('/proxy/v1/responses', 'chat_completions', 'm', false)).toBe('/proxy/v1/chat/completions');
  expect(targetPath('/other', 'gemini_generate_content', 'm', false)).toBe('/other');
});
