/**
 * Google Chat カード(cardsV2)ビルダー。
 * カード UI は「確認ボタン」「提案の採否ボタン」の2種のみ(Phase 1)。
 * chat-gateway(応答)と batch(配信)の両方から使用する。
 */

export function reportConfirmCard(reportId: number | string, reportDate: string, content: string): unknown {
  return {
    cardId: `report-${reportId}`,
    card: {
      header: {
        title: `日報(${reportDate})`,
        subtitle: '内容を確認して「確認済みにする」を押してください',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: content } },
            {
              buttonList: {
                buttons: [
                  {
                    text: '確認済みにする',
                    onClick: {
                      action: {
                        function: 'confirm_report',
                        parameters: [{ key: 'reportId', value: String(reportId) }],
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

export function confirmedReportCard(reportDate: string, content: string): unknown {
  return {
    cardId: 'report-confirmed',
    card: {
      header: { title: `日報(${reportDate})`, subtitle: '確認済み ✓' },
      sections: [{ widgets: [{ textParagraph: { text: content } }] }],
    },
  };
}

export function suggestionCard(suggestionId: number | string, content: string): unknown {
  return {
    cardId: `suggestion-${suggestionId}`,
    card: {
      header: {
        title: '次アクションの提案',
        subtitle: '採用/見送りはあなたが決めてください',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: content } },
            {
              buttonList: {
                buttons: [
                  {
                    text: '採用する',
                    onClick: {
                      action: {
                        function: 'decide_suggestion',
                        parameters: [
                          { key: 'suggestionId', value: String(suggestionId) },
                          { key: 'decision', value: 'accepted' },
                        ],
                      },
                    },
                  },
                  {
                    text: '見送る',
                    onClick: {
                      action: {
                        function: 'decide_suggestion',
                        parameters: [
                          { key: 'suggestionId', value: String(suggestionId) },
                          { key: 'decision', value: 'rejected' },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

export function decidedSuggestionCard(content: string, decision: string): unknown {
  const label = decision === 'accepted' ? '採用 ✓' : '見送り';
  return {
    cardId: 'suggestion-decided',
    card: {
      header: {
        title: '次アクションの提案',
        subtitle: `${label}(理由を返信してもらえると、チームの知恵として記録されます)`,
      },
      sections: [{ widgets: [{ textParagraph: { text: content } }] }],
    },
  };
}
