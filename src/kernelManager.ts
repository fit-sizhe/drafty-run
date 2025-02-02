/**
 * This file is intended as a drop-in replacement for pythonRunner.ts,
 * but using the jmq.ts library (ZeroMQ + Jupyter wire protocol).
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { CellOutput } from "./types";
import * as jmq from "./jmq";
import * as net from "net";
import * as crypto from "crypto";
import * as path from "path";

/** Quickly find an ephemeral free port for binding */
async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function randomHexKey(len = 24): string {
  return crypto.randomBytes(len).toString("hex");
}

// Minimal interface for storing kernel connection info
interface KernelInfo {
  process: ChildProcessWithoutNullStreams;
  shellPort: number;
  iopubPort: number;
  stdinPort: number;
  controlPort: number;
  hbPort: number;
  scheme: string; // e.g. "sha256"
  key: string;
}

interface ExecutionItem {
  code: string;
  onDataCallback?: (partialOutput: CellOutput) => void;
  resolve: (val: { outputs: CellOutput[] }) => void;
  reject: (err: unknown) => void;
}

/**
 * The KernelManager is a drop-in replacement for PythonRunner,
 * but uses jmq.js to talk to a Jupyter kernel via ZeroMQ.
 */
export class KernelManager {
  private kernelMap = new Map<string, KernelInfo>();
  private executionQueue: Map<string, ExecutionItem[]> = new Map();
  private processing: Map<string, boolean> = new Map();

  /**
   * We hold references to the jmq Sockets (shell, iopub, control) per doc.
   */
  private jmqSockets: Map<
    string,
    {
      shell: jmq.Socket;
      iopub: jmq.Socket;
      control: jmq.Socket;
    }
  > = new Map();

  constructor() {}

