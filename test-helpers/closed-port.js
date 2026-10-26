import net from 'node:net';

// Ask the OS for an ephemeral port, then wait until it is no longer listening.
// An unspecified host reserves both loopback families on dual-stack hosts.
/** @returns {Promise<number>} */
export function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}
