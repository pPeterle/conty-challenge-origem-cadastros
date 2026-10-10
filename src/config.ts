import { DAY, HOUR, MINUTE } from "./clock.ts";
import type { FirstOpenLimits } from "./attribution.ts";

export interface AttributionConfig {
  /** Janela de validade, contada a partir do first_open_at do install. */
  windowMs: number;
  /** Endereço que abre o app (universal link / app link). O redirecionador manda o clique para cá. */
  appLinkBase: string;
  /** Quando aceitar o first_open_at informado pelo aparelho. */
  firstOpen: FirstOpenLimits;
}

export const DEFAULT_FIRST_OPEN_LIMITS: FirstOpenLimits = { maxFutureMs: 5 * MINUTE, maxAgeMs: 30 * DAY };

export const DEFAULT_WINDOW_HOURS = 168;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AttributionConfig {
  const hours = Number(env.ATTRIBUTION_WINDOW_HOURS ?? DEFAULT_WINDOW_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`ATTRIBUTION_WINDOW_HOURS inválido: ${env.ATTRIBUTION_WINDOW_HOURS}`);
  }
  return {
    windowMs: hours * HOUR,
    appLinkBase: env.APP_LINK_BASE ?? "https://conty.app/abrir",
    firstOpen: DEFAULT_FIRST_OPEN_LIMITS,
  };
}
