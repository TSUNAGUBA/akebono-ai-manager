import { describe, expect, it } from 'vitest';
import {
  actionName,
  actionParameters,
  messageText,
  type ChatEvent,
} from '../src/chat-event.js';

describe('messageText', () => {
  it('argumentText(メンション除去済み)を優先する', () => {
    const event: ChatEvent = {
      type: 'MESSAGE',
      message: { text: '@AIマネージャー 種まきリストとは?', argumentText: ' 種まきリストとは? ' },
    };
    expect(messageText(event)).toBe('種まきリストとは?');
  });

  it('argumentText がなければ text を使う', () => {
    const event: ChatEvent = { type: 'MESSAGE', message: { text: 'おはようございます' } };
    expect(messageText(event)).toBe('おはようございます');
  });

  it('message が無ければ空文字', () => {
    expect(messageText({ type: 'MESSAGE' })).toBe('');
  });
});

describe('actionParameters / actionName', () => {
  it('旧形式(action.parameters)を読む', () => {
    const event: ChatEvent = {
      type: 'CARD_CLICKED',
      action: {
        actionMethodName: 'confirm_report',
        parameters: [{ key: 'reportId', value: '42' }],
      },
    };
    expect(actionName(event)).toBe('confirm_report');
    expect(actionParameters(event)).toEqual({ reportId: '42' });
  });

  it('新形式(common.invokedFunction)を優先する', () => {
    const event: ChatEvent = {
      type: 'CARD_CLICKED',
      action: { actionMethodName: 'old_name' },
      common: { invokedFunction: 'decide_suggestion', parameters: { decision: 'accepted' } },
    };
    expect(actionName(event)).toBe('decide_suggestion');
    expect(actionParameters(event)).toEqual({ decision: 'accepted' });
  });
});
