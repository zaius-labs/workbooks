/**
 * Block registry — maps each WorkbookBlock kind to the Svelte component that
 * renders it.
 *
 * The registry pattern lets the workbook runtime stay portable while
 * specific block kinds reach into runtime data (Convex, model-skill catalog,
 * etc.). Clean display blocks ship with the package as defaults; coupled
 * blocks must be injected by the consumer.
 *
 * # Usage
 *
 *   // apps/web — pass the full registry with local convex-coupled blocks
 *   import { defaultBlockRegistry } from "@signal/workbook-runtime";
 *   import File from "$lib/workbook/blocks/File.svelte";
 *
 *   const registry = {
 *     ...defaultBlockRegistry,
 *     file: File,
 *     image: Image,
 *     video: Video,
 *     input: Input,
 *     concept: Concept,
 *   };
 *
 *   <Workbook {doc} {registry} />
 *
 *   // exported workbook (no convex) — defaults are sufficient; coupled
 *   // blocks render their embedded fallback (read-only).
 */

import type { Component } from "svelte";

import Heading from "./blocks/Heading.svelte";
import Paragraph from "./blocks/Paragraph.svelte";
import Markdown from "./blocks/Markdown.svelte";
import Callout from "./blocks/Callout.svelte";
import Divider from "./blocks/Divider.svelte";
import Code from "./blocks/Code.svelte";
import Diagram from "./blocks/Diagram.svelte";
import Chart from "./blocks/Chart.svelte";
import Metric from "./blocks/Metric.svelte";
import Metrics from "./blocks/Metrics.svelte";
import Table from "./blocks/Table.svelte";
import Step from "./blocks/Step.svelte";
import Machine from "./blocks/Machine.svelte";
import Widget from "./blocks/Widget.svelte";
import Network from "./blocks/Network.svelte";
import Geo from "./blocks/Geo.svelte";
import Embedding3D from "./blocks/Embedding3D.svelte";

/**
 * Map of block-kind string → Svelte component.
 *
 * Block kind names match WorkbookBlock discriminator values from
 * @shinymono/shared. Components receive the block as their `block` prop;
 * Step blocks additionally receive `blockId` and `runState`.
 *
 * Kinds whose values are `undefined` are not rendered — the dispatcher
 * falls back to a placeholder. Consumers wishing to support those kinds
 * must inject a component.
 */
export interface BlockRegistry {
  // Display blocks — always available from the package
  heading: Component;
  paragraph: Component;
  markdown: Component;
  callout: Component;
  divider: Component;
  code: Component;
  diagram: Component;
  chart: Component;
  metric: Component;
  metrics: Component;
  table: Component;
  step: Component;
  machine: Component;
  widget: Component;
  network: Component;
  geo: Component;
  embedding_3d: Component;

  // Coupled blocks — consumer must inject if they appear in workbooks
  file?: Component;
  image?: Component;
  video?: Component;
  input?: Component;
  concept?: Component;
}

/**
 * Default registry — the package's clean display blocks. Convex-coupled
 * block slots (file/image/video/input/concept) are undefined; consumers
 * extend this object with their implementations.
 */
export const defaultBlockRegistry: BlockRegistry = {
  heading: Heading,
  paragraph: Paragraph,
  markdown: Markdown,
  callout: Callout,
  divider: Divider,
  code: Code,
  diagram: Diagram,
  chart: Chart,
  metric: Metric,
  metrics: Metrics,
  table: Table,
  step: Step,
  machine: Machine,
  widget: Widget,
  network: Network,
  geo: Geo,
  embedding_3d: Embedding3D,
};
