import { expect, test } from 'bun:test';
import { TokenStatsPricingService, TokenStatsPlugin } from '../../server';
import type { TokenStatsPricing, TokenStatsPricingInput } from '../../server/pricing';
import { PluginServiceHost, TOKEN_PRICING_SERVICE_ID, type TokenMeteringResult, type TokenMeteringService, type TokenMeteringSubscription, type TokenPricingService } from '../../../../packages/core/src/plugin-services';
import type { PluginStorage, TokenStatsAttempt } from '../../../../packages/core/src/plugin.types.ts';

const result = (extra: Partial<TokenMeteringResult> = {}): TokenMeteringResult => ({
  requestId: 'request', attemptId: 'attempt', keyId: 'trusted-key', routeId: 'route', upstreamId: 'upstream', provider: 'openai',
  pricingProvider: 'xai', model: 'grok', inputTokens: 10, outputTokens: 5,
  inputSource: 'official', outputSource: 'official', inputAuthority: 'official', outputAuthority: 'official',
  complete: true, observationIncomplete: false, outcome: 'completed', finishedAtMs: Date.now(), settlementVersion: 1, ...extra,
});

function pricingFixture() {
  let raw: number | null = 0.1234567894;
  const inputs: TokenStatsPricingInput[] = [];
  const pricing = { async ready() {}, start() {}, stop() {}, estimate(input: TokenStatsPricingInput) {
    inputs.push(input);
    return !input.model || input.model === 'unknown' || input.inputTokens === undefined || input.outputTokens === undefined ? null
      : input.inputTokens === 0 && input.outputTokens === 0 ? 0 : raw;
  } } as unknown as TokenStatsPricing;
  return { pricing, inputs, setPrice: (value: number | null) => { raw = value; } };
}

test('shared public pricing service pins one result for reporting and budget through catalog refresh', async () => {
  const f = pricingFixture(); const host = new PluginServiceHost();
  let subscriber!: TokenMeteringSubscription; const rows: TokenStatsAttempt[] = [];
  let rowReady!: () => void; const written = new Promise<void>(resolve => { rowReady = resolve; });
  const meteringServices = host.createContext('token-metering');
  meteringServices.publish('token-metering.v1', 1, { subscribe: (subscription: TokenMeteringSubscription) => { subscriber = subscription; return () => {}; } } as TokenMeteringService);
  host.markReady('token-metering');
  const storage = { async get() { return null; }, metering: { async recordAttempt(row: TokenStatsAttempt) { rows.push(row); rowReady(); } } } as unknown as PluginStorage;
  const plugin = new TokenStatsPlugin({}, () => f.pricing);
  await plugin.init({ config: {}, storage, logger: {debug() {},info() {},warn() {},error() {}}, services: host.createContext('token-stats', 'global', {'token-metering':'^1.0.0'}) });
  host.markReady('token-stats');
  const pricing = host.createContext('budget', 'global', {'token-stats':'^3.2.0'}).consume<TokenPricingService>('token-stats', TOKEN_PRICING_SERVICE_ID, 1);
  expect(Object.keys(pricing).sort()).toEqual(['canPrice', 'price']);
  try {
    const input = result();
    await subscriber.onResult(input);
    const cost = await pricing.price(input);
    f.setPrice(9);
    expect(await pricing.price({...input})).toEqual(cost);
    await written;
    expect(cost).toEqual({costUsd:0.123456789,costNanoUsd:123456789});
    expect(rows[0]).toMatchObject({cost_usd:cost.costUsd,key_id:'trusted-key'});
    expect(f.inputs).toHaveLength(1);
    expect(await pricing.price({...input,settlementVersion:2})).toEqual({costUsd:9,costNanoUsd:9e9});
  } finally { await plugin.onDestroy(); }
});

test('unknown prices stay null, real zero stays zero, overflow is rejected and revised usage gets repriced', async () => {
  const f = pricingFixture(); const service = new TokenStatsPricingService(f.pricing);
  expect(await service.canPrice({model:'grok',pricingProvider:'xai'})).toBe(true);
  expect(await service.canPrice({model:'unknown'})).toBe(false);
  expect(await service.price(result({model:'unknown'}))).toEqual({costUsd:null,costNanoUsd:null});
  f.setPrice(0);
  expect(await service.price(result())).toEqual({costUsd:0,costNanoUsd:0});
  f.setPrice(Number.MAX_SAFE_INTEGER);
  expect(await service.price(result({settlementVersion:2}))).toEqual({costUsd:null,costNanoUsd:null});
  f.setPrice(-1e-12);
  expect(await service.price(result({settlementVersion:3}))).toEqual({costUsd:null,costNanoUsd:null});
  f.setPrice(2);
  expect(await service.price(result({inputTokens:11}))).toEqual({costUsd:2,costNanoUsd:2e9});
  expect(await service.price(result({outcome:'aborted',outputSource:'partial',outputAuthority:'partial'}))).toEqual({costUsd:null,costNanoUsd:null});
});

test('pricing cache is bounded and retains consistent concurrent in-flight results', async () => {
  const f = pricingFixture(); const service = new TokenStatsPricingService(f.pricing);
  const first = service.price(result());
  expect(service.price({...result()})).toBe(first);
  await first;
  for (let i=0; i<2048; i++) await service.price(result({attemptId:`attempt-${i}`}));
  f.setPrice(3);
  expect((await service.price(result())).costUsd).toBe(3);
  expect(f.inputs).toHaveLength(2050);
});
