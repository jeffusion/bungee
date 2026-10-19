
    window.bodyCalls = [];
    window.headerCalls = [];
    const pendingHeaders = new Map();
    window.releaseHeader = id => {
      window.headerGates = window.headerGates.filter(value => value !== id);
      for (const release of pendingHeaders.get(id) ?? []) release();
      pendingHeaders.delete(id);
    };
    export async function loadBodyById(id) {
      window.bodyCalls.push(id);
      if (window.sseBodies) return structuredClone(window.sseBodies[id]);
      return { content: 'body-' + id };
    }
    export async function loadHeaderById(id) {
      window.headerCalls.push(id);
      if (window.headerGates?.includes(id)) await new Promise(resolve => {
        const pending = pendingHeaders.get(id) ?? []; pending.push(resolve); pendingHeaders.set(id,pending);
      });
      if (window.sseHeaders) {
        return structuredClone(window.sseHeaders[id]);
      }
      if (window.contentType) {
        return { 'Content-Type': window.contentType };
      }
      return { 'x-test': 'header-' + id };
    }
