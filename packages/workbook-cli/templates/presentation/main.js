import { mount } from "svelte";
import App from "./src/App.svelte";
import "./styles.css";

mount(App, {
  target: document.getElementById("app"),
});
