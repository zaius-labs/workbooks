// Mount the Svelte app. Routing is hash-based via svelte-spa-router so
// the app loads correctly from file:// — the History API can't push
// proper URLs there, but #/route works everywhere.
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app") });
