mod utils;

use js_sys::{Object, Reflect, Uint8ClampedArray};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{
    CanvasRenderingContext2d, Document, HtmlCanvasElement, HtmlElement, ImageData, Window,
};

macro_rules! log {
    ($($t:tt)*) => {
        web_sys::console::log_1(&format!($($t)*).into());
    };
}
// Reinterpret the same WASM ArrayBuffer range as Uint8ClampedArray.
// This should not copy pixel bytes.

#[wasm_bindgen(inline_js = r#"
export function makeClampedView(data) {
  if (data instanceof Uint8ClampedArray) {
    return data;
  }

  if (!ArrayBuffer.isView(data)) {
    throw new TypeError("data is not a typed array view");
  }

  return new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength
  );
}

export function makeImageDataFromClampedView(data, width) {
  if (!(data instanceof Uint8ClampedArray)) {
    throw new TypeError("ImageData input is not Uint8ClampedArray");
  }

  return new ImageData(data, width);
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = makeClampedView)]
    fn make_clamped_view(data: JsValue) -> Result<Uint8ClampedArray, JsValue>;

    #[wasm_bindgen(catch, js_name = makeImageDataFromClampedView)]
    fn make_image_data_from_clamped_view(
        data: &Uint8ClampedArray,
        width: u32,
    ) -> Result<ImageData, JsValue>;
}

// WASM memory is little-endian.
// These u32 constants appear in memory as RGBA bytes:
//
// 0xff_00_00_00 -> [0x00, 0x00, 0x00, 0xff]
// 0xff_dd_dd_dd -> [0xdd, 0xdd, 0xdd, 0xff]
// 0xff_ff_ff_ff -> [0xff, 0xff, 0xff, 0xff]
const ALIVE_PIXEL: u32 = 0xff_00_00_00;
const GRID_PIXEL: u32 = 0xff_dd_dd_dd;
const DEAD_PIXEL: u32 = 0xff_ff_ff_ff;

#[derive(Clone, Copy)]
struct Rect {
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
}

fn window() -> Result<Window, JsValue> {
    web_sys::window().ok_or_else(|| JsValue::from_str("no global `window` exists"))
}

fn document() -> Result<Document, JsValue> {
    window()?
        .document()
        .ok_or_else(|| JsValue::from_str("no `document` exists"))
}

fn now() -> Result<f64, JsValue> {
    Ok(window()?
        .performance()
        .ok_or_else(|| JsValue::from_str("`performance` is not available"))?
        .now())
}

fn get_canvas(canvas_id: &str) -> Result<HtmlCanvasElement, JsValue> {
    document()?
        .get_element_by_id(canvas_id)
        .ok_or_else(|| JsValue::from_str("canvas element not found"))?
        .dyn_into::<HtmlCanvasElement>()
        .map_err(|_| JsValue::from_str("element is not an HtmlCanvasElement"))
}

fn get_html_element(element_id: &str) -> Result<HtmlElement, JsValue> {
    document()?
        .get_element_by_id(element_id)
        .ok_or_else(|| JsValue::from_str("element not found"))?
        .dyn_into::<HtmlElement>()
        .map_err(|_| JsValue::from_str("element is not an HtmlElement"))
}

fn get_2d_context(canvas: &HtmlCanvasElement) -> Result<CanvasRenderingContext2d, JsValue> {
    let options = Object::new();

    Reflect::set(&options, &JsValue::from_str("alpha"), &JsValue::FALSE)?;

    canvas
        .get_context_with_context_options("2d", &options)?
        .ok_or_else(|| JsValue::from_str("2D canvas context unavailable"))?
        .dyn_into::<CanvasRenderingContext2d>()
        .map_err(|_| JsValue::from_str("context is not CanvasRenderingContext2d"))
}

fn u32_pixels_as_u8_slice(pixels: &[u32]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(
            pixels.as_ptr() as *const u8,
            pixels.len() * std::mem::size_of::<u32>(),
        )
    }
}

fn build_neighbors(width: u32, height: u32) -> Vec<[usize; 8]> {
    let mut neighbors = Vec::with_capacity((width * height) as usize);

    for row in 0..height {
        for col in 0..width {
            let up = if row == 0 { height - 1 } else { row - 1 };
            let down = if row + 1 == height { 0 } else { row + 1 };
            let left = if col == 0 { width - 1 } else { col - 1 };
            let right = if col + 1 == width { 0 } else { col + 1 };

            let idx = |r: u32, c: u32| -> usize { (r * width + c) as usize };

            neighbors.push([
                idx(up, left),
                idx(up, col),
                idx(up, right),
                idx(row, left),
                idx(row, right),
                idx(down, left),
                idx(down, col),
                idx(down, right),
            ]);
        }
    }

    neighbors
}

