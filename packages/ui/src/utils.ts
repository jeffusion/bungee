import { twMerge } from "tailwind-merge";
import { clsx, type ClassValue } from "clsx";
import { cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

type FlyAndScaleParams = {
	y?: number;
	x?: number;
	start?: number;
	duration?: number;
};

const defaultFlyAndScaleParams = { y: -8, x: 0, start: 0.95, duration: 150 };

export const flyAndScale = (node: Element, params?: FlyAndScaleParams): TransitionConfig => {
	const style = getComputedStyle(node);
	const transform = style.transform === "none" ? "" : style.transform;
	const withDefaults = { ...defaultFlyAndScaleParams, ...params };

	const scaleConversion = (valueA: number, scaleA: [number, number], scaleB: [number, number]) => {
		const [minA, maxA] = scaleA;
		const [minB, maxB] = scaleB;

		const percentage = (valueA - minA) / (maxA - minA);
		const valueB = percentage * (maxB - minB) + minB;

		return valueB;
	};

	const styleToString = (style: Record<string, number | string | undefined>): string => {
		return Object.keys(style).reduce((str, key) => {
			if (style[key] === undefined) return str;
			return str + `${key}:${style[key]};`;
		}, "");
	};

	return {
		duration: withDefaults.duration,
		easing: cubicOut,
		delay: 0,
		css: (t) => {
			const y = scaleConversion(t, [0, 1], [withDefaults.y, 0]);
			const x = scaleConversion(t, [0, 1], [withDefaults.x, 0]);
			const scale = scaleConversion(t, [0, 1], [withDefaults.start, 1]);

			return styleToString({
				transform: `${transform} translate3d(${x}px, ${y}px, 0) scale(${scale})`,
				opacity: t
			});
		}
	};
};