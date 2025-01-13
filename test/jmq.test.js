const assert = require('assert');
const { Message, Socket } = require('../out/jmq');

describe('Jupyter Message Protocol Tests', function() {
  // Example data for testing that matches Jupyter protocol
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
    msg_type: 'kernel_info_request',
    version: '5.3'
  };
  const testMetadata = { someKey: 'someValue' };
  const testContent = { 
    code: 'print("Hello, World!")',
    silent: false,
    store_history: true,
    user_expressions: {},
    allow_stdin: true,
    stop_on_error: true
  };

  describe('Message Format Tests', function() {
    it('should create a valid Jupyter protocol message', function() {
      const msg = new Message({
        idents: [Buffer.from('identity')],
        header: testHeader,
        parent_header: testParent,
        metadata: testMetadata,
        content: testContent
      });

      assert(msg.idents.length > 0, 'Message should have identities');
      assert.deepStrictEqual(msg.header, testHeader);
      assert.deepStrictEqual(msg.parent_header, testParent);
      assert.deepStrictEqual(msg.metadata, testMetadata);
      assert.deepStrictEqual(msg.content, testContent);
    });

    it('should encode and decode a message with HMAC signature', function() {
      const key = 'secret-key';
      const msg = new Message({
        idents: [Buffer.from('identity')],
        header: testHeader,
        parent_header: testParent,
        metadata: testMetadata,
        content: testContent
      });

      const encoded = msg._encode('sha256', key);
      const decoded = Message._decode(encoded, 'sha256', key);

      assert(decoded, 'Message should decode successfully');
      assert.deepStrictEqual(decoded.header, testHeader);
      assert.deepStrictEqual(decoded.content, testContent);
    });

    it('should fail to decode with incorrect HMAC key', function() {
      const msg = new Message({
        header: testHeader,
        content: testContent
      });

      const encoded = msg._encode('sha256', 'correct-key');
      const decoded = Message._decode(encoded, 'sha256', 'wrong-key');

      assert.strictEqual(decoded, null, 'Message should not decode with wrong key');
    });
  });

  describe('Socket Communication Tests', function() {
    let frontend, backend;
    const port = 5555;

    beforeEach(async function() {
      frontend = new Socket('DEALER');
      backend = new Socket('ROUTER');
      await backend.bindSync(`tcp://127.0.0.1:${port}`);
      await frontend.connect(`tcp://127.0.0.1:${port}`);
    });

    afterEach(async function() {
      await frontend.close();
      await backend.close();
    });

    it('should handle execute_request/reply cycle', async function() {
      this.timeout(5000);

      // Create and send execute_request
      const executeRequest = new Message({
        idents: [Buffer.from('test-kernel')],
        header: {
          msg_id: '12345',
          username: 'test-user',
          session: 'test-session',
          msg_type: 'execute_request',
          version: '5.3'
        },
        content: {
          code: 'print("Hello")',
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: true,
          stop_on_error: true
        }
      });

      // Set up backend receiver
      const backendPromise = (async () => {
        const receivedMsg = await backend.receive();
        assert(receivedMsg, 'Backend should receive message');
        assert.strictEqual(receivedMsg.header.msg_type, 'execute_request');
        
        // Send execute_reply
        const reply = receivedMsg.respond(backend, 'execute_reply', {
          status: 'ok',
          execution_count: 1,
          user_expressions: {}
        });
        
        assert.strictEqual(reply.header.msg_type, 'execute_reply');
        return reply;
      })();

      // Send request from frontend
      await frontend.send(executeRequest);

      // Receive reply at frontend
      const frontendMsg = await frontend.receive();
      assert(frontendMsg, 'Frontend should receive reply');
      assert.strictEqual(frontendMsg.header.msg_type, 'execute_reply');
      assert.strictEqual(frontendMsg.content.status, 'ok');

      await backendPromise;
    });

    it('should handle kernel_info_request/reply cycle', async function() {
      this.timeout(5000);

      const kernelInfoRequest = new Message({
        idents: [Buffer.from('test-kernel')],
        header: {
          msg_id: '12346',
          username: 'test-user',
          session: 'test-session',
          msg_type: 'kernel_info_request',
          version: '5.3'
        },
        content: {}
      });

      // Set up backend receiver
      const backendPromise = (async () => {
        const receivedMsg = await backend.receive();
        assert(receivedMsg, 'Backend should receive message');
        assert.strictEqual(receivedMsg.header.msg_type, 'kernel_info_request');
        
        // Send kernel_info_reply
        const reply = receivedMsg.respond(backend, 'kernel_info_reply', {
          status: 'ok',
          protocol_version: '5.3',
          implementation: 'test',
          implementation_version: '1.0',
          language_info: {
            name: 'python',
            version: '3.8',
            mimetype: 'text/x-python',
            file_extension: '.py'
          },
          banner: 'Test Kernel'
        });
        
        assert.strictEqual(reply.header.msg_type, 'kernel_info_reply');
        return reply;
      })();

      // Send request from frontend
      await frontend.send(kernelInfoRequest);

      // Receive reply at frontend
      const frontendMsg = await frontend.receive();
      assert(frontendMsg, 'Frontend should receive reply');
      assert.strictEqual(frontendMsg.header.msg_type, 'kernel_info_reply');
      assert.strictEqual(frontendMsg.content.status, 'ok');
      assert(frontendMsg.content.language_info, 'Should include language info');

      await backendPromise;
    });

    it('should handle message routing with multiple identities', async function() {
      this.timeout(5000);

      // Use different port to avoid any potential conflicts
      const testPort = 5556;
      const testBackend = new Socket('ROUTER');
      const testFrontend = new Socket('DEALER');

      try {
        await testBackend.bindSync(`tcp://127.0.0.1:${testPort}`);
        await testFrontend.connect(`tcp://127.0.0.1:${testPort}`);

        // Create test message
        const msg = new Message({
          idents: [Buffer.from('id1'), Buffer.from('id2')],
          header: {
            msg_id: 'test-msg-id',
            username: 'test-user',
            session: 'test-session',
            msg_type: 'test_message',
            version: '5.3'
          },
          content: { test: 'content' }
        });

        // Send from frontend to backend
        console.log('Sending message from frontend...');
        await testFrontend.send(msg);
        
        // Receive at backend
        console.log('Waiting for backend to receive...');
        const receivedAtBackend = await testBackend.receive();
        assert(receivedAtBackend, 'Backend should receive message');
        
        // ROUTER socket adds routing identity as first frame
        assert.strictEqual(receivedAtBackend.idents.length, 3, 'Should have routing id + two identities');
        // Skip first identity (routing id) and check our custom identities
        assert.strictEqual(receivedAtBackend.idents[1].toString(), 'id1');
        assert.strictEqual(receivedAtBackend.idents[2].toString(), 'id2');

        // Create reply keeping all identities (including routing id)
        console.log('Sending echo from backend...');
        await testBackend.send(receivedAtBackend);

        // Receive echo at frontend
        console.log('Waiting for frontend to receive echo...');
        const receivedAtFrontend = await testFrontend.receive();
        assert(receivedAtFrontend, 'Frontend should receive message');
        // Frontend should receive original identities (routing id is stripped)
        assert.strictEqual(receivedAtFrontend.idents.length, 2, 'Should receive original identities');
        assert.strictEqual(receivedAtFrontend.idents[0].toString(), 'id1');
        assert.strictEqual(receivedAtFrontend.idents[1].toString(), 'id2');

      } finally {
        // Clean up test sockets
        console.log('Cleaning up test sockets...');
        await testFrontend.close();
        await testBackend.close();
      }
    });
  });
});
