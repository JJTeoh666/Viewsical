//! Private process entry point. mpv owns playback and its usual JSON IPC pipe.
//! The parent lends this process a mapping for a single RGBA frame at a time.

use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_int, c_ulong, c_void, CString, OsString};
use std::io::{self, BufRead, Write};
use std::os::windows::{
    ffi::OsStrExt,
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use std::path::Path;
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};
use windows::{
    core::{s, Interface, PCSTR, PCWSTR},
    Win32::{
        Foundation::{FreeLibrary, HANDLE, HMODULE, WAIT_FAILED},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::*,
            Dxgi::{Common::*, DXGI_ERROR_WAS_STILL_DRAWING},
        },
        System::{
            LibraryLoader::{
                GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            },
            Memory::{MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS},
            Threading::{CreateEventW, SetEvent, WaitForSingleObject},
        },
    },
};

const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
const RENDER_API_TYPE: c_int = 1;
const ADVANCED_CONTROL: c_int = 10;
const NEXT_FRAME_INFO: c_int = 11;
const BLOCK_FOR_TARGET_TIME: c_int = 12;
const SKIP_RENDERING: c_int = 13;
const D3D11_INIT_PARAMS: c_int = 21;
const D3D11_FBO: c_int = 22;
const UPDATE_FRAME: u64 = 1;
const FRAME_PRESENT: u64 = 1;
const FRAME_REDRAW: u64 = 2;

type Result<T> = std::result::Result<T, &'static str>;
type Callback = unsafe extern "C" fn(*mut c_void);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Input {
    Surface {
        generation: u64,
        handle: usize,
        width: u32,
        height: u32,
    },
    Release {
        generation: u64,
        sequence: u64,
    },
    Inactive,
    ResetFrame,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Output {
    Ready,
    Frame { generation: u64, sequence: u64 },
    Error { reason: &'static str },
}

fn notify(output: &mut impl Write, event: Output) -> Result<()> {
    serde_json::to_writer(&mut *output, &event).map_err(|_| "renderer_output")?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| "renderer_output")
}

pub fn run_video_renderer() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref()? != "--viewsical-video-renderer" {
        return None;
    }
    let mut output = io::stdout().lock();
    Some(match run(args, &mut output) {
        Ok(()) => 0,
        Err(reason) => {
            let _ = notify(&mut output, Output::Error { reason });
            1
        }
    })
}

struct Library(HMODULE);

impl Library {
    fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err("renderer_library_path");
        }
        let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // Limit dependency lookup to the pinned DLL's folder and System32.
        unsafe {
            LoadLibraryExW(
                PCWSTR(path.as_ptr()),
                None,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        }
        .map(Self)
        .map_err(|_| "renderer_library")
    }

    fn symbol(&self, name: PCSTR) -> Result<unsafe extern "system" fn() -> isize> {
        unsafe { GetProcAddress(self.0, name) }.ok_or("renderer_symbol")
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        let _ = unsafe { FreeLibrary(self.0) };
    }
}

#[repr(C)]
struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

impl RenderParam {
    fn new<T>(kind: c_int, value: &mut T) -> Self {
        Self {
            kind,
            data: ptr::from_mut(value).cast(),
        }
    }

    const END: Self = Self {
        kind: 0,
        data: ptr::null_mut(),
    };
}

// Both mpv_d3d11_init_params and mpv_d3d11_fbo contain a single COM pointer.
#[repr(C)]
struct D3dObject {
    pointer: *mut c_void,
}

#[repr(C)]
#[derive(Default)]
struct FrameInfo {
    flags: u64,
    target_time: i64,
}

struct Mpv {
    _library: Library,
    core: *mut c_void,
    set_option: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    terminate: unsafe extern "C" fn(*mut c_void),
    create_renderer: unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *mut RenderParam) -> c_int,
    free_renderer: unsafe extern "C" fn(*mut c_void),
    set_update: unsafe extern "C" fn(*mut c_void, Option<Callback>, *mut c_void),
    update: unsafe extern "C" fn(*mut c_void) -> u64,
    frame_info: unsafe extern "C" fn(*mut c_void, RenderParam) -> c_int,
    render: unsafe extern "C" fn(*mut c_void, *mut RenderParam) -> c_int,
}

