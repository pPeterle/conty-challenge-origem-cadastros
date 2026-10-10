import type { Source } from "./link.ts";

// Regra de atribuição, sem I/O. Recebe os toques do install e devolve a origem
// e um veredito por toque. Tudo que o cadastro grava sai daqui.

/** Ordem de desempate quando dois toques válidos têm o mesmo horário. */
export const TIE_PRIORITY: readonly Source[] = ["campanha", "indicacao", "comunidade"];

export type Origin = Source | "organico";

export type TouchReason =
  | "toque_mais_recente_na_janela"
  | "venceu_empate_por_prioridade"
  | "venceu_empate_por_click_id"
  | "perdeu_para_toque_mais_recente"
  | "empate_desfeito_por_prioridade"
  | "empate_desfeito_por_click_id"
  | "fora_da_janela"
  | "posterior_ao_cadastro"
  | "anterior_a_primeira_abertura"
  | "ja_usado_em_outro_cadastro";

export type OriginReason =
  | "toque_mais_recente_na_janela"
  | "venceu_empate_por_prioridade"
  | "venceu_empate_por_click_id"
  | "sem_toques"
  | "nenhum_toque_valido"
  | "install_desconhecido";

export interface TouchInput {
  id: number;
  clickId: string;
  source: Source;
  touchedAt: number;
  /** O toque já foi a origem de outro cadastro deste mesmo install. */
  usedBySignup?: string | null;
}

export interface DecisionInput {
  firstOpenAt: number | null;
  signupAt: number;
  windowMs: number;
  touches: TouchInput[];
}

export interface TouchVerdict {
  touchId: number;
  result: "venceu" | "perdeu";
  reason: TouchReason;
}

export interface Decision {
  origin: Origin;
  winnerTouchId: number | null;
  reason: OriginReason;
  windowStart: number | null;
  windowEnd: number | null;
  verdicts: TouchVerdict[];
}

const priorityOf = (s: Source) => TIE_PRIORITY.indexOf(s);

/** Ordena do melhor para o pior: mais recente, depois prioridade, depois click id. */
export function compareTouches(a: TouchInput, b: TouchInput): number {
  if (a.touchedAt !== b.touchedAt) return b.touchedAt - a.touchedAt;
  const p = priorityOf(a.source) - priorityOf(b.source);
  if (p !== 0) return p;
  return a.clickId < b.clickId ? -1 : a.clickId > b.clickId ? 1 : 0;
}

function ineligibleReason(t: TouchInput, input: DecisionInput, windowEnd: number): TouchReason | null {
  if (t.usedBySignup) return "ja_usado_em_outro_cadastro";
  if (t.touchedAt > input.signupAt) return "posterior_ao_cadastro";
  if (t.touchedAt < input.firstOpenAt!) return "anterior_a_primeira_abertura";
  if (t.touchedAt > windowEnd) return "fora_da_janela";
  return null;
}

export function decideAttribution(input: DecisionInput): Decision {
  if (input.firstOpenAt === null) {
    return {
      origin: "organico",
      winnerTouchId: null,
      reason: "install_desconhecido",
      windowStart: null,
      windowEnd: null,
      verdicts: [],
    };
  }

  const windowStart = input.firstOpenAt;
  const windowEnd = input.firstOpenAt + input.windowMs;
  const verdicts = new Map<number, TouchVerdict>();
  const eligible: TouchInput[] = [];

  for (const t of input.touches) {
    const reason = ineligibleReason(t, input, windowEnd);
    if (reason) verdicts.set(t.id, { touchId: t.id, result: "perdeu", reason });
    else eligible.push(t);
  }

  eligible.sort(compareTouches);
  const [winner, ...rest] = eligible;

  let originReason: OriginReason;
  if (!winner) {
    originReason = input.touches.length === 0 ? "sem_toques" : "nenhum_toque_valido";
  } else {
    // O vencedor diz se precisou de desempate, olhando só para o segundo colocado.
    const runnerUp = rest[0];
    let winReason: TouchReason & OriginReason = "toque_mais_recente_na_janela";
    if (runnerUp && runnerUp.touchedAt === winner.touchedAt) {
      winReason = runnerUp.source !== winner.source ? "venceu_empate_por_prioridade" : "venceu_empate_por_click_id";
    }
    originReason = winReason;
    verdicts.set(winner.id, { touchId: winner.id, result: "venceu", reason: winReason });
    for (const t of rest) {
      let reason: TouchReason = "perdeu_para_toque_mais_recente";
      if (t.touchedAt === winner.touchedAt) {
        reason = t.source !== winner.source ? "empate_desfeito_por_prioridade" : "empate_desfeito_por_click_id";
      }
      verdicts.set(t.id, { touchId: t.id, result: "perdeu", reason });
    }
  }

  return {
    origin: winner ? winner.source : "organico",
    winnerTouchId: winner ? winner.id : null,
    reason: originReason,
    windowStart,
    windowEnd,
    // Mantém a ordem de entrada para a auditoria ficar estável.
    verdicts: input.touches.map((t) => verdicts.get(t.id)!),
  };
}
