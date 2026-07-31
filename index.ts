#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { fetchReplaysForDate, groupReplaysIntoSlots } from "./src/api.ts";
import { downloadReplayPairs } from "./src/download.ts";
import {
  assertFfmpegAvailable,
  concatClips,
  probeDimensions,
  probeDuration,
  renderClip,
} from "./src/ffmpeg.ts";

const DEFAULTS = {
  field: "placar-society",
  outDir: "output",
  downloadsDir: "downloads",
  concurrency: 4,
  crf: 20,
  preset: "veryfast",
  fps: 30,
} as const;

interface CliArgs {
  help: boolean;
  list: boolean;
  concat: boolean;
  date: string | undefined;
  time: string | undefined;
  field: string;
  outDir: string;
  downloadsDir: string;
  concurrency: number;
  crf: number;
  preset: string;
  fps: number;
}

const USAGE = `
download-replay — baixa replays do ReplayBR e junta as duas câmeras lado a lado

Gera um vídeo por lance (câmera 1 | câmera 2 tocando ao mesmo tempo).

Uso:
  bun run index.ts <data> <hora> [opções]
  bun run index.ts --date 2026-07-29 --time 20:30

Argumentos:
  <data>   YYYY-MM-DD
  <hora>   HH:MM — o slot de 30min exibido no site (ex: 20:30)

Opções:
  -f, --field <slug>     campo (padrão: ${DEFAULTS.field})
  -l, --list             lista os horários disponíveis na data e sai
  -c, --concat           além dos individuais, gera também um vídeo com todos
  -o, --out-dir <dir>    diretório de saída (padrão: ${DEFAULTS.outDir})
      --downloads <dir>  diretório dos brutos (padrão: ${DEFAULTS.downloadsDir})
  -j, --concurrency <n>  downloads em paralelo (padrão: ${DEFAULTS.concurrency})
      --crf <n>          qualidade x264, menor = melhor (padrão: ${DEFAULTS.crf})
      --preset <p>       preset x264 (padrão: ${DEFAULTS.preset})
      --fps <n>          fps de saída (padrão: ${DEFAULTS.fps})
  -h, --help             mostra esta ajuda

Exemplos:
  bun run index.ts 2026-07-29 --list
  bun run index.ts 2026-07-29 20:30
  bun run index.ts 2026-07-29 20:30 --concat
  bun run index.ts 2026-07-29 22:30 --field global-society
`.trim();

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      date: { type: "string" },
      time: { type: "string" },
      field: { type: "string", short: "f" },
      list: { type: "boolean", short: "l" },
      concat: { type: "boolean", short: "c" },
      "out-dir": { type: "string", short: "o" },
      downloads: { type: "string" },
      concurrency: { type: "string", short: "j" },
      crf: { type: "string" },
      preset: { type: "string" },
      fps: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  return {
    help: values.help ?? false,
    list: values.list ?? false,
    concat: values.concat ?? false,
    date: values.date ?? positionals[0],
    time: values.time ?? positionals[1],
    field: values.field ?? DEFAULTS.field,
    outDir: values["out-dir"] ?? DEFAULTS.outDir,
    downloadsDir: values.downloads ?? DEFAULTS.downloadsDir,
    concurrency: Number(values.concurrency ?? DEFAULTS.concurrency),
    crf: Number(values.crf ?? DEFAULTS.crf),
    preset: values.preset ?? DEFAULTS.preset,
    fps: Number(values.fps ?? DEFAULTS.fps),
  };
}

