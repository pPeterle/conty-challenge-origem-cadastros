import { HOUR } from "./clock.ts";

export interface AttributionConfig {
  /** Janela de validade, contada a partir do first_open_at do install. */
  windowMs: number;
  /** Endereço que abre o app (universal link / app link). O redirecionador manda o clique para cá. */
  appLinkBase: string;
}

export const DEFAULT_WINDOW_HOURS = 168;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AttributionConfig {
  const hours = Number(env.ATTRIBUTION_WINDOW_HOURS ?? DEFAULT_WINDOW_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`ATTRIBUTION_WINDOW_HOURS inválido: ${env.ATTRIBUTION_WINDOW_HOURS}`);
  }
  return {
    windowMs: hours * HOUR,
    appLinkBase: env.APP_LINK_BASE ?? "https://conty.app/abrir",
  };
}
