/**
 * Google Chat カード(cardsV2)ビルダー。
 * カード UI: 日報確認 / 提案の採否 / タスク承認・完了確認(M3) / エスカレーション裁定(M6)。
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

// ── タスクオーケストレーション(M3)──────────────────────────────

export interface TaskApprovalCardInput {
  title: string;
  assigneeName: string;
  dueDate?: string;
  estimatedHours?: number;
  projectName?: string;
  subtasks: string[];
  expectedOutcome?: string;
}

/** 管理者向け: AI 分解結果の承認カード(承認して配信 / 却下)。 */
export function taskApprovalCard(taskId: number | string, input: TaskApprovalCardInput): unknown {
  const lines = [
    `<b>担当案:</b> ${input.assigneeName}`,
    `<b>期限案:</b> ${input.dueDate ?? '(未定)'}`,
  ];
  if (input.estimatedHours !== undefined) lines.push(`<b>見積工数:</b> 約${input.estimatedHours}時間`);
  if (input.projectName !== undefined) lines.push(`<b>プロジェクト:</b> ${input.projectName}`);
  if (input.subtasks.length > 0) {
    lines.push('', '<b>分解案:</b>', ...input.subtasks.map((s, i) => `${i + 1}. ${s}`));
  }
  if (input.expectedOutcome !== undefined) {
    lines.push('', '<b>期待成果:</b>', input.expectedOutcome);
  }

  return {
    cardId: `task-${taskId}`,
    card: {
      header: {
        title: `タスク案: ${input.title}`,
        subtitle: '内容を確認して、承認または却下してください',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: lines.join('\n') } },
            {
              buttonList: {
                buttons: [
                  {
                    text: '承認して配信',
                    onClick: {
                      action: {
                        function: 'decide_task',
                        parameters: [
                          { key: 'taskId', value: String(taskId) },
                          { key: 'decision', value: 'approve' },
                        ],
                      },
                    },
                  },
                  {
                    text: '却下',
                    onClick: {
                      action: {
                        function: 'decide_task',
                        parameters: [
                          { key: 'taskId', value: String(taskId) },
                          { key: 'decision', value: 'reject' },
                        ],
                      },
                    },
                  },
                ],
              },
            },
            {
              textParagraph: {
                text: '<i>内容を修正したい場合は「却下」を押して、修正した指示を出し直してください。</i>',
              },
            },
          ],
        },
      ],
    },
  };
}

const TASK_STATUS_LABELS: Record<string, string> = {
  proposed: '承認待ち',
  approved: '承認済み ✓',
  in_progress: '進行中',
  blocked: '停滞中',
  done: '完了 ✓',
  cancelled: '却下(指示を出し直してください)',
};

/** タスクの現在状態を表示するカード(承認・却下後の差し替え、2度押し時の表示に使う)。 */
export function taskStateCard(title: string, status: string, note?: string): unknown {
  const widgets: unknown[] = [];
  if (note !== undefined && note !== '') widgets.push({ textParagraph: { text: note } });
  return {
    cardId: 'task-decided',
    card: {
      header: {
        title: `タスク: ${title}`,
        subtitle: TASK_STATUS_LABELS[status] ?? status,
      },
      ...(widgets.length > 0 ? { sections: [{ widgets }] } : {}),
    },
  };
}

/** メンバー向け: 完了申告の確認カード(このタスクの完了として記録しますか?)。 */
export function taskDoneConfirmCard(taskId: number | string, title: string): unknown {
  return {
    cardId: `task-done-${taskId}`,
    card: {
      header: {
        title: 'タスク完了の確認',
        subtitle: '報告内容から該当しそうなタスクを見つけました',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: `「${title}」をこのタスクの完了として記録しますか?` } },
            {
              buttonList: {
                buttons: [
                  {
                    text: '完了として記録',
                    onClick: {
                      action: {
                        function: 'confirm_task_done',
                        parameters: [
                          { key: 'taskId', value: String(taskId) },
                          { key: 'decision', value: 'done' },
                        ],
                      },
                    },
                  },
                  {
                    text: '記録しない',
                    onClick: {
                      action: {
                        function: 'confirm_task_done',
                        parameters: [
                          { key: 'taskId', value: String(taskId) },
                          { key: 'decision', value: 'dismiss' },
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

// ── エスカレーション(M6)────────────────────────────────────────

const ESCALATION_REASON_LABELS: Record<string, string> = {
  low_confidence: 'AIの確信度低',
  customer_impact: '顧客影響',
  member_anomaly: 'メンバー異常シグナル',
  priority_conflict: '優先度の競合',
};

export function escalationReasonLabel(reason: string): string {
  return ESCALATION_REASON_LABELS[reason] ?? reason;
}

/** 管理者向け: エスカレーション通知カード(裁定を記録ボタン付き)。 */
export function escalationCard(escalationId: number | string, reason: string, context: string): unknown {
  return {
    cardId: `escalation-${escalationId}`,
    card: {
      header: {
        title: `⚠️ エスカレーション(${escalationReasonLabel(reason)})`,
        subtitle: '裁定を記録すると、判断基準ナレッジへ還流されます',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: context.slice(0, 500) } },
            {
              buttonList: {
                buttons: [
                  {
                    text: '裁定を記録',
                    onClick: {
                      action: {
                        function: 'record_resolution',
                        parameters: [{ key: 'escalationId', value: String(escalationId) }],
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

/** 「裁定を記録」押下後のカード(次のメッセージを裁定として受け付ける状態)。 */
export function escalationRecordingCard(
  escalationId: number | string,
  reason: string,
  context: string,
): unknown {
  return {
    cardId: `escalation-${escalationId}`,
    card: {
      header: {
        title: `⚠️ エスカレーション(${escalationReasonLabel(reason)})`,
        subtitle: '次のメッセージを裁定として記録します(15分以内。「キャンセル」と送ると中止できます)',
      },
      sections: [{ widgets: [{ textParagraph: { text: context.slice(0, 500) } }] }],
    },
  };
}

/** 裁定記録済みのカード(記録完了後の差し替え表示)。 */
export function escalationResolvedCard(
  escalationId: number | string,
  reason: string,
  resolution: string,
): unknown {
  return {
    cardId: `escalation-${escalationId}`,
    card: {
      header: {
        title: `エスカレーション(${escalationReasonLabel(reason)})`,
        subtitle: '裁定済み ✓',
      },
      sections: [{ widgets: [{ textParagraph: { text: resolution.slice(0, 500) } }] }],
    },
  };
}

/**
 * 裁定は記録済みだがナレッジ還流に失敗した状態のカード(「ナレッジ還流を再試行」ボタン付き)。
 * ボタンは record_resolution アクションを再送し、card-action 側の再還流分岐
 * (status='resolved' かつ knowledge_reflected=false のときのみ再還流)に到達する。冪等。
 */
export function escalationRefluxRetryCard(
  escalationId: number | string,
  reason: string,
  resolution: string,
): unknown {
  return {
    cardId: `escalation-${escalationId}`,
    card: {
      header: {
        title: `エスカレーション(${escalationReasonLabel(reason)})`,
        subtitle: '裁定は記録済みです(ナレッジへの反映に失敗しました)',
      },
      sections: [
        {
          widgets: [
            { textParagraph: { text: resolution.slice(0, 500) } },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'ナレッジ還流を再試行',
                    onClick: {
                      action: {
                        function: 'record_resolution',
                        parameters: [{ key: 'escalationId', value: String(escalationId) }],
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
