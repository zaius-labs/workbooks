/**
 * Presentation SDK — standardized chrome for slide-shaped workbooks.
 *
 * Presentations are interactive HTML workbooks with a fixed-ratio stage.
 * Static PDF export uses the print layout: one slide per page, preserving
 * the configured aspect ratio.
 */

export { default as Presentation } from "./Presentation.svelte";
export { default as Slide } from "./Slide.svelte";
export { getPresentationContext, setPresentationContext } from "./context";
export type { PresentationApi } from "./context";
