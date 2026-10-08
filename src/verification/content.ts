import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const YTDLP = process.env.YTDLP_PATH ?? 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

let cookiesPath: string | undefined;
/** Common yt-dlp flags. YouTube blocks datacenter IPs without cookies: set YTDLP_COOKIES (Netscape cookies.txt contents). */
async function ytdlpBase() {
  const args = ['--no-warnings', '--js-runtimes', 'node'];
  if (process.env.YTDLP_COOKIES) {
    if (!cookiesPath) {
      cookiesPath = join(tmpdir(), 'yt-cookies.txt');
      await writeFile(cookiesPath, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'));
    }
    args.push('--cookies', cookiesPath);
  }
  return args;
}

export type SupportedPlatform = 'tiktok' | 'youtube';

export type PostMetadata = {
  platform: SupportedPlatform;
  url: string;
  id?: string;
  handle?: string; // @username / channel handle as shown publicly
  author?: string;
  caption: string; // title + description, where hashtags and mentions live
  tags: string[];
  publishedAt?: string;
  durationSec?: number;
  thumbnailUrl?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  source: 'yt-dlp' | 'youtube-api' | 'oembed';
};

export function detectPlatform(url: string): SupportedPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return null;
  }
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
  return null;
}

/** yt-dlp first (both platforms, no API keys), then official APIs/oEmbed as fallbacks. */
export async function fetchMetadata(url: string): Promise<PostMetadata> {
  const platform = detectPlatform(url);
  if (!platform) throw new Error('Unsupported platform URL');
  try {
    const { stdout } = await run(YTDLP, [...(await ytdlpBase()), '-J', '--skip-download', url], { timeout: 60_000, maxBuffer: 20e6 });
    const j = JSON.parse(stdout);
    return {
      platform,
      url,
      id: j.id,
      handle: j.uploader_id ?? j.channel_handle ?? j.uploader,
      author: j.uploader ?? j.channel,
      caption: [j.title, j.description].filter(Boolean).join('\n'),
      tags: j.tags ?? [],
      publishedAt: j.timestamp ? new Date(j.timestamp * 1000).toISOString() : j.upload_date ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}T00:00:00Z` : undefined,
      durationSec: j.duration,
      thumbnailUrl: j.thumbnail,
      views: j.view_count,
      likes: j.like_count,
      comments: j.comment_count,
      shares: j.repost_count,
      source: 'yt-dlp',
    };
  } catch {
    return platform === 'youtube' ? youtubeFallback(url) : oembed(url, 'https://www.tiktok.com/oembed?url=');
  }
}

async function youtubeFallback(url: string): Promise<PostMetadata> {
  const id = /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(url)?.[1];
  const key = process.env.YOUTUBE_API_KEY;
  if (id && key) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${id}&key=${key}`).then((r) => r.json());
    const v = r.items?.[0];
    if (v) {
      return {
        platform: 'youtube',
        url,
        id,
        handle: v.snippet.channelTitle,
        author: v.snippet.channelTitle,
        caption: `${v.snippet.title}\n${v.snippet.description}`,
        tags: v.snippet.tags ?? [],
        publishedAt: v.snippet.publishedAt,
        thumbnailUrl: v.snippet.thumbnails?.high?.url,
        views: Number(v.statistics.viewCount ?? 0),
        likes: Number(v.statistics.likeCount ?? 0),
        comments: Number(v.statistics.commentCount ?? 0),
        source: 'youtube-api',
      };
    }
  }
  return oembed(url, 'https://www.youtube.com/oembed?format=json&url=');
}

async function oembed(url: string, endpoint: string): Promise<PostMetadata> {
  const res = await fetch(endpoint + encodeURIComponent(url), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Post not found or not public (${res.status})`);
  const j = await res.json();
  return {
    platform: detectPlatform(url)!,
    url,
    handle: j.author_unique_id ?? /@([\w.]+)/.exec(j.author_url ?? '')?.[1] ?? j.author_name,
    author: j.author_name,
    caption: j.title ?? '',
    tags: [],
    thumbnailUrl: j.thumbnail_url,
    source: 'oembed',
  };
}

/**
 * Downloads the post once, samples up to `count` evenly spaced JPEG frames (base64) and extracts the
 * audio as 16 kHz mono mp3 for transcription. Falls back to the thumbnail when the video can't be fetched.
 */
export async function extractMedia(meta: PostMetadata, count = 6): Promise<{ frames: string[]; audio: Buffer; fromVideo: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'afc-verify-'));
  try {
    await run(YTDLP, [...(await ytdlpBase()), '-f', 'worst[ext=mp4]/worst', '--max-filesize', '80M', '-o', join(dir, 'v.%(ext)s'), meta.url], { timeout: 120_000 });
    const video = (await readdir(dir)).find((f) => f.startsWith('v.'));
    if (!video) throw new Error('download failed');
    const src = join(dir, video);
    const duration = meta.durationSec && meta.durationSec > 0 ? meta.durationSec : 30;
    await run(FFMPEG, ['-v', 'error', '-i', src, '-vf', `fps=${count}/${duration},scale=512:-2`, '-frames:v', String(count), '-q:v', '5', join(dir, 'f_%02d.jpg')], { timeout: 120_000 });
    // Audio is optional: silent videos simply have no transcript.
    await run(FFMPEG, ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-t', '600', join(dir, 'a.mp3')], { timeout: 120_000 }).catch(() => null);
    const files = await readdir(dir);
    const frames = await Promise.all(files.filter((f) => f.startsWith('f_')).sort().map(async (f) => (await readFile(join(dir, f))).toString('base64')));
    const audio = files.includes('a.mp3') ? await readFile(join(dir, 'a.mp3')) : Buffer.alloc(0);
    if (frames.length) return { frames, audio, fromVideo: true };
  } catch {
    // fall through to thumbnail
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (meta.thumbnailUrl) {
    const res = await fetch(meta.thumbnailUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.ok && (res.headers.get('content-type') ?? '').includes('jpeg')) {
      return { frames: [Buffer.from(await res.arrayBuffer()).toString('base64')], audio: Buffer.alloc(0), fromVideo: false };
    }
  }
  return { frames: [], audio: Buffer.alloc(0), fromVideo: false };
}
