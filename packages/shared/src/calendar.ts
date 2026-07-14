import { optionalEnv } from './config.js';
import { getDelegatedAccessToken, SCOPES } from './google-auth.js';
import { logger } from './logger.js';
import { jstDateString, jstDateStringDaysAgo } from './time.js';

/**
 * Google カレンダー読み取り(要件 M2「朝: カレンダーとタスク状況を読み」/ v0.14 随時 QA)。
 * ドメイン全体委任で本人のプライマリカレンダーを参照する。
 * 朝の問いかけ配信(batch)と随時 QA の予定質問(chat-gateway)が共用する
 * (v0.14 で batch/src/calendar.ts から移設・一般化 — 開発原則3)。
 * CALENDAR_ENABLED=true かつ Workspace 側の委任設定が済むまでは無効(undefined を返し、
 * 呼び出し元は従来どおりカレンダーなしで動作する)。取得失敗も同様に非ブロッキング(開発原則4)。
 */
export function calendarEnabled(): boolean {
  return optionalEnv('CALENDAR_ENABLED', 'false') === 'true';
}

interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/**
 * 対象日(JST の YYYY-MM-DD)の予定を「HH:MM-HH:MM 件名」形式の複数行テキストで返す。
 * 対象日は timeMin / timeMax(JST の 0:00〜23:59)に反映される(v0.14 §2.3)。
 * 無効時・取得失敗時は undefined(呼び出し元はカレンダー文脈なしで継続する)。
 */
export async function fetchEventsText(
  email: string,
  dateJst: string,
): Promise<string | undefined> {
  if (!calendarEnabled()) return undefined;
  try {
    const token = await getDelegatedAccessToken(email, [SCOPES.CALENDAR_READONLY]);
    const params = new URLSearchParams({
      timeMin: `${dateJst}T00:00:00+09:00`,
      timeMax: `${dateJst}T23:59:59+09:00`,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '10',
      fields: 'items(summary,start,end)',
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('カレンダー取得に失敗しました(カレンダー文脈なしで継続)', {
        email,
        dateJst,
        status: res.status,
        body: body.slice(0, 200),
      });
      return undefined;
    }
    const json = (await res.json()) as { items?: CalendarEvent[] };
    const items = json.items ?? [];
    // 対象日が当日の場合は移設前(batch/src/calendar.ts)と同一の文言を返す:
    // 朝の問いかけ配信のプロンプト入力を v0.14 前後で変えない(下位互換 — 原則7)
    if (items.length === 0) {
      return dateJst === jstDateString() ? '(本日の予定はありません)' : '(この日の予定はありません)';
    }
    return items
      .map((e) => {
        const title = e.summary ?? '(無題)';
        if (e.start?.date !== undefined) return `- 終日 ${title}`;
        const hhmm = (iso?: string): string => (iso === undefined ? '' : iso.slice(11, 16));
        return `- ${hhmm(e.start?.dateTime)}-${hhmm(e.end?.dateTime)} ${title}`;
      })
      .join('\n');
  } catch (err) {
    logger.warn('カレンダー取得でエラーが発生しました(カレンダー文脈なしで継続)', {
      email,
      dateJst,
      error: String(err),
    });
    return undefined;
  }
}

/** 当日(JST)の予定テキスト。朝の問いかけ配信(batch)向けの薄いラッパー(呼び出し互換)。 */
export async function fetchTodayEventsText(email: string): Promise<string | undefined> {
  return fetchEventsText(email, jstDateString());
}

// ── 予定質問の検知(要件 v0.14)──────────────────────────────────────

/** 予定質問のキーワード(v0.14 §2.1)。 */
const SCHEDULE_KEYWORD_PATTERN = /(予定|カレンダー|スケジュール)/;

/** 本人のカレンダー参照であることの補助シグナル(自分への言及・日付語)。 */
const SELF_OR_DATE_PATTERN = /(私|わたし|自分|僕|今日|本日|明日|あした|あす|明後日|あさって)/;

/**
 * 予定質問のルールベース検知(v0.14 §2.1〜2.2)。構造の判定を LLM にさせない(v0.3 設計原則2)。
 * 予定質問なら参照すべき対象日(JST の YYYY-MM-DD)を返し、予定質問でなければ undefined を返す。
 *
 * 誤検知の抑制: 「予定」「スケジュール」は業務ドメインの質問(例: 「A社の納品スケジュールを
 * 教えて」)にも現れるため、これらのキーワード単独では発火させず、本人への言及(私・自分)
 * または日付語(今日・明日等)を伴う場合のみ本人カレンダーを参照する。無関係な QA に
 * 本人の予定が混入するのを防ぐ。「カレンダー」は本人カレンダー参照の意図が強い語のため
 * 単独でも発火させる(「カレンダーを確認して」)。
 *
 * 対象日の解決: 明後日・あさって → 翌々日 / 明日・あした・あす → 翌日 /
 * それ以外(今日・本日・無指定)→ 当日。
 * 「明後日」を先に判定し、「明日」系パターンとの部分一致の混同を防ぐ(優先順: 明後日 → 明日 → 既定)。
 */
export function detectScheduleQuestion(text: string): string | undefined {
  if (!SCHEDULE_KEYWORD_PATTERN.test(text)) return undefined;
  if (!/カレンダー/.test(text) && !SELF_OR_DATE_PATTERN.test(text)) return undefined;
  // jstDateStringDaysAgo は負数で未来日を返す(既存ヘルパーの再利用 — 開発原則3)
  if (/(明後日|あさって)/.test(text)) return jstDateStringDaysAgo(-2);
  if (/(明日|あした|あす)/.test(text)) return jstDateStringDaysAgo(-1);
  return jstDateString();
}
