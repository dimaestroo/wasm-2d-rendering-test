mod utils;

use wasm_bindgen::prelude::*;
use wasm_bindgen::{Clamped, JsCast};
use web_sys::{
    CanvasRenderingContext2d,
    Document,
    HtmlCanvasElement,
    HtmlElement,
    ImageData,
    Window,
};

macro_rules! log {
    ($($t:tt)*) => {
        web_sys::console::log_1(&format!($($t)*).into());
    };
}
#[wasm_bindgen]
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cell {
    Dead = 0,
    Alive = 1,
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
    canvas
        .get_context("2d")?
        .ok_or_else(|| JsValue::from_str("2D canvas context unavailable"))?
        .dyn_into::<CanvasRenderingContext2d>()
        .map_err(|_| JsValue::from_str("context is not CanvasRenderingContext2d"))
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,

    pixel_width: u32,
    pixel_height: u32,

    cells: Vec<Cell>,
    next_cells: Vec<Cell>,

    // RGBA framebuffer in WASM memory.
    // Layout: [r, g, b, a, r, g, b, a, ...]
    pixels: Vec<u8>,

    // Keep browser objects alive.
    _canvas: HtmlCanvasElement,
    ctx: CanvasRenderingContext2d,
    image_data: ImageData,
}

impl Universe {
    fn get_cell_index(&self, row: u32, col: u32) -> usize {
        (row * self.width + col) as usize
    }

    fn get_pixel_index(&self, x: u32, y: u32) -> usize {
        ((y * self.pixel_width + x) * 4) as usize
    }

    fn live_neighbor_count(&self, row: u32, col: u32) -> u8 {
        let mut count = 0;

        for delta_row in [self.height - 1, 0, 1] {
            for delta_col in [self.width - 1, 0, 1] {
                if delta_row == 0 && delta_col == 0 {
                    continue;
                }

                let neighbor_row = (row + delta_row) % self.height;
                let neighbor_col = (col + delta_col) % self.width;
                let idx = self.get_cell_index(neighbor_row, neighbor_col);

                count += self.cells[idx] as u8;
            }
        }

        count
    }

    fn build_board(&mut self) {
        for row in 0..self.height {
            for col in 0..self.width {
                let idx = self.get_cell_index(row, col);
                let cell = self.cells[idx];
                let live_neighbors = self.live_neighbor_count(row, col);

                let next_cell = match (cell, live_neighbors) {
                    (Cell::Alive, x) if x < 2 => Cell::Dead,
                    (Cell::Alive, 2) | (Cell::Alive, 3) => Cell::Alive,
                    (Cell::Alive, x) if x > 3 => Cell::Dead,
                    (Cell::Dead, 3) => Cell::Alive,
                    (otherwise, _) => otherwise,
                };

                self.next_cells[idx] = next_cell;
            }
        }

        std::mem::swap(&mut self.cells, &mut self.next_cells);
    }

    fn set_pixel(&mut self, x: u32, y: u32, r: u8, g: u8, b: u8, a: u8) {
        if x >= self.pixel_width || y >= self.pixel_height {
            return;
        }

        let idx = self.get_pixel_index(x, y);

        self.pixels[idx] = r;
        self.pixels[idx + 1] = g;
        self.pixels[idx + 2] = b;
        self.pixels[idx + 3] = a;
    }

    fn clear_board(&mut self) {
        for px in self.pixels.chunks_exact_mut(4) {
            px[0] = 0xff;
            px[1] = 0xff;
            px[2] = 0xff;
            px[3] = 0xff;
        }
    }

    fn draw_row(&mut self, row: u32, cell_height: f32) {
        let y = (row as f32 * cell_height).round() as u32;

        if y >= self.pixel_height {
            return;
        }

        for x in 0..self.pixel_width {
            self.set_pixel(x, y, 0xdd, 0xdd, 0xdd, 0xff);
        }
    }

