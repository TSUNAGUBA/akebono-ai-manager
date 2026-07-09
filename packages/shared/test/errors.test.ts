import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES, isAppError } from '../src/errors.js';

describe('AppError', () => {
  it('コード・ステータス・詳細を保持する', () => {
    const err = new AppError(ERROR_CODES.AUTH_FORBIDDEN, '権限がありません', {
      status: 403,
      details: { role: 'member' },
    });
    expect(err.code).toBe('AIM-3004');
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ role: 'member' });
    expect(isAppError(err)).toBe(true);
  });

  it('ステータス未指定は 500', () => {
    const err = new AppError(ERROR_CODES.DB_QUERY_FAILED, 'query failed');
    expect(err.status).toBe(500);
  });

  it('エラーコードが一意である', () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
