import {createInterface} from 'node:readline/promises';
import {PassThrough, Writable} from 'node:stream';
import type {OfflineRecoveryPrompt} from '../plugin-control/contracts';

type RecoveryPrompts = readonly OfflineRecoveryPrompt[];
export type RecoveryQuestion = (label: string, secret: boolean) => Promise<string>;

export function requireRecoveryTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('recovery_requires_terminal');
}

/** Plugins own field semantics; the host only validates the bounded prompt protocol. */
export async function collectRecoveryAnswers(prompts: RecoveryPrompts, ask: RecoveryQuestion): Promise<Record<string, string>> {
  if (!Array.isArray(prompts) || prompts.length > 64) throw new Error('invalid_recovery_prompts');
  const names = new Set<string>();
  for (const prompt of prompts) {
    if (!prompt || typeof prompt.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(prompt.name)
      || ['__proto__', 'constructor', 'prototype'].includes(prompt.name) || names.has(prompt.name)
      || typeof prompt.label !== 'string' || !prompt.label || typeof prompt.secret !== 'boolean') throw new Error('invalid_recovery_prompts');
    names.add(prompt.name);
  }
  const answers: Record<string, string> = {};
  for (const prompt of prompts) {
    const answer = await ask(prompt.label, prompt.secret);
    if (typeof answer !== 'string') throw new Error('invalid_recovery_input');
    answers[prompt.name] = answer;
    if (Buffer.byteLength(JSON.stringify(answers)) > 8192) throw new Error('recovery_input_too_large');
  }
  return answers;
}

/** Secret input is never echoed; all interaction stays on the owning terminal. */
export async function readRecoveryAnswers(prompts: RecoveryPrompts): Promise<Record<string, string>> {
  requireRecoveryTerminal();
  const input = process.stdin;
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  let bytes = 0, overflow = false;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const boundInput = (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8192) { overflow = true; abort.abort(); }
  };
  input.on('data', boundInput);
  input.on('end', cancel);
  input.on('close', cancel);
  try {
    return await collectRecoveryAnswers(prompts, async (label, secret) => {
      if (abort.signal.aborted || input.readableEnded || input.destroyed) throw new Error(overflow ? 'recovery_input_too_large' : 'recovery_cancelled');
      // History and the kill/yank buffer belong to one question, never to a later public prompt.
      // The disposable input also owns readline's keypress decoder and its listeners.
      const questionInput = new PassThrough();
      const output = new Writable({write(chunk, _encoding, callback) { if (!secret) process.stdout.write(chunk); callback(); }});
      const rl = createInterface({input: questionInput, output, terminal: true, historySize: 0});
      const forward = (chunk: Buffer | string) => { questionInput.write(chunk); };
      rl.on('SIGINT', cancel);
      rl.on('close', cancel);
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(true);
        input.on('data', forward);
        process.stdout.write(label + '：');
        return await rl.question('', {signal: abort.signal});
      }
      catch { throw new Error(overflow ? 'recovery_input_too_large' : 'recovery_cancelled'); }
      finally {
        // Closing an answered question is normal; EOF/SIGINT still cancel the whole interaction.
        input.off('data', forward);
        rl.off('SIGINT', cancel); rl.off('close', cancel);
        rl.close(); questionInput.destroy(); output.end();
        if (secret) process.stdout.write('\n');
      }
    });
  } finally {
    input.off('data', boundInput); input.off('end', cancel); input.off('close', cancel);
    if (!input.destroyed && typeof input.setRawMode === 'function' && input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    if (!input.destroyed) { if (wasFlowing) input.resume(); else input.pause(); }
  }
}
