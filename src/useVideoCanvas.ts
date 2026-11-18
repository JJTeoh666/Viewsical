import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { api, isDesktop } from './api';
import type { VideoRendererMode } from './types';

interface WebViewFrames extends EventTarget {
  releaseBuffer(buffer: ArrayBuffer): void;
}

interface BufferEvent extends Event {
  additionalData?: { type: string; generation: number; loadId: number; width: number; height: number };
  getBuffer(): ArrayBuffer;
}

interface Frame {
  type: string;
  generation: number;
  loadId: number;
  sequence: number;
}

const maxBytes = 128 * 1024 * 1024;

function createPainter(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  const texture = gl.createTexture();
  if (!program || !texture) throw new Error('Could not create the video renderer');

  const compile = (type: number, code: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create a video shader');
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  };
  try {
    // This oversized triangle covers the canvas and maps the first row of the
    // top-down Direct3D image to the top of the WebGL framebuffer.
    compile(gl.VERTEX_SHADER, `#version 300 es
      out vec2 uv;
      void main() {
        vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
        uv = vec2(corner.x, 1.0 - corner.y);
      }`);
    compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 uv;
      uniform sampler2D videoFrame;
      out vec4 pixel;
      void main() { pixel = vec4(texture(videoFrame, uv).rgb, 1.0); }
    `);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Could not link the video shaders');
  } catch (error) {
    gl.deleteProgram(program);
    gl.deleteTexture(texture);
    throw error;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(program);
  let textureWidth = 0, textureHeight = 0;
  const canvas = gl.canvas as HTMLCanvasElement;
  return {
    paint(width: number, height: number, bytes: Uint8Array) {
      if (textureWidth !== width || textureHeight !== height) {
        canvas.width = textureWidth = width;
        canvas.height = textureHeight = height;
        gl.viewport(0, 0, width, height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not allocate the video texture');
      }
      // WebGL copies the typed array on upload. The sender may reuse it as
      // soon as this call returns, without waiting for the GPU to draw.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    clear() { gl.clear(gl.COLOR_BUFFER_BIT); },
    dispose() { gl.deleteTexture(texture); gl.deleteProgram(program); },
  };
}

interface SurfaceState {
  loadId: number;
  hasVideo: boolean;
  audio: boolean;
  active: boolean;
}

export function useVideoCanvas(canvasRef: RefObject<HTMLCanvasElement | null>, surfaceRef: RefObject<HTMLDivElement | null>, state: SurfaceState) {
  const [mode, setMode] = useState<VideoRendererMode>('native');
  const current = useRef(state);
  const updateSurface = useRef<(clear: boolean) => void>(null);
  useLayoutEffect(() => {
    const clear = current.current.loadId !== state.loadId || current.current.audio !== state.audio || !state.hasVideo;
    current.current = state;
    updateSurface.current?.(clear);
  }, [state.loadId, state.hasVideo, state.audio, state.active]);

  useEffect(() => {
    const view = (window as Window & { chrome?: { webview?: WebViewFrames } }).chrome?.webview;
    const canvas = canvasRef.current;
    const stage = surfaceRef.current;
    if (!isDesktop || !view?.releaseBuffer || !canvas || !stage) return;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) { void api.videoSurfaceFailed(0).catch(() => {}); return; }
    let painter: ReturnType<typeof createPainter>;
    try { painter = createPainter(gl); }
    catch { void api.videoSurfaceFailed(0).catch(() => {}); return; }
    const maxDimension = Math.min(8192, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    let disposed = false, failed = false, inViewport = true;
    let buffer: { generation: number; loadId: number; width: number; height: number; bytes: Uint8Array<ArrayBuffer> } | undefined;
    let newestGeneration = 0;
    let desired = [0, 0], configured = '', configuring = false;
    const releaseFrame = (frame: Frame) => { void api.videoSurfaceRelease(frame.generation, frame.sequence).catch(() => {}); };
    const releaseBuffer = () => {
      if (!buffer) return;
      view.releaseBuffer(buffer.bytes.buffer);
      buffer = undefined;
    };
    const fail = (generation = newestGeneration) => {
      if (disposed || failed) return;
      failed = true;
      releaseBuffer();
      void api.videoSurfaceFailed(generation).catch(() => {});
    };
    const configure = async () => {
      if (configuring) return;
      configuring = true;
      try {
        while (!disposed && !failed && configured !== desired.join('x')) {
          const [width, height] = desired;
          configured = desired.join('x');
          await api.videoSurfaceConfigure(width, height);
        }
      } catch { fail(); }
      finally { configuring = false; }
    };
    const visible = () => current.current.active && inViewport && !document.hidden;
    const resize = (clear = false) => {
      if (clear) painter.clear();
      const { width, height } = stage.getBoundingClientRect();
      const ratio = devicePixelRatio || 1;
      if (!document.hidden && !current.current.hasVideo) desired = [1, 1];
      else if (visible() && width > 0 && height > 0) {
        const scale = Math.min(ratio, maxDimension / Math.max(width, height), Math.sqrt(maxBytes / (4 * width * height)));
        desired = [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
      } else desired = [0, 0];
      void configure();
    };
    const receiveBuffer = (event: Event) => {
      const { additionalData: info, getBuffer } = event as BufferEvent;
      if (info?.type !== 'viewsical-video-buffer') return;
      const bytes = getBuffer.call(event);
      const { generation, loadId, width, height } = info;
      if (failed || generation <= newestGeneration) { view.releaseBuffer(bytes); return; }
      const size = width * height * 4;
      if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(loadId) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxDimension || height > maxDimension || size > maxBytes || bytes.byteLength !== size) {
        view.releaseBuffer(bytes);
        fail();
        return;
      }
      releaseBuffer();
      newestGeneration = generation;
      buffer = { generation, loadId, width, height, bytes: new Uint8Array(bytes) };
    };
    const receiveFrame = (event: Event) => {
      const frame = (event as MessageEvent<Frame | null>).data;
      if (!frame || !Number.isSafeInteger(frame.generation)) return;
      if (frame.type === 'viewsical-video-inactive' && frame.generation > newestGeneration) {
        newestGeneration = frame.generation;
        releaseBuffer();
      }
      if (frame.type !== 'viewsical-video-frame' || !Number.isSafeInteger(frame.sequence)) return;
      try {
        if (!failed && buffer && frame.generation === buffer.generation && frame.loadId === buffer.loadId && frame.loadId === current.current.loadId && visible()) {
          // The native producer waits for this acknowledgement before writing
          // again. Upload now so the compositor can use the next refresh.
          painter.paint(buffer.width, buffer.height, buffer.bytes);
        }
      } catch { fail(); }
      finally { releaseFrame(frame); }
    };
    const layout = () => resize();
    const onLoss = () => fail(0);
    view.addEventListener('sharedbufferreceived', receiveBuffer);
    view.addEventListener('message', receiveFrame);
    canvas.addEventListener('webglcontextlost', onLoss);
    const observer = new ResizeObserver(layout);
    observer.observe(stage);
    const intersection = new IntersectionObserver(([entry]) => { inViewport = entry.isIntersecting; resize(); });
    intersection.observe(stage);
    document.addEventListener('visibilitychange', layout);
    window.addEventListener('resize', layout);
    updateSurface.current = resize;
    resize();

    let unlisten: (() => void) | undefined;
    let modeUpdates = 0;
    const updateMode = (value: VideoRendererMode) => {
      if (disposed) return;
      if (value !== 'canvas') releaseBuffer();
      setMode(value === 'canvas' ? 'canvas' : 'native');
    };
    void api.on<VideoRendererMode>('video-renderer-mode', value => { modeUpdates += 1; updateMode(value); }).then(async stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      const previous = modeUpdates;
      const value = await api.videoRendererMode();
      if (modeUpdates === previous) updateMode(value);
    }).catch(() => {});
    return () => {
      disposed = true;
      updateSurface.current = null;
      releaseBuffer();
      painter.dispose();
      unlisten?.();
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', layout);
      window.removeEventListener('resize', layout);
      view.removeEventListener('sharedbufferreceived', receiveBuffer);
      view.removeEventListener('message', receiveFrame);
      canvas.removeEventListener('webglcontextlost', onLoss);
    };
  }, [canvasRef, surfaceRef]);

  return mode;
}