fn build_background(width: u32, height: u32, pixel_width: u32, pixel_height: u32) -> Vec<u32> {
    let mut background = vec![DEAD_PIXEL; (pixel_width * pixel_height) as usize];

    let cell_width = (pixel_width - 2) as f32 / width as f32;
    let cell_height = (pixel_height - 2) as f32 / height as f32;

    for row in 0..=height {
        let y = (row as f32 * cell_height).round() as u32;

        if y >= pixel_height {
            continue;
        }

        let start = (y * pixel_width) as usize;
        let end = start + pixel_width as usize;

        background[start..end].fill(GRID_PIXEL);
    }

    for col in 0..=width {
        let x = (col as f32 * cell_width).round() as u32;

        if x >= pixel_width {
            continue;
        }

        for y in 0..pixel_height {
            let idx = (y * pixel_width + x) as usize;
            background[idx] = GRID_PIXEL;
        }
    }

    background
}

fn build_cell_rects(width: u32, height: u32, pixel_width: u32, pixel_height: u32) -> Vec<Rect> {
    let mut rects = Vec::with_capacity((width * height) as usize);

    let cell_width = (pixel_width - 2) as f32 / width as f32;
    let cell_height = (pixel_height - 2) as f32 / height as f32;

    for row in 0..height {
        for col in 0..width {
            let start_x = (col as f32 * cell_width).round() as u32;
            let start_y = (row as f32 * cell_height).round() as u32;

            let end_x = ((start_x as f32 + cell_width).round() as u32).min(pixel_width);
            let end_y = ((start_y as f32 + cell_height).round() as u32).min(pixel_height);

            // We draw the static grid first, then draw alive cell interiors.
            // +1 avoids overwriting the left/top grid lines.
            let x0 = (start_x + 1).min(pixel_width) as usize;
            let y0 = (start_y + 1).min(pixel_height) as usize;
            let x1 = end_x as usize;
            let y1 = end_y as usize;

            rects.push(Rect { x0, x1, y0, y1 });
        }
    }

    rects
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,

    pixel_width: u32,
    pixel_height: u32,

    // 0 = dead, 1 = alive.
    // Internal u8 is faster/simpler than enum matching in the hot loop.
    cells: Vec<u8>,
    next_cells: Vec<u8>,

    // Precomputed topology and render geometry.
    neighbors: Vec<[usize; 8]>,
    cell_rects: Vec<Rect>,

    // Static white background + grid.
    background: Vec<u32>,

    // One u32 per RGBA canvas pixel.
    pixels: Vec<u32>,

    _canvas: HtmlCanvasElement,
    ctx: CanvasRenderingContext2d,

    // Keep this alive; ImageData is backed by this view.
    _pixels_view: Uint8ClampedArray,

    image_data: ImageData,
}

impl Universe {
    #[inline(always)]
    fn live_neighbor_count_by_idx(&self, idx: usize) -> u8 {
        let n = self.neighbors[idx];

        unsafe {
            *self.cells.get_unchecked(n[0])
                + *self.cells.get_unchecked(n[1])
                + *self.cells.get_unchecked(n[2])
                + *self.cells.get_unchecked(n[3])
                + *self.cells.get_unchecked(n[4])
                + *self.cells.get_unchecked(n[5])
                + *self.cells.get_unchecked(n[6])
                + *self.cells.get_unchecked(n[7])
        }
    }

    #[inline(always)]
    fn draw_alive_rect_by_idx(&mut self, idx: usize) {
        let rect = unsafe { *self.cell_rects.get_unchecked(idx) };

        if rect.x0 >= rect.x1 || rect.y0 >= rect.y1 {
            return;
        }

        let pixel_width = self.pixel_width as usize;

        for y in rect.y0..rect.y1 {
            let row_start = y * pixel_width;
            let start = row_start + rect.x0;
            let end = row_start + rect.x1;

            self.pixels[start..end].fill(ALIVE_PIXEL);
        }
    }

