import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import * as zmq from "zeromq";

// Debug logging setup
const DEBUG = (global as any).DEBUG || false;

let log: (...args: any[]) => void;
if (DEBUG) {
  log = function log(this: Console, ...args: any[]) {
    process.stderr.write("JMP: ");
    console.error.apply(this, args);
  };
} else {
  try {
    log = require("debug")("JMP:");
  } catch (err) {
    log = function noop() {};
  }
}

const DELIMITER = "<IDS|MSG>";

/**
 * Interface for Jupyter message header
 */
interface IHeader {
  msg_id: string;
  username: string;
  session: string;
  msg_type: string;
  version?: string;
}

/**
 * Interface for Message properties
 */
interface IMessageProperties {
  idents?: Buffer[];
  header?: IHeader;
  parent_header?: IHeader;
  metadata?: Record<string, any>;
  content?: Record<string, any>;
  buffers?: any[];
}

/**
 * Interface for Socket message listener
 */
interface IMessageListener {
  unwrapped: (message: Message) => void;
  wrapped: (...args: any[]) => void;
}

/**
 * Interface for ZMQ socket based on zeromq.js v6.3.0
 */
interface IZmqSocket {
  readonly readable: boolean;
  readonly writable: boolean;
  bind(address: string): Promise<void>;
  unbind(address: string): Promise<void>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  close(): Promise<void>;
  send(message: Array<Buffer | string>): Promise<void>;
  receive(): Promise<Buffer[]>;
  [Symbol.asyncIterator](): AsyncIterator<Buffer[]>;
}

/**
 * Represents a Jupyter message that follows the Jupyter Messaging Protocol.
 * This class provides functionality for creating, parsing, and replying to Jupyter messages.
 */
export class Message {
  public idents: Buffer[];
  public header: IHeader;
  public parent_header: IHeader;
  public metadata: Record<string, any>;
  public content: Record<string, any>;
  public buffers: any[];

  /**
   * Creates a new Message instance
   * @param properties Optional properties to initialize the message with
   */
  constructor(properties?: IMessageProperties) {
    this.idents = properties?.idents || [];
    this.header = properties?.header || ({} as IHeader);
    this.parent_header = properties?.parent_header || ({} as IHeader);
    this.metadata = properties?.metadata || {};
    this.content = properties?.content || {};
    this.buffers = properties?.buffers || [];
  }

  /**
   * Send a response over a given socket
   * @param socket Socket over which the response is sent
   * @param messageType Jupyter response message type
   * @param content Optional Jupyter response content
   * @param metadata Optional Jupyter response metadata
   * @param protocolVersion Optional Jupyter protocol version
   * @returns The response message sent over the given socket
   */
  respond(
    socket: Socket,
    messageType: string,
    content?: Record<string, any>,
    metadata?: Record<string, any>,
    protocolVersion?: string,
  ): Message {
    const response = new Message();

    response.idents = this.idents;

    response.header = {
      msg_id: uuidv4(),
      username: this.header.username,
      session: this.header.session,
      msg_type: messageType,
      version: protocolVersion || this.header.version,
    };

    response.parent_header = this.header;
    response.content = content || {};
    response.metadata = metadata || {};

    socket.send(response);

    return response;
  }

  /**
   * Decode message received over a ZMQ socket
   * @param messageFrames argsArray of a message listener on a JMP socket
   * @param scheme Optional hashing scheme (default: 'sha256')
   * @param key Optional hashing key (default: '')
   * @returns JMP message or null if failed to decode
   */
  static _decode(
    messageFrames: any[],
    scheme = "sha256",
    key = "",
  ): Message | null {
    try {
      return this._decodeInternal(messageFrames, scheme, key);
    } catch (err) {
      log("MESSAGE: DECODE: Error:", err);
      return null;
    }
  }

  private static _decodeInternal(
    messageFrames: any[],
    scheme: string,
    key: string,
  ): Message | null {
    const idents: Buffer[] = [];
    let i = 0;

    // Extract identities until delimiter
    for (; i < messageFrames.length; i++) {
      const frame = messageFrames[i];
      if (frame.toString() === DELIMITER) {
        break;
      }
      idents.push(frame);
    }

    if (messageFrames.length - i < 5) {
      log("MESSAGE: DECODE: Not enough message frames", messageFrames);
      return null;
    }

    if (messageFrames[i].toString() !== DELIMITER) {
      log("MESSAGE: DECODE: Missing delimiter", messageFrames);
      return null;
    }

    // Verify signature if key provided
    if (key) {
      const obtainedSignature = messageFrames[i + 1].toString();
      const hmac = crypto.createHmac(scheme, key);

      hmac.update(messageFrames[i + 2]);
      hmac.update(messageFrames[i + 3]);
      hmac.update(messageFrames[i + 4]);
      hmac.update(messageFrames[i + 5]);

      const expectedSignature = hmac.digest("hex");

      if (expectedSignature !== obtainedSignature) {
        log(
          "MESSAGE: DECODE: Incorrect message signature:",
          "Obtained = " + obtainedSignature,
          "Expected = " + expectedSignature,
        );
        return null;
      }
    }

    return new Message({
      idents,
      header: this.toJSON(messageFrames[i + 2]),
      parent_header: this.toJSON(messageFrames[i + 3]),
      metadata: this.toJSON(messageFrames[i + 4]),
      content: this.toJSON(messageFrames[i + 5]),
      buffers: Array.prototype.slice.call(messageFrames, i + 6),
    });
  }

