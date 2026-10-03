export type RateUnit = 'second' | 'minute';
export type RatePolicy = { rps: number; burst: number; unit?: RateUnit };
export type RateDraft = {
  unit: RateUnit;
  quantity: number | undefined;
  burst: number | undefined;
  customBurst: boolean;
  // Keep the exact stored rate when the displayed quantity has not changed.
  preservedRps: number | undefined;
  preservedQuantity: number | undefined;
};

const positiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export type RateText = (key:string, values?:Record<string,string|number>) => string;
export const unitLabel = (unit: RateUnit, text:RateText) => text(`unit.${unit}`);
export const policyUnit = (policy: RatePolicy): RateUnit => policy.unit === 'minute' ? 'minute' : 'second';
export const displayQuantity = (rps: number, unit: RateUnit) => unit === 'minute' ? rps * 60 : rps;

export function automaticBurst(quantity: number | undefined): number | undefined {
  if (!positiveFinite(quantity)) return undefined;
  const burst = Math.max(1, Math.ceil(quantity));
  return Number.isSafeInteger(burst) ? burst : undefined;
}

export function createRateDraft(policy?: RatePolicy | null): RateDraft {
  const unit = policy ? policyUnit(policy) : 'minute';
  const quantity = policy ? displayQuantity(policy.rps, unit) : 60;
  const burst = policy?.burst ?? automaticBurst(quantity);
  return { unit, quantity, burst, customBurst: burst !== automaticBurst(quantity), preservedRps: policy?.rps ?? 1, preservedQuantity: quantity };
}

function draftRps(draft: RateDraft): number | undefined {
  if (!positiveFinite(draft.quantity)) return undefined;
  const rps = draft.quantity === draft.preservedQuantity && draft.preservedRps !== undefined
    ? draft.preservedRps
    : draft.unit === 'minute' ? draft.quantity / 60 : draft.quantity;
  return positiveFinite(rps) ? rps : undefined;
}

export function draftPolicy(draft: RateDraft): (RatePolicy & {unit: RateUnit}) | null {
  const rps = draftRps(draft);
  const burst = draft.customBurst ? draft.burst : automaticBurst(draft.quantity);
  if (rps === undefined || typeof burst !== 'number' || !Number.isSafeInteger(burst) || burst < 1) return null;
  return { rps, burst, unit: draft.unit };
}

// A unit change is a display change. Preserve capacity even when the new
// automatic capacity differs, by making the previous capacity explicit.
export function changeRateUnit(draft: RateDraft, unit: RateUnit): RateDraft | null {
  if (unit === draft.unit) return draft;
  const rps = draftRps(draft);
  if (rps === undefined && positiveFinite(draft.quantity)) return null;
  const quantity = rps === undefined ? draft.quantity : displayQuantity(rps, unit);
  if (rps !== undefined && !positiveFinite(quantity)) return null;
  const burst = draft.customBurst ? draft.burst : automaticBurst(draft.quantity);
  return { ...draft, unit, quantity, burst, customBurst: draft.customBurst || burst !== automaticBurst(quantity), preservedRps: rps, preservedQuantity: quantity };
}

export function changeCustomBurst(draft: RateDraft, enabled: boolean): RateDraft {
  return { ...draft, customBurst: enabled, burst: enabled && !draft.customBurst ? automaticBurst(draft.quantity) : draft.burst };
}

export function formatRate(policy: RatePolicy, text:RateText, locale?:string): string {
  const unit = policyUnit(policy);
  return text('ui.rateValue',{quantity:displayQuantity(policy.rps,unit).toLocaleString(locale,{maximumSignificantDigits:21}),unit:unitLabel(unit,text)});
}
