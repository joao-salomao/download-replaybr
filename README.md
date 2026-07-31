# download-replay

CLI em [Bun](https://bun.sh) + TypeScript que baixa os replays do [ReplayBR](https://www.replaybr.com.br/replay?fieldName=placar-society) de uma data e horário e gera **um vídeo por lance**, com as **duas câmeras lado a lado** tocando ao mesmo tempo.

Campos com uma câmera só também funcionam — veja [Câmera única](#câmera-única).

## Requisitos

- `bun`
- `ffmpeg` e `ffprobe` no PATH (`brew install ffmpeg`)

```bash
bun install
```

## Uso

Listar os horários disponíveis em uma data:

```bash
bun run index.ts 2026-07-29 --list
```

Gerar os vídeos de um horário:

```bash
bun run index.ts 2026-07-29 20:30
```

Saída — **um arquivo por lance**, nomeado pelo horário em que aconteceu:

```
output/placar-society/2026-07-29/20-30/
  01_20-02-49.mp4    1408x560 · 30s
  02_20-08-14.mp4    1408x560 · 30s
  …
```

Para também juntar tudo em um vídeo único (`completo.mp4`), use `--concat`:

```bash
bun run index.ts 2026-07-29 20:30 --concat
```

### Opções

| Opção | Padrão | Descrição |
|---|---|---|
| `-f, --field <slug>` | `placar-society` | Campo (o `fieldName` da URL do site) |
| `-l, --list` | — | Lista os horários da data e sai |
| `-c, --concat` | — | Gera também um `completo.mp4` com todos os lances |
| `-o, --out-dir <dir>` | `output` | Diretório de saída |
| `--downloads <dir>` | `downloads` | Diretório dos arquivos brutos |
| `-j, --concurrency <n>` | `4` | Downloads em paralelo |
| `--crf <n>` | `20` | Qualidade x264 (menor = melhor) |
| `--preset <p>` | `veryfast` | Preset x264 |
| `--fps <n>` | `30` | FPS de saída |

O horário aceita `20:30`, `2030` ou `20h30`.

## Como funciona

1. **`src/api.ts`** — consulta `GET https://replays.replaybr.com.br/available-hours?fieldName=…&date=…`, que devolve `{ replays: [{ timestamp, camera1_url, camera2_url }] }`, e agrupa os replays em slots de 30 minutos.

   O agrupamento reproduz a lógica do site: um replay antes dos `:30` pertence ao slot da **hora anterior**, exceto na primeira hora com replays no dia. Por isso o slot `20:30` cobre 20:30–21:29.

2. **`src/download.ts`** — baixa `camera1.mp4` e `camera2.mp4` de cada replay (~7 MB cada, 30s, 704x560, sem áudio), com paralelismo limitado. Arquivos já baixados são reaproveitados.

3. **`src/ffmpeg.ts`** — para cada replay, normaliza as câmeras para o mesmo tamanho e faz `hstack` (1408x560), gerando um arquivo por lance. Com `--concat`, junta os clipes com o concat demuxer sem recodificar — o que só funciona porque todos foram codificados com parâmetros idênticos.

### Câmera única

`camera2_url` é opcional **por lance**, não por campo: `four-play-1` não tem nenhuma segunda câmera, e `four-play-2` tem em apenas 7 dos 44 lances de um dia. A regra é decidida por horário:

- Se **nenhum** lance do horário tem segunda câmera → os clipes saem em largura simples (704x560).
- Se **algum** tem → o quadro é duplo (1408x560) e os lances de câmera única ficam centralizados, com barras nas laterais.

Assim todos os clipes de um horário mantêm as mesmas dimensões, e o `--concat` sem recodificar continua válido.

A duração também varia por campo: `placar-society` grava ~30s por lance, enquanto `four-play-1` grava ~3s. O resumo ao final mede a duração real em vez de assumir.

### Estrutura de saída (gerada)

```
output/<campo>/<data>/<HH-MM>/
  01_20-02-49.mp4, 02_20-08-14.mp4, …   ← um vídeo por lance (câmera 1 | câmera 2)
  completo.mp4                          ← só com --concat

downloads/<campo>/<data>/<HH-MM>/
  raw/  01_camera1.mp4, 01_camera2.mp4, …   ← brutos, permitem reprocessar sem baixar de novo
```

## Desenvolvimento

O projeto é TypeScript puro. Bun executa os `.ts` diretamente, então **não há build step** — `tsc` é usado só para checagem de tipos e para o suporte no editor.

```bash
bun run typecheck
```

O `tsconfig.json` roda em modo `strict` com `noUncheckedIndexedAccess`, e `@types/bun` fornece os tipos das APIs do Bun (`Bun.write`, `Bun.spawn`, `Bun.file`).

```
index.ts          CLI: argumentos, validação, orquestração e progresso
src/api.ts        cliente da API + agrupamento em slots de 30min
src/download.ts   download paralelo com reaproveitamento de cache
src/ffmpeg.ts     hstack das duas câmeras + concat sem recodificar
```