    #[inline(always)]
    fn tick_inner(&mut self) {
        self.pixels.copy_from_slice(&self.background);

        let len = self.cells.len();

        for idx in 0..len {
            let alive = unsafe { *self.cells.get_unchecked(idx) };

            let neighbors = self.live_neighbor_count_by_idx(idx);

            // Conway rule:
            // alive next if exactly 3 neighbors, or if already alive and exactly 2.
            let next = ((neighbors == 3) || (alive == 1 && neighbors == 2)) as u8;

            unsafe {
                *self.next_cells.get_unchecked_mut(idx) = next;
            }

            if next != 0 {
                self.draw_alive_rect_by_idx(idx);
            }
        }

        std::mem::swap(&mut self.cells, &mut self.next_cells);
    }

    #[inline(always)]
    fn flush_to_canvas(&self) -> Result<(), JsValue> {
        self.ctx.put_image_data(&self.image_data, 0.0, 0.0)
    }
}

#[wasm_bindgen]
impl Universe {
    #[wasm_bindgen(constructor)]
    pub fn new(pixel_width: u32, pixel_height: u32, canvas_id: &str) -> Result<Universe, JsValue> {
        utils::set_panic_hook();

        if pixel_width == 0 || pixel_height == 0 {
            return Err(JsValue::from_str(
                "pixel_width and pixel_height must be non-zero",
            ));
        }

        let canvas = get_canvas(canvas_id)?;
        canvas.set_width(pixel_width);
        canvas.set_height(pixel_height);

        let ctx = get_2d_context(&canvas)?;

        let width = 64;
        let height = 64;

        let cells: Vec<u8> = (0..width * height)
            .map(|i| if i % 2 == 0 || i % 7 == 0 { 1 } else { 0 })
            .collect();

        let next_cells = vec![0; (width * height) as usize];

        let neighbors = build_neighbors(width, height);
        let cell_rects = build_cell_rects(width, height, pixel_width, pixel_height);
        let background = build_background(width, height, pixel_width, pixel_height);

        let pixels = background.clone();

        let byte_slice = u32_pixels_as_u8_slice(&pixels);

        let raw_view = unsafe { Uint8ClampedArray::view(byte_slice) };

        let pixels_view = make_clamped_view(raw_view.into())?;

        if pixels_view.length() != pixel_width * pixel_height * 4 {
            return Err(JsValue::from_str(
                "pixels_view length does not match width*height*4",
            ));
        }

        let image_data = make_image_data_from_clamped_view(&pixels_view, pixel_width)?;

        Ok(Universe {
            width,
            height,
            pixel_width,
            pixel_height,
            cells,
            next_cells,
            neighbors,
            cell_rects,
            background,
            pixels,
            _canvas: canvas,
            ctx,
            _pixels_view: pixels_view,
            image_data,
        })
    }

    pub fn tick(&mut self) -> Result<(), JsValue> {
        self.tick_inner();
        self.flush_to_canvas()
    }

    pub fn benchmark(
        &mut self,
        frames: u32,
        warmup_frames: u32,
        fps_element_id: &str,
    ) -> Result<f64, JsValue> {
        if frames == 0 {
            return Ok(0.0);
        }

        for _ in 0..warmup_frames {
            self.tick_inner();
            self.flush_to_canvas()?;
        }

        let start = now()?;

        for _ in 0..frames {
            self.tick_inner();
            self.flush_to_canvas()?;
        }

        let elapsed = now()? - start;
        let fps = frames as f64 / (elapsed / 1000.0);
        let ms_per_frame = elapsed / frames as f64;

        let fps_element = get_html_element(fps_element_id)?;
        fps_element.set_text_content(Some(&format!("{}", fps.round() as u32)));

        log!("Frames: {}", frames);
        log!("Elapsed: {:.2} ms", elapsed);
        log!("Average: {:.3} ms/frame", ms_per_frame);
        log!("Throughput: {:.0} FPS", fps);

        Ok(fps)
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn pixel_width(&self) -> u32 {
        self.pixel_width
    }

    pub fn pixel_height(&self) -> u32 {
        self.pixel_height
    }

    pub fn cells_ptr(&self) -> *const u8 {
        self.cells.as_ptr()
    }

    pub fn pixels_ptr(&self) -> *const u32 {
        self.pixels.as_ptr()
    }
}

#[wasm_bindgen]
pub fn start_benchmark(
    canvas_id: &str,
    fps_element_id: &str,
    pixel_width: u32,
    pixel_height: u32,
    frames: u32,
    warmup_frames: u32,
) -> Result<f64, JsValue> {
    let mut universe = Universe::new(pixel_width, pixel_height, canvas_id)?;
    universe.benchmark(frames, warmup_frames, fps_element_id)
}
