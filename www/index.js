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

const computeShaderCode = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  pixel_width: u32,
  pixel_height: u32,
};

@group(0) @binding(0)
var<storage, read> src_cells: array<u32>;

@group(0) @binding(1)
var<storage, read_write> dst_cells: array<u32>;

@group(0) @binding(2)
var<uniform> params: Params;

fn cell_index(row: u32, col: u32) -> u32 {
  return row * params.width + col;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let col = gid.x;
  let row = gid.y;

  if (col >= params.width || row >= params.height) {
    return;
  }

  let up = select(row - 1u, params.height - 1u, row == 0u);
  let down = select(row + 1u, 0u, row + 1u == params.height);

  let left = select(col - 1u, params.width - 1u, col == 0u);
  let right = select(col + 1u, 0u, col + 1u == params.width);

  let count =
      src_cells[cell_index(up, left)]
    + src_cells[cell_index(up, col)]
    + src_cells[cell_index(up, right)]
    + src_cells[cell_index(row, left)]
    + src_cells[cell_index(row, right)]
    + src_cells[cell_index(down, left)]
    + src_cells[cell_index(down, col)]
    + src_cells[cell_index(down, right)];

  let idx = cell_index(row, col);
  let alive = src_cells[idx];

  let next_alive = (count == 3u) || (alive == 1u && count == 2u);

  dst_cells[idx] = select(0u, 1u, next_alive);
}
`;

const renderShaderCode = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  pixel_width: u32,
  pixel_height: u32,
};

@group(0) @binding(0)
var<storage, read> cells: array<u32>;

@group(0) @binding(1)
var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),

    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );

  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let x = u32(position.x);
  let y = u32(position.y);

  let pitch_x = params.pixel_width / params.width;
  let pitch_y = params.pixel_height / params.height;

  let is_grid = (x % pitch_x == 0u) || (y % pitch_y == 0u);

  if (is_grid) {
    return vec4<f32>(0.866, 0.866, 0.866, 1.0);
  }

  let col = min(x / pitch_x, params.width - 1u);
  let row = min(y / pitch_y, params.height - 1u);

  let idx = row * params.width + col;
  let alive = cells[idx];

  if (alive == 1u) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;

async function initWebGPU() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");

  if (!context) {
    throw new Error("Could not get WebGPU canvas context.");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  return {
    device,
    context,
    format,
  };
}

function createInitialCells() {
  const cells = new Uint32Array(GRID_WIDTH * GRID_HEIGHT);

  for (let i = 0; i < cells.length; i++) {
    cells[i] = i % 2 === 0 || i % 7 === 0 ? 1 : 0;
  }

  return cells;
}

function createBuffer(device, size, usage, initialData = null) {
  const buffer = device.createBuffer({
    size,
    usage,
    mappedAtCreation: initialData !== null,
  });

  if (initialData !== null) {
    const mapped = new Uint32Array(buffer.getMappedRange());
    mapped.set(initialData);
    buffer.unmap();
  }

  return buffer;
}

async function main() {
  const { device, context, format } = await initWebGPU();

  const cellCount = GRID_WIDTH * GRID_HEIGHT;
  const cellBufferSize = cellCount * 4;

  const initialCells = createInitialCells();

  const cellBuffers = [
    createBuffer(
      device,
      cellBufferSize,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      initialCells
    ),
    createBuffer(
      device,
      cellBufferSize,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      new Uint32Array(cellCount)
    ),
  ];

  const paramsBuffer = createBuffer(
    device,
    16,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  );

  device.queue.writeBuffer(
    paramsBuffer,
    0,
    new Uint32Array([
      GRID_WIDTH,
      GRID_HEIGHT,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    ])
  );

  const computeModule = device.createShaderModule({
    code: computeShaderCode,
  });

  const renderModule = device.createShaderModule({
    code: renderShaderCode,
  });

  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "read-only-storage",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "uniform",
        },
      },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: "read-only-storage",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: "uniform",
        },
      },
    ],
  });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [computeBindGroupLayout],
    }),
    compute: {
      module: computeModule,
      entryPoint: "main",
    },
  });

  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout],
    }),
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
    },
  });

  const computeBindGroups = [
    device.createBindGroup({
      layout: computeBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cellBuffers[0],
          },
        },
        {
          binding: 1,
          resource: {
            buffer: cellBuffers[1],
          },
        },
        {
          binding: 2,
          resource: {
            buffer: paramsBuffer,
          },
        },
      ],
    }),

    device.createBindGroup({
      layout: computeBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cellBuffers[1],
          },
        },
        {
          binding: 1,
          resource: {
            buffer: cellBuffers[0],
          },
        },
        {
          binding: 2,
          resource: {
            buffer: paramsBuffer,
          },
        },
      ],
    }),
  ];

  const renderBindGroups = [
    device.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cellBuffers[0],
          },
        },
        {
          binding: 1,
          resource: {
            buffer: paramsBuffer,
          },
        },
      ],
    }),

    device.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cellBuffers[1],
          },
        },
        {
          binding: 1,
          resource: {
            buffer: paramsBuffer,
          },
        },
      ],
    }),
  ];

  let readBufferIndex = 0;
  let writeBufferIndex = 1;

  const offscreenTexture = device.createTexture({
    size: [CANVAS_WIDTH, CANVAS_HEIGHT],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  function encodeFrame(renderToCanvas) {
    const encoder = device.createCommandEncoder();

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroups[readBufferIndex]);
    computePass.dispatchWorkgroups(
      Math.ceil(GRID_WIDTH / 8),
      Math.ceil(GRID_HEIGHT / 8)
    );
    computePass.end();

    const targetView = renderToCanvas
      ? context.getCurrentTexture().createView()
      : offscreenTexture.createView();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: {
            r: 1,
            g: 1,
            b: 1,
            a: 1,
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroups[writeBufferIndex]);
    renderPass.draw(6);
    renderPass.end();

    const commandBuffer = encoder.finish();

    const oldRead = readBufferIndex;
    readBufferIndex = writeBufferIndex;
    writeBufferIndex = oldRead;

    return commandBuffer;
  }

  async function runBenchmark() {
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      device.queue.submit([encodeFrame(false)]);
    }

    await device.queue.onSubmittedWorkDone();

    const start = performance.now();

    for (let i = 0; i < FRAME_COUNT; i++) {
      device.queue.submit([encodeFrame(false)]);
    }

    await device.queue.onSubmittedWorkDone();

    const elapsed = performance.now() - start;
    const fps = FRAME_COUNT / (elapsed / 1000);
    const msPerFrame = elapsed / FRAME_COUNT;

    fpsCounter.textContent = Math.round(fps).toString();

    console.log(`WebGPU benchmark`);
    console.log(`Frames: ${FRAME_COUNT}`);
    console.log(`Elapsed: ${elapsed.toFixed(2)} ms`);
    console.log(`Average: ${msPerFrame.toFixed(3)} ms/frame`);
    console.log(`Throughput: ${Math.round(fps)} FPS`);

    device.queue.submit([encodeFrame(true)]);
  }

  function animationLoop() {
    device.queue.submit([encodeFrame(true)]);
    requestAnimationFrame(animationLoop);
  }

  await runBenchmark();

  requestAnimationFrame(animationLoop);
}

main().catch((error) => {
  console.error(error);
  fpsCounter.textContent = "WebGPU error";
});