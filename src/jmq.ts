/*
 * BSD 3-Clause License
 *
 * Copyright (c) 2015, Nicolas Riesco and others as credited in the AUTHORS file
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as zmq from 'zeromq';

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
        this.header = properties?.header || {} as IHeader;
        this.parent_header = properties?.parent_header || {} as IHeader;
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
        protocolVersion?: string
    ): Message {
        const response = new Message();

        response.idents = this.idents;

        response.header = {
            msg_id: uuidv4(),
            username: this.header.username,
            session: this.header.session,
            msg_type: messageType,
            version: protocolVersion || this.header.version
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
    static _decode(messageFrames: any[], scheme = 'sha256', key = ''): Message | null {
        try {
            return this._decodeInternal(messageFrames, scheme, key);
        } catch (err) {
            log("MESSAGE: DECODE: Error:", err);
            return null;
        }
    }

    private static _decodeInternal(messageFrames: any[], scheme: string, key: string): Message | null {
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
            
            const expectedSignature = hmac.digest('hex');

            if (expectedSignature !== obtainedSignature) {
                log(
                    "MESSAGE: DECODE: Incorrect message signature:",
                    "Obtained = " + obtainedSignature,
                    "Expected = " + expectedSignature
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
    _encode(scheme = 'sha256', key = ''): (Buffer | string)[] {
        const header = JSON.stringify(this.header);
        const parent_header = JSON.stringify(this.parent_header);
        const metadata = JSON.stringify(this.metadata);
        const content = JSON.stringify(this.content);

        let signature = '';
        if (key) {
            const hmac = crypto.createHmac(scheme, key);
            const encoding = 'utf8';
            hmac.update(Buffer.from(header, encoding));
            hmac.update(Buffer.from(parent_header, encoding));
            hmac.update(Buffer.from(metadata, encoding));
            hmac.update(Buffer.from(content, encoding));
            signature = hmac.digest('hex');
        }

        return [
            ...this.idents,
            DELIMITER,
            signature,
            header,
            parent_header,
            metadata,
            content,
            ...this.buffers
        ];
    }
}

/**
 * Interface for ZMQ socket methods we need to implement
 */
interface IZmqSocket {
    bindSync(address: string): void;
    connect(address: string): void;
    close(): void;
    send(msg: any, flags?: number): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    removeListener(event: string, listener: (...args: any[]) => void): void;
    removeAllListeners(event?: string): void;
    getsockopt(option: number): any;
    setsockopt(option: number, value: any): void;
}

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
    constructor(socketType: number | string, scheme = 'sha256', key = '') {
        // Handle string socket types for backward compatibility
        const type = typeof socketType === 'string' ? (zmq as any)[socketType.toUpperCase()] : socketType;
        this.socket = new (zmq as any).Socket(type);
        this._jmp = {
            scheme,
            key,
            _listeners: [],
        };
    }

    /**
     * Bind socket to an address
     */
    bindSync(address: string): void {
        this.socket.bindSync(address);
    }

    /**
     * Connect socket to an address
     */
    connect(address: string): void {
        this.socket.connect(address);
    }

    /**
     * Close the socket
     */
    close(): void {
        this.socket.close();
    }

    /**
     * Get socket option
     */
    getsockopt(option: number): any {
        return this.socket.getsockopt(option);
    }

    /**
     * Set socket option
     */
    setsockopt(option: number, value: any): void {
        this.socket.setsockopt(option, value);
    }

    /**
     * Send a message over the socket
     * @param message Message to send
     * @param flags Optional send flags
     * @returns this socket instance for chaining
     */
    send(message: Message | string | Buffer | any[], flags?: number): this {
        if (message instanceof Message) {
            log("SOCKET: SEND:", message);
            this.socket.send(message._encode(this._jmp.scheme, this._jmp.key), flags);
        } else {
            this.socket.send(message, flags);
        }
        return this;
    }

    /**
     * Add an event listener
     * @param event Event name
     * @param listener Event listener function
     * @returns this socket instance for chaining
     */
    on(event: string, listener: (...args: any[]) => void): this {
        if (event !== 'message') {
            this.socket.on(event, listener);
            return this;
        }

        const _listener: IMessageListener = {
            unwrapped: listener,
            wrapped: ((...args: any[]) => {
                const message = Message._decode(args, this._jmp.scheme, this._jmp.key);
                if (message) {
                    listener(message);
                }
            }).bind(this)
        };

        this._jmp._listeners.push(_listener);
        this.socket.on(event, _listener.wrapped);
        return this;
    }

    /**
     * Add a one-time event listener
     * @param event Event name
     * @param listener Event listener function
     * @returns this socket instance for chaining
     */
    once(event: string, listener: (...args: any[]) => void): this {
        if (event !== 'message') {
            this.socket.once(event, listener);
            return this;
        }

        const _listener: IMessageListener = {
            unwrapped: listener,
            wrapped: ((...args: any[]) => {
                const message = Message._decode(args, this._jmp.scheme, this._jmp.key);
                if (message) {
                    try {
                        listener(message);
                    } catch (error) {
                        this.removeListener(event, listener);
                        throw error;
                    }
                }
                this.removeListener(event, listener);
            }).bind(this)
        };

        this._jmp._listeners.push(_listener);
        this.socket.on(event, _listener.wrapped);
        return this;
    }

    /**
     * Remove an event listener
     * @param event Event name
     * @param listener Event listener function to remove
     * @returns this socket instance for chaining
     */
    removeListener(event: string, listener: (...args: any[]) => void): this {
        if (event !== 'message') {
            this.socket.removeListener(event, listener);
            return this;
        }

        const index = this._jmp._listeners.findIndex(l => l.unwrapped === listener);
        if (index !== -1) {
            const _listener = this._jmp._listeners[index];
            this._jmp._listeners.splice(index, 1);
            this.socket.removeListener(event, _listener.wrapped);
        }

        return this;
    }

    /**
     * Remove all event listeners
     * @param event Optional event name
     * @returns this socket instance for chaining
     */
    removeAllListeners(event?: string): this {
        if (arguments.length === 0 || event === 'message') {
            this._jmp._listeners = [];
        }
        this.socket.removeAllListeners(event);
        return this;
    }

    /**
     * Alias for on() method
     */
    addListener = this.on;
}

// Export the module
export default {
    Message,
    Socket,
    zmq
};
