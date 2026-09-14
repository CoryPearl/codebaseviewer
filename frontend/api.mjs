export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('ngrok-skip-browser-warning', 'true');
  return fetch(url, { ...options, headers });
}

// Read SSE over fetch so progress requests can carry the same headers as JSON.
export async function* progressEvents(response) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Could not connect to indexing progress.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (event === 'progress' && data.length) yield JSON.parse(data.join('\n'));
          event = ''; data = [];
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
