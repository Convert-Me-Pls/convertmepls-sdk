import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConvertMePls, ConvertMePlsError } from '../src/index.ts';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
}

/** A scripted fetch that walks the upload → create → poll flow. */
function fakeFetch() {
  let polls = 0;
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('http://api', '');
    calls.push(`${method} ${path}`);
    if (path === '/formats') {
      return jsonRes({
        formats: { png: { id: 'png', label: 'PNG', mime: 'image/png', category: 'image', extensions: ['png'] } },
        pairs: [{ source: 'png', target: 'webp', clientSide: true }]
      });
    }
    if (path === '/uploads' && method === 'POST') return jsonRes({ inputKey: 'inputs/x', uploadUrl: 'http://api/_dev/put/inputs/x' });
    if (path === '/_dev/put/inputs/x' && method === 'PUT') return jsonRes({ ok: true });
    if (path === '/conversions' && method === 'POST') return jsonRes({ jobId: 'job1' });
    if (path === '/conversions/job1') {
      polls++;
      return polls < 2
        ? jsonRes({ id: 'job1', status: 'processing' })
        : jsonRes({ id: 'job1', status: 'done', downloadUrl: 'http://api/_dev/get/out.webp', bytesOut: 123 });
    }
    return jsonRes({ error: 'unexpected' }, false, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('convert() runs upload → create → poll and returns the finished job', async () => {
  const { impl, calls } = fakeFetch();
  const gc = new ConvertMePls({ baseUrl: 'http://api', fetch: impl, apiKey: 'gck_test' });
  const job = await gc.convert(new Uint8Array([1, 2, 3]), { filename: 'cat.png', target: 'webp', intervalMs: 1 });

  assert.equal(job.status, 'done');
  assert.equal(job.downloadUrl, 'http://api/_dev/get/out.webp');
  assert.equal(job.bytesOut, 123);
  // source inferred from filename, full sequence exercised
  assert.deepEqual(calls.slice(0, 4), ['GET /formats', 'POST /uploads', 'PUT /_dev/put/inputs/x', 'POST /conversions']);
});

test('targetsFor() reads the catalog', async () => {
  const { impl } = fakeFetch();
  const gc = new ConvertMePls({ baseUrl: 'http://api', fetch: impl });
  assert.deepEqual(await gc.targetsFor('png'), ['webp']);
});

test('convertBatch uploads all, submits one batch, waits for each job', async () => {
  const impl = (async (url: string, init?: RequestInit) => {
    const path = url.replace('http://api', '');
    const method = init?.method ?? 'GET';
    if (path === '/formats') return jsonRes({
      formats: { png: { id: 'png', label: 'PNG', mime: 'image/png', category: 'image', extensions: ['png'] }, wav: { id: 'wav', label: 'WAV', mime: 'audio/wav', category: 'audio', extensions: ['wav'] } },
      pairs: []
    });
    if (path === '/uploads' && method === 'POST') return jsonRes({ inputKey: 'inputs/x', uploadUrl: 'http://api/_dev/put/x' });
    if (path.startsWith('/_dev/put')) return jsonRes({ ok: true });
    if (path === '/conversions/batch') return jsonRes({ jobs: [{ jobId: 'j1', source: 'png', target: 'webp' }, { jobId: 'j2', source: 'wav', target: 'mp3' }] });
    if (path === '/conversions/j1') return jsonRes({ id: 'j1', status: 'done', downloadUrl: 'http://api/get/1' });
    if (path === '/conversions/j2') return jsonRes({ id: 'j2', status: 'done', downloadUrl: 'http://api/get/2' });
    return jsonRes({ error: 'unexpected' }, false, 404);
  }) as unknown as typeof fetch;

  const gc = new ConvertMePls({ baseUrl: 'http://api', fetch: impl });
  const jobs = await gc.convertBatch([
    { data: new Uint8Array([1]), filename: 'a.png', target: 'webp' },
    { data: new Uint8Array([2]), filename: 'b.wav', target: 'mp3' }
  ], { intervalMs: 1 });
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.status === 'done'));
});

test('errors surface as ConvertMePlsError with status', async () => {
  const impl = (async () => jsonRes({ error: 'nope' }, false, 422)) as unknown as typeof fetch;
  const gc = new ConvertMePls({ baseUrl: 'http://api', fetch: impl });
  await assert.rejects(() => gc.getConversion('x'), (e: unknown) => e instanceof ConvertMePlsError && e.status === 422);
});
