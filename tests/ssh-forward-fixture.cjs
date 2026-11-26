const { createHash } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const { Server, utils } = require('ssh2');

function gatewayHostKey() {
  // ssh2's Ed25519 generator can strip leading zero bytes from a generated public key.
  for (let attempt = 0; attempt < 5; attempt++) {
    const privateKey = utils.generateKeyPairSync('ed25519').private;
    const parsed = utils.parseKey(privateKey);
    if (!(parsed instanceof Error)) return { privateKey, publicKey: parsed.getPublicSSH() };
  }
  throw new Error('Could not generate a valid SSH fixture host key.');
}

async function startGateway(target, targetHosts = ['localhost'], { stallReply = () => false } = {}) {
  const { privateKey, publicKey } = gatewayHostKey();
  const fingerprint = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  const clients = new Set();
  let forwards = 0;
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'fixture' && auth.password === 'fixture-gateway') auth.accept();
      else auth.reject(['password']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (!targetHosts.includes(info.destIP) || info.destPort !== target) return reject();
      const socket = net.connect(target, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        const channel = accept();
        forwards++;
        channel.on('error', () => socket.destroy());
        socket.on('error', () => channel.destroy());
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        socket.pipe(channel).pipe(socket);
        if (stallReply(forwards)) socket.pause();
      });
    }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  function dropClients() {
    for (const client of clients) client.end();
  }
  return { port: server.address().port, fingerprint, forwarded: () => forwards, dropClients, close() {
    dropClients();
    server.close();
  } };
}

module.exports = { startGateway };
