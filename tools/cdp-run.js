// Run one JS expression inside the panel WebView over the Chrome DevTools Protocol.
// Node 22+ (global fetch + WebSocket). Keeps the awkward quoting out of PowerShell.
//   node tools/cdp-run.js <expr-file> [port]
// The file must contain a single expression; its completion value is printed as JSON.
const fs = require('fs');

const file = process.argv[2];
const port = Number(process.argv[3] || 9222);
if (!file) { console.error('usage: node tools/cdp-run.js <expr-file> [port]'); process.exit(2); }
const expr = fs.readFileSync(file, 'utf8');

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('no page target'); process.exit(3); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 30000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      }));
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      resolve(m);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); resolve({ error: String(e.message || e) }); });
  });

  const reply = await done;
  try { ws.close(); } catch (e) { }

  if (reply.timeout) { console.log('TIMEOUT'); process.exit(4); }
  if (reply.error) { console.log('WSERROR: ' + reply.error); process.exit(5); }
  if (reply.exceptionDetails) {
    const d = reply.exceptionDetails;
    console.log('EXCEPTION: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    process.exit(6);
  }
  const r = reply.result && reply.result.result;
  if (!r) { console.log('<no result>'); process.exit(0); }
  if (r.type === 'object') { console.log(JSON.stringify(r.value, null, 1)); }
  else console.log(JSON.stringify(r.value));
})();
