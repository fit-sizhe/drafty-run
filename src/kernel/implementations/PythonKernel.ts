import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { v4 as uuidv4 } from "uuid";
import * as net from "net";
import * as crypto from "crypto";
import * as jmq from "../protocol/jmq";
import { CellOutput } from "../../types";
import { KernelConnection, ConnectionInfo, KernelSockets } from "../../kernel/base/KernelConnection";
import { JupyterKernel } from "../../kernel/base/JupyterKernel";
import { ExecutionResult } from "../../kernel/base/types";

// Helper functions from before.
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

// Modify the ExecutionItem to optionally include a callback.
interface ExecutionItem {
  code: string;
  onPartialOutput?: (partialOutput: CellOutput) => void;
  resolve: (val: ExecutionResult) => void;
  reject: (err: unknown) => void;
}

/**
 * PythonKernel extends JupyterKernel and implements execution,
 * interruption, widget-support, and now accepts an onPartialOutput callback.
 */
export class PythonKernel extends JupyterKernel {
  private connection: KernelConnection;
  private kernelProcess: ChildProcessWithoutNullStreams | null = null;
  private kernelInfo: {
    shellPort: number;
    iopubPort: number;
    controlPort: number;
    key: string;
    scheme: string;
    child: ChildProcessWithoutNullStreams;
  } | null = null;
  private executionQueue: ExecutionItem[] = [];
  private processing: boolean = false;

  constructor() {
    super();
    this.connection = new KernelConnection();
  }

  async start(pythonPath: string, cwd: string): Promise<void> {
    const shellPort = await getRandomPort();
    const iopubPort = await getRandomPort();
    const controlPort = await getRandomPort();
    const signatureScheme = "hmac-sha256";
    const key = randomHexKey();
    const scheme = signatureScheme.replace("hmac-", "") || "sha256";

    const child = spawn(
      pythonPath,
      [
        "-m",
        "ipykernel",
        "--IPKernelApp.transport=tcp",
        "--IPKernelApp.ip=127.0.0.1",
        `--IPKernelApp.shell_port=${shellPort}`,
        `--IPKernelApp.iopub_port=${iopubPort}`,
        `--IPKernelApp.control_port=${controlPort}`,
        `--Session.key=${key}`,
        `--Session.signature_scheme=${signatureScheme}`,
      ],
      { cwd }
    );

    this.kernelInfo = { shellPort, iopubPort, controlPort, key, scheme, child };
    this.kernelProcess = child;

    const connectionInfo: ConnectionInfo = { shellPort, iopubPort, controlPort, key, scheme };
    await this.connection.connect(connectionInfo);
    await this.waitForKernelInfoReply();

    // uncomment log below to debug kernel startup
    child.stdout.on("data", (data: Buffer) => {
      // console.log(`Kernel stdout: ${data.toString()}`);
    });
    child.stderr.on("data", (data: Buffer) => {
      // console.error(`Kernel stderr: ${data.toString()}`);
    });
    child.on("exit", (code, signal) => {
      console.log(`Kernel exited with code=${code} signal=${signal}`);
    });
  }

