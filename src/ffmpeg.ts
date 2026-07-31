import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Dimensions {
  width: number;
  height: number;
}

export interface RenderClipOptions {
  /** Uma ou duas câmeras do mesmo lance. */
  sources: string[];
  output: string;
  /** Tamanho de cada câmera dentro do quadro. */
  cell: Dimensions;
  /** Colunas do quadro final: 2 quando o horário tem alguma segunda câmera. */
  columns: number;
  fps: number;
  crf: number;
  preset: string;
}

async function run(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-15).join("\n");
    throw new Error(`${bin} saiu com código ${code}:\n${tail}`);
  }
  return stdout.trim();
}

export async function assertFfmpegAvailable(): Promise<void> {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await run(bin, ["-version"]);
    } catch {
      throw new Error(
        `\`${bin}\` não encontrado no PATH. Instale com: brew install ffmpeg`,
      );
    }
  }
}

/** Lê largura e altura do vídeo, usadas para normalizar todos os clipes. */
export async function probeDimensions(file: string): Promise<Dimensions> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    file,
  ]);

  const [width, height] = out.split("x").map(Number);
  if (!width || !height) {
    throw new Error(`Não foi possível ler as dimensões de ${file}`);
  }
  return { width, height };
}

/**
 * Renderiza um lance. Com duas câmeras, elas vão lado a lado; com uma só, ela
 * fica centralizada no quadro (que continua com `columns` colunas).
 *
 * Cada câmera é escalada para o mesmo tamanho preservando o aspecto, e todos os
 * clipes de um horário saem com dimensões idênticas — pré-requisito do concat
 * sem recodificar.
 */
export async function renderClip({
  sources,
  output,
  cell,
  columns,
  fps,
  crf,
  preset,
}: RenderClipOptions): Promise<string> {
  if (sources.length === 0) {
    throw new Error(`Nenhuma câmera para renderizar em ${output}`);
  }

  const frameWidth = cell.width * columns;
  const steps = sources.map(
    (_, i) =>
      `[${i}:v]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
      `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[c${i}]`,
  );

  if (sources.length >= 2) {
    steps.push(`[c0][c1]hstack=inputs=2[v]`);
  } else if (frameWidth !== cell.width) {
    // Câmera única num quadro de duas colunas: centraliza e preenche o resto.
    steps.push(`[c0]pad=${frameWidth}:${cell.height}:(ow-iw)/2:0[v]`);
  } else {
    steps.push(`[c0]null[v]`);
  }

  await mkdir(dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    ...sources.flatMap((source) => ["-i", source]),
    "-filter_complex", steps.join(";"),
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    output,
  ]);
  return output;
}

/** Concatena clipes já normalizados, sem recodificar. */
export async function concatClips(
  clips: string[],
  output: string,
  workDir: string,
): Promise<string> {
  const listFile = `${workDir}/concat.txt`;
  // O concat demuxer resolve caminhos relativos à pasta do arquivo de lista,
  // então os clipes precisam entrar como caminhos absolutos.
  const body = clips
    .map((clip) => `file '${resolve(clip).replaceAll("'", "'\\''")}'`)
    .join("\n");

  await mkdir(workDir, { recursive: true });
  await writeFile(listFile, `${body}\n`);
  await mkdir(dirname(output), { recursive: true });

  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0",
    "-i", listFile,
    "-c", "copy",
    output,
  ]);
  return output;
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);
  return Number(out);
}
