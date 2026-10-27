import { createHash } from 'node:crypto';

let input = Buffer.alloc(0), upgraded = false;
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (!upgraded) {
    const end = input.indexOf('\r\n\r\n');
    if (end < 0) return;
    const request = input.subarray(0, end).toString();
    const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1];
    if (!key) process.exit(2);
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    input = input.subarray(end + 4); upgraded = true;
  }
  frames();
});

function frames() {
  while (input.length >= 6) {
    const first = input[0], second = input[1];
    let length = second & 0x7f, offset = 2;
    if (length === 126) { if (input.length < 8) return; length = input.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (input.length < 14) return; length = Number(input.readBigUInt64BE(2)); offset = 10; }
    if (!(second & 0x80)) process.exit(3);
    if (input.length < offset + 4 + length) return;
    const mask = input.subarray(offset, offset + 4);
    const payload = Buffer.from(input.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
    input = input.subarray(offset + 4 + length);
    if ((first & 0x0f) === 0x8) { process.stdin.end(); return; }
    if ((first & 0x0f) !== 1) process.exit(4);
    const request = JSON.parse(payload.toString());
    if (request.method === 'initialized') continue;
    const result = request.method === 'initialize' ? {} : request.method === 'thread/list' ? { data: [] } : {};
    process.stdout.write(encode({ id: request.id, result }));
  }
}

function encode(message) {
  const payload = Buffer.from(JSON.stringify(message));
  let header;
  if (payload.length < 126) { header = Buffer.from([0x81, payload.length]); }
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
