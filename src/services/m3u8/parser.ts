/**
 * Minimal HLS m3u8 fetch + parse: resolve master → first variant, then first .ts segment.
 * Handles relative URLs, timeouts, and invalid bodies without throwing from fetch layer.
 */

export class M3u8ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M3u8ParseError';
  }
}

export interface ExtractTsResult {
  tsUrl: string;
}

function resolveAgainst(base: string, ref: string): string {
  return new URL(ref.trim(), base).href;
}

function splitLines(body: string): string[] {
  return body.split(/\r?\n/).map((l) => l.trim());
}

/** True if playlist looks like a master (variant) list rather than media segments. */
function isMasterPlaylist(lines: string[]): boolean {
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
}

/** First variant URI: optional URI="..." on #EXT-X-STREAM-INF, else next non-comment line. */
function pickFirstVariantUrl(lines: string[], baseUrl: string): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const quoted = line.match(/URI="([^"]+)"/i);
    if (quoted?.[1]) return resolveAgainst(baseUrl, quoted[1]);
    const bare = line.match(/URI=([^,\s]+)/i);
    if (bare?.[1] && bare[1].includes('.m3u8')) return resolveAgainst(baseUrl, bare[1]);
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next || next.startsWith('#')) continue;
      return resolveAgainst(baseUrl, next);
    }
  }
  return undefined;
}

/** First media segment line ending in .ts */
function pickFirstTsSegment(lines: string[], baseUrl: string): string | undefined {
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.includes('.ts')) return resolveAgainst(baseUrl, line);
  }
  return undefined;
}

function parsePlaylistContent(content: string, baseUrl: string): ExtractTsResult {
  const lines = splitLines(content).filter(Boolean);
  if (lines.length === 0 || !lines[0].includes('#EXTM3U')) {
    throw new M3u8ParseError('Invalid m3u8: missing #EXTM3U');
  }

  if (isMasterPlaylist(lines)) {
    const variant = pickFirstVariantUrl(lines, baseUrl);
    if (!variant) throw new M3u8ParseError('Master playlist: no variant m3u8 found');
    return { tsUrl: variant };
  }

  const ts = pickFirstTsSegment(lines, baseUrl);
  if (!ts) throw new M3u8ParseError('Media playlist: no .ts segment found');
  return { tsUrl: ts };
}

/**
 * Fetch m3u8 (with timeout). If master, fetches first variant and parses again for .ts.
 */
export async function fetchAndExtractFirstTs(
  m3u8Url: string,
  timeoutMs: number
): Promise<ExtractTsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(m3u8Url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'fetch failed';
    throw new M3u8ParseError(`m3u8 fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new M3u8ParseError(`m3u8 HTTP ${res.status}`);
  }

  const text = await res.text();
  const first = parsePlaylistContent(text, m3u8Url);

  // Nested master: first pass returned another .m3u8 URL
  if (first.tsUrl.toLowerCase().includes('.m3u8')) {
    return fetchAndExtractFirstTs(first.tsUrl, timeoutMs);
  }

  return first;
}
