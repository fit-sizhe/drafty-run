import { Input, Slider } from "../../parser/directives";
import { postMessage } from "./panelGui";
import {
  InboundMessage,
  IReorderBlocksMessage,
  IUpdateBlockStatusMessage,
  IUpdateEnvOptionsMessage,
  IUpdateLoadedPathMessage,
  IPartialOutputMessage,
  IScrollToBlockMessage,
  OutputType,
} from "./msgTypes";
import { plotUpdateRes } from "./widgetPlot";


/**
 * Attach a single global message listener that handles
 * all inbound messages from extension → webview.
 */
export function registerMessageListener(): void {
  window.addEventListener("message", (event) => {
    const message = event.data as InboundMessage;
    switch (message.command) {
      case "reorderBlocks":
        handleReorderBlocks(message);
        break;

      case "updateBlockStatus":
        handleUpdateBlockStatus(message);
        break;

      case "updateEnvOptions":
        handleUpdateEnvOptions(message);
        break;

      case "updateLoadedPath":
        handleUpdateLoadedPath(message);
        break;

      case "partialOutput":
        handlePartialOutput(message);
        break;

      case "scrollToBlock":
        handleScrollToBlock(message);
        break;
    }
  });
}

// ----------------- Message Handlers -----------------

function handleReorderBlocks(msg: IReorderBlocksMessage) {
  reorderBlockElements(msg.order, msg.focusedId, msg.rmOrphaned);
}

function handleUpdateBlockStatus(msg: IUpdateBlockStatusMessage) {
  updateBlockStatus(
    msg.containerId,
    msg.status,
    msg.runNum,
    msg.clearContent,
    msg.title,
    msg.executionTime
  );
}

function handleUpdateEnvOptions(msg: IUpdateEnvOptionsMessage) {
  updateEnvOptions(msg.envs, msg.selected);
}

function handleUpdateLoadedPath(msg: IUpdateLoadedPathMessage) {
  const loadedPathBox = document.getElementById(
    "loadedResultsPath"
  ) as HTMLInputElement | null;
  if (loadedPathBox) {
    loadedPathBox.value = msg.path ?? "";
  }
}

function handlePartialOutput(msg: IPartialOutputMessage) {
  updateBlockOutput(msg.blockId, msg.output);
}

function handleScrollToBlock(msg: IScrollToBlockMessage) {
  scrollToBlock(msg.blockId);
}

// ----------------- DOM Helper Functions -----------------

function reorderBlockElements(
  idArray: string[],
  focusedId?: string,
  rmOrphaned?: boolean
) {
  const filteredIds = idArray.filter((id) => !id.includes("999"));
  const finalOrder = filteredIds.map((id) => "result-block-" + id);

  let focusedFullId: string | undefined;
  if (focusedId && filteredIds.includes(focusedId)) {
    focusedFullId = "result-block-" + focusedId;
  }

  const container = document.body;
  let currentNodes = Array.from(
    container.querySelectorAll(
      "div.block-container[id^='result-block-DRAFTY-ID-']"
    )
  );

  for (let i = 0; i < finalOrder.length; i++) {
    const desiredId = finalOrder[i];
    const existingIndex = currentNodes.findIndex(
      (node) => node.id === desiredId
    );
    if (existingIndex !== -1) {
      if (existingIndex !== i) {
        container.insertBefore(currentNodes[existingIndex], currentNodes[i]);
        const [node] = currentNodes.splice(existingIndex, 1);
        currentNodes.splice(i, 0, node);
      }
    } else {
      if (focusedFullId && desiredId === focusedFullId) {
        const idSuffix = desiredId.substring("result-block-".length);
        const newNode = createResultBlock(idSuffix);
        if (i < currentNodes.length) {
          container.insertBefore(newNode, currentNodes[i]);
        } else if (currentNodes.length > 0) {
          const lastNode = currentNodes[currentNodes.length - 1];
          if (lastNode.nextSibling) {
            container.insertBefore(newNode, lastNode.nextSibling);
          } else {
            container.appendChild(newNode);
          }
        } else {
          container.appendChild(newNode);
        }
        currentNodes.splice(i, 0, newNode);
      }
    }
  }

  if (rmOrphaned) {
    const allNodes = Array.from(
      container.querySelectorAll(
        "div.block-container[id^='result-block-DRAFTY-ID-']"
      )
    );
    allNodes.forEach((node) => {
      if (!finalOrder.includes(node.id)) {
        container.removeChild(node);
      }
    });
  }
}

