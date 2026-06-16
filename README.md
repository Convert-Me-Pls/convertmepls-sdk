# @convert-me-pls/sdk

[![npm](https://img.shields.io/npm/v/@convert-me-pls/sdk.svg)](https://www.npmjs.com/package/@convert-me-pls/sdk)

**Links:** [npm](https://www.npmjs.com/package/@convert-me-pls/sdk) · [GitHub](https://github.com/Convert-Me-Pls/convertmepls-sdk) · [API docs](https://convertmepls.com/en/docs)

Official JavaScript / TypeScript SDK for the [Convert Me Pls](https://convertmepls.com) file-conversion API. Convert and compress images, video, and audio (68 formats, ~1,500 conversion pairs) with one call. Zero dependencies — works in Node 18+ and the browser (uses global `fetch`).

## Install

```bash
npm install @convert-me-pls/sdk
```

## Quick start

```ts
import { ConvertMePls } from '@convert-me-pls/sdk';

const cmp = new ConvertMePls({ apiKey: 'gck_live_…' }); // create a key in your dashboard

// Convert one file (uploads, runs, waits, returns the finished job)
const fileBytes = new Uint8Array(/* … */);
const job = await cmp.convert(fileBytes, { filename: 'cat.png', target: 'webp', options: { quality: 82 } });
console.log(job.downloadUrl);

// Download the result
const out = await cmp.download(job.downloadUrl!);
```

Each API conversion costs **1 credit**. The anonymous web converter at convertmepls.com is free; the API is metered.

## Common operations

```ts
// Discover formats + valid targets
const { formats, pairs } = await cmp.formats();
const targets = await cmp.targetsFor('png'); // ['webp', 'avif', 'jpeg', …]

// Batch — each file to its own target, uploaded and awaited together
const jobs = await cmp.convertBatch([
  { data: pngBytes, filename: 'a.png', target: 'webp' },
  { data: movBytes, filename: 'b.mov', target: 'mp3' }
]);

// Manual flow (your own polling)
const { inputKey, uploadUrl } = await cmp.createUpload('a.png', 'image/png', pngBytes.length);
// PUT the bytes to uploadUrl with the same content-type…
const { jobId } = await cmp.createConversion(inputKey, 'png', 'webp', { quality: 80 });
const done = await cmp.waitForConversion(jobId);
```

## Configuration

```ts
new ConvertMePls({
  apiKey: 'gck_live_…',                 // optional for free/anonymous use; required for the metered API
  baseUrl: 'https://api.convertmepls.com', // default
  fetch: customFetch                     // optional: inject a fetch implementation
});
```

Conversion `options`: `quality`, `width`, `height`, `crf`, `bitrate` (passed through to the engine where applicable).

## Errors

Failed requests throw `ConvertMePlsError` with a `.status` (HTTP code). A `402` means you're out of credits.

## Links

- Docs: https://convertmepls.com/en/docs
- API reference: https://convertmepls.com/en/docs/conversions

MIT licensed.
