import { getContext, setContext } from "svelte";

const PRESENTATION_CONTEXT = Symbol("workbook-presentation");

export interface PresentationApi {
  register(id: symbol): number;
  unregister(id: symbol): void;
  goTo(index: number): void;
  next(): void;
  previous(): void;
  indexOf(id: symbol): number;
  readonly current: number;
  readonly count: number;
  readonly printMode: boolean;
}

export function setPresentationContext(api: PresentationApi): void {
  setContext(PRESENTATION_CONTEXT, api);
}

export function getPresentationContext(): PresentationApi {
  const api = getContext<PresentationApi | undefined>(PRESENTATION_CONTEXT);
  if (!api) {
    throw new Error("<Slide> must be used inside a <Presentation> component.");
  }
  return api;
}
