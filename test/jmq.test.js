const assert = require('assert');
const zmq = require('zeromq');
const { Message } = require('../out/jmq');

describe('jmp.js Tests', function() {

  // Example data for testing
  const testHeader = {
    msg_id: '12345',
    username: 'test-user',
    session: 'test-session',
    msg_type: 'execute_request',
    version: '5.3'
  };
  const testParent = {
    msg_id: '00000',
    username: 'parent-user',
    session: 'parent-session',
    msg_type: 'parent_msg',
    version: '5.3'
  };
  const testMetadata = { someKey: 'someValue' };
  const testContent = { code: 'print("Hello, JMP!")' };

  it('should encode and decode a Message without HMAC key', function() {
    const msg = new Message({
      header: testHeader,
      parent_header: testParent,
      metadata: testMetadata,
      content: testContent
    });

    // Encode
    const encoded = msg._encode(); // scheme=sha256, key=''
    // Decode
    const decodedMsg = Message._decode(encoded);

    assert(decodedMsg, 'Failed to decode message');
    assert.deepStrictEqual(decodedMsg.header, testHeader);
    assert.deepStrictEqual(decodedMsg.parent_header, testParent);
    assert.deepStrictEqual(decodedMsg.metadata, testMetadata);
    assert.deepStrictEqual(decodedMsg.content, testContent);
  });

  it('should encode and decode a Message with HMAC key', function() {
    const secretKey = 'my-secret-key';
    const msg = new Message({
      header: testHeader,
      content: testContent
    });

    // Encode with key
    const encoded = msg._encode('sha256', secretKey);

    // Decode with key
    const decodedMsg = Message._decode(encoded, 'sha256', secretKey);

    assert(decodedMsg, 'Failed to decode message with HMAC key');
    assert.deepStrictEqual(decodedMsg.header, testHeader);
    assert.deepStrictEqual(decodedMsg.content, testContent);
  });

  it('should fail to decode if HMAC is incorrect', function() {
    const correctKey = 'correct-key';
    const wrongKey = 'wrong-key';

    const msg = new Message({ header: testHeader });

    const encoded = msg._encode('sha256', correctKey);
    const decodedMsg = Message._decode(encoded, 'sha256', wrongKey);

    assert.strictEqual(decodedMsg, null, 'Message decoding should fail with wrong key');
  });

  it('should send and receive a Message over ZeroMQ sockets', async function() {
    this.timeout(5000); // Increase timeout for async operations
    // We'll use a dealer/dealer setup for simplicity
    const port = 40123;
    const addr = `tcp://127.0.0.1:${port}`;

    // Create server and client sockets
    const server = new zmq.Dealer();
    const client = new zmq.Dealer();

    // Bind server and connect client
    await server.bind(addr);
    client.connect(addr);

    // Prepare the test message
    const originalMsg = new Message({
      header: testHeader,
      content: testContent
    });

    // Set up async message handling
    const handleMessages = async () => {
      try {
        // Wait for server to receive message
        for await (const [msgStr] of server) {
          // Parse received message
          const receivedMsg = JSON.parse(msgStr.toString());
          
          // Check that we got the right header + content
          assert.deepStrictEqual(receivedMsg.header.msg_type, testHeader.msg_type);
          assert.deepStrictEqual(receivedMsg.content, testContent);

          // Respond back with multipart message
          await server.send(['execute_reply', JSON.stringify({ status: 'ok' })]);
          break;
        }
      } catch (err) {
        throw err;
      }
    };

    // Start message handling
    const serverPromise = handleMessages();

    // Send message from client to server
    await client.send([JSON.stringify(originalMsg)]);

    // Wait for and verify client reply
    for await (const [msgType, msgContent] of client) {
      assert.strictEqual(msgType.toString(), 'execute_reply');
      assert.deepStrictEqual(JSON.parse(msgContent.toString()), { status: 'ok' });
      break;
    }

    // Clean up
    await serverPromise;
    server.close();
    client.close();
  });

});
