import { describe, expect, it } from 'vitest';
import {
  actionName,
  actionParameters,
  messageText,
  normalizeChatEvent,
  wrapChatResponse,
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

describe('normalizeChatEvent(新方式アドオンイベント)', () => {
  it('messagePayload を MESSAGE に正規化する', () => {
    const { event, mode } = normalizeChatEvent({
      commonEventObject: { hostApp: 'CHAT' },
      chat: {
        user: { name: 'users/1', displayName: '山下', email: 'y@example.com' },
        messagePayload: {
          message: { text: 'こんにちは', argumentText: 'こんにちは' },
          space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' },
        },
      },
    });
    expect(mode).toBe('addon');
    expect(event.type).toBe('MESSAGE');
    expect(event.user?.email).toBe('y@example.com');
    expect(event.space?.name).toBe('spaces/AAA');
    expect(messageText(event)).toBe('こんにちは');
  });

  it('addedToSpacePayload を ADDED_TO_SPACE に正規化する', () => {
    const { event, mode } = normalizeChatEvent({
      chat: {
        user: { email: 'y@example.com' },
        addedToSpacePayload: { space: { name: 'spaces/BBB', spaceType: 'DIRECT_MESSAGE' } },
      },
    });
    expect(mode).toBe('addon');
    expect(event.type).toBe('ADDED_TO_SPACE');
    expect(event.space?.name).toBe('spaces/BBB');
  });

  it('buttonClickedPayload を CARD_CLICKED に正規化し、commonEventObject のパラメータを読む', () => {
    const { event, mode } = normalizeChatEvent({
      commonEventObject: {
        invokedFunction: 'confirm_report',
        parameters: { reportId: '42' },
      },
      chat: {
        user: { email: 'y@example.com' },
        buttonClickedPayload: { space: { name: 'spaces/CCC' } },
      },
    });
    expect(mode).toBe('addon');
    expect(event.type).toBe('CARD_CLICKED');
    expect(actionName(event)).toBe('confirm_report');
    expect(actionParameters(event)).toEqual({ reportId: '42' });
  });

  it('旧形式はそのまま classic として返す', () => {
    const { event, mode } = normalizeChatEvent({
      type: 'MESSAGE',
      user: { email: 'y@example.com' },
      message: { text: 'hi' },
    });
    expect(mode).toBe('classic');
    expect(event.type).toBe('MESSAGE');
  });
});

describe('wrapChatResponse', () => {
  it('classic はそのまま返す', () => {
    expect(wrapChatResponse('classic', { text: 'a' })).toEqual({ text: 'a' });
  });

  it('addon のテキスト応答は createMessageAction でラップする', () => {
    expect(wrapChatResponse('addon', { text: 'こんにちは' })).toEqual({
      hostAppDataAction: {
        chatDataAction: { createMessageAction: { message: { text: 'こんにちは' } } },
      },
    });
  });

  it('addon の UPDATE_MESSAGE は updateMessageAction でラップする', () => {
    const cards = [{ cardId: 'x' }];
    expect(
      wrapChatResponse('addon', { actionResponse: { type: 'UPDATE_MESSAGE' }, cardsV2: cards }),
    ).toEqual({
      hostAppDataAction: {
        chatDataAction: { updateMessageAction: { message: { cardsV2: cards } } },
      },
    });
  });

  it('addon の空応答は空オブジェクトのまま', () => {
    expect(wrapChatResponse('addon', {})).toEqual({});
    expect(wrapChatResponse('addon', undefined)).toEqual({});
  });
});
