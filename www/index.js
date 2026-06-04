const GRID_WIDTH = 64;
const GRID_HEIGHT = 64;

const CANVAS_WIDTH = 768;
const CANVAS_HEIGHT = 768;

const FRAME_COUNT = 1000;
const WARMUP_FRAMES = 50;

const canvas = document.getElementById("game-of-life-canvas");
const fpsCounter = document.getElementById("fps-count");

canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
});

if (!gl) {
  throw new Error("WebGL2 is not available.");
}

gl.disable(gl.BLEND);
gl.disable(gl.DEPTH_TEST);
gl.disable(gl.STENCIL_TEST);
gl.disable(gl.CULL_FACE);
gl.disable(gl.SCISSOR_TEST);
gl.disable(gl.DITHER);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

const timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");

const quadVertexShader = `#version 300 es
precision highp float;

const vec2 positions[6] = vec2[6](
  vec2(-1.0, -1.0),
  vec2( 1.0, -1.0),
  vec2(-1.0,  1.0),

  vec2(-1.0,  1.0),
  vec2( 1.0, -1.0),
  vec2( 1.0,  1.0)
);

void main() {
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

const lifeFragmentShader = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform ivec2 u_grid_size;

out vec4 out_color;

int alive_at(ivec2 p) {
  p = ivec2(
    (p.x + u_grid_size.x) % u_grid_size.x,
    (p.y + u_grid_size.y) % u_grid_size.y
  );

  float value = texelFetch(u_state, p, 0).r;
  return value > 0.5 ? 1 : 0;
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);

  int count = 0;

  count += alive_at(cell + ivec2(-1, -1));
  count += alive_at(cell + ivec2( 0, -1));
  count += alive_at(cell + ivec2( 1, -1));

  count += alive_at(cell + ivec2(-1,  0));
  count += alive_at(cell + ivec2( 1,  0));

  count += alive_at(cell + ivec2(-1,  1));
  count += alive_at(cell + ivec2( 0,  1));
  count += alive_at(cell + ivec2( 1,  1));

  int alive = alive_at(cell);

  bool next_alive = count == 3 || (alive == 1 && count == 2);

  out_color = next_alive
    ? vec4(1.0, 0.0, 0.0, 1.0)
    : vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const displayFragmentShader = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform ivec2 u_grid_size;
uniform ivec2 u_canvas_size;

out vec4 out_color;

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);

  int pitch_x = u_canvas_size.x / u_grid_size.x;
  int pitch_y = u_canvas_size.y / u_grid_size.y;

  bool is_grid =
    (pixel.x % pitch_x == 0) ||
    (pixel.y % pitch_y == 0);

  if (is_grid) {
    out_color = vec4(0.866, 0.866, 0.866, 1.0);
    return;
  }

  int col = min(pixel.x / pitch_x, u_grid_size.x - 1);
  int row = min(pixel.y / pitch_y, u_grid_size.y - 1);

  float alive = texelFetch(u_state, ivec2(col, row), 0).r;

  out_color = alive > 0.5
    ? vec4(0.0, 0.0, 0.0, 1.0)
    : vec4(1.0, 1.0, 1.0, 1.0);
}
`;

function createShader(type, source) {
  const shader = gl.createShader(type);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed:\n${log}`);
  }

  return shader;
}

function createProgram(vertexSource, fragmentSource) {
  const program = gl.createProgram();

  const vertexShader = createShader(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed:\n${log}`);
  }

  return program;
}

function createInitialState() {
  const data = new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 4);

  for (let i = 0; i < GRID_WIDTH * GRID_HEIGHT; i++) {
    const alive = i % 2 === 0 || i % 7 === 0 ? 255 : 0;
    const offset = i * 4;

    data[offset + 0] = alive;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 255;
  }

  return data;
}

function createStateTexture(initialData = null) {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    GRID_WIDTH,
    GRID_HEIGHT,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    initialData
  );

  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

