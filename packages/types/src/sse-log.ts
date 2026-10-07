export interface SSELogMessage {
  event: string;
  data: unknown;
}

function parseData(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return text; }
}

// Without response metadata, require both explicit negotiation and recognizable
// frames. Scan without building an array so ordinary errors stay plain text.
function isNegotiatedSSE(body: string, accept: string): boolean {
  const requested = accept.split(',').some(range => {
    const [type, ...parameters] = range.trim().toLowerCase().split(';');
    return type.trim() === 'text/event-stream'
      && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter));
  });
  if (!requested) return false;
  let hasData = false;
  const lines = /([^\r\n]*)(?:\r\n|\r|\n|$)/g;
  const text = body.startsWith('\uFEFF') ? body.slice(1) : body;
  let match: RegExpExecArray | null;
  while ((match = lines.exec(text)) && match[0].length) {
    const line = match[1];
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field === 'data') hasData = true;
    else if (!['event', 'id', 'retry'].includes(field)) return false;
  }
  return hasData;
}

/** Format a log copy only. reserve accounts for additional parsing allocations. */
export function formatSSELog(body: unknown, contentType = '', reserve?: (bytes: number) => void, requestAccept = '', parsedMessages?: SSELogMessage[]): unknown {
  // Historical structured logs are projected on read, without rewriting their files.
  if (body && typeof body === 'object' && !Array.isArray(body)
    && 'kind' in body && body.kind === 'sse_messages' && 'messages' in body && Array.isArray(body.messages)) {
    if (!body.messages.every(message => message && typeof message === 'object'
      && (typeof message.dataText === 'string' || 'data' in message || message.done === true))) return body;
    return body.messages.map(message => ({
      event: typeof message.event === 'string' && message.event ? message.event : 'message',
      data: message.done === true ? '[DONE]' : message.data !== undefined ? message.data : parseData(message.dataText ?? ''),
    }));
  }
  if (typeof body !== 'string') return body;
  const media = contentType.trim();
  if (!/^text\/event-stream(?:\s*;|$)/i.test(media)
    && (media || !isNegotiatedSSE(body, requestAccept))) return body;

  // A trusted gateway cache avoids parsing the same data again; classification above still wins.
  if (parsedMessages !== undefined) return parsedMessages;
  const messages: SSELogMessage[] = [];
  let event = '';
  let data: string[] = [];
  let dataLength = 0;
  const dispatch = () => {
    if (data.length) {
      reserve?.(128 + dataLength * 8);
      messages.push({ event: event || 'message', data: parseData(data.join('\n')) });
    }
    event = ''; data = []; dataLength = 0;
  };
  // Iterate lines rather than splitting the whole stream into an unbounded line array.
  const lines = /([^\r\n]*)(?:\r\n|\r|\n|$)/g;
  const text = body.startsWith('\uFEFF') ? body.slice(1) : body;
  let match: RegExpExecArray | null;
  while ((match = lines.exec(text)) && match[0].length) {
    const line = match[1]!;
    if (!line) { dispatch(); continue; }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') {
      reserve?.(64 + value.length * 2);
      dataLength += value.length + (data.length ? 1 : 0);
      data.push(value);
    }
  }
  // Retain the last captured data block even when its trailing blank line is absent.
  dispatch();
  return messages;
}
