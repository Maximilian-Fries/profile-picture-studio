// Local-only API route for the optional "AI enhance" feature.
// The OpenAI key is read from .env.local on the machine running the dev/preview server
// and never reaches the browser.
import type { IncomingMessage, ServerResponse } from 'node:http';
import OpenAI, { toFile } from 'openai';
import { loadEnv, type Plugin } from 'vite';

const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
const MAX_BODY = 24 * 1024 * 1024;
const QUALITIES = new Set(['low', 'medium', 'high']);

interface EnhanceBody {
  images?: string[];
  prompt?: string;
  quality?: string;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<EnhanceBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('The photo is too large to send.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid request.'));
      }
    });
    req.on('error', reject);
  });
}

function decodeImage(dataUrl: string): { buffer: Buffer; type: string; ext: string } {
  const match = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Unsupported image data.');
  return { buffer: Buffer.from(match[3], 'base64'), type: match[1], ext: match[2] === 'jpeg' ? 'jpg' : match[2] };
}

/** Turns provider errors into something a person can act on, without leaking request details. */
function explain(error: unknown): { status: number; message: string } {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
  const raw = (error as any)?.error?.message ?? (error as any)?.message ?? 'Unknown error';
  const code = (error as any)?.code ?? (error as any)?.error?.code;
  if (status === 401) return { status, message: 'OpenAI rejected the API key. Check OPENAI_API_KEY in .env.local.' };
  if (status === 429) return { status, message: `OpenAI is rate-limiting or the account is out of credit. ${raw}` };
  if (status === 403 || code === 'model_not_found' || status === 404) {
    return { status, message: `This OpenAI account cannot use the selected image model. ${raw} You can set OPENAI_IMAGE_MODEL in .env.local.` };
  }
  if (code === 'moderation_blocked' || /safety|moderation/i.test(raw)) {
    return { status: 422, message: `OpenAI declined to edit this photo. ${raw}` };
  }
  return { status: status >= 400 && status < 600 ? status : 500, message: String(raw) };
}

export function aiPlugin(): Plugin {
  let root = process.cwd();
  let mode = 'development';

  // Re-read on every request so adding the key does not require a restart.
  const settings = () => {
    const env = { ...loadEnv(mode, root, ''), ...process.env } as Record<string, string | undefined>;
    return { key: env.OPENAI_API_KEY?.trim() || '', model: env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_MODEL };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/api/ai/')) return next();

    // Only this app's own pages may use the key: other sites cannot send this header
    // or a JSON body to localhost without a CORS preflight, which we never approve.
    const site = req.headers['sec-fetch-site'];
    if (req.headers['x-pfp'] !== '1' || (site && site !== 'same-origin')) {
      return send(res, 403, { error: 'Forbidden.' });
    }

    const { key, model } = settings();
    if (url === '/api/ai/status' && req.method === 'GET') {
      return send(res, 200, { configured: !!key, model });
    }
    if (url === '/api/ai/enhance' && req.method === 'POST') {
      if (!key) return send(res, 400, { error: 'No OpenAI API key found. Add OPENAI_API_KEY to .env.local.' });
      try {
        const body = await readJson(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 12000) : '';
        const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
        if (!prompt || !images.length) return send(res, 400, { error: 'A photo and instructions are required.' });
        const quality = QUALITIES.has(body.quality ?? '') ? (body.quality as 'low' | 'medium' | 'high') : 'medium';
        const files = await Promise.all(
          images.map((data, i) => {
            const { buffer, type, ext } = decodeImage(data);
            return toFile(buffer, `${i === 0 ? 'photo' : 'reference'}.${ext}`, { type });
          }),
        );
        const client = new OpenAI({ apiKey: key, maxRetries: 1, timeout: 5 * 60 * 1000 });
        const params: Record<string, unknown> = {
          model,
          image: files.length === 1 ? files[0] : files,
          prompt,
          size: '1024x1024',
          quality,
          output_format: 'png',
          n: 1,
        };
        // Only gpt-image-1.5 takes this switch; newer models preserve faces without it.
        if (model.startsWith('gpt-image-1.5')) params.input_fidelity = 'high';
        const result = await client.images.edit(params as any);
        const b64 = (result as any).data?.[0]?.b64_json;
        if (!b64) return send(res, 502, { error: 'OpenAI returned no image.' });
        return send(res, 200, { image: `data:image/png;base64,${b64}`, model });
      } catch (error) {
        const { status, message } = explain(error);
        return send(res, status, { error: message });
      }
    }
    return send(res, 404, { error: 'Not found.' });
  };

  return {
    name: 'profile-picture-ai',
    configResolved(config) {
      root = config.root;
      mode = config.mode;
    },
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}
