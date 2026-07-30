import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Dimensions {
  width: number;
  height: number;
}

export interface StackOptions extends Dimensions {
  camera1: string;
  camera2: string;
  output: string;
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
 * Junta duas câmeras lado a lado em um clipe. Ambas são escaladas para o mesmo
 * tamanho (com padding, preservando o aspecto) para que o hstack nunca falhe e
 * para que todos os clipes fiquem idênticos — pré-requisito do concat sem recodificar.
 */
export async function stackPair({
  camera1,
  camera2,
  output,
  width,
  height,
  fps,
  crf,
  preset,
}: StackOptions): Promise<string> {
  const normalize = (label: string): string =>
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[${label}]`;

  await mkdir(dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", camera1,
    "-i", camera2,
    "-filter_complex",
    `[0:v]${normalize("l")};[1:v]${normalize("r")};[l][r]hstack=inputs=2[v]`,
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
