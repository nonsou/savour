// Preloaded with --import. Any attempt to reach the network, resolve DNS, or
// load a Firebase/Supabase module terminates the process with exit code 99.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

function trip(what) {
  process.stderr.write(`NETWORK_TRIPWIRE:${what}\n`);
  process.exit(99);
}

globalThis.fetch = () => trip('fetch');
globalThis.WebSocket = function WebSocket() { trip('WebSocket'); };
globalThis.EventSource = function EventSource() { trip('EventSource'); };
for (const [mod, names] of [
  [net, ['connect', 'createConnection']],
  [tls, ['connect']],
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [http2, ['connect']],
  [dgram, ['createSocket']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
]) {
  for (const name of names) mod[name] = () => trip(name);
}
net.Socket.prototype.connect = () => trip('Socket.connect');
// Propagate the patches to named ESM imports such as `import { lookup } from 'node:dns'`.
syncBuiltinESMExports();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|[/@])(firebase|supabase)/i.test(specifier)) trip(`module:${specifier.replace(/[^a-z0-9@/_-]/gi, '')}`);
    return nextResolve(specifier, context);
  },
});