/** Aceita "20:30", "2030" ou "20h30" e normaliza para "HH:MM". */
function normalizeTime(input: string): string | null {
  const match = input.match(/^(\d{1,2})[:h.]?(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const formatBytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help || !args.date) {
    console.log(USAGE);
    process.exit(args.date ? 0 : 1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    fail(`Data inválida: "${args.date}". Use o formato YYYY-MM-DD.`);
  }

  console.log(`→ Buscando replays de "${args.field}" em ${args.date}...`);
  const replays = await fetchReplaysForDate(args.field, args.date);

  if (replays.length === 0) {
    fail(`Nenhum replay encontrado para "${args.field}" em ${args.date}.`);
  }

  const { slots, keys } = groupReplaysIntoSlots(replays);
  console.log(`  ${replays.length} replays em ${keys.length} horários.`);

  if (args.list || !args.time) {
    console.log("\nHorários disponíveis:");
    for (const key of keys) {
      console.log(`  ${key}  —  ${slots[key]?.length ?? 0} replay(s)`);
    }
    if (!args.list) {
      console.log("\nInforme um horário para gerar o vídeo. Ex:");
      console.log(`  bun run index.ts ${args.date} ${keys.at(-1) ?? "20:30"}`);
    }
    return;
  }

  const time = normalizeTime(args.time);
  if (!time) fail(`Horário inválido: "${args.time}". Use HH:MM (ex: 20:30).`);

  const selected = slots[time];
  if (!selected?.length) {
    fail(`Nenhum replay no horário ${time}. Disponíveis: ${keys.join(", ")}`);
  }

  await assertFfmpegAvailable();

  const slotLabel = time.replace(":", "-");
  const slotDir = `${args.downloadsDir}/${args.field}/${args.date}/${slotLabel}`;
  const rawDir = `${slotDir}/raw`;
  const outSlotDir = `${args.outDir}/${args.field}/${args.date}/${slotLabel}`;

  // A segunda câmera varia por lance. Se algum lance do horário tiver duas, o
  // quadro é duplo e os de câmera única ficam centralizados — assim todos os
  // clipes saem com o mesmo tamanho e o concat sem recodificar continua válido.
  const withTwoCameras = selected.filter((replay) => replay.camera2_url).length;
  const columns = withTwoCameras > 0 ? 2 : 1;
  const fileCount = selected.length + withTwoCameras;

  console.log(
    `\n→ ${selected.length} replay(s) no horário ${time}. Baixando ${fileCount} arquivos...`,
  );
  if (withTwoCameras < selected.length) {
    const singles = selected.length - withTwoCameras;
    console.log(`  ${singles} lance(s) com uma câmera só.`);
  }

  const pairs = await downloadReplayPairs(selected, rawDir, {
    concurrency: args.concurrency,
    onProgress: ({ done, total, job, skipped, bytes }) => {
      const tag = skipped ? "cache" : formatBytes(bytes);
      const label = `${job.replay.timestamp.slice(11)} cam${job.camera}`;
      console.log(`  [${String(done).padStart(2)}/${total}] ${label}  (${tag})`);
    },
  });

  const first = pairs[0]?.cameras[0];
  if (!first) fail("Nenhum vídeo foi baixado.");

  const cell = await probeDimensions(first);
  const frameWidth = cell.width * columns;
  console.log(
    columns === 2
      ? `\n→ Juntando lado a lado (${cell.width}x${cell.height} → ${frameWidth}x${cell.height})...`
      : `\n→ Renderizando câmera única (${frameWidth}x${cell.height})...`,
  );

  const clips: string[] = [];
  const durations: number[] = [];
  for (const pair of pairs) {
    // Um arquivo por lance, nomeado pelo horário em que ele aconteceu.
    const index = String(pair.index + 1).padStart(2, "0");
    const clock = pair.timestamp.slice(11).replaceAll(":", "-");
    const output = `${outSlotDir}/${index}_${clock}.mp4`;

    await renderClip({
      sources: pair.cameras,
      output,
      cell,
      columns,
      fps: args.fps,
      crf: args.crf,
      preset: args.preset,
    });
    clips.push(output);
    durations.push(await probeDuration(output));

    const tag = pair.cameras.length === 1 ? "  (1 câmera)" : "";
    console.log(
      `  [${String(clips.length).padStart(2)}/${pairs.length}] ${output}${tag}`,
    );
  }

  // A duração varia bastante entre campos (de ~3s a ~30s), então é medida.
  const shortest = Math.min(...durations);
  const longest = Math.max(...durations);
  const each =
    longest - shortest < 1
      ? `${longest.toFixed(1)}s cada`
      : `${shortest.toFixed(1)}–${longest.toFixed(1)}s cada`;
  const layout = columns === 2 ? "câmera 1 | câmera 2" : "câmera 1";

  console.log(`\n✓ ${clips.length} vídeo(s) em ${outSlotDir}/`);
  console.log(`  ${frameWidth}x${cell.height} · ${each} · ${layout}`);

  if (args.concat) {
    const finalPath = `${outSlotDir}/completo.mp4`;
    console.log(`\n→ Concatenando ${clips.length} clipes...`);
    await concatClips(clips, finalPath, slotDir);

    const duration = await probeDuration(finalPath);
    console.log(
      `✓ ${finalPath} · ${duration.toFixed(1)}s · ${formatBytes(Bun.file(finalPath).size)}`,
    );
  }

  console.log(`  Brutos mantidos em: ${rawDir}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