impl Mpv {
    fn open(path: &Path, pipe: &str, args: impl Iterator<Item = OsString>) -> Result<Self> {
        let Some(suffix) = pipe.strip_prefix(r"\\.\pipe\tubedesk-") else {
            return Err("renderer_pipe");
        };
        uuid::Uuid::parse_str(suffix).map_err(|_| "renderer_pipe")?;
        let library = Library::open(path)?;
        // Signatures come from the pinned v0.42 client.h and render.h headers.
        macro_rules! symbol {
            ($name:literal) => {
                unsafe { std::mem::transmute(library.symbol(s!($name))?) }
            };
        }
        let version: unsafe extern "C" fn() -> c_ulong = symbol!("mpv_client_api_version");
        if unsafe { version() } >> 16 != 2 {
            return Err("renderer_api_version");
        }
        let create: unsafe extern "C" fn() -> *mut c_void = symbol!("mpv_create");
        let mpv = Self {
            core: ptr::null_mut(),
            set_option: symbol!("mpv_set_option_string"),
            initialize: symbol!("mpv_initialize"),
            terminate: symbol!("mpv_terminate_destroy"),
            create_renderer: symbol!("mpv_render_context_create"),
            free_renderer: symbol!("mpv_render_context_free"),
            set_update: symbol!("mpv_render_context_set_update_callback"),
            update: symbol!("mpv_render_context_update"),
            frame_info: symbol!("mpv_render_context_get_info"),
            render: symbol!("mpv_render_context_render"),
            _library: library,
        };
        let mut mpv = mpv;
        mpv.core = unsafe { create() };
        if mpv.core.is_null() {
            return Err("renderer_mpv_create");
        }
        for arg in args {
            let arg = arg.to_str().ok_or("renderer_options")?;
            let arg = arg.strip_prefix("--").unwrap_or(arg);
            let (name, value) = arg
                .split_once('=')
                .or_else(|| arg.strip_prefix("no-").map(|name| (name, "no")))
                .ok_or("renderer_options")?;
            match name {
                "idle"
                | "keep-open"
                | "terminal"
                | "config"
                | "load-scripts"
                | "stop-screensaver"
                | "input-default-bindings"
                | "input-vo-keyboard"
                | "input-cursor"
                | "window-dragging"
                | "input-doubleclick-time"
                | "osc"
                | "osd-level"
                | "sub-pos"
                | "ytdl"
                | "tls-verify"
                | "network-timeout"
                | "http-proxy"
                | "cache"
                | "cache-pause"
                | "cache-pause-initial"
                | "cache-pause-wait"
                | "cache-secs"
                | "demuxer-readahead-secs"
                | "demuxer-max-bytes"
                | "demuxer-max-back-bytes"
                | "volume"
                | "mute"
                | "speed" => mpv.option(name, value)?,
                "force-window" | "title" | "hwdec" => {}
                _ => return Err("renderer_options"),
            }
        }
        for (name, value) in [
            ("input-ipc-server", pipe),
            ("idle", "yes"),
            ("vo", "libmpv"),
            ("hwdec", "d3d11va"),
            ("force-window", "no"),
            ("video-sync", "audio"),
            ("target-prim", "bt.709"),
            ("target-trc", "srgb"),
            ("config", "no"),
            ("load-scripts", "no"),
            ("terminal", "no"),
            ("ytdl", "no"),
        ] {
            mpv.option(name, value)?;
        }
        if unsafe { (mpv.initialize)(mpv.core) } < 0 {
            return Err("renderer_mpv_init");
        }
        Ok(mpv)
    }

    fn option(&self, name: &str, value: &str) -> Result<()> {
        let name = CString::new(name).map_err(|_| "renderer_options")?;
        let value = CString::new(value).map_err(|_| "renderer_options")?;
        if unsafe { (self.set_option)(self.core, name.as_ptr(), value.as_ptr()) } < 0 {
            return Err("renderer_mpv_option");
        }
        Ok(())
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        if !self.core.is_null() {
            unsafe { (self.terminate)(self.core) };
        }
    }
}

struct Wake {
    event: OwnedHandle,
    needs_update: AtomicBool,
}

