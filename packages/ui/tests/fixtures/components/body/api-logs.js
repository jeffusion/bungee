
    window.bodyCalls = [];
    export async function loadBodyById(id) {
      window.bodyCalls.push(id);
      if (window.sseBodies) return structuredClone(window.sseBodies[id]);
      return { content: 'body-' + id };
    }
    export async function loadHeaderById(id) {
      if (window.sseHeaders) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return structuredClone(window.sseHeaders[id]);
      }
      if (window.contentType) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { 'Content-Type': window.contentType };
      }
      return { 'x-test': 'header-' + id };
    }