    fn draw_col(&mut self, col: u32, cell_width: f32) {
        let x = (col as f32 * cell_width).round() as u32;

        if x >= self.pixel_width {
            return;
        }

        for y in 0..self.pixel_height {
            self.set_pixel(x, y, 0xdd, 0xdd, 0xdd, 0xff);
        }
    }

    fn draw_square(&mut self, row: u32, col: u32, cell_width: f32, cell_height: f32) {
        let start_x = (col as f32 * cell_width).round() as u32;
        let start_y = (row as f32 * cell_height).round() as u32;

        let end_x = ((start_x as f32 + cell_width).round() as u32).min(self.pixel_width);
        let end_y = ((start_y as f32 + cell_height).round() as u32).min(self.pixel_height);

        for y in start_y..end_y {
            for x in start_x..end_x {
                self.set_pixel(x, y, 0x00, 0x00, 0x00, 0xff);
            }
        }
    }

    fn render_board_to_pixel_buffer(&mut self) {
        let cell_width = (self.pixel_width - 2) as f32 / self.width as f32;
        let cell_height = (self.pixel_height - 2) as f32 / self.height as f32;

        self.clear_board();

        for row in 0..self.height {
            for col in 0..self.width {
                let idx = self.get_cell_index(row, col);

                if self.cells[idx] == Cell::Alive {
                    self.draw_square(row, col, cell_width, cell_height);
                }
            }
        }

        for row in 0..=self.height {
            self.draw_row(row, cell_height);
        }

        for col in 0..=self.width {
            self.draw_col(col, cell_width);
        }
    }

    fn flush_to_canvas(&self) -> Result<(), JsValue> {
        self.ctx.put_image_data(&self.image_data, 0.0, 0.0)
    }
}

#[wasm_bindgen]
impl Universe {
    #[wasm_bindgen(constructor)]
    pub fn new(
        pixel_width: u32,
        pixel_height: u32,
        canvas_id: &str,
    ) -> Result<Universe, JsValue> {
        utils::set_panic_hook();

        let canvas = get_canvas(canvas_id)?;
        canvas.set_width(pixel_width);
        canvas.set_height(pixel_height);

        let ctx = get_2d_context(&canvas)?;

        let width = 64;
        let height = 64;

        let cells: Vec<Cell> = (0..width * height)
            .map(|i| {
                if i % 2 == 0 || i % 7 == 0 {
                    Cell::Alive
                } else {
                    Cell::Dead
                }
            })
            .collect();

        let next_cells = cells.clone();

        let mut pixels = vec![0xff; (pixel_width * pixel_height * 4) as usize];

        // Build the initial frame before creating ImageData.
        // After ImageData is created, avoid reallocating `pixels`.
        for px in pixels.chunks_exact_mut(4) {
            px[0] = 0xff;
            px[1] = 0xff;
            px[2] = 0xff;
            px[3] = 0xff;
        }

        // Best Canvas2D-style path:
        //
        // ImageData is created once from the WASM-owned framebuffer.
        // Each frame mutates `self.pixels`, then calls putImageData().
        //
        // Do not push/resize/replace `pixels` after this point.
        // Avoid allocations inside tick().
        let image_data = ImageData::new_with_u8_clamped_array_and_sh(
            Clamped(pixels.as_slice()),
            pixel_width,
            pixel_height,
        )?;

        Ok(Universe {
            width,
            height,
            pixel_width,
            pixel_height,
            cells,
            next_cells,
            pixels,
            _canvas: canvas,
            ctx,
            image_data,
        })
    }

    pub fn tick(&mut self) -> Result<(), JsValue> {
        self.build_board();
        self.render_board_to_pixel_buffer();
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
            self.tick()?;
        }

        let start = now()?;

        for _ in 0..frames {
            self.tick()?;
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

    pub fn cells_ptr(&self) -> *const Cell {
        self.cells.as_ptr()
    }

    pub fn pixels_ptr(&self) -> *const u8 {
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