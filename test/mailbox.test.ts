import net from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {normalizeAccount} from '../src/config.js';
import {listFolders} from '../src/mailbox.js';

let server: net.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** IMAP server that rejects every login. */
async function rejectingImapServer(
  onClientClosed: () => void
): Promise<number> {
  server = net.createServer(socket => {
    socket.on('close', onClientClosed);
    socket.on('error', () => {});
    socket.write('* OK ready\r\n');
    socket.on('data', data => {
      for (const line of data.toString().split('\r\n').filter(Boolean)) {
        const [tag, command] = line.split(' ');
        if (/^capability$/i.test(command)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        } else if (/^login$/i.test(command)) {
          socket.write(
            `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`
          );
        } else {
          socket.write(`${tag} BAD unexpected\r\n`);
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server!.once('listening', resolve));
  return (server.address() as net.AddressInfo).port;
}

describe('IMAP connections', () => {
  it('closes the connection when login fails', async () => {
    let closed = false;
    const port = await rejectingImapServer(() => {
      closed = true;
    });
    const account = normalizeAccount({
      provider: 'custom',
      email: 'me@example.com',
      password: 'wrong',
      imap: {host: '127.0.0.1', port, secure: false},
      smtp: {host: '127.0.0.1', port: 1, secure: false},
    });

    await expect(listFolders(account)).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(closed).toBe(true);
  });
});
