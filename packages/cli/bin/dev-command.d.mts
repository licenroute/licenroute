export const SESSION_FILE: string;
export const APP_FILE: string;
export function appEnv(base: Record<string, string | undefined>, port: number): Record<string, string>;
export function appCommand(real: string, entry: string, port: number): { file: string; args: string[]; display: string };
export function runDev(opts: unknown): Promise<number>;
