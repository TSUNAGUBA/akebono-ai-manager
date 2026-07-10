import { describe, expect, it } from 'vitest';
import {
  isJstWeekday,
  jstDateKey,
  jstDateString,
  jstDateStringDaysAgo,
  jstDateTimeString,
  jstDayOfWeek,
} from '../src/time.js';

describe('JST 日付ユーティリティ', () => {
  // UTC 2026-07-08 16:00 = JST 2026-07-09 01:00(水曜→木曜の境界確認)
  const utcEvening = new Date('2026-07-08T16:00:00Z');
  // UTC 2026-07-08 14:00 = JST 2026-07-08 23:00
  const utcAfternoon = new Date('2026-07-08T14:00:00Z');

  it('日付境界をまたぐケースで JST の日付を返す', () => {
    expect(jstDateString(utcEvening)).toBe('2026-07-09');
    expect(jstDateString(utcAfternoon)).toBe('2026-07-08');
  });

  it('YYYYMMDD 形式の date_key を返す', () => {
    expect(jstDateKey(utcEvening)).toBe(20260709);
  });

  it('JST の日時文字列(YYYY-MM-DD HH:MM)を返す', () => {
    expect(jstDateTimeString(utcEvening)).toBe('2026-07-09 01:00');
    expect(jstDateTimeString(utcAfternoon)).toBe('2026-07-08 23:00');
  });

  it('JST の曜日を返す(2026-07-09 は木曜)', () => {
    expect(jstDayOfWeek(utcEvening)).toBe(4);
    expect(isJstWeekday(utcEvening)).toBe(true);
  });

  it('土日は平日でない(2026-07-11 は土曜)', () => {
    expect(isJstWeekday(new Date('2026-07-11T03:00:00Z'))).toBe(false);
  });

  it('N日前の日付文字列を返す', () => {
    expect(jstDateStringDaysAgo(7, utcEvening)).toBe('2026-07-02');
  });
});
