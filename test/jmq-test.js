#!/usr/bin/env node

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

import assert from "assert";
import crypto from "crypto";
import { v4 as uuid } from "uuid";
import jmp from "../out/jmq.js";

const zmq = jmp.zmq;

// Setup logging helpers
let log;
const dontLog = function dontLog() {};
const doLog = function doLog() {
    process.stderr.write("JMP: TEST:");
    console.error.apply(this, arguments);
};

if (process.env.DEBUG) {
    global.DEBUG = true;

    try {
        doLog = (await import("debug")).default("JMP: TEST:");
    } catch (err) {}
}

log = global.DEBUG ? doLog : dontLog;

/**
 * @typedef Context
 *
 * @property                     context
 * @property {String}            context.scheme       Hashing scheme
 * @property {String}            context.key          Hashing key
 * @property {module:jmp~Socket} context.serverSocket Server socket
 * @property {module:jmp~Socket} context.clientSocket Client socket
 *
 */

describe("Listeners", function() {
    const context = {};

    beforeEach(function() {
        context.scheme = "sha256";
        context.key = crypto.randomBytes(256).toString("base64");

        context.serverSocket = new jmp.Socket(
            "rep", context.scheme, context.key
        );

        context.clientSocket = new jmp.Socket(
            "req", context.scheme, context.key
        );

        // Assign identity to client socket (only for testing purposes)
        context.clientSocket.setsockopt(
            zmq.ZMQ_IDENTITY,
            Buffer.from(uuid(), "ascii")
        );

        // Bind to a random local port
        bindServerAndClient(context.serverSocket, context.clientSocket);
    });

    it("can be registered, invoked and removed", function(done) {
        context.serverSocket.on("message", onServerMessageListener1);
        context.serverSocket.on("message", onServerMessageListener2);
        context.clientSocket.on("message", onClientMessage);
        context.clientSocket.on("close", function() {});

        context.clientSocket.send(new jmp.Message());

        function onServerMessageListener1(message) {
            log("Running onServerMessageListener1...");

            onServerMessageListener1.hasRun = true;
            if (onServerMessageListener2.hasRun) {
                message.respond(context.serverSocket);
            }
        }

        function onServerMessageListener2(message) {
            log("Running onServerMessageListener2...");

            onServerMessageListener2.hasRun = true;
            if (onServerMessageListener1.hasRun) {
                message.respond(context.serverSocket);
            }
        }

        function onClientMessage() {
            log("Running onClientMessage...");

            context.clientSocket.close();
            context.serverSocket.close();

            context.serverSocket.removeListener(
                "message", onServerMessageListener1
            );
            context.serverSocket.removeListener(
                "message", onServerMessageListener2
            );
            context.clientSocket.removeAllListeners();

            assert.deepEqual(
                context.serverSocket._events, {},
                "Failed to removed all listeners in serverSocket"
            );

            assert.deepEqual(
                context.serverSocket._jmp._listeners, [],
                "Failed to removed all message listeners in serverSocket"
            );

            assert.deepEqual(
                context.clientSocket._events, {},
                "Failed to removed all listeners in clientSocket"
            );

            assert.deepEqual(
                context.clientSocket._jmp._listeners, [],
                "Failed to removed all message listeners in clientSocket"
            );

            done();
        }
    });

    it("can be registered to be invoked once", function(done) {
        context.serverSocket.once("message", onServerMessageListener1);
        context.serverSocket.on("message", onServerMessageListener2);
        context.clientSocket.on("message", onClientMessage);

        context.clientSocket.send(new jmp.Message());

        return;

        function onClientMessage() {
            log("Running onClientMessage...");
            context.clientSocket.send(new jmp.Message());
        }

        function onServerMessageListener1(message) {
            log("Running onServerMessageListener1...");

            assert(
                message instanceof jmp.Message,
                "onServerMessageListener1 should receive an instance of Message"
            );

            assert(
                !onServerMessageListener1.hasRun,
                "onServerMessageListener1 has been invoked more than once"
            );

            onServerMessageListener1.hasRun = true;
        }

        function onServerMessageListener2(message) {
            log("Running onServerMessageListener2...");

            if (!onServerMessageListener2.hasRun) {
                onServerMessageListener2.hasRun = true;
                message.respond(context.serverSocket);
                return;
            }

            if (!onServerMessageListener2.hasRunTwice) {
                onServerMessageListener2.hasRunTwice = true;
                message.respond(context.serverSocket);
                return;
            }

            assert(
                onServerMessageListener1.hasRun,
                "onServerMessageListener1 has not been invoked"
            );

            context.clientSocket.close();
            context.serverSocket.close();

            done();
        }
    });
});