function createResultBlock(idSuffix: string): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "block-container status-pending";
  container.id = "result-block-" + idSuffix;
  container.style.maxHeight = "400px";
  container.style.overflowY = "auto";

  const header = document.createElement("div");
  header.className = "block-header";

  const spanStatus = document.createElement("span");
  spanStatus.className = "status";
  spanStatus.textContent = "Output [?]";

  const spanTitle = document.createElement("span");
  spanTitle.className = "title";
  spanTitle.textContent = idSuffix;

  const spanTime = document.createElement("span");
  spanTime.className = "time";
  spanTime.textContent = "";

  header.appendChild(spanStatus);
  header.appendChild(spanTitle);
  header.appendChild(spanTime);

  container.appendChild(header);

  const outputsDiv = document.createElement("div");
  outputsDiv.className = "block-outputs";
  container.appendChild(outputsDiv);

  return container;
}

function updateEnvOptions(
  envs: Array<{ path: string; label: string }>,
  selected: string
) {
  const selector = document.getElementById(
    "envSelect"
  ) as HTMLSelectElement | null;
  if (!selector) return;
  selector.innerHTML = "";
  for (const env of envs) {
    const option = document.createElement("option");
    option.value = env.path;
    option.innerText = env.label;
    if (env.path === selected) {
      option.selected = true;
    }
    selector.appendChild(option);
  }
}

function updateBlockStatus(
  blockId: string,
  status: string,
  runNum?: number,
  clearContent?: boolean,
  title?: string,
  executionTime?: number
) {
  const containerId = "result-block-" + blockId;
  const blockElement = document.getElementById(
    containerId
  ) as HTMLElement | null;
  if (!blockElement) return;

  const statusClass = "status-" + status;
  const execTime = executionTime
    ? `(${(executionTime / 1000).toFixed(2)}s)`
    : "";
  const runLabel = runNum ? `Output [${runNum}]` : "Output [?]";
  let resultTitle = blockId;
  if (title) {
    const idparts = blockId.split("-");
    resultTitle = `${title} (${idparts[2]}-${idparts[3]})`;
  }

  // Remove old status classes
  Array.from(blockElement.classList).forEach((cls) => {
    if (cls.startsWith("status-")) {
      blockElement.classList.remove(cls);
    }
  });
  blockElement.classList.add(statusClass);

  const headerElement = blockElement.querySelector(
    ".block-header"
  ) as HTMLDivElement | null;
  const outputElement = blockElement.querySelector(
    ".block-outputs"
  ) as HTMLDivElement | null;

  if (headerElement) {
    const statusSpan = headerElement.querySelector(
      "span.status"
    ) as HTMLSpanElement | null;
    if (statusSpan) statusSpan.textContent = runLabel;

    const titleSpan = headerElement.querySelector(
      "span.title"
    ) as HTMLSpanElement | null;
    if (titleSpan) titleSpan.textContent = resultTitle;

    const timeSpan = headerElement.querySelector(
      "span.time"
    ) as HTMLSpanElement | null;
    if (timeSpan) timeSpan.textContent = execTime;
  }

  if (outputElement && clearContent) {
    outputElement.innerHTML = "";
  }
}

function updateBlockOutput(blockId: string, output: OutputType) {
  const containerId = "result-block-" + blockId;
  const blockContainer = document.getElementById(
    containerId
  ) as HTMLDivElement | null;
  if (!blockContainer) return;

  const outputsDiv = blockContainer.querySelector(
    ".block-outputs"
  ) as HTMLDivElement | null;
  if (!outputsDiv) return;

  switch (output.type) {
    case "text": {
      const textDiv = document.createElement("div");
      textDiv.classList.add("output", "text-output");
      if (output.stream) {
        textDiv.classList.add(output.stream);
      }
      textDiv.textContent = output.content;
      outputsDiv.appendChild(textDiv);
      break;
    }
    case "widget": {
      let command = output.content.command;
      let widgetWrapper = outputsDiv.querySelector(
        ".widget-output"
      ) as HTMLElement | null;
      if (!widgetWrapper) {
        widgetWrapper = document.createElement("div");
        widgetWrapper.className = "widget-output";
        outputsDiv.appendChild(widgetWrapper);
      }
      if (command === "init") {
        widgetWrapper.innerHTML = "";
        let widgetControls = document.createElement("div");
        widgetControls.className = "widget-controls";
        for (const control of output.content.directives!.controls) {
          let singleCtrl = document.createElement("div");
          singleCtrl.className = "widget-control";
          singleCtrl.id = `pctrl-[${control.param}]-${blockId}`;
          createControlElement(singleCtrl, control, blockId);
          widgetControls.appendChild(singleCtrl);
        }
        widgetWrapper.appendChild(widgetControls);

        let resultWrapper = document.createElement("div");
        resultWrapper.className = "widget-plot";
        resultWrapper.id = `pctrl-${blockId}-plot`;
        widgetWrapper.appendChild(resultWrapper);
        plotUpdateRes(resultWrapper, output.content.results);

      } else if (command === "update") {
        let widgetPlotElm = widgetWrapper.querySelector(
          ".widget-plot"
        ) as HTMLElement;
        if (widgetPlotElm) {
          plotUpdateRes(widgetPlotElm, output.content.results);
        }
      }
      break;
    }
    case "image": {
      let imgWrapper = outputsDiv.querySelector(
        ".image-output"
      ) as HTMLDivElement | null;
      if (!imgWrapper) {
        imgWrapper = document.createElement("div");
        imgWrapper.classList.add("output", "image-output");
        outputsDiv.appendChild(imgWrapper);
      }
      let imgEl = imgWrapper.querySelector(
        "img.live-plot"
      ) as HTMLImageElement | null;
      if (!imgEl) {
        imgEl = document.createElement("img");
        imgEl.classList.add("live-plot");
        imgWrapper.appendChild(imgEl);
      }
      const format = output.format || "png";
      imgEl.src = `data:image/${format};base64,${output.data}`;
      break;
    }
    case "error": {
      const errDiv = document.createElement("div");
      errDiv.classList.add("output", "error-output");
      errDiv.textContent = output.error;
      outputsDiv.appendChild(errDiv);
      break;
    }
    case "rich": {
      const richDiv = document.createElement("div");
      richDiv.classList.add("output", "rich-output");
      if (output.format === "html") {
        richDiv.innerHTML = output.content;
      } else {
        richDiv.textContent = output.content;
      }
      outputsDiv.appendChild(richDiv);
      break;
    }
  }
}

