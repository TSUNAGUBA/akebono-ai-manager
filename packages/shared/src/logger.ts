import { isAppError } from './errors.js';

/**
 * Cloud Logging 互換の構造化ログ(JSON Lines)。
 * `severity` フィールドは Cloud Logging が重大度として解釈する。
 */
type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

function emit(severity: Severity, message: string, fields: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    severity,
    message,
    service: process.env['K_SERVICE'] ?? process.env['SERVICE_NAME'] ?? 'local',
    time: new Date().toISOString(),
    ...fields,
  };
  // eslint 不使用のため注記: 構造化ログの出力先は標準出力(Cloud Run の規約)
  console.log(JSON.stringify(entry));
}

function errorFields(err: unknown): Record<string, unknown> {
  if (isAppError(err)) {
    return {
      errorCode: err.code,
      errorMessage: err.message,
      errorDetails: err.details,
      stack: err.stack,
    };
  }
  if (err instanceof Error) {
    return { errorMessage: err.message, stack: err.stack };
  }
  return { errorMessage: String(err) };
}

export const logger = {
  debug(message: string, fields: Record<string, unknown> = {}): void {
    emit('DEBUG', message, fields);
  },
  info(message: string, fields: Record<string, unknown> = {}): void {
    emit('INFO', message, fields);
  },
  warn(message: string, fields: Record<string, unknown> = {}): void {
    emit('WARNING', message, fields);
  },
  error(message: string, err?: unknown, fields: Record<string, unknown> = {}): void {
    emit('ERROR', message, { ...(err === undefined ? {} : errorFields(err)), ...fields });
  },
};
