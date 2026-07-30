import { stat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Replay } from "./api.ts";

export interface DownloadJob {
  /** Índice do replay ao qual este arquivo pertence. */
  index: number;
  replay: Replay;
  camera: 1 | 2;
  url: string;
  path: string;
}

export interface DownloadResult {
  /** `true` quando o arquivo já existia e o download foi reaproveitado. */
  skipped: boolean;
  bytes: number;
}

export interface DownloadProgress extends DownloadResult {
  done: number;
  total: number;
  job: DownloadJob;
}

/** Um replay com os dois arquivos locais já baixados. */
export interface ReplayPair {
  index: number;
  timestamp: string;
  camera1: string;
  camera2: string;
}

export interface DownloadOptions {
  concurrency?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

/** Roda `worker` sobre `items` com no máximo `limit` em paralelo, preservando a ordem. */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item, index);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function downloadFile(
  url: string,
  destination: string,
): Promise<DownloadResult> {
  // Retomada barata: se o arquivo já existe e não está vazio, não baixa de novo.
  const existing = await fileSize(destination);
  if (existing > 0) return { skipped: true, bytes: existing };

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download falhou (${res.status}) para ${url}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const bytes = await Bun.write(destination, res);
  return { skipped: false, bytes };
}

const prefixFor = (index: number): string => String(index + 1).padStart(2, "0");

/** Baixa camera1 e camera2 de cada replay para `rawDir`. */
export async function downloadReplayPairs(
  replays: Replay[],
  rawDir: string,
  { concurrency = 4, onProgress }: DownloadOptions = {},
): Promise<ReplayPair[]> {
  const jobs: DownloadJob[] = replays.flatMap((replay, index) => {
    const prefix = prefixFor(index);
    return [
      {
        index,
        replay,
        camera: 1,
        url: replay.camera1_url,
        path: `${rawDir}/${prefix}_camera1.mp4`,
      },
      {
        index,
        replay,
        camera: 2,
        url: replay.camera2_url,
        path: `${rawDir}/${prefix}_camera2.mp4`,
      },
    ];
  });

  let done = 0;
  await withConcurrency(jobs, concurrency, async (job) => {
    const result = await downloadFile(job.url, job.path);
    done++;
    onProgress?.({ done, total: jobs.length, job, ...result });
    return result;
  });

  return replays.map((replay, index) => {
    const prefix = prefixFor(index);
    return {
      index,
      timestamp: replay.timestamp,
      camera1: `${rawDir}/${prefix}_camera1.mp4`,
      camera2: `${rawDir}/${prefix}_camera2.mp4`,
    };
  });
}