function scrollToBlock(blockId: string) {
  const containerId = "result-block-" + blockId;
  const blockContainer = document.getElementById(
    containerId
  ) as HTMLDivElement | null;
  if (blockContainer) {
    blockContainer.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ----------------- Utilities -----------------

/**
 * Simple debounce helper, serve as a throttle strategy
 */
export function simpleDebounce<T extends (...args: any[]) => void>(
  callback: T,
  delay: number
) {
  let timer: ReturnType<typeof setTimeout>;
  return function (...args: Parameters<T>) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      callback(...args);
    }, delay);
  };
}

/**
 * Creates an HTML element for a given widget control.
 */
function createControlElement(
  container: HTMLElement,
  control: Input | Slider,
  drafty_id: string
) {
  const label = document.createElement("label");
  label.textContent = control.param;
  label.htmlFor = container.id + "-gui";

  let controlElement: HTMLInputElement | HTMLSelectElement | null = null;

  if (control.type === "slider") {
    controlElement = document.createElement("input");
    controlElement.setAttribute("type", "range");
    controlElement.id = container.id + "-gui";
    controlElement.setAttribute("min", control.min.toString());
    controlElement.setAttribute("max", control.max.toString());
    if (control.step !== undefined) {
      controlElement.setAttribute("step", control.step.toString());
    } else {
      controlElement.setAttribute(
        "step",
        ((control.max - control.min) / 50).toString()
      );
    }
    controlElement.value = control.current
      ? String(control.current)
      : String((control.min + control.max) / 2);
    const valueDisplay = document.createElement("span");
    valueDisplay.textContent = controlElement.value;

    controlElement.addEventListener(
      "input",
      simpleDebounce(function () {
        valueDisplay.textContent = controlElement!.value;
        postMessage({
          command: "runDirectiveUpdate",
          msg: {
            drafty_id,
            param: control.param,
            current: controlElement!.value,
          },
        });
      }, 100)
    );

    container.appendChild(label);
    container.appendChild(controlElement);
    container.appendChild(valueDisplay);
  } else {
    // For number or options
    if (control.type === "number") {
      controlElement = document.createElement("input");
      controlElement.setAttribute("type", "number");
      controlElement.id = container.id + "-gui";
      controlElement.value = String(control.current);

      controlElement.addEventListener(
        "input",
        simpleDebounce(function (evt: Event) {
          const target = evt.target as HTMLInputElement;
          postMessage({
            command: "runDirectiveUpdate",
            msg: {
              drafty_id,
              param: control.param,
              current: target.value,
            },
          });
        }, 600)
      );
    } else if (control.type === "options") {
      const selectEl = document.createElement("select");
      selectEl.id = container.id + "-gui";
      if (control.options && control.options.length > 0) {
        for (const opt of control.options) {
          const optionEl = document.createElement("option");
          optionEl.value = opt;
          optionEl.textContent = opt;
          selectEl.appendChild(optionEl);
        }
      }
      selectEl.addEventListener("change", (event) => {
        const target = event.target as HTMLSelectElement;
        postMessage({
          command: "runDirectiveUpdate",
          msg: {
            drafty_id,
            param: control.param,
            current: target.value,
          },
        });
      });
      controlElement = selectEl;
    }
    container.appendChild(label);
    if (controlElement) {
      container.appendChild(controlElement);
    }
  }
}
