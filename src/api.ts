const API_BASE = "https://replays.replaybr.com.br";

/** Um lance gravado. Nem todo campo (nem todo lance) tem a segunda câmera. */
export interface Replay {
  /** ISO local sem timezone, ex: "2026-07-29T20:02:49" */
  timestamp: string;
  camera1_url: string;
  /** Ausente quando o lance foi gravado por uma câmera só. */
  camera2_url?: string;
}

export interface SlotGrouping {
  slots: Record<string, Replay[]>;
  /** Rótulos "HH:MM" ordenados. */
  keys: string[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Busca todos os replays de um campo em uma data (YYYY-MM-DD). */
export async function fetchReplaysForDate(
  fieldName: string,
  date: string,
): Promise<Replay[]> {
  const url = `${API_BASE}/available-hours?fieldName=${encodeURIComponent(
    fieldName,
  )}&date=${encodeURIComponent(date)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API respondeu ${res.status} ${res.statusText} para ${url}`);
  }

  const body = (await res.json()) as { replays?: Replay[] };
  return Array.isArray(body?.replays) ? body.replays : [];
}

/**
 * Agrupa replays em slots de 30 minutos, replicando a lógica do site.
 *
 * O slot não é simplesmente `floor(minuto/30)`: um replay antes dos :30 pertence
 * ao slot da hora anterior, exceto quando cai na primeira hora com replays no dia
 * (aí o slot é HH:00). É assim que o site rotula "20:30" cobrindo 20:30–21:29.
 */
export function groupReplaysIntoSlots(replays: Replay[]): SlotGrouping {
  const sorted = [...replays].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const slots: Record<string, Replay[]> = {};
  let firstHour: number | null = null;

  for (const replay of sorted) {
    // Timestamps vêm como ISO local ("2026-07-29T20:02:49"), sem timezone.
    // Fatiar a string evita qualquer conversão de fuso.
    const hour = Number(replay.timestamp.slice(11, 13));
    const minute = Number(replay.timestamp.slice(14, 16));

    if (firstHour === null) firstHour = hour;

    let slotHour: number;
    let slotMinute: number;
    if (minute < 30) {
      if (hour === firstHour) {
        slotHour = hour;
        slotMinute = 0;
      } else {
        slotHour = hour - 1;
        slotMinute = 30;
      }
    } else {
      slotHour = hour;
      slotMinute = 30;
    }

    const key = `${pad(slotHour)}:${pad(slotMinute)}`;
    (slots[key] ??= []).push(replay);
  }

  return { slots, keys: Object.keys(slots).sort() };
}
