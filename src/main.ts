import { XpraClient } from './core/client.ts';
import type { CredentialRequest } from './core/types.ts';
import { WebSocketTransport } from './browser/websocket.ts';
import { DesktopSkin } from './ui/desktop.ts';
import './ui/style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="toolbar">
    <a class="brand" href="./" aria-label="Xpra home"><span class="brand-mark">x</span> xpra <span class="brand-detail">workspace</span></a>
    <span id="status" class="connection-status" role="status">Disconnected</span>
    <nav class="toolbar-actions" aria-label="Session controls">
      <button id="fullscreen" type="button">Full screen</button><button id="disconnect" type="button" hidden>Disconnect</button>
    </nav>
  </header>
  <main id="workspace" class="workspace" aria-label="Remote workspace">
    <div class="workspace-hint"><span class="hint-symbol">↗</span><h1>Your apps. Anywhere.</h1><p>A quiet space for your remote desktop.</p></div>
    <div id="stage" class="stage"></div>
  </main>
  <footer class="bottom-bar"><nav id="tasks" aria-label="Remote windows"></nav><span>TypeScript client <span class="version">0.1</span></span></footer>
  <section id="connection" class="connection-panel" aria-labelledby="connection-title">
    <form id="connect-form" class="connection-card">
      <span class="eyebrow">REMOTE WORKSPACE</span><h1 id="connection-title">Make yourself at home.</h1><p class="intro">Connect to an Xpra session to bring your applications here.</p>
      <label for="endpoint">Server address</label><input id="endpoint" name="endpoint" type="url" required spellcheck="false" placeholder="wss://server.example:14500/" autocomplete="url">
      <div class="credentials"><div><label for="username">Username <span>optional</span></label><input id="username" name="username" autocomplete="username"></div><div><label for="password">Password <span>optional</span></label><input id="password" name="password" type="password" autocomplete="current-password"></div></div>
      <div class="options"><label><input id="share" type="checkbox"> Share session</label><label><input id="readonly" type="checkbox"> View only</label></div>
      <p class="option-help">Connecting takes over any existing client unless sharing is selected.</p>
      <button class="primary" id="connect" type="submit">Connect to workspace <span>→</span></button>
      <p id="connection-message" class="connection-message" role="status"></p>
      <details class="diagnostics"><summary>Connection details</summary><ol id="diagnostics"></ol></details>
    </form>
  </section>
  <dialog id="credentials-dialog"><form method="dialog" id="credentials-form"><span class="eyebrow">AUTHENTICATION</span><h2 id="credential-prompt">Password</h2><label for="challenge-password">Secret</label><input id="challenge-password" type="password" autocomplete="off"><div class="dialog-actions"><button value="cancel">Cancel</button><button value="submit" class="primary">Continue</button></div></form></dialog>
`;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const endpoint = get<HTMLInputElement>('endpoint');
const current = new URL(location.href); current.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; current.search = ''; current.hash = ''; endpoint.value = current.href;
const workspace = get<HTMLElement>('workspace');
const skin = new DesktopSkin(get('stage'), get('tasks'));
async function credentials(request: CredentialRequest): Promise<string | undefined> {
  const dialog = get<HTMLDialogElement>('credentials-dialog'), secret = get<HTMLInputElement>('challenge-password');
  get('credential-prompt').textContent = request.prompt || 'Password'; secret.value = ''; dialog.returnValue = '';
  if (request.signal.aborted) return undefined;
  return new Promise(resolve => {
    const close = () => { dialog.removeEventListener('close', close); request.signal.removeEventListener('abort', abort); const value = dialog.returnValue === 'submit' ? secret.value : undefined; secret.value = ''; resolve(value); };
    const abort = () => dialog.close('cancel');
    dialog.addEventListener('close', close); request.signal.addEventListener('abort', abort, { once: true }); dialog.showModal(); secret.focus();
  });
}
const client = new XpraClient({ transport: () => new WebSocketTransport(), renderer: skin, credentials, width: Math.max(1, workspace.clientWidth), height: Math.max(1, workspace.clientHeight - 44) });
skin.attach(client);
client.subscribe(event => {
  if (event.type === 'state') {
    const { state, reason, readonly, capabilities } = event.snapshot;
    const connected = state === 'connected', busy = ['connecting', 'handshaking', 'authenticating'].includes(state);
    get('connection').hidden = connected;
    get<HTMLButtonElement>('connect').disabled = busy;
    get('connect').textContent = busy ? 'Connecting…' : 'Connect to workspace →';
    get('disconnect').hidden = !connected && !busy;
    get('status').textContent = connected ? `${typeof capabilities.session_name === 'string' ? capabilities.session_name : 'Connected'}${readonly ? ' · View only' : ''}` : state[0]!.toUpperCase() + state.slice(1);
    get('status').dataset.state = state;
    get('connection-message').textContent = reason || (busy ? 'Establishing your session…' : '');
    get('connection-message').classList.toggle('error', state === 'error');
  } else if (event.type === 'diagnostic') {
    const item = document.createElement('li'); item.textContent = event.message;
    const log = get('diagnostics'); log.append(item); while (log.children.length > 50) log.firstElementChild!.remove();
    if (event.level === 'warning') get<HTMLDetailsElement>('diagnostics').closest('details')!.open = true;
  }
});
get('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  const password = get<HTMLInputElement>('password');
  const options = { url: endpoint.value.trim(), username: get<HTMLInputElement>('username').value, password: password.value || undefined, share: get<HTMLInputElement>('share').checked, readonly: get<HTMLInputElement>('readonly').checked };
  password.value = '';
  void client.connect(options).catch(error => { get('connection-message').textContent = String(error); });
});
get('disconnect').addEventListener('click', () => client.disconnect());
get('fullscreen').addEventListener('click', () => {
  void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(error => { get('connection-message').textContent = String(error); });
});
let resizeTimer: ReturnType<typeof setTimeout>;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => client.setDisplaySize(Math.max(1, Math.min(32767, workspace.clientWidth)), Math.max(1, Math.min(32767, workspace.clientHeight - 44))), 150); }).observe(workspace);
window.addEventListener('pagehide', () => client.disconnect());
