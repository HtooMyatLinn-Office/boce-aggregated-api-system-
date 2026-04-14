import { config } from '../../config';

export interface StreamSamplingResult {
  sources: StreamPlaybackSource[];
}

interface PlaybackSource {
  raw_play_url?: string;
  api_from_code?: string;
}

interface PlaybackVideo {
  sources?: PlaybackSource[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export interface StreamPlaybackSource {
  m3u8Url: string;
  sourceCode: string;
}

function collectSourcesFromJson(data: unknown): StreamPlaybackSource[] {
  const out: StreamPlaybackSource[] = [];

  const visit = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;

    if (Array.isArray(o.sources) && !Array.isArray(o.videos)) {
      for (const s of o.sources) {
        if (s && typeof s === 'object' && isNonEmptyString((s as PlaybackSource).raw_play_url)) {
          const src = s as PlaybackSource;
          out.push({
            m3u8Url: String(src.raw_play_url).trim(),
            sourceCode: isNonEmptyString(src.api_from_code) ? src.api_from_code.trim() : 'unknown',
          });
        }
      }
    }

    if (Array.isArray(o.videos)) {
      for (const v of o.videos as PlaybackVideo[]) {
        if (v && Array.isArray(v.sources)) {
          for (const s of v.sources) {
            if (s && isNonEmptyString(s.raw_play_url)) {
              out.push({
                m3u8Url: String(s.raw_play_url).trim(),
                sourceCode: isNonEmptyString(s.api_from_code) ? s.api_from_code.trim() : 'unknown',
              });
            }
          }
        }
      }
    }
  };

  visit(data);
  if (typeof data === 'object' && data !== null && 'data' in data) {
    visit((data as { data: unknown }).data);
  }

  return out;
}

function buildPlaybackUrl(template: string, region: string): string {
  return template.replace(/\{region\}/gi, encodeURIComponent(region.trim()));
}

/** Calls playback API and returns all valid sources deduplicated by source code. */
export async function sampleM3u8UrlsForRegion(region: string): Promise<StreamSamplingResult> {
  const template = config.stream.playbackApiUrl?.trim();
  if (!template) {
    return { sources: [] };
  }

  const url = buildPlaybackUrl(template, region);
  const method = config.stream.playbackApiMethod === 'POST' ? 'POST' : 'GET';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.stream.m3u8FetchTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ region: region.trim() }) : undefined,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    return { sources: [] };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { sources: [] };
  }

  const raw = collectSourcesFromJson(data);
  const seen = new Set<string>();
  const deduped: StreamPlaybackSource[] = [];
  for (const s of raw) {
    const key = s.sourceCode.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  return { sources: deduped };
}
