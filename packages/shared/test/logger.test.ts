import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import { logger } from '../src/logger.js';

describe('logger.error の cause 出力', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function lastEntry(): Record<string, unknown> {
    const line = spy.mock.calls.at(-1)?.[0] as string;
    return JSON.parse(line) as Record<string, unknown>;
  }

  it('AppError の cause(pg エラーの code/detail)をログに含める', () => {
    const pgError = Object.assign(new Error('permission denied for table projects'), {
      code: '42501',
      detail: 'テーブルへの SELECT 権限がありません',
    });
    const err = new AppError('AIM-2002', 'DB クエリの実行に失敗しました', { cause: pgError });
    logger.error('ページ描画に失敗しました', err);

    const entry = lastEntry();
    expect(entry['errorCode']).toBe('AIM-2002');
    const cause = entry['errorCause'] as Record<string, unknown>;
    expect(cause['message']).toBe('permission denied for table projects');
    expect(cause['code']).toBe('42501');
    expect(cause['detail']).toBe('テーブルへの SELECT 権限がありません');
  });

  it('cause が無ければ errorCause を出力しない', () => {
    logger.error('失敗', new AppError('AIM-2002', 'x'));
    expect('errorCause' in lastEntry()).toBe(false);
  });

  it('ネストした cause は深さ 3 で打ち切る(循環対策)', () => {
    const level3 = new Error('level3');
    const level2 = new Error('level2', { cause: level3 });
    const level1 = new Error('level1', { cause: level2 });
    logger.error('失敗', new AppError('AIM-2002', 'x', { cause: level1 }));
    const entry = lastEntry();
    const c1 = entry['errorCause'] as Record<string, unknown>;
    expect(c1['message']).toBe('level1');
    const c2 = c1['cause'] as Record<string, unknown>;
    expect(c2['message']).toBe('level2');
    const c3 = c2['cause'] as Record<string, unknown>;
    expect(c3['message']).toBe('level3');
    expect(c3['cause']).toBeUndefined();
  });
});
