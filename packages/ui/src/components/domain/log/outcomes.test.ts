import { describe, expect, test } from 'bun:test';
import { bodyRecordingEvidence, chainTransportOutcome, diagnosticExport, httpStatusLabel, parseStatusFilter, transportOutcome, transportExplanation } from './outcomes';
import type { ChainEntry, LogEntry } from '../../../api/logs';

const entry = (data: Partial<LogEntry> = {}): LogEntry => ({ id: 1, requestId: 'fixture', timestamp: 1,
  method: 'POST', path: '/test', status: 200, duration: 1, authSuccess: true, success: true, ...data });

describe('independent request outcomes', () => {
  for (const [status, outcome] of [[200, 'completed'], [200, 'cancelled'], [200, 'failed'], [500, 'completed']] as const) {
    test(`HTTP ${status}, transport ${outcome}`, () => {
      const log = entry({ status, transportOutcome: outcome, success: outcome === 'completed' });
      expect(httpStatusLabel(log.status)).toBe(String(status));
      expect(transportOutcome(log.transportOutcome)).toBe(outcome);
      expect(diagnosticExport(log).transportOutcome).toBe(outcome);
    });
  }
  test('legacy success and HTTP status cannot manufacture a transport outcome', () => {
    for (const success of [true, false]) expect(transportOutcome(entry({ success }).transportOutcome)).toBe('unknown');
    expect(httpStatusLabel(0)).toBe('—');
  });
  test('chain outcome uses final metadata, even when its representative row says the opposite', () => {
    const chain = { ...entry({ transportOutcome: 'failed' }), chainTransportOutcome: 'completed' } as ChainEntry;
    expect(chainTransportOutcome(chain)).toBe('completed');
    expect(chainTransportOutcome({ ...chain, chainTransportOutcome: undefined })).toBe('unknown');
  });
  test('JSON diagnostics preserve independent protocol result and raw codes', () => {
    expect(diagnosticExport(entry({ transportOutcome: 'completed', transportCode: 'RAW_CODE', protocolOutcome: 'failed', protocolCode: 'PROTOCOL_CODE' })))
      .toEqual({ transportOutcome: 'completed', transportCode: 'RAW_CODE', protocolOutcome: 'failed', protocolCode: 'PROTOCOL_CODE' });
  });
});

test('HTTP filter accepts exact values, repeated lists and complete HTTP classes', () => {
  expect(parseStatusFilter('200')).toBe(200);
  expect(parseStatusFilter('200,404，200')).toEqual([200, 404]);
  const values = parseStatusFilter('5xx,200') as number[];
  expect(values).toHaveLength(101); expect(values[0]).toBe(500); expect(values[99]).toBe(599); expect(values[100]).toBe(200);
  expect(parseStatusFilter('')).toBeUndefined();
  for (const value of ['200garbage', '99', '600', '2x', '200,wat']) expect(() => parseStatusFilter(value)).toThrow('logs.invalidStatus');
});

test('body evidence is historical, matches direction/type and never guesses absent causes', () => {
  const log = entry({ processingSteps: [
    { step: 'body_recording_skipped', timestamp: 1, detail: { type: 'original-request', reason: 'size_limit' } },
    { step: 'body_logging_incomplete', timestamp: 2, detail: { direction: 'response', reason: 'opaque_body_not_observed' } },
  ] });
  expect(bodyRecordingEvidence(log, 'original').key).toBe('logs.detail.bodySizeLimit');
  expect(bodyRecordingEvidence(log, 'response').key).toBe('logs.detail.bodyNotObserved');
  expect(bodyRecordingEvidence(log, 'transformed').key).toBe('logs.detail.bodyReasonUnknown');
  expect(bodyRecordingEvidence(entry(), 'response').key).toBe('logs.detail.bodyReasonUnknown');
  expect(bodyRecordingEvidence(entry({ processingSteps: [{ step: 'body_recording_skipped', timestamp: 1,
    detail: { type: 'request', reason: 'vendor_reason' } }] }), 'transformed')).toEqual({ key: 'logs.detail.bodySkipped', reason: 'vendor_reason' });
});

test('both locales name all independent outcomes and evidence messages', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const translations = await Bun.file(new URL(`../../../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(Object.keys(translations.logs.transport).sort()).toEqual(['cancelled', 'completed', 'failed', 'pending', 'unknown']);
    for (const key of ['bodyReasonUnknown', 'bodySizeLimit', 'bodyNotObserved', 'cancelSourceUnknown', 'protocolSeparate', 'requestTimeout', 'firstResponseTimeout', 'streamReadFailed', 'clientCancelled'])
      expect(translations.logs.detail[key]).toBeTruthy();
    expect(translations.dashboard.successRate).toBe(locale === 'zh-CN' ? '请求成功率' : 'Request Success Rate');
  }
});

test('transport explanations require recorded evidence and preserve unknown causes', () => {
  expect(transportExplanation('client_cancelled')).toBe('logs.detail.clientCancelled');
  expect(transportExplanation('request_timeout')).toBe('logs.detail.requestTimeout');
  expect(transportExplanation('vendor_failure')).toBeUndefined();
  expect(transportExplanation(undefined)).toBeUndefined();
});
