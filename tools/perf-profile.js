// CPU profile of the running panel WebView over CDP (Node 22+: global fetch/WebSocket).
//   node tools/perf-profile.js [seconds] [port]
// Prints: ws frame counts (state_changed rate), sampled self-time table (function, ms, %).
const seconds = Number(process.argv[2] || 10);
const port = Number(process.argv[3] || 9222);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('no page target'); process.exit(3); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = {};
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending[mid] = resolve;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  let wsFrames = 0, wsBytes = 0, stateEvents = 0;
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
    if (m.method === 'Network.webSocketFrameReceived' && m.params && m.params.response) {
      wsFrames++; wsBytes += (m.params.response.payloadData || '').length;
      if (String(m.params.response.payloadData).indexOf('"state_changed"') >= 0) stateEvents++;
    }
  });
  ws.addEventListener('error', (e) => { console.error('ws error', e.message); process.exit(5); });
  await new Promise((r) => ws.addEventListener('open', r));

  await send('Network.enable');
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 200 });
  await send('Profiler.start');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const prof = (await send('Profiler.stop')).result.profile;
  const heap = await send('Runtime.evaluate', { expression: 'performance.memory ? {used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize} : null', returnByValue: true });
  ws.close();

  // node id -> self time; convert samples/timeDeltas
  const byId = {};
  prof.nodes.forEach((n) => { byId[n.id] = n; });
  const self = {};
  const total = prof.timeDeltas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < prof.samples.length; i++) {
    const n = byId[prof.samples[i]];
    const dt = prof.timeDeltas[i] || 0;
    if (!n) continue;
    const cf = n.callFrame || {};
    const name = (cf.functionName || '(anonymous)') + ' ' + (cf.url ? cf.url.split('/').pop() : '') + ':' + ((cf.lineNumber || 0) + 1);
    self[name] = (self[name] || 0) + dt;
  }
  const rows = Object.keys(self).map((k) => ({ k, us: self[k] })).sort((a, b) => b.us - a.us).slice(0, 40);
  const sec = total / 1e6;
  console.log(JSON.stringify({
    seconds, sampledSeconds: +sec.toFixed(2),
    wsFrames, wsKB: Math.round(wsBytes / 1024), stateEvents,
    stateEventsPerSec: +(stateEvents / seconds).toFixed(2),
    heap: heap && heap.result && heap.result.value,
    top: rows.map((r) => ({ fn: r.k, ms: +(r.us / 1000).toFixed(1), pct: +(r.us / total * 100).toFixed(1) }))
  }, null, 1));
})();
