<script>
  import { Presentation, Slide } from "@work.books/runtime/presentation";

  let adoption = $state(34);
  const baseRevenue = 18.4;
  const baseMargin = 42;
  const revenue = $derived((baseRevenue * (1 + adoption / 100)).toFixed(1));
  const margin = $derived(Math.round(baseMargin + adoption * 0.18));

  const segments = [
    { label: "Core", value: 58, color: "#0f5f73" },
    { label: "Expansion", value: 31, color: "#d96f32" },
    { label: "Labs", value: 11, color: "#8f6fd6" },
  ];

  const roadmap = [
    ["Now", "Launch workbook presentations"],
    ["30d", "Template library + PDF presets"],
    ["60d", "Runtime-backed slide widgets"],
    ["90d", "Collaborative narrative review"],
  ];
</script>

<Presentation title="Workbook Presentations" aspectRatio="16:9">
  <Slide class="cover">
    <div class="slide cover-layout">
      <div class="orbital" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div class="kicker animate delay-1">Interactive board narrative</div>
      <h1 class="animate delay-2">Workbook presentations</h1>
      <p class="lede animate delay-3">
        A fixed-aspect, animated, data-aware deck that remains usable as HTML
        and exports cleanly to static PDF.
      </p>
      <div class="meta-strip animate delay-4">
        <span>16:9 stage</span>
        <span>Svelte slides</span>
        <span>Live controls</span>
      </div>
    </div>
  </Slide>

  <Slide class="thesis">
    <div class="slide thesis-layout">
      <section>
        <div class="kicker animate delay-1">Why this shape</div>
        <h2 class="animate delay-2">A deck should carry the analysis, not flatten it.</h2>
      </section>
      <div class="cards">
        <article class="card animate delay-2">
          <span>01</span>
          <h3>Designed</h3>
          <p>Slides keep a composed canvas instead of responsive document flow.</p>
        </article>
        <article class="card animate delay-3">
          <span>02</span>
          <h3>Runnable</h3>
          <p>Charts, sliders, forms, and runtime output can stay live in HTML.</p>
        </article>
        <article class="card animate delay-4">
          <span>03</span>
          <h3>Portable</h3>
          <p>PDF export captures one clean page per slide for stakeholders.</p>
        </article>
      </div>
    </div>
  </Slide>

  <Slide class="data">
    <div class="slide data-layout">
      <div>
        <div class="kicker animate delay-1">Market signal</div>
        <h2 class="animate delay-2">Three motions are driving adoption.</h2>
      </div>
      <div class="chart-panel animate delay-3">
        {#each segments as segment, i}
          <div class="bar-row" style={`--value:${segment.value}; --bar:${segment.color}; --i:${i}`}>
            <span>{segment.label}</span>
            <div class="bar-track"><div class="bar-fill"></div></div>
            <strong>{segment.value}%</strong>
          </div>
        {/each}
      </div>
      <p class="caption animate delay-4">
        Presentation slides can use the same data primitives as other workbooks,
        but present the story in a paced, high-design sequence.
      </p>
    </div>
  </Slide>

  <Slide class="scenario">
    <div class="slide scenario-layout">
      <section>
        <div class="kicker animate delay-1">Live scenario</div>
        <h2 class="animate delay-2">Model adoption while presenting.</h2>
        <p class="animate delay-3">
          Move the control in the HTML deck. The PDF exporter captures whichever
          state is rendered when the deck is printed.
        </p>
        <label class="control animate delay-4">
          Adoption lift
          <input type="range" min="0" max="60" bind:value={adoption} />
        </label>
      </section>
      <aside class="scenario-card animate delay-3">
        <span>{adoption}%</span>
        <strong>${revenue}M</strong>
        <small>projected ARR</small>
        <div class="mini-metric">
          <b>{margin}%</b>
          <em>gross margin</em>
        </div>
      </aside>
    </div>
  </Slide>

  <Slide class="roadmap">
    <div class="slide roadmap-layout">
      <div class="kicker animate delay-1">Execution path</div>
      <h2 class="animate delay-2">A standard deck lane, not another custom app.</h2>
      <div class="timeline">
        {#each roadmap as item, i}
          <article class="milestone animate" style={`--i:${i}`}>
            <span>{item[0]}</span>
            <p>{item[1]}</p>
          </article>
        {/each}
      </div>
    </div>
  </Slide>

  <Slide class="close">
    <div class="slide close-layout">
      <div class="kicker animate delay-1">Recommendation</div>
      <h2 class="animate delay-2">Make presentations the canonical format for interactive narrative.</h2>
      <p class="animate delay-3">
        Documents explain. Notebooks explore. Apps operate. Presentations
        persuade with a fixed canvas, motion, and enough runtime to keep the
        story alive.
      </p>
    </div>
  </Slide>
</Presentation>
