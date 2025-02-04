import * as jmq from "../protocol/jmq";

export interface ConnectionInfo {
  shellPort: number;
  iopubPort: number;
  controlPort: number;
  key: string;
  scheme: string;
}

export interface KernelSockets {
  shell: jmq.Socket;
  iopub: jmq.Socket;
  control: jmq.Socket;
}

export class KernelConnection {
  private sockets: KernelSockets | null = null;

  /**
   * Connect all required sockets.
   */
  async connect(info: ConnectionInfo): Promise<KernelSockets> {
    const { shellPort, iopubPort, controlPort, key, scheme } = info;

    // Create and connect the shell socket.
    const shellSocket = new jmq.Socket("DEALER", scheme, key);
    await shellSocket.connect(`tcp://127.0.0.1:${shellPort}`);

    // Create and connect the iopub socket (SUB subscriber must subscribe to all messages).
    const iopubSocket = new jmq.Socket("SUB", scheme, key);
    (iopubSocket as any).socket.subscribe(""); // subscribe to all messages
    await iopubSocket.connect(`tcp://127.0.0.1:${iopubPort}`);

    // Create and connect the control socket.
    const controlSocket = new jmq.Socket("DEALER", scheme, key);
    await controlSocket.connect(`tcp://127.0.0.1:${controlPort}`);

    this.sockets = { shell: shellSocket, iopub: iopubSocket, control: controlSocket };
    return this.sockets;
  }

  /**
   * Returns the connected sockets (throws if not connected).
   */
  getSockets(): KernelSockets {
    if (!this.sockets) {
      throw new Error("KernelConnection: not connected yet.");
    }
    return this.sockets;
  }

  /**
   * Sends a message on the shell channel and awaits a reply.
   * (Note the reply might be null if none is received.)
   */
  async sendAndAwait(msg: jmq.Message): Promise<jmq.Message | null> {
    const { shell } = this.getSockets();
    await shell.send(msg);
    return await shell.receive();
  }
}
