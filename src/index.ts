/**
 * Official SDK for the ConvertMePls file conversion API.
 *
 *   const gc = new ConvertMePls({ apiKey: 'gck_live_…' });
 *   const out = await gc.convert(bytes, { filename: 'cat.png', target: 'webp' });
 *   console.log(out.downloadUrl);
 *
 * Zero dependencies — works in Node 18+ and the browser (uses global fetch).
 */

export interface ConvertMePlsConfig {
  apiKey?: string;
  /** API base URL. Defaults to the public API. */
  baseUrl?: string;
  /** Custom fetch (e.g. for testing or a proxy). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface ConvertOptions {
  quality?: number;
  width?: number;
  height?: number;
  crf?: number;
  bitrate?: number;
  [key: string]: unknown;
}

export type FormatCategory = 'image' | 'video' | 'audio';

export interface FormatInfo {
  id: string;
  label: string;
  mime: string;
  category: FormatCategory;
  extensions: string[];
}

export interface ConversionPair { source: string; target: string; clientSide: boolean; }
export interface Catalog { formats: Record<string, FormatInfo>; pairs: ConversionPair[]; }

export interface Job {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  downloadUrl?: string;
  bytesOut?: number;
  error?: string;
}

export interface ConvertParams {
  filename: string;
  target: string;
  /** Source format id; inferred from the filename extension if omitted. */
  source?: string;
  contentType?: string;
  options?: ConvertOptions;
  /** Poll timeout (ms). Default 300_000. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 1500. */
  intervalMs?: number;
}

export class ConvertMePlsError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ConvertMePlsError'; }
}

const DEFAULT_BASE = 'https://api.convertmepls.com';

export class ConvertMePls {
  private apiKey?: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private catalogCache?: Catalog;

  constructor(config: ConvertMePlsConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    const f = config.fetch ?? globalThis.fetch;
    if (!f) throw new ConvertMePlsError('No fetch implementation available; pass one via config.fetch');
    this.fetchImpl = f;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Always attach auth so reads (e.g. job status) resolve to the key's account.
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) }
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      throw new ConvertMePlsError(`${init?.method ?? 'GET'} ${path} failed (${res.status}) ${detail}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  /** Fetch the supported formats + conversion pairs (cached). */
  async formats(force = false): Promise<Catalog> {
    if (!this.catalogCache || force) this.catalogCache = await this.req<Catalog>('/formats');
    return this.catalogCache;
  }

  /** Valid target format ids for a given source. */
  async targetsFor(source: string): Promise<string[]> {
    const { pairs } = await this.formats();
    return pairs.filter((p) => p.source === source).map((p) => p.target);
  }

  async createUpload(filename: string, contentType: string, bytes: number): Promise<{ inputKey: string; uploadUrl: string }> {
    return this.req('/uploads', { method: 'POST', headers: this.headers(true), body: JSON.stringify({ filename, contentType, bytes }) });
  }

  async createConversion(inputKey: string, source: string, target: string, options: ConvertOptions = {}): Promise<{ jobId: string }> {
    return this.req('/conversions', { method: 'POST', headers: this.headers(true), body: JSON.stringify({ inputKey, source, target, options }) });
  }

  async getConversion(jobId: string): Promise<Job> {
    return this.req<Job>(`/conversions/${jobId}`);
  }

  /** Poll a job until it finishes or fails. */
  async waitForConversion(jobId: string, timeoutMs = 300_000, intervalMs = 1500): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getConversion(jobId);
      if (job.status === 'done') return job;
      if (job.status === 'error') throw new ConvertMePlsError(job.error || 'conversion failed');
      if (Date.now() > deadline) throw new ConvertMePlsError('conversion timed out');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  private async inferSource(filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const { formats } = await this.formats();
    for (const f of Object.values(formats)) if (f.extensions.includes(ext)) return f.id;
    throw new ConvertMePlsError(`Could not infer source format from "${filename}" — pass { source }`);
  }

  /** High-level: upload bytes, run the conversion, wait, and return the finished job. */
  async convert(data: Uint8Array | ArrayBuffer | Blob, params: ConvertParams): Promise<Job> {
    const bytesBody = (data instanceof Blob ? data : data) as unknown as BodyInit;
    const size = data instanceof Blob ? data.size : (data instanceof ArrayBuffer ? data.byteLength : data.byteLength);
    const source = params.source ?? (await this.inferSource(params.filename));
    const contentType = params.contentType ?? 'application/octet-stream';

    const { inputKey, uploadUrl } = await this.createUpload(params.filename, contentType, size);
    // Send the same content-type the presigned URL was signed with, or the S3
    // signature check fails.
    const put = await this.fetchImpl(uploadUrl, { method: 'PUT', body: bytesBody, headers: { 'content-type': contentType } });
    if (!put.ok) throw new ConvertMePlsError(`upload failed (${put.status})`, put.status);

    const { jobId } = await this.createConversion(inputKey, source, params.target, params.options ?? {});
    return this.waitForConversion(jobId, params.timeoutMs, params.intervalMs);
  }

  /**
   * Convert many files at once, each to its own target format. Uploads all
   * inputs, submits one batch request, and waits for every job.
   */
  async convertBatch(
    files: Array<{ data: Uint8Array | ArrayBuffer | Blob; filename: string; target: string; source?: string; contentType?: string; options?: ConvertOptions }>,
    opts: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<Job[]> {
    const items = await Promise.all(files.map(async (f) => {
      const body = (f.data instanceof Blob ? f.data : f.data) as unknown as BodyInit;
      const size = f.data instanceof Blob ? f.data.size : (f.data instanceof ArrayBuffer ? f.data.byteLength : f.data.byteLength);
      const source = f.source ?? (await this.inferSource(f.filename));
      const ct = f.contentType ?? 'application/octet-stream';
      const { inputKey, uploadUrl } = await this.createUpload(f.filename, ct, size);
      const put = await this.fetchImpl(uploadUrl, { method: 'PUT', body, headers: { 'content-type': ct } });
      if (!put.ok) throw new ConvertMePlsError(`upload failed for ${f.filename} (${put.status})`, put.status);
      return { inputKey, source, target: f.target, options: f.options ?? {} };
    }));

    const res = await this.req<{ jobs: Array<{ jobId?: string; source: string; target: string; error?: string }> }>(
      '/conversions/batch',
      { method: 'POST', headers: this.headers(true), body: JSON.stringify({ items }) }
    );

    return Promise.all(res.jobs.map((j) =>
      j.jobId
        ? this.waitForConversion(j.jobId, opts.timeoutMs, opts.intervalMs)
        : Promise.resolve({ id: '', status: 'error', error: j.error ?? 'unsupported conversion' } as Job)
    ));
  }

  /** Download a finished conversion's bytes. */
  async download(downloadUrl: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(downloadUrl);
    if (!res.ok) throw new ConvertMePlsError(`download failed (${res.status})`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export default ConvertMePls;
