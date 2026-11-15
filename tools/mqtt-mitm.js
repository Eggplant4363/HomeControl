// 临时 MITM：MQTTX 指到 127.0.0.1:18830，转发到 10.10.1.8:1883，记录两侧原始字节（hex）
const net = require('net');
const fs = require('fs');
const LOG = process.env.MQTTX_LOG || 'D:\\Document\\Project\\HomeControl\\tools\\mqttx-capture.log';
function hex(b) { return b.toString('hex').replace(/(..)/g, '$1 ').trim(); }
const srv = net.createServer((cli) => {
  const up = net.connect({ host: '10.10.1.8', port: 1883 }, () => {
    fs.appendFileSync(LOG, `\n=== session start ${new Date().toISOString()} ===\n`);
    cli.on('data', (d) => { fs.appendFileSync(LOG, `client->broker ${d.length}B: ${hex(d)}\n`); up.write(d); });
    up.on('data', (d) => { fs.appendFileSync(LOG, `broker->client ${d.length}B: ${hex(d)}\n`); cli.write(d); });
    cli.on('end', () => up.end());
    up.on('end', () => cli.end());
    cli.on('error', () => up.destroy());
    up.on('error', (e) => { fs.appendFileSync(LOG, `broker err: ${e.message}\n`); cli.destroy(); });
  });
  up.on('error', (e) => { fs.appendFileSync(LOG, `up connect err: ${e.message}\n`); cli.destroy(); });
});
srv.listen(18830, '127.0.0.1', () => console.log('MITM proxy on 127.0.0.1:18830 -> 10.10.1.8:1883, log=', LOG));
