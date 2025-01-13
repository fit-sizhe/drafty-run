/* kernelManager.test.js */

const path = require('path');
const fs = require('fs');
const { strict: assert } = require('assert'); // or use chai, if you prefer
const { describe, it, before, after } = require('mocha');
const { KernelManager } = require('../out/kernelManager'); // Adjust to your actual import

// If you want to set a custom python path, set process.env.PYTHON_TEST_PATH:
const PYTHON_PATH = process.env.PYTHON_TEST_PATH || 'python';

// We'll use a temporary docPath (any file path is OK, so long as it's writable)
const DOC_PATH = path.join(__dirname, 'temp.ipynb');

describe('KernelManager Integration Tests', function() {
  // Increase timeout if kernel startup can be slow
  this.timeout(15000);

  let km;

  before(async function() {
    // Create the KernelManager instance
    km = new KernelManager();

    // Start a kernel for our test doc
    // In normal usage, you'd await startProcessForDoc with an onDataCallback
    // but we'll skip that here for brevity.
    await km.startProcessForDoc(DOC_PATH, PYTHON_PATH);
  });

  after(async function() {
    // Clean up all kernels
    km.disposeAll();

    // Optionally remove temp doc file if created
    try {
      if (fs.existsSync(DOC_PATH)) {
        fs.unlinkSync(DOC_PATH);
      }
    } catch (err) {
      console.error('Error removing temp doc file:', err);
    }
  });

  it('should run a simple Python expression and retrieve the result', async function() {
    const code = `
import sys
print("Hello from Python " + sys.version.split()[0])
2+3
`;
    const result = await km.queueCodeExecution(DOC_PATH, code);

    // The result.outputs is an array of CellOutputs (text, image, error, etc.)
    // We'll check if there's a "text" output that ends with "5"
    // and "Hello from Python ..."
    const textOutputs = result.outputs.filter(o => o.type === 'text');
    const entireText = textOutputs.map(o => o.content).join('\n');

    assert.match(entireText, /Hello from Python/);
    assert.match(entireText, /5$/);
  });

  it('should confirm kernel is persistent between executions (variables stay in memory)', async function() {
    // 1) Define a variable in the Python namespace
    await km.queueCodeExecution(DOC_PATH, 'x = 42');
    
    // 2) Check that variable is still there
    const result = await km.queueCodeExecution(DOC_PATH, 'print(x)');
    const printedValues = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    
    // We expect something that includes "42"
    assert.ok(printedValues.some(line => line === '42'), 'Expected "42" in output');
  });

  it('should interrupt a long-running command and still allow further execution', async function() {
    // 1) Start something that never ends (or sleeps for a while)
    // We'll do "while True: pass" to force a busy loop
    const code = `
import time
while True:
    time.sleep(0.1)
`;
    // Fire off the execution
    const execPromise = km.queueCodeExecution(DOC_PATH, code);

    // 2) Wait a bit, then interrupt
    await new Promise(res => setTimeout(res, 1000)); // allow it to run a little
    km.terminateExecution(DOC_PATH);

    let didThrow = false;
    try {
      await execPromise;
    } catch (err) {
      // We might see an error from KeyboardInterrupt or similar.
      didThrow = true;
    }

    // We expect the code either to be forcibly interrupted or to produce partial output
    assert.ok(didThrow, 'Expected an error or forced interrupt from infinite loop');

    // 3) Now run a new code cell to verify kernel is still responsive
    const result = await km.queueCodeExecution(DOC_PATH, 'print("Still alive?")');
    const textOutputs = result.outputs.filter(o => o.type === 'text');
    assert.ok(
      textOutputs.some(o => o.content.includes('Still alive?')),
      'Kernel did not respond after interrupt'
    );
  });

  it('should run multiple sequential executions and maintain state', async function() {
    // This test ensures we can queue multiple commands in a row
    // and the kernel keeps track of intermediate states.

    // 1) Python sum
    let result = await km.queueCodeExecution(DOC_PATH, 'a = sum(range(10))\nprint(a)');
    let lines = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    assert.ok(lines.includes('45'), 'Expected "45" from sum(range(10))');

    // 2) Next code uses `a` in a new cell
    result = await km.queueCodeExecution(DOC_PATH, 'print(a * 2)');
    lines = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    assert.ok(lines.includes('90'), 'Expected "90" from a*2');

    // 3) Confirm no error
    const errors = result.outputs.filter(o => o.type === 'error');
    assert.equal(errors.length, 0, 'Unexpected error in final cell');
  });
});
