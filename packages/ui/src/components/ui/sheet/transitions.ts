import { fade, fly, type FadeParams, type FlyParams } from 'svelte/transition';

function motionDuration(duration: number | undefined) {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
}

export function sheetSlide(node: Element, params: FlyParams) {
  return fly(node, { ...params, duration: motionDuration(params.duration) });
}

export function sheetFade(node: Element, params: FadeParams) {
  return fade(node, { ...params, duration: motionDuration(params.duration) });
}
