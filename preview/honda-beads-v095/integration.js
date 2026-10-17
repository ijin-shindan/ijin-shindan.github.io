import { mountMotion } from "./app/motion.js";

const root = document.documentElement;
const stage = document.querySelector('[data-testid="result-stage"]');
const compactImages = [...document.querySelectorAll("[data-compact-image]")];
const imageModeControls = [...document.querySelectorAll('input[name="image-mode"]')];
const themeControls = [...document.querySelectorAll('input[name="theme"]')];
let disposeMotion = () => {};

function selected(controls) {
  return controls.find((control) => control.checked)?.value;
}

function mountColorMotion() {
  disposeMotion();
  disposeMotion = mountMotion(stage, { name: "本多忠勝（研究候補）" });
}

function applyImageMode() {
  const mode = selected(imageModeControls) || "color";
  disposeMotion();
  disposeMotion = () => {};
  stage.dataset.state = mode === "silhouette" ? "sil" : "done";
  for (const image of compactImages) {
    image.src = mode === "silhouette" ? "candidate-silhouette.svg" : "candidate-color.svg";
  }
  if (mode === "color") mountColorMotion();
}

function applyTheme() {
  root.dataset.theme = selected(themeControls) || "light";
}

for (const control of imageModeControls) control.addEventListener("change", applyImageMode);
for (const control of themeControls) control.addEventListener("change", applyTheme);
applyTheme();
applyImageMode();
window.addEventListener("pagehide", () => disposeMotion(), { once: true });
