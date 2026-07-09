import { describe, expect, it } from 'vitest';
import { checksum, sortRepeatableFiles, sortVersionedFiles } from '../src/files.js';

describe('sortVersionedFiles', () => {
  it('バージョン順にソートする', () => {
    expect(
      sortVersionedFiles(['0003_dwh_schema.sql', '0001_ops_schema.sql', '0002_rag_schema.sql']),
    ).toEqual(['0001_ops_schema.sql', '0002_rag_schema.sql', '0003_dwh_schema.sql']);
  });

  it('命名規約違反を拒否する', () => {
    expect(() => sortVersionedFiles(['1_bad.sql'])).toThrowError(/規約/);
    expect(() => sortVersionedFiles(['0001-bad.sql'])).toThrowError(/規約/);
  });

  it('バージョン番号の重複を拒否する', () => {
    expect(() => sortVersionedFiles(['0001_a.sql', '0001_b.sql'])).toThrowError(/重複/);
  });
});

describe('sortRepeatableFiles', () => {
  it('番号順にソートする', () => {
    expect(sortRepeatableFiles(['20_daily_etl.sql', '10_dwh_views.sql'])).toEqual([
      '10_dwh_views.sql',
      '20_daily_etl.sql',
    ]);
  });

  it('命名規約違反を拒否する', () => {
    expect(() => sortRepeatableFiles(['daily_etl.sql'])).toThrowError(/規約/);
  });
});

describe('checksum', () => {
  it('内容が同じなら同一、異なれば別のハッシュ', () => {
    expect(checksum('SELECT 1;')).toBe(checksum('SELECT 1;'));
    expect(checksum('SELECT 1;')).not.toBe(checksum('SELECT 2;'));
  });
});
