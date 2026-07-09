import { vi } from 'vitest';
import type pg from 'pg';

/** テスト用モックプール。発行された SQL を記録し、responder の結果を返す。 */
export interface QueryCall {
  text: string;
  params: unknown[];
}

export type Responder = (
  text: string,
  params: unknown[],
) => { rows?: unknown[]; rowCount?: number } | Error | undefined;

export function createMockPool(responder: Responder = () => undefined): {
  pool: pg.Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const run = async (text: string, params: unknown[] = []): Promise<unknown> => {
    calls.push({ text, params });
    const result = responder(text, params);
    if (result instanceof Error) throw result;
    const rows = result?.rows ?? [];
    return { rows, rowCount: result?.rowCount ?? rows.length, command: '', oid: 0, fields: [] };
  };
  const client = { query: run, release: vi.fn() };
  const pool = { query: run, connect: async () => client } as unknown as pg.Pool;
  return { pool, calls };
}

/** 記録済みクエリから、SQL 断片に一致する最初の呼び出しを探す。 */
export function findCall(calls: QueryCall[], fragment: string): QueryCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

/** 記録済みクエリの中で、SQL 断片が最初に現れるインデックス(現れなければ -1)。 */
export function callIndex(calls: QueryCall[], fragment: string): number {
  return calls.findIndex((c) => c.text.includes(fragment));
}
