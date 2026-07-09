import { getDelegatedAccessToken, jstDateString, logger, optionalEnv, SCOPES } from '@ai-manager/shared';

/**
 * Google カレンダー読み取り(要件 M2「朝: カレンダーとタスク状況を読み」)。
 * ドメイン全体委任で本人のプライマリカレンダーを参照する。
 * CALENDAR_ENABLED=true かつ Workspace 側の委任設定が済むまでは無効(undefined を返し、
 * 呼び出し元は従来どおりタスク状況のみで動作する)。取得失敗も同様に非ブロッキング。
 */
export function calendarEnabled(): boolean {
  return optionalEnv('CALENDAR_ENABLED', 'false') === 'true';
}

interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** 当日(JST)の予定を「HH:MM-HH:MM 件名」形式の複数行テキストで返す。 */
export async function fetchTodayEventsText(email: string): Promise<string | undefined> {
  if (!calendarEnabled()) return undefined;
  try {
    const day = jstDateString();
    const token = await getDelegatedAccessToken(email, [SCOPES.CALENDAR_READONLY]);
    const params = new URLSearchParams({
      timeMin: `${day}T00:00:00+09:00`,
      timeMax: `${day}T23:59:59+09:00`,
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
      logger.warn('カレンダー取得に失敗しました(タスク状況のみで継続)', {
        email,
        status: res.status,
        body: body.slice(0, 200),
      });
      return undefined;
    }
    const json = (await res.json()) as { items?: CalendarEvent[] };
    const items = json.items ?? [];
    if (items.length === 0) return '(本日の予定はありません)';
    return items
      .map((e) => {
        const title = e.summary ?? '(無題)';
        if (e.start?.date !== undefined) return `- 終日 ${title}`;
        const hhmm = (iso?: string): string => (iso === undefined ? '' : iso.slice(11, 16));
        return `- ${hhmm(e.start?.dateTime)}-${hhmm(e.end?.dateTime)} ${title}`;
      })
      .join('\n');
  } catch (err) {
    logger.warn('カレンダー取得でエラーが発生しました(タスク状況のみで継続)', {
      email,
      error: String(err),
    });
    return undefined;
  }
}