  private static toJSON(value: Buffer): any {
    return JSON.parse(value.toString());
  }

  /**
   * Encode message for transfer over a ZMQ socket
   * @param scheme Optional hashing scheme (default: 'sha256')
   * @param key Optional hashing key (default: '')
   * @returns Encoded message frames
   */
  _encode(scheme = "sha256", key = ""): (Buffer | string)[] {
    const header = JSON.stringify(this.header);
    const parent_header = JSON.stringify(this.parent_header);
    const metadata = JSON.stringify(this.metadata);
    const content = JSON.stringify(this.content);

    let signature = "";
    if (key) {
      const hmac = crypto.createHmac(scheme, key);
      const encoding = "utf8";
      hmac.update(Buffer.from(header, encoding));
      hmac.update(Buffer.from(parent_header, encoding));
      hmac.update(Buffer.from(metadata, encoding));
      hmac.update(Buffer.from(content, encoding));
      signature = hmac.digest("hex");
    }

    return [
      ...this.idents,
      DELIMITER,
      signature,
      header,
      parent_header,
      metadata,
      content,
      ...this.buffers,
    ];
  }
}

/**
 * Supported socket types
 */
type SocketType = "ROUTER" | "DEALER" | "PUB" | "SUB" | "PAIR";

/**
 * Extended ZMQ socket that parses the Jupyter Messaging Protocol.
 * This class provides functionality for sending and receiving Jupyter messages over ZMQ sockets.
 */
export class Socket {
  private socket: IZmqSocket;
  private _jmp: {
    scheme: string;
    key: string;
    _listeners: IMessageListener[];
  };

  /**
   * Creates a new Socket instance
   * @param socketType ZMQ socket type
   * @param scheme Optional hashing scheme (default: 'sha256')
   * @param key Optional hashing key (default: '')
   */
  constructor(socketType: SocketType, scheme = "sha256", key = "") {
    // Create socket using the appropriate ZMQ socket class
    switch (socketType.toUpperCase() as SocketType) {
      case "ROUTER":
        this.socket = new zmq.Router() as unknown as IZmqSocket;
        break;
      case "DEALER":
        this.socket = new zmq.Dealer() as unknown as IZmqSocket;
        break;
      case "PUB":
        this.socket = new zmq.Publisher() as unknown as IZmqSocket;
        break;
      case "SUB":
        this.socket = new zmq.Subscriber() as unknown as IZmqSocket;
        break;
      case "PAIR":
        this.socket = new zmq.Pair() as unknown as IZmqSocket;
        break;
      default:
        throw new Error("Invalid socket type: " + socketType);
    }

    this._jmp = {
      scheme,
      key,
      _listeners: [],
    };
  }

  /**
   * Bind socket to an address
   */
  async bindSync(address: string): Promise<void> {
    await this.socket.bind(address);
  }

  /**
   * Connect socket to an address
   */
  async connect(address: string): Promise<void> {
    await this.socket.connect(address);
  }

  /**
   * Close the socket
   */
  async close(): Promise<void> {
    await this.socket.close();
  }

  /**
   * Send a message over the socket
   * @param message Message to send
   * @param flags Optional send flags
   * @returns this socket instance for chaining
   */
  async send(message: Message | string | Buffer | any[]): Promise<this> {
    if (message instanceof Message) {
      log("SOCKET: SEND:", message);
      await this.socket.send(message._encode(this._jmp.scheme, this._jmp.key));
    } else if (Array.isArray(message)) {
      await this.socket.send(message.map((m) => Buffer.from(m)));
    } else {
      await this.socket.send([Buffer.from(message)]);
    }
    return this;
  }

  /**
   * Receive a message from the socket
   * @returns Promise resolving to the received message
   */
  async receive(): Promise<Message | null> {
    const frames = await this.socket.receive();
    return Message._decode(frames, this._jmp.scheme, this._jmp.key);
  }

  /**
   * Async iterator for receiving messages
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Message> {
    for await (const frames of this.socket) {
      const message = Message._decode(frames, this._jmp.scheme, this._jmp.key);
      if (message) {
        yield message;
      }
    }
  }
}

// Export the module
export default {
  Message,
  Socket,
  zmq,
};