  /**
   * Launches a new Jupyter kernel for the given docPath,
   * and sets up channels for sending/receiving messages.
   */
  public async startProcessForDoc(
    docPath: string,
    pythonPath: string,
    onDataCallback?: (partialOutput: CellOutput) => void,
  ): Promise<void> {
    if (this.kernelMap.has(docPath)) {
      // Already started
      return;
    }

    let lastError: unknown = null;
    const tot_attempts = 5;
    
    for (let attempt = 1; attempt <= tot_attempts; attempt++) {
      try {
        // Allocate ephemeral ports
        const shellPort = await getRandomPort();
        const iopubPort = await getRandomPort();
        const stdinPort = await getRandomPort();
        const controlPort = await getRandomPort();
        const hbPort = await getRandomPort();

        // Generate key & scheme
        const signatureScheme = "hmac-sha256"; // typical for ipykernel
        const key = randomHexKey();
        // jmq's scheme is just the "sha256" portion (removing the "hmac-")
        const scheme = signatureScheme.replace("hmac-", "") || "sha256";

        let shellSocket: jmq.Socket | undefined;
        let iopubSocket: jmq.Socket | undefined;
        let controlSocket: jmq.Socket | undefined;
        let child: ChildProcessWithoutNullStreams | undefined;

        try {
          // Spawn the kernel with our chosen ports
          child = spawn(
            pythonPath,
            [
              "-m",
              "ipykernel",
              "--IPKernelApp.transport=tcp",
              "--IPKernelApp.ip=127.0.0.1",
              `--IPKernelApp.shell_port=${shellPort}`,
              `--IPKernelApp.iopub_port=${iopubPort}`,
              `--IPKernelApp.stdin_port=${stdinPort}`,
              `--IPKernelApp.control_port=${controlPort}`,
              `--IPKernelApp.hb_port=${hbPort}`,
              `--Session.key=${key}`,
              `--Session.signature_scheme=${signatureScheme}`,
            ],
            {
              cwd: path.dirname(docPath),
            },
          );

          // Keep track of whether the kernel closed unexpectedly
          if (!child) {
            throw new Error("Kernel process unexpectedly undefined after spawn");
          }
          
          // Create a strongly-typed reference that TypeScript knows won't be undefined
          const kernel: ChildProcessWithoutNullStreams = child;
          
          const exitPromise = new Promise<void>((_, reject) => {
            kernel.once("exit", (code, signal) => {
              if (code !== 0) {
                reject(
                  new Error(
                    `Kernel exited before readiness (doc=${docPath}), code=${code}, signal=${signal}`,
                  ),
                );
              }
            });
          });

          shellSocket = new jmq.Socket("DEALER", scheme, key);
          await shellSocket.connect(`tcp://127.0.0.1:${shellPort}`);

          // Increase timeout to 2000ms and add retry delay between attempts
          await this.waitForKernelInfoReply(shellSocket, exitPromise, 2000);

          // If we get here, we got "kernel_info_reply" => kernel is ready
          iopubSocket = new jmq.Socket("SUB", scheme, key);
          (iopubSocket as any).socket.subscribe("");
          await iopubSocket.connect(`tcp://127.0.0.1:${iopubPort}`);

          controlSocket = new jmq.Socket("DEALER", scheme, key);
          await controlSocket.connect(`tcp://127.0.0.1:${controlPort}`);

          // At this point child must be defined since we got past the kernel_info_reply
          if (!child) {
            throw new Error("Kernel process unexpectedly undefined");
          }

          // Save kernel + sockets to memory
          const kInfo: KernelInfo = {
            process: child,
            shellPort,
            iopubPort,
            stdinPort,
            controlPort,
            hbPort,
            scheme,
            key,
          };
          this.kernelMap.set(docPath, kInfo);

          this.jmqSockets.set(docPath, {
            shell: shellSocket,
            iopub: iopubSocket,
            control: controlSocket,
          });

          // Listen on child process events/logging
          child.stdout.on("data", (data: Buffer) => {
            onDataCallback?.({
              type: "text",
              timestamp: Date.now(),
              content: data.toString(),
              stream: "stdout",
            });
          });
          child.stderr.on("data", (data: Buffer) => {
            onDataCallback?.({
              type: "text",
              timestamp: Date.now(),
              content: data.toString(),
              stream: "stderr",
            });
          });
          child.on("close", (code, signal) => {
            console.log(
              `KernelManager: kernel closed doc=${docPath}, code=${code}, signal=${signal}`,
            );
            this.executionQueue.delete(docPath);
            this.processing.delete(docPath);
            this.kernelMap.delete(docPath);
            this.jmqSockets.delete(docPath);
          });

          child.on("exit", (code, signal) => {
            console.log(
              `KernelManager: kernel closed doc=${docPath}, code=${code}, signal=${signal}`,
            );
            this.executionQueue.delete(docPath);
            this.processing.delete(docPath);
            this.kernelMap.delete(docPath);
            this.jmqSockets.delete(docPath);
          });

          // Store references
          this.executionQueue.set(docPath, []);
          this.processing.set(docPath, false);

          // Stop the for-loop (success)
          return;
        } catch (innerErr) {
          // Clean up sockets on error
          shellSocket?.close();
          iopubSocket?.close();
          controlSocket?.close();
          
          // Kill child process if it exists
          if (child?.pid) {
            try {
              process.kill(child.pid);
            } catch (killErr) {
              console.error("Error killing kernel process:", killErr);
            }
          }
          child = undefined;
          
          throw innerErr;
        }

      } catch (err) {
        lastError = err;
        // Add delay between attempts
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // If we tried all attempts and still failed, rethrow
    throw new Error(
      `Failed to start kernel (doc=${docPath}) after ${tot_attempts} attempts. Last error: ` +
        (lastError instanceof Error ? lastError.message : String(lastError)),
    );
  }

  /**
   * Wait for a "kernel_info_reply" on the given shell socket.
   * We'll race this against:
   *   - kernel process exit (exitPromise)
   *   - a 5s (or custom) timeout
   */
  private async waitForKernelInfoReply(
    shellSocket: jmq.Socket,
    exitPromise: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    // Prepare a "kernel_info_request" message
    const msgId = crypto.randomUUID();
    const request = new jmq.Message({
      header: {
        msg_id: msgId,
        username: "kernelManager",
        session: crypto.randomUUID(),
        msg_type: "kernel_info_request",
        version: "5.3",
      },
      content: {},
    });
    await shellSocket.send(request);

    // We'll set up an async loop to read from shellSocket.receive()
    const readiness = new Promise<void>(async (resolve, reject) => {
      try {
        while (true) {
          const reply = await shellSocket.receive();
          if (!reply) {
            // null or parse failure => continue
            continue;
          }
          if (reply.header.msg_type === "kernel_info_reply") {
            if (reply.parent_header?.msg_id === msgId) {
              // success
              return resolve();
            }
          }
        }
      } catch (err) {
        reject(err);
      }
    });

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Timeout: No kernel_info_reply within ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    // Race: either we succeed, or kernel exits, or time out
    await Promise.race([readiness, exitPromise, timeoutPromise]);
  }

  /**
   * Enqueue code execution for the doc's kernel
   */
  public queueCodeExecution(
    docPath: string,
    code: string,
    onDataCallback?: (partialOutput: CellOutput) => void,
  ): Promise<{ outputs: CellOutput[] }> {
    const item: ExecutionItem = {
      code,
      onDataCallback,
      resolve: () => {},
      reject: () => {},
    };

    const promise = new Promise<{ outputs: CellOutput[] }>(
      (resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
      },
    );

    const queue = this.executionQueue.get(docPath);
    if (!queue) {
      throw new Error(`No Jupyter kernel initialized for docPath=${docPath}`);
    }
    queue.push(item);

    if (!this.processing.get(docPath)) {
      this.processNext(docPath);
    }

    return promise;
  }

  /**
   * Attempt to interrupt/terminate execution in the kernel
   */
  public async terminateExecution(docPath: string) {
    const info = this.kernelMap.get(docPath);
    const sockets = this.jmqSockets.get(docPath);
    if (!info || !sockets) {
      console.log(`No kernel to terminate for docPath=${docPath}`);
      return;
    }

    // Try interrupt_request on control channel first
    console.log(`Sending interrupt_request on control channel: doc=${docPath}`);
    const controlSocket = sockets.control;
    const interruptMsg = new jmq.Message({
      header: {
        msg_id: crypto.randomUUID(),
        username: "user",
        session: crypto.randomUUID(),
        msg_type: "interrupt_request",
        version: "5.3",
      },
      content: { reason: "user" },
    });
    await controlSocket.send(interruptMsg);

    // Wait for interrupt_reply with timeout
    let interruptSucceeded = false;
    try {
      const replyPromise = controlSocket.receive();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Interrupt reply timeout")), 1000);
      });

      const reply = (await Promise.race([
        replyPromise,
        timeoutPromise,
      ])) as jmq.Message;
      if (reply && reply.header?.msg_type === "interrupt_reply") {
        console.log("Received interrupt_reply");
        interruptSucceeded = true;
      }
    } catch (err) {
      console.warn("Error or timeout waiting for interrupt_reply:", err);
    }

    // If interrupt_request failed, try SIGINT as fallback
    if (!interruptSucceeded) {
      console.log("Interrupt request failed, trying SIGINT...");
      const child = info.process;
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGINT");
          console.log("Sent SIGINT to kernel process");
          // Give SIGINT a moment to take effect
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err) {
          console.error("Error sending SIGINT to kernel process:", err);
        }
      }
    }
  }

  /**
   * Dispose of the kernel for a particular docPath
   */
  public disposeRunner(docPath: string): void {
    const child = this.kernelMap.get(docPath)?.process;
    if (child) {
      try {
        child.kill();
      } catch (err) {
        console.error("Error killing kernel process:", err);
      }
      this.executionQueue.delete(docPath);
      this.processing.delete(docPath);
      this.kernelMap.delete(docPath);
    }
    const sockets = this.jmqSockets.get(docPath);
    if (sockets) {
      // Close sockets
      sockets.shell.close();
      sockets.iopub.close();
      sockets.control.close();
      this.jmqSockets.delete(docPath);
    }
  }

  /**
   * Dispose all kernels
   */
  public disposeAll(): void {
    for (const [_, child] of this.kernelMap.entries()) {
      try {
        child.process.kill();
      } catch (err) {
        console.error("Error killing kernel process:", err);
      }
    }
    this.executionQueue.clear();
    this.processing.clear();
    this.kernelMap.clear();

    for (const [_, sockets] of this.jmqSockets.entries()) {
      sockets.shell.close();
      sockets.iopub.close();
      sockets.control.close();
    }
    this.jmqSockets.clear();
  }

  /**
   * Clear user-defined state but keep kernel alive
   */
  public clearState(): void {
    // Up to you to design a "soft reset" (like %reset -f),
    // or do nothing.
  }

  /**
   * Internally process the execution queue
   */
  private async processNext(docPath: string) {
    const queue = this.executionQueue.get(docPath);
    if (!queue || queue.length === 0) {
      this.processing.set(docPath, false);
      return;
    }

    this.processing.set(docPath, true);
    const currentItem = queue.shift()!;

    try {
      const result = await this.executeCodeImpl(
        docPath,
        currentItem.code,
        currentItem.onDataCallback,
      );
      currentItem.resolve(result);
    } catch (err) {
      currentItem.reject(err);
    }

    this.processNext(docPath);
  }

  /**
   * Actually send 'execute_request' to the shell channel
   * and gather outputs from the iopub channel.
   */
  private async executeCodeImpl(
    docPath: string,
    code: string,
    onDataCallback?: (partialOutput: CellOutput) => void,
  ): Promise<{ outputs: CellOutput[] }> {
    const child = this.kernelMap.get(docPath);
    if (!child) {
      throw new Error(`No kernel for docPath: ${docPath}`);
    }
    const sockets = this.jmqSockets.get(docPath);
    if (!sockets) {
      throw new Error(`No jmq sockets available for docPath: ${docPath}`);
    }

    const shellSocket = sockets.shell;
    const iopubSocket = sockets.iopub;

    // We'll gather all final outputs in an array
    const finalOutputs: CellOutput[] = [];

    // We create a new msg_id so we can match it in the iopub stream
    const msgId = uuidv4();

    // 1) Listen for IOPub messages until we see 'status'=='idle' with matching parent_header.msg_id
    const iopubListener = this.createIOPubListener(msgId, (cellOutput) => {
      // Send partial outputs
      onDataCallback?.(cellOutput);
      // Also accumulate in finalOutputs
      finalOutputs.push(cellOutput);
    });

    // 1) Create an IOPub pump that finishes when 'status: idle'
    const iopubPump = this.consumeIOPub(iopubSocket, iopubListener);

    // 2) Send an 'execute_request' on Shell channel
    const executeRequest = new jmq.Message({
      header: {
        msg_id: msgId,
        username: "vscode",
        session: uuidv4(),
        msg_type: "execute_request",
        version: "5.3",
      },
      content: {
        code,
        silent: false,
        store_history: true,
        stop_on_error: false,
      },
    });
    await shellSocket.send(executeRequest);

    // 3) Wait for the Shell channel to give an 'execute_reply' OR an error.
    //    We'll do a simple one-shot read from shellSocket.receive().
    //    In a more robust scenario, you'd also iterate over shell messages.
    const shellReply = await shellSocket.receive();
    if (!shellReply) {
      throw new Error("No execute_reply received on shell channel");
    }

    // 4) The shellReply might or might not indicate an error
    //    but typically the real content is in iopub messages.
    //    We'll rely on iopubPump to see 'status' -> 'idle'.
    //    So let's wait for that.
    await iopubPump;

    // 5) Return final outputs
    return { outputs: finalOutputs };
  }

  /**
   * Create a function that interprets iopub messages
   * and emits "partial output" for stream, execute_result, display_data, error, etc.
   *
   * We only handle messages for the specific parent_header.msg_id
   * to isolate outputs for the specific code cell being run.
   */
  private createIOPubListener(
    parentMsgId: string,
    onPartialOutput: (output: CellOutput) => void,
  ) {
    // Return a function that we can call on each iopub message
    return (msg: jmq.Message) => {
      if (!msg.parent_header || msg.parent_header.msg_id !== parentMsgId) {
        return false; // ignore messages for other executions
      }
      const msgType = msg.header.msg_type;
      const content = msg.content || {};

      switch (msgType) {
        case "stream": {
          // e.g. content.name = 'stdout', content.text = ...
          onPartialOutput({
            type: "text",
            timestamp: Date.now(),
            content: String(content.text || ""),
            stream: content.name || "stdout",
          });
          break;
        }
        case "display_data":
        case "execute_result": {
          // Could be image/png, text/html, text/plain, etc.
          // We'll store them as "rich" or "image" or so, depending on data.
          const data = content.data || {};
          if (data["text/plain"]) {
            onPartialOutput({
              type: "text",
              timestamp: Date.now(),
              content: String(data["text/plain"]),
              stream: "stdout",
            });
          }
          if (data["image/png"]) {
            onPartialOutput({
              type: "image",
              timestamp: Date.now(),
              format: "png",
              data: data["image/png"],
              metadata: content.metadata || {},
            });
          }
          if (data["text/html"]) {
            onPartialOutput({
              type: "rich",
              timestamp: Date.now(),
              content: data["text/html"],
              format: "html",
            });
          }
          break;
        }
        case "error": {
          // content.ename, content.evalue, content.traceback
          onPartialOutput({
            type: "error",
            timestamp: Date.now(),
            error: String(content.evalue || "Error"),
            traceback: (content.traceback || []).map((x: any) => String(x)),
          });
          break;
        }
        case "status": {
          // e.g. {execution_state: 'idle'}
          if (content.execution_state === "idle") {
            // End of cell execution
            return true;
          }
          break;
        }
        default:
          // For debugging, log unknown message types
          // or handle 'execute_input', 'clear_output', etc.
          break;
      }
      return false;
    };
  }

  /**
   * Continuously read from iopub until we see a message that returns `true`.
   * That signals the end (status: idle).
   */
  private consumeIOPub(
    iopubSocket: jmq.Socket,
    iopubListener: (msg: jmq.Message) => boolean | void,
  ): Promise<void> {
    // Return an async function that runs the for-await loop
    return (async () => {
      for await (const msg of iopubSocket) {
        if (!msg) {
          continue;
        }
        const done = iopubListener(msg);
        if (done === true) {
          // break out of the for-await => stops the loop
          break;
        }
      }
    })();
  }
}
