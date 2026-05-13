<script>
  import { Presentation, Slide } from "@work.books/runtime/presentation";

  let confidence = $state(72);
</script>

<Presentation title="%%NAME%%" aspectRatio="16:9">
  <Slide class="intro">
    <div class="slide">
      <p class="eyebrow">Workbook presentation</p>
      <h1>%%NAME%%</h1>
      <p>Fixed-ratio slides with live HTML controls.</p>
    </div>
  </Slide>

  <Slide>
    <div class="slide split">
      <section>
        <p class="eyebrow">Interactive slide</p>
        <h2>Controls stay live in the HTML deck.</h2>
        <label>
          Confidence
          <input type="range" min="0" max="100" bind:value={confidence} />
        </label>
      </section>
      <aside>
        <strong>{confidence}%</strong>
        <span>captured as static state in PDF export</span>
      </aside>
    </div>
  </Slide>
</Presentation>