function createRenderTexture(width, height) {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

function createFramebuffer(texture) {
  const framebuffer = gl.createFramebuffer();

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: ${status}`);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return framebuffer;
}

const lifeProgram = createProgram(quadVertexShader, lifeFragmentShader);
const displayProgram = createProgram(quadVertexShader, displayFragmentShader);

const lifeUniforms = {
  state: gl.getUniformLocation(lifeProgram, "u_state"),
  gridSize: gl.getUniformLocation(lifeProgram, "u_grid_size"),
};

const displayUniforms = {
  state: gl.getUniformLocation(displayProgram, "u_state"),
  gridSize: gl.getUniformLocation(displayProgram, "u_grid_size"),
  canvasSize: gl.getUniformLocation(displayProgram, "u_canvas_size"),
};

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const stateTextures = [
  createStateTexture(createInitialState()),
  createStateTexture(null),
];

const stateFramebuffers = [
  createFramebuffer(stateTextures[0]),
  createFramebuffer(stateTextures[1]),
];

const offscreenTexture = createRenderTexture(CANVAS_WIDTH, CANVAS_HEIGHT);
const offscreenFramebuffer = createFramebuffer(offscreenTexture);

let readIndex = 0;
let writeIndex = 1;

function stepSimulation() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, stateFramebuffers[writeIndex]);
  gl.viewport(0, 0, GRID_WIDTH, GRID_HEIGHT);

  gl.useProgram(lifeProgram);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, stateTextures[readIndex]);

  gl.uniform1i(lifeUniforms.state, 0);
  gl.uniform2i(lifeUniforms.gridSize, GRID_WIDTH, GRID_HEIGHT);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const oldRead = readIndex;
  readIndex = writeIndex;
  writeIndex = oldRead;
}

function renderState(renderToCanvas) {
  if (renderToCanvas) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, offscreenFramebuffer);
  }

  gl.viewport(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  gl.useProgram(displayProgram);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, stateTextures[readIndex]);

  gl.uniform1i(displayUniforms.state, 0);
  gl.uniform2i(displayUniforms.gridSize, GRID_WIDTH, GRID_HEIGHT);
  gl.uniform2i(displayUniforms.canvasSize, CANVAS_WIDTH, CANVAS_HEIGHT);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function encodeFrame(renderToCanvas) {
  stepSimulation();
  renderState(renderToCanvas);
}

function forceFramebufferObservable() {
  const readback = new Uint8Array(4);

  gl.bindFramebuffer(gl.FRAMEBUFFER, offscreenFramebuffer);
  gl.readPixels(
    0,
    0,
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    readback
  );

  return readback[0];
}

function waitForQueryResult(query) {
  return new Promise((resolve, reject) => {
    function poll() {
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);

      if (disjoint) {
        reject(new Error("GPU timer query became disjoint; result is invalid."));
        return;
      }

      if (available) {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
        resolve(nanoseconds);
        return;
      }

      requestAnimationFrame(poll);
    }

    poll();
  });
}

async function runGpuTimerBenchmark() {
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    encodeFrame(false);
  }

  gl.flush();

  const query = gl.createQuery();

  const cpuSubmitStart = performance.now();

  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);

  for (let i = 0; i < FRAME_COUNT; i++) {
    encodeFrame(false);
  }

  gl.endQuery(timerExt.TIME_ELAPSED_EXT);
  gl.flush();

  const cpuSubmitElapsed = performance.now() - cpuSubmitStart;
  const gpuNanoseconds = await waitForQueryResult(query);
  const gpuElapsedMs = gpuNanoseconds / 1_000_000;

  gl.deleteQuery(query);

  const gpuFps = FRAME_COUNT / (gpuElapsedMs / 1000);
  const gpuMsPerFrame = gpuElapsedMs / FRAME_COUNT;

  fpsCounter.textContent = `GPU timer: ${Math.round(gpuFps)} FPS`;

  console.log("WebGL2 GPU timer benchmark");
  console.log(`Frames: ${FRAME_COUNT}`);
  console.log(`CPU submit elapsed: ${cpuSubmitElapsed.toFixed(2)} ms`);
  console.log(`GPU elapsed: ${gpuElapsedMs.toFixed(3)} ms`);
  console.log(`GPU average: ${gpuMsPerFrame.toFixed(4)} ms/frame`);
  console.log(`GPU throughput: ${Math.round(gpuFps)} FPS`);

  return gpuFps;
}

function runReadbackBenchmark() {
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    encodeFrame(false);
    forceFramebufferObservable();
  }

  gl.finish();

  const start = performance.now();

  let checksum = 0;

  for (let i = 0; i < FRAME_COUNT; i++) {
    encodeFrame(false);

    // Brutal correctness fence:
    // forces the rendered offscreen framebuffer to be observable every frame.
    checksum ^= forceFramebufferObservable();
  }

  gl.finish();

  const elapsed = performance.now() - start;
  const fps = FRAME_COUNT / (elapsed / 1000);
  const msPerFrame = elapsed / FRAME_COUNT;

  fpsCounter.textContent = `Readback: ${Math.round(fps)} FPS`;

  console.log("WebGL2 strict readback benchmark");
  console.log(`Frames: ${FRAME_COUNT}`);
  console.log(`Elapsed: ${elapsed.toFixed(2)} ms`);
  console.log(`Average: ${msPerFrame.toFixed(4)} ms/frame`);
  console.log(`Throughput: ${Math.round(fps)} FPS`);
  console.log(`Checksum: ${checksum}`);

  return fps;
}

async function runBenchmark() {
  if (timerExt) {
    await runGpuTimerBenchmark();
  } else {
    console.warn(
      "EXT_disjoint_timer_query_webgl2 is unavailable; using strict readback fallback."
    );
    runReadbackBenchmark();
  }

  encodeFrame(true);
}

let visualFrames = 0;
let visualLast = performance.now();

function animationLoop() {
  encodeFrame(true);

  visualFrames++;
  const now = performance.now();

  if (now - visualLast >= 1000) {
    console.log(`Visual rAF FPS: ${visualFrames}`);
    visualFrames = 0;
    visualLast = now;
  }

  requestAnimationFrame(animationLoop);
}

runBenchmark()
  .then(() => {
    requestAnimationFrame(animationLoop);
  })
  .catch((error) => {
    console.error(error);
    fpsCounter.textContent = "WebGL benchmark error";
  });