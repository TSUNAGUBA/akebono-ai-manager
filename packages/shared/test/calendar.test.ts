import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calendarEnabled,
  detectScheduleQuestion,
  fetchEventsText,
  fetchTodayEventsText,
} from '../src/calendar.js';
import { SCOPES } from '../src/google-auth.js';
import { jstDateString, jstDateStringDaysAgo } from '../src/time.js';

const mocks = vi.hoisted(() => ({
  getDelegatedAccessToken: vi.fn(async () => 'delegated-token'),
}));

vi.mock('../src/google-auth.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/google-auth.js')>();
  return { ...mod, getDelegatedAccessToken: mocks.getDelegatedAccessToken };
});

const fetchMock = vi.fn();

/** Calendar API の正常応答を模す。 */
function okResponse(items: unknown[]): unknown {
  return { ok: true, json: async () => ({ items }) };
}

beforeEach(() => {
  mocks.getDelegatedAccessToken.mockClear();
  fetchMock.mockReset().mockResolvedValue(okResponse([]));
  vi.stubGlobal('fetch', fetchMock);
  process.env['CALENDAR_ENABLED'] = 'true';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['CALENDAR_ENABLED'];
});

describe('fetchEventsText(対象日のカレンダー取得 — v0.14 で batch から共通化)', () => {
  it('対象日が timeMin / timeMax(JST の 0:00〜23:59)に反映される', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        {
          summary: 'A社定例',
          start: { dateTime: '2026-07-14T10:00:00+09:00' },
          end: { dateTime: '2026-07-14T11:00:00+09:00' },
        },
      ]),
    );

    const text = await fetchEventsText('tanaka@example.com', '2026-07-14');

    expect(text).toBe('- 10:00-11:00 A社定例');
    // 委任トークンは本人メール+calendar.readonly スコープで要求される
    expect(mocks.getDelegatedAccessToken).toHaveBeenCalledWith('tanaka@example.com', [
      SCOPES.CALENDAR_READONLY,
    ]);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('timeMin')).toBe('2026-07-14T00:00:00+09:00');
    expect(url.searchParams.get('timeMax')).toBe('2026-07-14T23:59:59+09:00');
  });

  it('終日予定と予定なしを整形する', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([{ summary: '棚卸し', start: { date: '2026-07-14' } }]));
    expect(await fetchEventsText('tanaka@example.com', '2026-07-14')).toBe('- 終日 棚卸し');

    fetchMock.mockResolvedValueOnce(okResponse([]));
    expect(await fetchEventsText('tanaka@example.com', '2026-07-15')).toBe(
      '(この日の予定はありません)',
    );
  });

  it('CALENDAR_ENABLED 無効時は API を呼ばず undefined を返す', async () => {
    delete process.env['CALENDAR_ENABLED'];
    expect(calendarEnabled()).toBe(false);

    const text = await fetchEventsText('tanaka@example.com', '2026-07-14');

    expect(text).toBeUndefined();
    expect(mocks.getDelegatedAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('API が HTTP エラーを返しても undefined で継続する(非ブロッキング — 原則4)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'forbidden' });
    expect(await fetchEventsText('tanaka@example.com', '2026-07-14')).toBeUndefined();
  });

  it('取得が例外を投げても undefined で継続する(非ブロッキング — 原則4)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await fetchEventsText('tanaka@example.com', '2026-07-14')).toBeUndefined();
  });

  it('fetchTodayEventsText は当日(JST)を対象日として渡す(batch の呼び出し互換)', async () => {
    await fetchTodayEventsText('tanaka@example.com');

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('timeMin')).toBe(`${jstDateString()}T00:00:00+09:00`);
  });
});

describe('detectScheduleQuestion(予定質問のルールベース検知 — v0.14)', () => {
  it('「明日」は翌日(JST)に解決する', () => {
    expect(detectScheduleQuestion('私の明日の予定を確認して')).toBe(jstDateStringDaysAgo(-1));
    expect(detectScheduleQuestion('あしたのスケジュールは?')).toBe(jstDateStringDaysAgo(-1));
    expect(detectScheduleQuestion('あすの予定を教えて')).toBe(jstDateStringDaysAgo(-1));
  });

  it('「明後日」は翌々日(JST)に解決する(「明日」より先に判定する)', () => {
    expect(detectScheduleQuestion('明後日の予定は?')).toBe(jstDateStringDaysAgo(-2));
    expect(detectScheduleQuestion('あさってのカレンダーを見て')).toBe(jstDateStringDaysAgo(-2));
    // 両方に言及した場合も「明後日」を優先する(部分一致の混同防止)
    expect(detectScheduleQuestion('明日と明後日の予定は?')).toBe(jstDateStringDaysAgo(-2));
  });

  it('今日・本日・日付の無指定は当日(JST)に解決する', () => {
    expect(detectScheduleQuestion('今日の予定を教えて')).toBe(jstDateString());
    expect(detectScheduleQuestion('本日のスケジュールは?')).toBe(jstDateString());
    expect(detectScheduleQuestion('カレンダーを確認して')).toBe(jstDateString());
  });

  it('予定キーワード(予定/カレンダー/スケジュール)を含まなければ undefined', () => {
    expect(detectScheduleQuestion('在庫の一般的な考え方を教えて')).toBeUndefined();
    expect(detectScheduleQuestion('明日までにA社の見積もりをお願いします')).toBeUndefined();
  });
});
