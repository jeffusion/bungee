import {PassThrough, Writable} from 'node:stream';

export interface RecoveryTerminalAnswer {label: string; answer: string; inputEvent?: 'end' | 'close'}

/** Exercise real readline with key sequences; restore the process streams even on failure. */
export async function withRecoveryTerminal<T>(operation: () => Promise<T>, answers: readonly RecoveryTerminalAnswer[] = [], initialRaw = false) {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const input = Object.assign(new PassThrough(), {isTTY: true, isRaw: initialRaw, setRawMode(raw: boolean) { this.isRaw = raw; return this; }});
  let rendered = '', stage = 0;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const output = Object.assign(new Writable({write(chunk, _encoding, callback) {
    const text = String(chunk); rendered += text;
    const next = answers[stage];
    if (next && text.includes(next.label + '：')) {
      stage++;
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (next.inputEvent === 'end') input.end(next.answer);
        else if (next.inputEvent === 'close') input.destroy();
        else input.write(next.answer + '\r');
      }, 0);
      pending.add(timer);
    }
    callback();
  }}), {isTTY: true, columns: 80});
  Object.defineProperty(process, 'stdin', {configurable: true, value: input});
  Object.defineProperty(process, 'stdout', {configurable: true, value: output});
  try {
    const result = await operation();
    if (stage !== answers.length) throw new Error('Recovery did not ask every expected terminal question');
    return {result, output: rendered, inputState: {isRaw: input.isRaw,
      dataListeners: input.listenerCount('data'), endListeners: input.listenerCount('end'), closeListeners: input.listenerCount('close'), keypressListeners: input.listenerCount('keypress')}};
  } finally {
    if (stdin) Object.defineProperty(process, 'stdin', stdin);
    if (stdout) Object.defineProperty(process, 'stdout', stdout);
    for (const timer of pending) clearTimeout(timer);
    input.destroy(); output.end();
  }
}

export function identityRecoveryAnswers(username: string, password: string, reason: string): readonly RecoveryTerminalAnswer[] {
  return [{label: 'Recovery username', answer: username}, {label: 'New password', answer: password},
    {label: 'Confirm password', answer: password}, {label: 'Recovery reason', answer: reason}, {label: 'Disable Turnstile? Type yes to disable; default no', answer: ''}];
}

// Bun 1.4 provides native PTYs. Keep the local shape until the installed bun-types exposes it.
interface RecoveryPty {write(data: string): number; close(): void}

/** A real child TTY; synthetic credentials travel only through terminal input after each prompt. */
export async function runRecoveryInTerminal(args: string[], options: {cwd?: string; env?: Record<string, string | undefined>}, answers: readonly RecoveryTerminalAnswer[], timeoutMs = 20_000): Promise<{code: number; output: string}> {
  let rendered = '', waiting = '', stage = 0;
  const decoder = new TextDecoder();
  const terminalDone = Promise.withResolvers<void>();
  const spawnOptions = {...options, terminal: {
    cols: 100, rows: 30, data(terminal: RecoveryPty, data: Uint8Array) {
      const text = decoder.decode(data, {stream: true}); rendered += text; waiting += text;
      const next = answers[stage];
      if (next && waiting.includes(next.label + '：')) {
        stage++; waiting = ''; terminal.write(next.answer + '\r');
      }
    },
    // PTY stream closure is independent of the child exit code (Linux may report EIO).
    exit() { terminalDone.resolve(); },
  }};
  const child = Bun.spawn(args, spawnOptions);
  // The runtime property is documented by Bun; validate it because older bun-types omits it.
  const terminal = 'terminal' in child ? child.terminal : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code] = await Promise.race([Promise.all([child.exited, terminalDone.promise]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Recovery terminal process timed out')), timeoutMs);
    })]);
    if (code === 0 && stage !== answers.length) throw new Error('Recovery did not ask every expected terminal question');
    return {code, output: rendered};
  } finally {
    clearTimeout(timer);
    try {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([child.exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Recovery terminal process exit after SIGKILL was not confirmed')), 5_000);
        })]);
      }
    } finally {
      clearTimeout(timer);
      if (!terminal || typeof terminal !== 'object' || !('close' in terminal) || typeof terminal.close !== 'function') {
        throw new Error('Bun recovery PTY was not available');
      }
      terminal.close();
    }
  }
}