impl Wake {
    fn open() -> Result<Self> {
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .map_err(|_| "renderer_event")?;
        Ok(Self {
            event: unsafe { OwnedHandle::from_raw_handle(event.0) },
            needs_update: AtomicBool::new(false),
        })
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.event.as_raw_handle())
    }

    fn signal(&self) {
        let _ = unsafe { SetEvent(self.handle()) };
    }

    fn wait(&self, timeout_ms: u32) -> Result<()> {
        if unsafe { WaitForSingleObject(self.handle(), timeout_ms) } == WAIT_FAILED {
            Err("renderer_wait")
        } else {
            Ok(())
        }
    }
}

unsafe extern "C" fn update_ready(userdata: *mut c_void) {
    // The callback is detached before the render context or Wake is dropped.
    let wake = unsafe { &*userdata.cast::<Wake>() };
    wake.needs_update.store(true, Ordering::Release);
    wake.signal();
}

struct Renderer<'a> {
    mpv: &'a Mpv,
    context: *mut c_void,
}

impl<'a> Renderer<'a> {
    fn open(mpv: &'a Mpv, device: &ID3D11Device, wake: &'a Wake) -> Result<Self> {
        let mut context = ptr::null_mut();
        let mut device = D3dObject {
            pointer: device.as_raw(),
        };
        let mut advanced = 1 as c_int;
        let mut params = [
            RenderParam {
                kind: RENDER_API_TYPE,
                data: c"d3d11".as_ptr().cast_mut().cast(),
            },
            RenderParam::new(D3D11_INIT_PARAMS, &mut device),
            RenderParam::new(ADVANCED_CONTROL, &mut advanced),
            RenderParam::END,
        ];
        unsafe {
            if (mpv.create_renderer)(&mut context, mpv.core, params.as_mut_ptr()) < 0
                || context.is_null()
            {
                return Err("renderer_context");
            }
            (mpv.set_update)(
                context,
                Some(update_ready),
                ptr::from_ref(wake).cast_mut().cast(),
            );
        }
        Ok(Self { mpv, context })
    }

    fn update(&self) -> bool {
        unsafe { (self.mpv.update)(self.context) & UPDATE_FRAME != 0 }
    }

    fn has_new_picture(&self) -> bool {
        let mut info = FrameInfo::default();
        let result = unsafe {
            (self.mpv.frame_info)(self.context, RenderParam::new(NEXT_FRAME_INFO, &mut info))
        };
        result >= 0 && info.flags & (FRAME_PRESENT | FRAME_REDRAW) == FRAME_PRESENT
    }

    fn draw(&self, texture: Option<&ID3D11Texture2D>) -> Result<()> {
        let mut no_wait = 0 as c_int;
        let mut skip = 1 as c_int;
        let mut target = D3dObject {
            pointer: ptr::null_mut(),
        };
        let output = if let Some(texture) = texture {
            target.pointer = texture.as_raw();
            RenderParam::new(D3D11_FBO, &mut target)
        } else {
            RenderParam::new(SKIP_RENDERING, &mut skip)
        };
        let mut params = [
            output,
            RenderParam::new(BLOCK_FOR_TARGET_TIME, &mut no_wait),
            RenderParam::END,
        ];
        if unsafe { (self.mpv.render)(self.context, params.as_mut_ptr()) } < 0 {
            return Err("renderer_draw");
        }
        Ok(())
    }
}

impl Drop for Renderer<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.mpv.set_update)(self.context, None, ptr::null_mut());
            (self.mpv.free_renderer)(self.context);
        }
    }
}

struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    fence: Option<(ID3D11DeviceContext4, ID3D11Fence)>,
    copy_id: u64,
}