describe("JMP messages", function() {
    const context = {};

    const versionMajor = Number(process.versions.node.split(".")[0]);

    // Use to skip a spec in Node.js v0.x
    const itIfNotNodeV0 = (versionMajor === 0) ? xit : it;

    before(function() {
        context.scheme = "sha256";
        context.key = crypto.randomBytes(256).toString("base64");

        context.serverSocket = new jmp.Socket(
            "router", context.scheme, context.key
        );

        context.clientSocket = new jmp.Socket(
            "dealer", context.scheme, context.key
        );

        // Assign identity to client socket (only for testing purposes)
        context.clientSocket.setsockopt(
            zmq.ZMQ_IDENTITY,
            Buffer.from(uuid(), "ascii")
        );

        // Bind to a random local port
        bindServerAndClient(context.serverSocket, context.clientSocket);
    });

    after(function() {
        context.serverSocket.close();
        context.clientSocket.close();
    });

    // A large `Buffer` makes Node.js v0.x exit with:
    // FATAL ERROR: CALL_AND_ENTRY_0 Allocation failed - process out of memory
    itIfNotNodeV0("that throw an error should be dropped", function() {
        const message = new jmp.Message();

        const messageFrames = message._encode(
            context.scheme, context.key
        );

        // The maximum length of a JS string in V8 is 0x1fffffe8 (536870888)
        // See issue #35676 https://github.com/nodejs/node/issues/35676
        messageFrames.unshift(Buffer.alloc(512 * 1024 * 1024));

        jmp.Message._decode(
            messageFrames, context.scheme, context.key
        );
    });

    it("can be validated", function() {
        const anotherKey = crypto.randomBytes(256).toString("base64");
        assert.notEqual(
            context.key, anotherKey, "Failed to generate a pair of keys"
        );

        const originalMessage = new jmp.Message();
        const messageFrames = originalMessage._encode(
            context.scheme, context.key
        );

        const decodedMessage = jmp.Message._decode(
            messageFrames, context.scheme, context.key
        );
        assert.deepEqual(
            decodedMessage, originalMessage,
            makeErrorMessage(
                "Failed signature validation", decodedMessage, originalMessage
            )
        );

        const malformedMessage = jmp.Message._decode(
            messageFrames, context.scheme, anotherKey
        );
        assert(!malformedMessage, "Failed to detect a malformed message");
    });

    it("can be sent and recieved", function(done) {
        const requestMsgType = "kernel_info_request";
        const responseMsgType = "kernel_info_reply";

        const requestHeader = {
            "msg_id": uuid(),
            "username": "user",
            "session": uuid(),
            "msg_type": requestMsgType,
            "version": "5.0",
        };
        const requestBuffers = [0x2A, "42", Array(42), {42: 42}];
        const request = new jmp.Message({
            header: requestHeader,
            buffers: requestBuffers,
        });
        assert.deepEqual(
            request.header, requestHeader,
            makeErrorMessage(
                "request.header is unset", request.header, requestHeader
            )
        );
        assert.deepEqual(
            request.buffers, requestBuffers,
            makeErrorMessage(
                "request.buffers is unset", request.buffers, requestBuffers
            )
        );

        const responseContent = {
            "protocol_version": "0.0.0",
            "implementation": "π",
            "implementation_version": "0.0.0",
            "language_info": {
                "name": "test",
                "version": "0.0.0",
                "mimetype": "text/plain",
                "file_extension": "test",
            },
            "banner": "Test",
            "help_links": [{
                "text": "JMP",
                "url": "https://github.com/n-riesco/nel",
            }],
        };
        const responseMetadata = {};

        context.serverSocket.on("message", getRequest);
        context.clientSocket.on("message", getResponse);

        context.clientSocket.send(request);

        return;

        function getRequest(message) {
            assert.equal(
                message.buffers.length, request.buffers.length,
                "Wrong number of frames in message.buffers"
            );

            assert.equal(
                message.idents[0],
                context.clientSocket.getsockopt(zmq.ZMQ_IDENTITY),
                makeErrorMessage(
                    "Wrong request.idents",
                    message.idents[0].toString(),
                    context.clientSocket.getsockopt(zmq.ZMQ_IDENTITY).toString()
                )
            );

            assert.deepEqual(
                message.header, request.header,
                makeErrorMessage(
                    "Wrong request.header",
                    message.header, request.header
                )
            );

            assert.deepEqual(
                message.parent_header, request.parent_header,
                makeErrorMessage(
                    "request.parent_header",
                    message.parent_header, request.parent_header
                )
            );

            assert.deepEqual(
                message.metadata, request.metadata,
                makeErrorMessage(
                    "request.metadata", message.metadata, request.metadata
                )
            );

            assert.deepEqual(
                message.content, request.content,
                makeErrorMessage(
                    "request.content", message.content, request.content
                )
            );

            message.respond(
                context.serverSocket,
                responseMsgType, responseContent, responseMetadata
            );
        }

        function getResponse(message) {
            assert.equal(
                message.idents.length,
                0,
                makeErrorMessage(
                    "Wrong response.idents.length", message.idents.length, 0
                )
            );

            assert.deepEqual(
                message.header.msg_type, responseMsgType,
                makeErrorMessage(
                    "Wrong response.header.msg_type",
                    message.header.msg_type,
                    responseMsgType
                )
            );

            assert.deepEqual(
                message.parent_header, request.header,
                makeErrorMessage(
                    "Wrong response.parent_header",
                    message.parent_header, request.header
                )
            );

            assert.deepEqual(
                message.content, responseContent,
                makeErrorMessage(
                    "Wrong response.content", message.content, responseContent
                )
            );

            context.serverSocket.removeListener("message", getRequest);
            context.clientSocket.removeListener("message", getResponse);

            done();
        }
    });
});

/**
 * Bind server and client through a random port
 *
 * @param {module:zmq~Socket} serverSocket Server socket
 * @param {module:zmq~Socket} clientSocket Client socket
 */
function bindServerAndClient(serverSocket, clientSocket) {
    for (let attempts = 0; ; attempts++) {
        const randomPort = Math.floor(1024 + Math.random() * (65536 - 1024));
        const address = "tcp://127.0.0.1:" + randomPort;

        try {
            serverSocket.bindSync(address);
            clientSocket.connect(address);
            break;
        } catch (e) {
            console.error(e.stack);
        }

        if (attempts >= 100) {
            throw new Error("can't bind to any local ports");
        }
    }
}

function makeErrorMessage(errorMessage, obtained, expected) {
    return [
        errorMessage,
        "Obtained", obtained,
        "Expected", expected,
    ].join(": ");
}
