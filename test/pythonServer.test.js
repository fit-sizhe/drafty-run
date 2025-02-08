const path = require('path');
const fs = require('fs');
const { strict: assert } = require('assert'); // or use chai, if you prefer
const { describe, it, before, after } = require('mocha');
const { PyKernelServer } = require('../out/kernel/implementations/PyKernelServer'); // Adjust to your actual import

// If you want to set a custom python path, set process.env.PYTHON_TEST_PATH:
const PYTHON_PATH = process.env.PYTHON_TEST_PATH || 'python';

// We'll use a temporary docPath (any file path is OK, so long as it's writable)
const DOC_PATH = path.join(__dirname, 'temp.md');

describe('KernelManager Integration Tests', function() {
  // Increase timeout if kernel startup can be slow
  this.timeout(35000);

  let km;

  before(async function() {
    // Create the KernelManager instance
    km = new PyKernelServer();

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
    const result = await km.executeCode(DOC_PATH, code);

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
    await km.executeCode(DOC_PATH, 'x = 42');
    
    // 2) Check that variable is still there
    const result = await km.executeCode(DOC_PATH, 'print(x)');
    const printedValues = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    
    // We expect something that includes "42"
    assert.ok(printedValues.some(line => line === '42'), 'Expected "42" in output');
  });

  it('should interrupt a long-running command and still allow further execution', async function() {
    this.timeout(20000); // Increase timeout to 20s

    // 1) Run a loop that prints strings
    const code = `
import time
i = 0
while True:
    print(f"Iteration {i}")
    time.sleep(0.5)  # Small delay to control output rate
    i += 1
`;
    console.log('Starting loop execution...');
    
    // Store outputs during execution
    const outputs = [];
    let terminated = false;

    const execPromise = km.executeCode(DOC_PATH, code, (output) => {
      if (!terminated && output.type === 'text' && output.content.includes('Iteration')) {
        outputs.push(output.content.trim());
        if (outputs.length === 3) {
          terminated = true;
          km.terminateExecution(DOC_PATH);
        }
      }
    });

    try {
      await execPromise;
    } catch (err) {
      console.log('Caught error:', err.message);
    }

    // Check we got exactly 3 iterations
    assert.equal(outputs.length, 3, 'Expected exactly 3 iterations before interrupt');
    assert.ok(outputs.every(o => o.startsWith('Iteration')), 'Expected all outputs to be iterations');

    // Wait a bit for the kernel to stabilize after interrupt
    await new Promise(res => setTimeout(res, 1000));

    // 3) Verify kernel is still responsive
    console.log('Testing if kernel is still responsive...');
    const result = await km.executeCode(DOC_PATH, 'print("Still alive?")');
    const aliveOutputs = result.outputs
      .filter(o => o.type === 'text' && o.content.includes('Still alive?'));
    assert.ok(aliveOutputs.length > 0, 'Kernel did not respond after interrupt');
  });

  it('should run multiple sequential executions and maintain state', async function() {
    // This test ensures we can queue multiple commands in a row
    // and the kernel keeps track of intermediate states.

    // 1) Python sum
    let result = await km.executeCode(DOC_PATH, 'a = sum(range(10))\nprint(a)');
    let lines = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    assert.ok(lines.includes('45'), 'Expected "45" from sum(range(10))');

    // 2) Next code uses `a` in a new cell
    result = await km.executeCode(DOC_PATH, 'print(a * 2)');
    lines = result.outputs
      .filter(o => o.type === 'text')
      .map(o => o.content.trim());
    assert.ok(lines.includes('90'), 'Expected "90" from a*2');

    // 3) Confirm no error
    const errors = result.outputs.filter(o => o.type === 'error');
    assert.equal(errors.length, 0, 'Unexpected error in final cell');
  });
});
