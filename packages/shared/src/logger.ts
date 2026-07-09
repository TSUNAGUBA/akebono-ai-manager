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

/**
 * cause チェーンを構造化ログ向けに要約する。
 * pg のエラー(SQLSTATE の code / detail / hint)を含めないと、
 * AIM-2002 の根本原因(権限か・カラム不存在か・接続か)がログから特定できない。
 */
function describeCause(cause: unknown, depth: number): unknown {
  if (cause === undefined || cause === null || depth >= 3) return undefined;
  if (cause instanceof Error) {
    const c = cause as Error & { code?: unknown; detail?: unknown; hint?: unknown; cause?: unknown };
    const described: Record<string, unknown> = { name: cause.name, message: cause.message };
    if (c.code !== undefined) described['code'] = c.code;
    if (c.detail !== undefined) described['detail'] = c.detail;
    if (c.hint !== undefined) described['hint'] = c.hint;
    const nested = describeCause(c.cause, depth + 1);
    if (nested !== undefined) described['cause'] = nested;
    return described;
  }
  return String(cause);
}

function errorFields(err: unknown): Record<string, unknown> {
  if (isAppError(err)) {
    const fields: Record<string, unknown> = {
      errorCode: err.code,
      errorMessage: err.message,
      errorDetails: err.details,
      stack: err.stack,
    };
    const cause = describeCause(err.cause, 0);
    if (cause !== undefined) fields['errorCause'] = cause;
    return fields;
  }
  if (err instanceof Error) {
    const fields: Record<string, unknown> = { errorMessage: err.message, stack: err.stack };
    const cause = describeCause((err as Error & { cause?: unknown }).cause, 0);
    if (cause !== undefined) fields['errorCause'] = cause;
    return fields;
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