impl Gpu {
    fn open() -> Result<Self> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|_| "renderer_device")?;
        let device = device.ok_or("renderer_device")?;
        let context = context.ok_or("renderer_device")?;
        let fence = (|| {
            let device: ID3D11Device5 = device.cast().ok()?;
            let context: ID3D11DeviceContext4 = context.cast().ok()?;
            let mut fence = None;
            unsafe { device.CreateFence(0, D3D11_FENCE_FLAG_NONE, &mut fence) }.ok()?;
            Some((context, fence?))
        })();
        Ok(Self {
            device,
            context,
            fence,
            copy_id: 0,
        })
    }

    fn create_texture(&self, desc: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D> {
        let mut target = None;
        unsafe { self.device.CreateTexture2D(desc, None, Some(&mut target)) }
            .map_err(|_| "renderer_texture")?;
        target.ok_or("renderer_texture")
    }

    fn stage(
        &mut self,
        source: &ID3D11Texture2D,
        target: &ID3D11Texture2D,
        wake: &Wake,
    ) -> Result<()> {
        unsafe {
            self.context.CopyResource(target, source);
            if let Some((context, fence)) = &self.fence {
                self.copy_id += 1;
                context
                    .Signal(fence, self.copy_id)
                    .map_err(|_| "renderer_fence")?;
                fence
                    .SetEventOnCompletion(self.copy_id, wake.handle())
                    .map_err(|_| "renderer_fence")?;
            }
            self.context.Flush();
        }
        Ok(())
    }

    fn read(
        &self,
        source: &ID3D11Texture2D,
        dest: &Mapping,
        width: u32,
        height: u32,
    ) -> Result<bool> {
        if let Some((_, fence)) = &self.fence {
            if unsafe { fence.GetCompletedValue() } < self.copy_id {
                return Ok(false);
            }
        }
        let mut mapped: D3D11_MAPPED_SUBRESOURCE = Default::default();
        match unsafe {
            self.context.Map(
                source,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => return Ok(false),
            Err(_) => return Err("renderer_readback"),
        }
        let row_bytes = width as usize * 4;
        let stride = mapped.RowPitch as usize;
        if mapped.pData.is_null() || stride < row_bytes {
            unsafe { self.context.Unmap(source, 0) };
            return Err("renderer_readback");
        }
        unsafe {
            // Our exact-size mapping is tightly packed. RowPitch includes any
            // D3D11 padding and can change across GPU vendors and sizes.
            if stride == row_bytes {
                ptr::copy_nonoverlapping(
                    mapped.pData.cast::<u8>(),
                    dest.0.Value.cast::<u8>(),
                    row_bytes * height as usize,
                );
            } else {
                for row in 0..height as usize {
                    ptr::copy_nonoverlapping(
                        mapped.pData.cast::<u8>().add(row * stride),
                        dest.0.Value.cast::<u8>().add(row * row_bytes),
                        row_bytes,
                    );
                }
            }
            self.context.Unmap(source, 0);
        }
        Ok(true)
    }
}

struct Mapping(MEMORY_MAPPED_VIEW_ADDRESS);

impl Mapping {
    fn open(handle: usize, width: u32, height: u32) -> Result<Self> {
        if handle == 0 || handle == usize::MAX {
            return Err("renderer_mapping");
        }
        let handle = HANDLE(handle as _);
        let len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .filter(|n| *n > 0 && *n <= MAX_FRAME_BYTES)
            .ok_or("renderer_dimensions")?;
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, len) };
        if view.Value.is_null() {
            return Err("renderer_mapping");
        }
        // The view keeps the mapping alive independently of this handle.
        let _handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        Ok(Self(view))
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        let _ = unsafe { UnmapViewOfFile(self.0) };
    }
}

struct Surface {
    generation: u64,
    width: u32,
    height: u32,
    mapping: Mapping,
    target: ID3D11Texture2D,
    staging: ID3D11Texture2D,
    redraw: bool,
    staged: Option<Instant>,
    published: Option<u64>,
}

impl Surface {
    fn new(gpu: &Gpu, generation: u64, handle: usize, width: u32, height: u32) -> Result<Self> {
        let mapping = Mapping::open(handle, width, height)?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let target = gpu.create_texture(&desc)?;
        let staging = gpu.create_texture(&D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..desc
        })?;
        Ok(Self {
            generation,
            width,
            height,
            mapping,
            target,
            staging,
            redraw: true,
            staged: None,
            published: None,
        })
    }

    fn publish(&mut self, gpu: &Gpu, sequence: &mut u64, output: &mut impl Write) -> Result<()> {
        if self.published.is_some() {
            return Ok(());
        }
        let Some(staged) = self.staged else {
            return Ok(());
        };
        if gpu.read(&self.staging, &self.mapping, self.width, self.height)? {
            self.staged = None;
            *sequence += 1;
            self.published = Some(*sequence);
            notify(
                output,
                Output::Frame {
                    generation: self.generation,
                    sequence: *sequence,
                },
            )?;
        } else if staged.elapsed() > Duration::from_secs(2) {
            return Err("renderer_readback_timeout");
        }
        Ok(())
    }
}

