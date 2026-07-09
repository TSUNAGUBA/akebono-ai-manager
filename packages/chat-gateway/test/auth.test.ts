import { describe, expect, it } from 'vitest';
import { allowedCallerEmails } from '../src/auth.js';

describe('allowedCallerEmails', () => {
  it('旧方式(chat@system)と新方式(gsuiteaddons サービスエージェント)の両方を許可する', () => {
    const emails = allowedCallerEmails('596615946398');
    expect(emails).toContain('chat@system.gserviceaccount.com');
    expect(emails).toContain('service-596615946398@gcp-sa-gsuiteaddons.iam.gserviceaccount.com');
    expect(emails).toHaveLength(2);
  });
});
