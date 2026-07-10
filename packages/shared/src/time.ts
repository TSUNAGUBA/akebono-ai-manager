/**
 * JST(Asia/Tokyo)の日付ユーティリティ。
 * JST は夏時間がないため UTC+9 固定のオフセット計算で扱える。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJst(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

/** JST での日付文字列 'YYYY-MM-DD' */
export function jstDateString(date: Date = new Date()): string {
  return toJst(date).toISOString().slice(0, 10);
}

/** JST での日時文字列 'YYYY-MM-DD HH:MM'(ダッシュボードの to_char 表示と同形式) */
export function jstDateTimeString(date: Date = new Date()): string {
  return toJst(date).toISOString().slice(0, 16).replace('T', ' ');
}

/** JST での日付キー YYYYMMDD(dwh.dim_date.date_key と同形式) */
export function jstDateKey(date: Date = new Date()): number {
  return Number(jstDateString(date).replaceAll('-', ''));
}

/** JST での曜日(0=日曜〜6=土曜) */
export function jstDayOfWeek(date: Date = new Date()): number {
  return toJst(date).getUTCDay();
}

/** JST での平日判定(祝日は考慮しない。バッチの起動は Cloud Scheduler の cron 側でも制御する) */
export function isJstWeekday(date: Date = new Date()): boolean {
  const dow = jstDayOfWeek(date);
  return dow >= 1 && dow <= 5;
}

/** 指定日数前の JST 日付文字列 */
export function jstDateStringDaysAgo(days: number, from: Date = new Date()): string {
  return jstDateString(new Date(from.getTime() - days * 24 * 60 * 60 * 1000));
}
