import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, progressEvents } from './api.mjs';

test('API requests include the bypass header and preserve caller options', async t => {
  const controller = new AbortController();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://example.invalid/api/jobs');
    assert.equal(options.headers.get('ngrok-skip-browser-warning'), 'true');
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{}');
    assert.equal(options.signal, controller.signal);
    return new Response('{}');
  });
  await apiFetch('https://example.invalid/api/jobs', { method: 'POST', body: '{}', headers, signal: controller.signal });
  assert.equal(headers.has('ngrok-skip-browser-warning'), false);
});

function responseFor(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    // Split UTF-8 characters, line endings, JSON and event boundaries.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('progress survives chunk boundaries, UTF-8, CRLF, comments and multiline data', async () => {
  const events = [];
  for await (const event of progressEvents(responseFor(': heartbeat\r\nevent: progress\r\ndata: {"message":"Café",\r\ndata: "completed":1}\r\n\r\nevent: progress\ndata: {"snapshotId":"ready"}\n\n'))) events.push(event);
  assert.deepEqual(events, [{ message: 'Café', completed: 1 }, { snapshotId: 'ready' }]);
});

test('HTML warning responses and unsuccessful streams are rejected', async () => {
  for (const response of [new Response('<html>warning</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('', { status: 503 })]) {
    await assert.rejects(async () => { for await (const event of progressEvents(response)) void event; }, /Could not connect/);
  }
});

test('stopping after a terminal event cancels the stream', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: progress\ndata: {"snapshotId":"ready"}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  for await (const event of progressEvents(response)) { assert.equal(event.snapshotId, 'ready'); break; }
  assert.equal(cancelled, true);
});
