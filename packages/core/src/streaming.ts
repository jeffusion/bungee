import type { ModificationRules, StreamTransformRules } from '@jeffusion/bungee-shared';
import type { ExpressionContext } from './expression-engine';
import { applyBodyRules } from './worker';
import { evaluateExpression } from './expression-engine';
import { logger } from './logger';

interface StreamState {
  hasStarted: boolean;
  isFinished: boolean;
  chunkCount: number;
}

// 通用的SSE流转换器，支持任意API格式的转换
export function createSseTransformerStream(
  rules: ModificationRules | StreamTransformRules,
  requestContext: ExpressionContext,
  requestLog: any
): TransformStream<Uint8Array, Uint8Array> {
  let buffer = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const state: StreamState = {
    hasStarted: false,
    isFinished: false,
    chunkCount: 0
  };

  // 检查是否为新的状态机规则格式
  const isStateMachineRules = (r: any): r is StreamTransformRules => {
    return r && (r.start || r.chunk || r.end);
  };

  const streamRules = isStateMachineRules(rules) ? rules : null;
  const legacyRules = !isStateMachineRules(rules) ? rules as ModificationRules : null;

  /**
   * 配置驱动的事件阶段判断函数
   *
   * 优先级：
   * 1. eventTypeMapping（用于带 event: 的 SSE，如 Anthropic）
   * 2. phaseDetection（用于基于 body 内容判断的 SSE，如 Gemini）
   * 3. 顺序处理（向后兼容，适用于无配置情况）
   */
  const determinePhase = (
    eventType: string | null,
    parsedBody: any,
    hasStarted: boolean
  ): 'start' | 'chunk' | 'end' | 'skip' => {
    // 1️⃣ 优先使用 eventTypeMapping（适用于 Anthropic 等带 event: 的 SSE）
    if (eventType && streamRules?.eventTypeMapping) {
      const mappedPhase = streamRules.eventTypeMapping[eventType];
      if (mappedPhase) {
        logger.debug(
          { request: requestLog, eventType, mappedPhase },
          'Phase determined by eventTypeMapping'
        );
        return mappedPhase;
      }
    }

    // 2️⃣ 使用 phaseDetection 表达式（适用于 Gemini 等不带 event: 的 SSE）
    if (streamRules?.phaseDetection) {
      const { isStart, isChunk, isEnd } = streamRules.phaseDetection;
      const responseContext: ExpressionContext = {
        ...requestContext,
        body: parsedBody,
        stream: { phase: 'unknown', chunkIndex: state.chunkCount }
      };

      const evaluate = (expression: string) => {
        const cleanExpression = expression.startsWith('{{') && expression.endsWith('}}')
          ? expression.slice(2, -2).trim()
          : expression;
        return evaluateExpression(cleanExpression, responseContext);
      };

      try {
        // 按 isEnd → isStart → isChunk 顺序检查（避免误判）
        if (isEnd) {
          if (evaluate(isEnd)) {
            logger.debug(
              { request: requestLog, expression: isEnd, result: true },
              'Phase determined by phaseDetection.isEnd'
            );
            return 'end';
          }
        }

        if (isStart && !hasStarted) {
          if (evaluate(isStart)) {
            logger.debug(
              { request: requestLog, expression: isStart, result: true },
              'Phase determined by phaseDetection.isStart'
            );
            return 'start';
          }
        }

        if (isChunk) {
          if (evaluate(isChunk)) {
            logger.debug(
              { request: requestLog, expression: isChunk, result: true },
              'Phase determined by phaseDetection.isChunk'
            );
            return 'chunk';
          }
        }
      } catch (error) {
        logger.warn(
          { request: requestLog, error, phaseDetection: streamRules.phaseDetection },
          'Failed to evaluate phaseDetection expression, falling back to sequential'
        );
      }
    }

    // 3️⃣ 向后兼容：顺序处理（没有配置时的默认行为）
    if (!hasStarted && streamRules?.start) {
      logger.debug({ request: requestLog }, 'Phase: start (sequential fallback)');
      return 'start';
    }

    logger.debug({ request: requestLog }, 'Phase: chunk (sequential fallback)');
    return 'chunk';
  };

  const sendEvent = async (controller: TransformStreamDefaultController<Uint8Array>, eventData: any, ruleType: 'start' | 'chunk' | 'end') => {
    let transformedData = eventData;

    if (streamRules) {
      // 使用新的状态机规则
      const ruleForPhase = streamRules[ruleType];
      if (ruleForPhase?.body) {
        const responseContext: ExpressionContext = {
          ...requestContext,
          body: eventData,
          stream: { phase: ruleType, chunkIndex: state.chunkCount }
        };
        transformedData = await applyBodyRules(eventData, ruleForPhase.body, responseContext, requestLog);
      }
    } else if (legacyRules && ruleType === 'chunk') {
      // 向后兼容：使用旧的单一规则格式（仅对chunk应用）
      if (legacyRules.body) {
        const responseContext: ExpressionContext = {
          ...requestContext,
          body: eventData
        };
        transformedData = await applyBodyRules(eventData, legacyRules.body, responseContext, requestLog);
      }
    }

    // 检查transformedData是否为事件数组（用于end阶段的多事件支持）
    const events = Array.isArray(transformedData) ? transformedData : [transformedData];

    // 发送所有事件
    for (const event of events) {
      if (event && typeof event === 'object') {
        const eventString = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(eventString));
      }
    }
  };

  return new TransformStream({
    async transform(chunk, controller) {
      if (state.isFinished) return;

      buffer += decoder.decode(chunk, { stream: true });

      // 支持两种行结束符：\r\n\r\n 和 \n\n
      let boundary = buffer.indexOf('\r\n\r\n');
      let boundaryLength = 4;
      if (boundary === -1) {
        boundary = buffer.indexOf('\n\n');
        boundaryLength = 2;
      }

      while (boundary !== -1) {
        const eventBlock = buffer.substring(0, boundary).trim();
        buffer = buffer.substring(boundary + boundaryLength);

        // Parse SSE event block (may contain "event:" and "data:" lines)
        const lines = eventBlock.split(/\r?\n/);
        let eventType: string | null = null;
        let dataContent: string | null = null;

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            dataContent = line.substring(5).trim();
          }
        }

        // Process the event if we have data
        if (dataContent) {
          if (dataContent === '[DONE]') {
            // 发送结束事件
            if (streamRules?.end) {
              await sendEvent(controller, {}, 'end');
            }
            state.isFinished = true;
            return;
          }

          try {
            const parsedBody = JSON.parse(dataContent);

            // ✅ 使用配置驱动的阶段判断
            const phase = determinePhase(eventType, parsedBody, state.hasStarted);

            logger.debug({
              request: requestLog,
              parsedBody,
              eventType,
              phase,
              hasStarted: state.hasStarted
            }, "Processing streaming event");

            // Process based on phase
            if (phase === 'start' && !state.hasStarted && streamRules?.start) {
              await sendEvent(controller, parsedBody, 'start');
              state.hasStarted = true;
            } else if (phase === 'chunk' && (streamRules?.chunk || legacyRules)) {
              await sendEvent(controller, parsedBody, 'chunk');
              state.chunkCount++;
            } else if (phase === 'end' && streamRules?.end) {
              await sendEvent(controller, parsedBody, 'end');
              state.isFinished = true;
            }
            // phase === 'skip' - do nothing

          } catch (error) {
            logger.error({ error, event: dataContent, request: requestLog }, 'Failed to parse streaming event');
            // 解析失败时，选择性转发原始事件或跳过
            if (!streamRules) {
              // 如果没有转换规则，转发原始事件
              controller.enqueue(encoder.encode(`${eventBlock}\n\n`));
            }
          }
        } else if (eventBlock && !streamRules) {
          // 转发非data事件（仅在非状态机模式下）
          controller.enqueue(encoder.encode(`${eventBlock}\n\n`));
        }

        // 重新检查边界
        boundary = buffer.indexOf('\r\n\r\n');
        if (boundary === -1) {
          boundary = buffer.indexOf('\n\n');
          boundaryLength = 2;
        } else {
          boundaryLength = 4;
        }
      }
    },
    async flush(controller) {
      // 确保流正确结束
      if (!state.isFinished && streamRules?.end) {
        logger.warn({ request: requestLog }, 'Stream ended without proper finish signal, sending default end event');
        await sendEvent(controller, {}, 'end');
      }

      // 处理缓冲区中剩余的数据
      if (buffer.trim() && !streamRules) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}