  /**
   * Now accepts an optional callback to handle partial outputs.
   */
  async execute(
    code: string,
    onPartialOutput?: (partialOutput: CellOutput) => void
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const item: ExecutionItem = { code, onPartialOutput, resolve, reject };
      this.executionQueue.push(item);
      if (!this.processing) {
        this.processNext();
      }
    });
  }

  async interrupt(): Promise<void> {
    if (!this.kernelInfo) {
      throw new Error("Kernel not started");
    }
    const sockets: KernelSockets = this.connection.getSockets();
    const controlSocket = sockets.control;
    const interruptMsg = new jmq.Message({
      header: {
        msg_id: uuidv4(),
        username: "user",
        session: uuidv4(),
        msg_type: "interrupt_request",
        version: "5.3",
      },
      content: { reason: "user" },
    });
    await controlSocket.send(interruptMsg);
    // Explicitly cast the reply so TypeScript knows its type.
    const reply = await Promise.race([
      controlSocket.receive() as Promise<jmq.Message | null>,
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Interrupt reply timeout")), 1000)
      )
    ]) as jmq.Message | null;

    if (!reply || reply.header.msg_type !== "interrupt_reply") {
      throw new Error("Interrupt failed");
    }
  }

  async stop(): Promise<void> {
    this.dispose();
    return Promise.resolve();
  }

  dispose(): void {
    if (this.kernelInfo) {
      try {
        this.kernelInfo.child.kill();
      } catch (err) {
        console.error("Error killing kernel process:", err);
      }
      this.kernelInfo = null;
    }
  }

  private async processNext(): Promise<void> {
    if (this.executionQueue.length === 0) {
      this.processing = false;
      return;
    }
    this.processing = true;
    const currentItem = this.executionQueue.shift()!;
    try {
      const result = await this.executeCodeImpl(currentItem.code, currentItem.onPartialOutput);
      currentItem.resolve(result);
    } catch (err) {
      currentItem.reject(err);
    }
    this.processNext();
  }

  private async executeCodeImpl(
    code: string,
    onPartialOutput?: (partialOutput: CellOutput) => void
  ): Promise<ExecutionResult> {
    const sockets = this.connection.getSockets();
    const finalOutputs: CellOutput[] = [];
    const msgId = uuidv4();

    const iopubListener = this.createIOPubListener(msgId, (output: CellOutput) => {
      finalOutputs.push(output);
      if (onPartialOutput) {
        onPartialOutput(output);
      }
    });
    const iopubPump = this.consumeIOPub(sockets.iopub, iopubListener);

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
    await sockets.shell.send(executeRequest);

    const shellReply = await sockets.shell.receive();
    if (!shellReply) {
      throw new Error("No execute_reply received on shell channel");
    }
    await iopubPump;
    return { outputs: finalOutputs };
  }

  /**
   * The iopub listener now calls the caller’s onPartialOutput callback
   * in addition to accumulating outputs.
   */
  private createIOPubListener(
    parentMsgId: string,
    onPartialOutput: (output: CellOutput) => void
  ): (msg: jmq.Message) => boolean | void {
    return (msg: jmq.Message) => {
      if (!msg.parent_header || msg.parent_header.msg_id !== parentMsgId) {
        return false;
      }
      const msgType = msg.header.msg_type;
      const content = msg.content || {};
      switch (msgType) {
        case "stream":
          onPartialOutput({
            type: "text",
            timestamp: Date.now(),
            content: String(content.text || ""),
            stream: content.name || "stdout",
          });
          break;
        case "display_data":
        case "execute_result":
          if (content.data && content.data["text/plain"]) {
            onPartialOutput({
              type: "text",
              timestamp: Date.now(),
              content: String(content.data["text/plain"]),
              stream: "stdout",
            });
          }
          if (content.data && content.data["image/png"]) {
            onPartialOutput({
              type: "image",
              timestamp: Date.now(),
              format: "png",
              data: content.data["image/png"],
              metadata: content.metadata || {},
            });
          }
          if (content.data && content.data["text/html"]) {
            onPartialOutput({
              type: "rich",
              timestamp: Date.now(),
              content: content.data["text/html"],
              format: "html",
            });
          }
          break;
        case "error":
          onPartialOutput({
            type: "error",
            timestamp: Date.now(),
            error: String(content.evalue || "Error"),
            traceback: content.traceback || [],
          });
          break;
        case "status":
          if (content.execution_state === "idle") {
            return true; // Signal that execution is complete.
          }
          break;
      }
      return false;
    };
  }

  private consumeIOPub(
    iopubSocket: jmq.Socket,
    listener: (msg: jmq.Message) => boolean | void
  ): Promise<void> {
    return (async () => {
      for await (const msg of iopubSocket) {
        if (!msg) continue;
        const done = listener(msg);
        if (done === true) break;
      }
    })();
  }

  private async waitForKernelInfoReply(timeoutMs = 2000): Promise<void> {
    const sockets = this.connection.getSockets();
    const msgId = uuidv4();
    const request = new jmq.Message({
      header: {
        msg_id: msgId,
        username: "kernelManager",
        session: uuidv4(),
        msg_type: "kernel_info_request",
        version: "5.3",
      },
      content: {},
    });
    await sockets.shell.send(request);
    const readiness = new Promise<void>(async (resolve, reject) => {
      while (true) {
        const reply = await sockets.shell.receive();
        if (
          reply &&
          reply.header.msg_type === "kernel_info_reply" &&
          reply.parent_header?.msg_id === msgId
        ) {
          return resolve();
        }
      }
    });
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout: No kernel_info_reply within ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([readiness, timeoutPromise]);
  }
}
