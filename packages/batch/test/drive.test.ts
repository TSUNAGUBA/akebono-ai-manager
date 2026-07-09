import { describe, expect, it } from 'vitest';
import { classifyDocument } from '../src/drive.js';

describe('classifyDocument(M1 標準フォーマット+v0.3 業界帰属)', () => {
  it('customer/{顧客ID}/profile.md → customer_profile', () => {
    expect(classifyDocument({ name: 'profile.md', path: 'customer/acme' })).toEqual({
      docType: 'customer_profile',
      customerId: 'acme',
      industryId: null,
    });
  });

  it('customer/{顧客ID}/glossary.md → glossary', () => {
    expect(classifyDocument({ name: 'glossary.md', path: 'customer/acme' })).toEqual({
      docType: 'glossary',
      customerId: 'acme',
      industryId: null,
    });
  });

  it('domain/{業界}/operations.md → domain_ops+業界帰属', () => {
    expect(classifyDocument({ name: 'operations.md', path: 'domain/logistics' })).toEqual({
      docType: 'domain_ops',
      customerId: null,
      industryId: 'logistics',
    });
  });

  it('domain 直下(業界セグメントなし)は industryId null', () => {
    expect(classifyDocument({ name: '共通.md', path: 'domain' })).toEqual({
      docType: 'domain_ops',
      customerId: null,
      industryId: null,
    });
  });

  it('judgement/decision-rules.md → decision_rules', () => {
    expect(classifyDocument({ name: 'decision-rules.md', path: 'judgement' })).toEqual({
      docType: 'decision_rules',
      customerId: null,
      industryId: null,
    });
  });

  it('judgement/analogy-library.md → analogy', () => {
    expect(classifyDocument({ name: 'analogy-library.md', path: 'judgement' })).toEqual({
      docType: 'analogy',
      customerId: null,
      industryId: null,
    });
  });

  it('フォーマット外はファイル名から推定し、既定は domain_ops', () => {
    expect(classifyDocument({ name: 'メモ.md', path: '' }).docType).toBe('domain_ops');
    expect(classifyDocument({ name: 'analogy集.md', path: '' }).docType).toBe('analogy');
  });
});
