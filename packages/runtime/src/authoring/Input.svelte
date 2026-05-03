<script lang="ts">
  /**
   * <Input> — declarative workbook input. Mirrors <wb-input>:
   *
   *   <Input name="csv" type="csv" default={initial} bind:value />
   *
   * Pushes the current value to the cell DAG via context.setInput()
   * any time it changes. Cells with `reads="csv"` re-execute
   * (debounced) on every change.
   *
   * Default UI is a plain `<input>` (or `<textarea>` for multi-line
   * types). Authors override via the `field` snippet:
   *
   *   <Input name="region" default="us" bind:value={region}>
   *     {#snippet field({ value, set })}
   *       <MyCustomCombo {value} on:change={(e) => set(e.detail)} />
   *     {/snippet}
   *   </Input>
   *
   * Type prop is informational at the runtime level — cells decide
   * how to interpret the value. For UI rendering we use it to pick
   * the input element's `type=`.
   */

  import type { Snippet } from "svelte";
  import { requireAuthoringContext } from "./context";

  type InputType =
    | "text" | "number" | "checkbox" | "color" | "date"
    | "range" | "file" | "csv" | "json" | "tsv";

  type Props<T = unknown> = {
    /** Name in the DAG. Cells reference this via `reads="<name>"`. */
    name: string;
    /** UI hint + value coercion target. Defaults to "text". */
    type?: InputType;
    /** Initial value. */
    default?: T;
    /** Two-way binding for the current value. */
    value?: T;
    /** Optional label rendered above the field by the default UI. */
    label?: string;
    /** Optional placeholder. */
    placeholder?: string;
    /** Snippet to render a custom field. Receives { value, set, name, type }. */
    field?: Snippet<[{
      value: T | undefined;
      set: (v: T) => void;
      name: string;
      type: InputType;
    }]>;
    /** Pass-through HTML class for the wrapper. */
    class?: string;
  };

  let {
    name,
    type = "text" as InputType,
    default: defaultValue,
    value = $bindable(),
    label,
    placeholder,
    field,
    class: klass = "",
  }: Props = $props();

  const ctx = requireAuthoringContext("Input");

  // Initialize from `default` prop if no bound value was provided.
  // Read inside an effect so Svelte sees a closure over `defaultValue`
  // rather than a static initial-value capture (which warns).
  $effect(() => {
    if (value === undefined && defaultValue !== undefined) {
      value = defaultValue;
    }
  });

  // Push to DAG whenever the bound value changes (including the initial
  // assignment above). Cells re-run debounced via the executor.
  $effect(() => {
    ctx.setInput(name, value);
  });

  function set(v: unknown) {
    value = v as typeof value;
  }

  function onInputEvent(e: Event) {
    const el = e.target as HTMLInputElement;
    if (type === "checkbox") {
      value = el.checked as typeof value;
    } else if (type === "number" || type === "range") {
      value = (el.valueAsNumber as unknown) as typeof value;
    } else {
      value = el.value as typeof value;
    }
  }
</script>

<div class="wb-input {klass}">
  {#if field}
    {@render field({ value, set, name, type })}
  {:else}
    {#if label}
      <label class="wb-input__label" for="wb-input-{name}">{label}</label>
    {/if}
    <input
      id="wb-input-{name}"
      class="wb-input__field"
      {type}
      {placeholder}
      checked={type === "checkbox" ? Boolean(value) : undefined}
      value={type === "checkbox" ? undefined : (value as string | number ?? "")}
      oninput={onInputEvent}
    />
  {/if}
</div>

<style>
  .wb-input { display: flex; flex-direction: column; gap: 4px; }
  .wb-input__label {
    font: 500 11px/1 ui-monospace, "SF Mono", Menlo, monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
  }
  .wb-input__field {
    padding: 8px 10px;
    border: 1px solid #e5e2db;
    border-radius: 4px;
    background: white;
    font: 13px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
    outline: none;
  }
  .wb-input__field:focus { border-color: #0f1115; }
</style>
