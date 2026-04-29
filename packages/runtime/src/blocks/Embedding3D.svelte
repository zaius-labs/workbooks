<script lang="ts">
  /** Embedding3D — 3D scatter (UMAP/PCA-3D embeddings) or surface (loss
   *  landscapes) rendered via Three.js. WebGL-only.
   *
   *  We use raw Three.js (not Threlte) because we only need a single
   *  scene per block; the declarative Svelte component layer Threlte
   *  provides is overkill here and would add ~150KB of wrapping for
   *  no architectural payoff. */
  import type { Embedding3DBlock } from "../types";
  import { onMount } from "svelte";
  import { PALETTE } from "./chart/palette";

  let { block }: { block: Embedding3DBlock } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  function hexToColor(hex: string): { r: number; g: number; b: number } {
    const v = hex.replace("#", "");
    return {
      r: parseInt(v.slice(0, 2), 16) / 255,
      g: parseInt(v.slice(2, 4), 16) / 255,
      b: parseInt(v.slice(4, 6), 16) / 255,
    };
  }

  onMount(() => {
    if (!host) return;
    const node = host;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const THREE = await import("three");
        if (cancelled) return;

        const width = node.clientWidth || 640;
        const height = 480;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xfafafa);

        const camera = new THREE.PerspectiveCamera(
          45,
          width / height,
          0.1,
          5000,
        );

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio);
        node.appendChild(renderer.domElement);

        /* Build the scene per subtype. */
        const data = block.data;
        let dataBounds = { min: -1, max: 1 };
        if (data.subtype === "scatter") {
          const groups = Array.from(
            new Set(data.points.map((p) => p.group ?? "")),
          );
          /* One Points object per group so they can each carry a
           * material color. Using BufferGeometry with attribute writes
           * — fast enough for ~50K points. */
          const allXs = data.points.map((p) => p.x);
          const allYs = data.points.map((p) => p.y);
          const allZs = data.points.map((p) => p.z);
          const minVal = Math.min(...allXs, ...allYs, ...allZs);
          const maxVal = Math.max(...allXs, ...allYs, ...allZs);
          dataBounds = { min: minVal, max: maxVal };

          for (const g of groups) {
            const pts = data.points.filter((p) => (p.group ?? "") === g);
            const positions = new Float32Array(pts.length * 3);
            for (let i = 0; i < pts.length; i++) {
              positions[i * 3] = pts[i].x;
              positions[i * 3 + 1] = pts[i].y;
              positions[i * 3 + 2] = pts[i].z;
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              "position",
              new THREE.BufferAttribute(positions, 3),
            );
            const c = hexToColor(PALETTE[groups.indexOf(g) % PALETTE.length]);
            const material = new THREE.PointsMaterial({
              color: new THREE.Color(c.r, c.g, c.b),
              size: 0.02 * (maxVal - minVal),
              sizeAttenuation: true,
              transparent: true,
              opacity: 0.85,
            });
            scene.add(new THREE.Points(geometry, material));
          }
        } else if (data.subtype === "surface") {
          /* Build a parametric surface from the values grid. */
          const rows = data.values.length;
          const cols = rows > 0 ? data.values[0].length : 0;
          if (rows < 2 || cols < 2) {
            throw new Error("surface requires at least 2x2 grid");
          }
          const xTicks = data.xTicks ?? Array.from({ length: cols }, (_, i) => i);
          const yTicks = data.yTicks ?? Array.from({ length: rows }, (_, i) => i);
          const flatZ = data.values.flat();
          const minZ = Math.min(...flatZ);
          const maxZ = Math.max(...flatZ);
          dataBounds = {
            min: Math.min(xTicks[0], yTicks[0], minZ),
            max: Math.max(xTicks[xTicks.length - 1], yTicks[yTicks.length - 1], maxZ),
          };

          const positions = new Float32Array(rows * cols * 3);
          const colors = new Float32Array(rows * cols * 3);
          const indices: number[] = [];
          const ramp = [
            hexToColor("#f0f7fc"),
            hexToColor(PALETTE[0]),
            hexToColor(PALETTE[3]),
          ];
          const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
          const sample = (t: number) => {
            const idx = Math.min(ramp.length - 2, Math.floor(t * (ramp.length - 1)));
            const u = t * (ramp.length - 1) - idx;
            return {
              r: lerp(ramp[idx].r, ramp[idx + 1].r, u),
              g: lerp(ramp[idx].g, ramp[idx + 1].g, u),
              b: lerp(ramp[idx].b, ramp[idx + 1].b, u),
            };
          };
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const i = r * cols + c;
              positions[i * 3] = xTicks[c];
              positions[i * 3 + 1] = data.values[r][c];
              positions[i * 3 + 2] = yTicks[r];
              const t = (data.values[r][c] - minZ) / Math.max(1e-9, maxZ - minZ);
              const col = sample(t);
              colors[i * 3] = col.r;
              colors[i * 3 + 1] = col.g;
              colors[i * 3 + 2] = col.b;
            }
          }
          for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols - 1; c++) {
              const a = r * cols + c;
              const b = r * cols + (c + 1);
              const cIdx = (r + 1) * cols + c;
              const d = (r + 1) * cols + (c + 1);
              indices.push(a, b, d, a, d, cIdx);
            }
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(positions, 3),
          );
          geometry.setAttribute(
            "color",
            new THREE.BufferAttribute(colors, 3),
          );
          geometry.setIndex(indices);
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            roughness: 0.65,
            metalness: 0.05,
          });
          scene.add(new THREE.Mesh(geometry, material));
          /* Lights for the surface case. */
          scene.add(new THREE.AmbientLight(0xffffff, 0.55));
          const dir = new THREE.DirectionalLight(0xffffff, 0.8);
          dir.position.set(1, 1, 1);
          scene.add(dir);
        }

        /* Auto-frame the data bounds. */
        const center = (dataBounds.min + dataBounds.max) / 2;
        const reach = Math.max(0.5, dataBounds.max - dataBounds.min);
        camera.position.set(
          center + reach * 1.2,
          center + reach * 0.9,
          center + reach * 1.2,
        );
        camera.lookAt(center, center, center);

        /* Add subtle axes helper at the data origin. */
        scene.add(new THREE.AxesHelper(reach * 0.6));

        /* Click-drag rotation: minimal manual orbit, no extra dep. */
        let dragging = false;
        let lastX = 0,
          lastY = 0;
        let yaw = 0,
          pitch = 0.4;
        const radius = reach * 1.8;
        const updateCamera = () => {
          camera.position.x = center + radius * Math.cos(pitch) * Math.cos(yaw);
          camera.position.y = center + radius * Math.sin(pitch);
          camera.position.z = center + radius * Math.cos(pitch) * Math.sin(yaw);
          camera.lookAt(center, center, center);
        };
        updateCamera();
        const onDown = (e: MouseEvent) => {
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
        };
        const onUp = () => {
          dragging = false;
        };
        const onMove = (e: MouseEvent) => {
          if (!dragging) return;
          yaw += (e.clientX - lastX) * 0.005;
          pitch = Math.max(
            -Math.PI / 2 + 0.05,
            Math.min(Math.PI / 2 - 0.05, pitch - (e.clientY - lastY) * 0.005),
          );
          lastX = e.clientX;
          lastY = e.clientY;
          updateCamera();
        };
        renderer.domElement.addEventListener("mousedown", onDown);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("mousemove", onMove);

        let frame = 0;
        const animate = () => {
          if (cancelled) return;
          frame = requestAnimationFrame(animate);
          renderer.render(scene, camera);
        };
        animate();

        cleanup = () => {
          cancelAnimationFrame(frame);
          renderer.domElement.removeEventListener("mousedown", onDown);
          window.removeEventListener("mouseup", onUp);
          window.removeEventListener("mousemove", onMove);
          renderer.dispose();
          if (renderer.domElement.parentElement === node) {
            node.removeChild(renderer.domElement);
          }
        };
      } catch (e) {
        error = e instanceof Error ? e.message : "3D render failed";
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  });
</script>

<figure
  class="flex flex-col gap-3 rounded-[18px] border border-border bg-surface p-4"
>
  {#if block.title}
    <figcaption class="flex items-center gap-2">
      <span
        class="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
      >
        embedding3d · {block.data.subtype}
      </span>
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}

  <div bind:this={host} class="relative h-[480px] w-full overflow-hidden rounded-lg"></div>

  {#if error}
    <p class="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
  {/if}

  {#if block.caption}
    <p class="text-[12.5px] text-fg-muted">{block.caption}</p>
  {/if}
</figure>
