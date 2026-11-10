import type { XpraClient } from '../core/client.ts';
import type { ClientEvent, Geometry, RemoteWindow, Renderer } from '../core/types.ts';
import { dict } from '../protocol/value.ts';
import { CanvasSurface } from '../browser/canvas.ts';
import { bindInput } from '../browser/input.ts';

interface View { element: HTMLElement; title: HTMLElement; canvas: HTMLCanvasElement; task: HTMLButtonElement; model: RemoteWindow; disposeInput: () => void }
function button(label: string, content: string, action: () => void) {
  const element = document.createElement('button'); element.type = 'button'; element.title = label; element.setAttribute('aria-label', label); element.textContent = content; element.addEventListener('click', action); return element;
}

/** A skin owns DOM and interaction. It never reads or constructs protocol packets. */
export class DesktopSkin implements Renderer {
  private views = new Map<number, View>();
  private order = 1;
  private client?: XpraClient;
  private unsubscribe?: () => void;
  private readonly = false;
  private stage: HTMLElement;
  private tasks: HTMLElement;
  constructor(stage: HTMLElement, tasks: HTMLElement) { this.stage = stage; this.tasks = tasks; }
  attach(client: XpraClient) { this.client = client; this.unsubscribe = client.subscribe(event => this.update(event)); }
  create(model: RemoteWindow) {
    if (!this.client) throw new Error('Attach the skin before connecting');
    const element = document.createElement('article'); element.className = 'remote-window'; element.dataset.wid = String(model.id);
    const chrome = document.createElement('header'); chrome.className = 'window-chrome';
    const title = document.createElement('span'); title.className = 'window-title'; chrome.append(title);
    const minimize = button('Minimize window', '−', () => this.client!.minimizeWindow(model.id, true));
    const close = button('Close window', '×', () => this.client!.closeWindow(model.id)); close.className = 'window-close'; chrome.append(minimize, close);
    const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.className = 'window-canvas';
    const resize = document.createElement('div'); resize.className = 'resize-handle'; resize.setAttribute('aria-hidden', 'true');
    element.append(chrome, canvas, resize); this.stage.append(element);
    const task = button('Switch window', '', () => {
      const view = this.views.get(model.id)!;
      if (view.model.minimized) this.client!.minimizeWindow(model.id, false);
      canvas.focus(); this.client!.focusWindow(model.id);
    }); task.className = 'window-task'; this.tasks.append(task);
    const view: View = { element, title, canvas, task, model, disposeInput: () => {} };
    view.disposeInput = bindInput(canvas, () => view.model, this.client);
    this.views.set(model.id, view); this.layout(view); this.raise(view);
    this.drag(chrome, view, false); this.drag(resize, view, true);
    element.addEventListener('pointerdown', () => this.raise(view));
    const surface = new CanvasSurface(canvas, model.width, model.height, this.client.limits.decodedBytes);
    return {
      resize: (width: number, height: number) => surface.resize(width, height),
      draw: surface.draw.bind(surface),
      dispose: () => { view.disposeInput(); surface.dispose(); element.remove(); task.remove(); this.views.delete(model.id); this.modalState(); },
    };
  }
  private update(event: ClientEvent) {
    if (event.type === 'state') { this.readonly = event.snapshot.readonly; this.stage.classList.toggle('readonly', this.readonly); return; }
    if (event.type !== 'window') return;
    const view = this.views.get(event.window.id); if (!view) return;
    view.model = event.window;
    if (event.action === 'raise') this.raise(view);
    this.layout(view); this.modalState();
  }
  private layout(view: View) {
    const w = view.model, popup = w.metadata['override-redirect'] === true;
    const title = typeof w.metadata.title === 'string' && w.metadata.title ? w.metadata.title : `Window ${w.id}`;
    view.title.textContent = title; view.task.textContent = title; view.task.title = title; view.canvas.setAttribute('aria-label', title);
    view.element.style.left = `${w.x}px`; view.element.style.top = `${w.y}px`;
    view.element.style.width = `${w.width}px`; view.element.style.height = `${w.height}px`;
    view.element.classList.toggle('undecorated', popup || w.metadata.decorations === 0);
    view.element.classList.toggle('popup', popup); view.element.hidden = w.minimized; view.task.hidden = popup;
    view.task.classList.toggle('minimized', w.minimized);
  }
  private modalState() {
    for (const view of this.views.values()) {
      view.element.inert = [...this.views.values()].some(child => child.model.metadata.modal === true && child.model.metadata['transient-for'] === view.model.id && !child.model.minimized);
    }
  }
  private raise(view: View) {
    view.element.style.zIndex = String(++this.order);
    for (const other of this.views.values()) other.task.classList.toggle('active', other === view);
    for (const child of this.views.values()) if (child.model.metadata['transient-for'] === view.model.id) child.element.style.zIndex = String(++this.order);
  }
  private drag(handle: HTMLElement, view: View, resizing: boolean) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.readonly || (event.target instanceof Element && event.target.closest('button')) || view.model.metadata['override-redirect']) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId); this.raise(view);
      const start = { ...view.model }, x = event.clientX, y = event.clientY;
      let geometry: Geometry = start;
      const move = (e: PointerEvent) => {
        geometry = resizing ? this.constrain(view.model, start.width + e.clientX - x, start.height + e.clientY - y) : { ...start, x: Math.max(-32768, Math.min(32767, Math.round(start.x + e.clientX - x))), y: Math.max(0, Math.min(32767, Math.round(start.y + e.clientY - y))) };
        view.element.style.left = `${geometry.x}px`; view.element.style.top = `${geometry.y}px`;
        view.element.style.width = `${geometry.width}px`; view.element.style.height = `${geometry.height}px`;
      };
      const stop = (e: PointerEvent) => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel);
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        if (this.views.has(view.model.id)) {
          try { this.client!.configureWindow(view.model.id, geometry); }
          catch { this.layout(view); } // A local resource limit can refuse this geometry.
        }
      };
      const cancel = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel); this.layout(view); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel);
    });
  }
  private constrain(model: RemoteWindow, width: number, height: number): Geometry {
    let constraints;
    try { constraints = dict(model.metadata['size-constraints']); } catch { constraints = {}; }
    const pair = (name: string, fallback: [number, number]): [number, number] => {
      const value = constraints[name]; return Array.isArray(value) && value.length >= 2 && value.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ? value as [number, number] : fallback;
    };
    const min = pair('minimum-size', [80, 40]), max = pair('maximum-size', [8192, 8192]);
    const base = pair('base-size', min), increment = pair('increment', [1, 1]);
    const size = [width, height].map((n, axis) => {
      const step = Math.max(1, increment[axis]!);
      const snapped = base[axis]! + Math.round((n - base[axis]!) / step) * step;
      return Math.max(1, min[axis]!, Math.min(max[axis]! || 8192, this.client!.limits.maxDimension, snapped));
    });
    const minimumRatio = pair('minimum-aspect-ratio', [0, 1]), maximumRatio = pair('maximum-aspect-ratio', [0, 1]);
    let w = size[0]!, h = size[1]!;
    if (minimumRatio[0] && minimumRatio[1] && w / h < minimumRatio[0] / minimumRatio[1]) h = Math.floor(w * minimumRatio[1] / minimumRatio[0]);
    if (maximumRatio[0] && maximumRatio[1] && w / h > maximumRatio[0] / maximumRatio[1]) w = Math.floor(h * maximumRatio[0] / maximumRatio[1]);
    if (w * h > this.client!.limits.maxWindowPixels) return model;
    return { x: model.x, y: model.y, width: Math.max(1, w), height: Math.max(1, h) };
  }
  dispose() { this.unsubscribe?.(); this.client?.disconnect(); }
}