fn run(mut args: impl Iterator<Item = OsString>, output: &mut impl Write) -> Result<()> {
    let dll = args.next().ok_or("renderer_arguments")?;
    let pipe = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("renderer_arguments")?;
    let mpv = Mpv::open(Path::new(&dll), &pipe, args)?;
    let mut gpu = Gpu::open()?;
    let device = gpu.device.clone();
    let wake = Arc::new(Wake::open()?);
    let renderer = Renderer::open(&mpv, &device, &wake)?;
    let (send, receive) = mpsc::sync_channel(8);
    let input_wake = Arc::clone(&wake);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(message) = line
                .as_deref()
                .ok()
                .and_then(|line| serde_json::from_str::<Input>(line).ok())
                .ok_or(())
            else {
                break;
            };
            if send.send(message).is_err() {
                break;
            }
            input_wake.signal();
        }
        drop(send);
        input_wake.signal();
    });
    notify(output, Output::Ready)?;

    let mut surface: Option<Surface> = None;
    let mut sequence = 0;
    let mut has_picture = false;
    loop {
        loop {
            match receive.try_recv() {
                Ok(Input::Surface {
                    generation,
                    handle,
                    width,
                    height,
                }) => {
                    surface = Some(Surface::new(&gpu, generation, handle, width, height)?);
                }
                Ok(Input::Inactive) => surface = None,
                Ok(Input::ResetFrame) => {
                    has_picture = false;
                    if let Some(surface) = &mut surface {
                        surface.staged = None;
                        surface.redraw = false;
                    }
                    if renderer.update() {
                        renderer.draw(None)?;
                    }
                }
                Ok(Input::Release {
                    generation,
                    sequence,
                }) => {
                    if let Some(surface) = &mut surface {
                        if surface.generation == generation && surface.published == Some(sequence) {
                            surface.published = None;
                        }
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }

        let new_frame = wake.needs_update.swap(false, Ordering::AcqRel) && renderer.update();
        if new_frame && !has_picture {
            has_picture = renderer.has_new_picture();
        }
        let Some(surface) = &mut surface else {
            if new_frame {
                // Consume callbacks even while hidden so audio keeps playing.
                // mpv retains its current frame for redraw after reactivation.
                renderer.draw(None)?;
            }
            wake.wait(u32::MAX)?;
            continue;
        };
        if !has_picture {
            if new_frame {
                renderer.draw(None)?;
            }
            wake.wait(u32::MAX)?;
            continue;
        }
        // If script was suspended, prefer the latest decoded picture over the
        // staging texture that has been waiting for the previous upload's ACK.
        if surface.published.is_none() && (new_frame || surface.redraw)
            && surface.staged.is_some_and(|staged| staged.elapsed() > Duration::from_millis(70))
        {
            surface.staged = None;
            surface.redraw = true;
        }
        surface.publish(&gpu, &mut sequence, output)?;
        if (new_frame || surface.redraw) && surface.staged.is_none() {
            renderer.draw(Some(&surface.target))?;
            gpu.stage(&surface.target, &surface.staging, &wake)?;
            surface.staged = Some(Instant::now());
            surface.redraw = false;
            surface.publish(&gpu, &mut sequence, output)?;
        } else if new_frame {
            // Only the latest frame matters when the browser or GPU falls behind.
            // A redraw can show that frame even if playback pauses in the meantime.
            renderer.draw(None)?;
            surface.redraw = true;
        }
        let timeout = if surface.staged.is_some() && surface.published.is_none() {
            if gpu.fence.is_some() {
                50
            } else {
                1
            }
        } else {
            u32::MAX
        };
        wake.wait(timeout)?;
    }
}
