import { createParser } from 'eventsource-parser';
import type { AttemptObservationEvent } from '../../hooks/plugin-hooks';
import { logger } from '../../logger';

const MAX_JSON_OBSERVATION_BYTES = 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;

export interface AttemptResponseObservationContext {
  readonly requestId: string;
  readonly routeId: string;
  readonly attemptId: string;
  readonly upstreamId: string;
  readonly status: number;
}

export function createAttemptResponseObserver(
  protocol: 'json' | 'sse',
  context: AttemptResponseObservationContext,
  dispatch: (event: AttemptObservationEvent) => Promise<void>,
  onComplete: () => void = () => undefined,
): TransformStream<Uint8Array, Uint8Array> {
  const incompleteReasons = new Set<'buffer-limit' | 'frame-limit' | 'frame-truncated'>();
  const notifyIncomplete = async (reason: 'buffer-limit' | 'frame-limit' | 'frame-truncated'): Promise<void> => {
    if (incompleteReasons.has(reason)) return;
    incompleteReasons.add(reason);
    try {
      await dispatch(Object.freeze({
        requestId: context.requestId,
        routeId: context.routeId,
        attemptId: context.attemptId,
        upstreamId: context.upstreamId,
        phase: 'incomplete',
        reason,
        isActive: () => true,
      }));
    } catch (error) {
      logger.warn({ error, requestId: context.requestId, reason }, 'Failed to report incomplete attempt observation');
    }
  };

  if (protocol === 'json') {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let skipped = false;
    return new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        if (!skipped) {
          if (bytes + chunk.byteLength >= MAX_JSON_OBSERVATION_BYTES) {
            skipped = true;
            chunks.length = 0;
            logger.warn({ requestId: context.requestId }, 'JSON response exceeded attempt observation limit; observation skipped');
            await notifyIncomplete('buffer-limit');
          } else {
            bytes += chunk.byteLength;
            chunks.push(chunk.slice());
          }
        }
        controller.enqueue(chunk);
      },
      async flush() {
        if (skipped || bytes === 0) { onComplete(); return; }
        try {
          const buffer = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
          const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          await dispatch(Object.freeze({ ...context, phase: 'response', protocol: 'json', body: cloneFrozenObservationBody(parsed as Record<string, unknown>), isActive: () => true }));
        } catch (error) {
          logger.warn({ error, requestId: context.requestId }, 'Failed to observe JSON upstream response');
        } finally {
          onComplete();
        }
      },
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending: AttemptObservationEvent[] = [];
  let frameBytes = 0;
  let previousWasCR = false;
  let frameSkipped = false;
  let currentLineHasContent = false;
  // Only retain enough of a line to identify the SSE `data` field. Lines may
  // be arbitrarily large, including after observation has been disabled.
  let currentLinePrefix = '';
  let frameHasData = false;
  const parser = createParser({
    onEvent(event) {
      frameBytes = 0;
      const data = event.data.trim();
      if (!data || data === '[DONE]') return;
      try {
        const body: unknown = JSON.parse(event.data);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return;
        const record = { ...(body as Record<string, unknown>) };
        if (event.event) record._event = event.event;
        pending.push(Object.freeze({ ...context, phase: 'response', protocol: 'sse', body: cloneFrozenObservationBody(record), isActive: () => true }));
      } catch {
        // Non-JSON SSE frames are not attempt observations.
      }
    },
    onError(error) {
      logger.debug({ error, requestId: context.requestId }, 'Ignoring malformed SSE frame during attempt observation');
    },
  });

  const dispatchPending = async (): Promise<void> => {
    const current = pending;
    pending = [];
    for (const event of current) {
      try { await dispatch(event); }
      catch (error) { logger.warn({ error, requestId: context.requestId }, 'Attempt response observer dispatch failed'); }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      let segmentStart = 0;
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char !== '\r' && char !== '\n') {
          currentLineHasContent = true;
          if (currentLinePrefix.length < 5) currentLinePrefix += char;
          previousWasCR = false;
          continue;
        }
        const isCrLfContinuation = char === '\n' && previousWasCR;
        const isBlankLine = !currentLineHasContent;
        const segment = text.slice(segmentStart, index + 1);
        if (!frameSkipped && !isCrLfContinuation) {
          frameBytes += encoder.encode(segment).byteLength;
          if (frameBytes >= MAX_SSE_FRAME_BYTES) {
            frameSkipped = true;
            parser.reset();
            logger.warn({ requestId: context.requestId }, 'SSE frame exceeded attempt observation limit; observation skipped');
            await notifyIncomplete('frame-limit');
          }
        }
        if (frameSkipped && !isCrLfContinuation && isBlankLine) {
          frameSkipped = false;
          frameBytes = 0;
          frameHasData = false;
          parser.reset();
          parser.feed(segment);
        } else if (!frameSkipped) {
          parser.feed(segment);
          if (!isCrLfContinuation) {
            if (!currentLineHasContent) {
              frameBytes = 0;
              frameHasData = false;
            } else if (currentLinePrefix === 'data' || currentLinePrefix.startsWith('data:')) {
              frameHasData = true;
            }
          }
        }
        await dispatchPending();
        currentLineHasContent = false;
        currentLinePrefix = '';
        previousWasCR = char === '\r';
        segmentStart = index + 1;
      }
      if (segmentStart < text.length) {
        const remainder = text.slice(segmentStart);
        if (!frameSkipped) {
          frameBytes += encoder.encode(remainder).byteLength;
          if (frameBytes >= MAX_SSE_FRAME_BYTES) {
            frameSkipped = true;
            parser.reset();
            logger.warn({ requestId: context.requestId }, 'SSE frame exceeded attempt observation limit; observation skipped');
            await notifyIncomplete('frame-limit');
          } else parser.feed(remainder);
        }
        currentLineHasContent = true;
      }
      await dispatchPending();
      controller.enqueue(chunk);
    },
    async flush() {
      const tail = decoder.decode();
      if (!frameSkipped && tail) {
        parser.feed(tail);
        currentLineHasContent = true;
        currentLinePrefix += tail.slice(0, Math.max(0, 5 - currentLinePrefix.length));
      }
      // eventsource-parser dispatches only on a complete blank-line delimiter;
      // an unfinished EOF frame is deliberately not promoted to an event.
      await dispatchPending();
      if (!frameSkipped && (frameHasData || currentLinePrefix === 'data' || currentLinePrefix.startsWith('data:'))) {
        await notifyIncomplete('frame-truncated');
      }
      onComplete();
    },
  });
}

export function cloneFrozenObservationBody(body: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(body);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  };
  freeze(clone);
  return clone;
}
