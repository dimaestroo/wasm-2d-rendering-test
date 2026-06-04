import { start_benchmark } from "wasm-game-of-life";

start_benchmark(
  "game-of-life-canvas",
  "fps-count",
  768,
  768,
  1000,
  50
);