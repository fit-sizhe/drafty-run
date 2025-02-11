// Initialize API only if not already done
const vscode = (function () {
  try {
    return acquireVsCodeApi();
  } catch {
    return window.vscode; // Reuse existing instance
  }
})();

// Env dropdown
const envSelect = document.getElementById("envSelect");
envSelect?.addEventListener("change", (event) => {
  vscode.postMessage({
    command: "changeEnv",
    pythonPath: event.target.value,
  });
});

// Listen for user updates to "maxHeightInput"
const maxHeightInput = document.getElementById("maxHeightInput");
maxHeightInput?.addEventListener("change", (event) => {
  const newVal = parseInt(event.target.value, 10);
  if (!isNaN(newVal) && newVal > 0) {
    vscode.postMessage({
      command: "changeMaxHeight",
      value: newVal,
    });
    const resultBlocks = document.querySelectorAll('[id^="result-block-"]');
    resultBlocks.forEach((block) => {
      block.style.maxHeight = newVal + "px";
    });
  }
});

// "Clear Results" button
const clearButton = document.getElementById("clearButton");
clearButton?.addEventListener("click", () => {
  vscode.postMessage({
    command: "clearState",
  });
});

// "Refresh Env" button
const refreshButton = document.getElementById("refreshButton");
refreshButton?.addEventListener("click", () => {
  vscode.postMessage({
    command: "refreshEnv",
  });
});

// "Save Results" button
const loadResultsButton = document.getElementById("loadResultsButton");
loadResultsButton?.addEventListener("click", () => {
  vscode.postMessage({ command: "loadResults" });
});

const saveAsButton = document.getElementById("saveAsButton");
saveAsButton?.addEventListener("click", () => {
  vscode.postMessage({ command: "saveAs" });
});

const saveButton = document.getElementById("saveButton");
saveButton?.addEventListener("click", () => {
  // We'll use "save" to respect the extension config
  vscode.postMessage({ command: "save" });
});

// Listen for commands from extension
window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.command) {
    case "reorderBlocks":
      reorderBlockElements(
        message.order,
        message.focusedId,
        message.rmOrphaned
      );
      break;

    case "updateBlockStatus":
      updateBlockStatus(
        message.containerId,
        message.status,
        message.runNum,
        message.clearContent,
        message.title,
        message.executionTime
      );
      break;

    case "updateEnvOptions":
      updateEnvOptions(message.envs, message.selected);
      break;

    case "updateLoadedPath":
      const loadedPathBox = document.getElementById("loadedResultsPath");
      if (loadedPathBox) {
        loadedPathBox.value = message.path || "";
      }
      break;

    case "partialOutput":
      updateBlockOutput(message.blockId, message.output);
      break;

    case "scrollToBlock":
      scrollToBlock(message.blockId);
      break;
  }
});

function reorderBlockElements(idArray, focusedId, rmOrphaned) {
  const filteredIds = idArray.filter((id) => id.indexOf("999") === -1);
  const finalOrder = filteredIds.map((id) => "result-block-" + id);

  let focusedFullId;
  if (focusedId && filteredIds.includes(focusedId)) {
    focusedFullId = "result-block-" + focusedId;
  }

  const container = document.body;
  let currentNodes = Array.from(
    container.querySelectorAll(
      "div.block-container[id^='result-block-DRAFTY-ID-']"
    )
  );

  // iterate over finalOrder and for each desired ID:
  for (let i = 0; i < finalOrder.length; i++) {
    const desiredId = finalOrder[i];
    // Try to find a node among currentNodes that has the desiredId.
    let existingIndex = currentNodes.findIndex((node) => node.id === desiredId);
    if (existingIndex !== -1) {
      if (existingIndex !== i) {
        // Move it to the correct position within the result-block group.
        container.insertBefore(currentNodes[existingIndex], currentNodes[i]);
        // Rearrange our currentNodes array accordingly.
        const [node] = currentNodes.splice(existingIndex, 1);
        currentNodes.splice(i, 0, node);
      }
    } else {
      // No node with desiredId exists.
      // Only create a new node if desiredId equals focusedFullId.
      if (focusedFullId && desiredId === focusedFullId) {
        const idSuffix = desiredId.substring("result-block-".length);
        const newNode = createResultBlock(idSuffix);
        // Determine the proper insertion point among the result block nodes.
        // If i is less than currentNodes.length, insert before the node at index i.
        // Otherwise, if there is at least one result block node, insert after the last one.
        if (i < currentNodes.length) {
          container.insertBefore(newNode, currentNodes[i]);
        } else if (currentNodes.length > 0) {
          // Insert after the last result block node.
          const lastNode = currentNodes[currentNodes.length - 1];
          if (lastNode.nextSibling) {
            container.insertBefore(newNode, lastNode.nextSibling);
          } else {
            container.appendChild(newNode);
          }
        } else {
          container.appendChild(newNode);
        }
        // Insert the new node into our currentNodes array at position i.
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

function createResultBlock(idSuffix) {
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

function updateEnvOptions(envs, selected) {
  const selector = document.getElementById("envSelect");
  selector.innerHTML = "";
  const options = envs
    .map((env) => {
      const selectedAttr = env.path === selected ? true : false;
      const option = document.createElement("option");
      option.value = env.path;
      option.selected = selectedAttr;
      option.innerText = env.label;
      return option;
    });
  for (const opt of options){
    selector.appendChild(opt);
  }
}

function updateBlockStatus(
  blockId,
  status,
  runNum,
  clearContent,
  title,
  executionTime
) {
  const containerId = "result-block-" + blockId;
  const blockElement = document.getElementById(containerId);
  if (!blockElement) return;
  const statusClass = "status-" + status;
  const execTime = executionTime
    ? "(" + (executionTime / 1000).toFixed(2) + "s)"
    : "";
  const runLabel = runNum ? "Output [" + runNum + "]" : "Output [?]";
  let resultTitle;
  if (title) {
    let idparts = blockId.split("-")
    resultTitle = title + " (" + idparts[2] + "-" + idparts[3] + ")";
  } else resultTitle = blockId;

  [...blockElement.classList].forEach((cls) => {
    if (cls.startsWith("status-")) {
      blockElement.classList.remove(cls);
    }
  });
  blockElement.classList.add(statusClass);

  const headerElement = blockElement.querySelector(".block-header");
  const outputElement = blockElement.querySelector(".block-outputs");

  if (headerElement) {
    const statusSpan = headerElement.querySelector("span.status");
    if (statusSpan) {
      statusSpan.textContent = runLabel;
    }
    const titleSpan = headerElement.querySelector("span.title");
    if (titleSpan) {
      titleSpan.textContent = resultTitle;
    }
    const timeSpan = headerElement.querySelector("span.time");
    if (timeSpan) {
      timeSpan.textContent = execTime;
    }
  }

  if (outputElement && clearContent) {
    outputElement.innerHTML = "";
  }
}

function updateBlockOutput(blockId, output) {
  const containerId = "result-block-" + blockId;
  const blockContainer = document.getElementById(containerId);
  if (!blockContainer) return;

  const outputsDiv = blockContainer.querySelector(".block-outputs");
  if (!outputsDiv) return;

  if (output.type === "text") {
    const textDiv = document.createElement("div");
    textDiv.classList.add("output", "text-output");
    if (output.stream) {
      textDiv.classList.add(output.stream);
    }
    textDiv.textContent = output.content;
    outputsDiv.appendChild(textDiv);
  } else if (output.type === "widget") {
    let command = output.content.command; // per type WidgetOutput

    let widgetWrapper = outputsDiv.querySelector(".widget-output");
    if (!widgetWrapper) {
      widgetWrapper = document.createElement("div");
      widgetWrapper.className = "widget-output";
      widgetWrapper = outputsDiv.appendChild(widgetWrapper);
    }

    if(command === "init"){
      // per arrangement in webviewManager.createOutputHtml
      widgetWrapper.innerHTML = "";
      let widgetControls = document.createElement("div");
      widgetControls.className = "widget-controls";
      for(const control of output.content.directives.controls){
        let singleCtrl = document.createElement("div");
        singleCtrl.className = "widget-control"
        singleCtrl.id = `pctrl-[${control.param}]-${blockId}`;
        createControlElement(singleCtrl, control, blockId);
        widgetControls.appendChild(singleCtrl);
      }
      widgetWrapper.appendChild(widgetControls);

      let resultWrapper = document.createElement("div");
      resultWrapper.className = "widget-plot";
      resultWrapper.innerText = JSON.stringify(output.content.results);
      widgetWrapper.appendChild(resultWrapper);

    } else if (command === "update") {
      let widgetPlotElm = widgetWrapper.querySelector(".widget-plot");
      if(widgetPlotElm) widgetPlotElm.innerText = JSON.stringify(output.content.results);
      widgetWrapper.appendChild(widgetPlotElm);
    }

  } else if (output.type === "image") {
    let imgWrapper = outputsDiv.querySelector(".image-output");
    if (!imgWrapper) {
      imgWrapper = document.createElement("div");
      imgWrapper.classList.add("output", "image-output");
      outputsDiv.appendChild(imgWrapper);
    }
    let imgEl = imgWrapper.querySelector("img.live-plot");
    if (!imgEl) {
      imgEl = document.createElement("img");
      imgEl.classList.add("live-plot");
      imgWrapper.appendChild(imgEl);
    }
    const format = output.format || "png";
    imgEl.src = "data:image/" + format + ";base64," + output.data;
  } else if (output.type === "error") {
    const errDiv = document.createElement("div");
    errDiv.classList.add("output", "error-output");
    errDiv.textContent = output.error;
    outputsDiv.appendChild(errDiv);
  } else if (output.type === "rich") {
    const richDiv = document.createElement("div");
    richDiv.classList.add("output", "rich-output");
    if (output.format === "html") {
      richDiv.innerHTML = output.content;
    } else {
      richDiv.textContent = output.content;
    }
    outputsDiv.appendChild(richDiv);
  }
}

function simpleDebounce(callback, delay) {
  let timer;
  return function(...args) {
    // Clear the previous timer if any
    clearTimeout(timer);
    // Set a new timer
    timer = setTimeout(() => {
      callback.apply(this, args);
    }, delay);
  };
}

/**
 * Creates an HTML element for a given control.
 *
 * For a Slider, it creates an <input type="range"> element.
 * For an Input of type "number", it creates an <input type="number"> element.
 * For an Input of type "options", it creates a <select> element with the provided options.
 *
 * @param control - The control configuration.
 * @returns A container HTMLElement that includes a label and the control element.
 */
function createControlElement(container, control, drafty_id) {
  // Create a label element
  const label = document.createElement("label");
  label.textContent = control.param;
  label.htmlFor = container.id + "-gui";

  let controlElement;

  // Create the control element based on its type
  controlElement = document.createElement("input");
  if (control.type === "slider") {
    // Create a slider (range input)
    controlElement.setAttribute("type", "range");
    controlElement.id = container.id + "-gui";
    controlElement.setAttribute("min", control.min.toString());
    controlElement.setAttribute("max", control.max.toString());
    if (control.step !== undefined) {
      controlElement.setAttribute("step", control.step.toString());
    } else {
      controlElement.setAttribute("step", ((control.max - control.min)/50).toString());
    }
    if(control.current){
      controlElement.value = control.current;
    } else {
      controlElement.value = (control.min+control.max)/2;
    }
    const valueDisplay = document.createElement('span');
    valueDisplay.textContent = controlElement.value;

    controlElement.addEventListener('input', simpleDebounce(function() {
      valueDisplay.textContent = controlElement.value;
      vscode.postMessage({
        command:"runDirectiveUpdate", 
        msg: {
          drafty_id, 
          param: control.param, 
          current: controlElement.value
        }
      });
    }, 100));

    container.appendChild(label);
    container.appendChild(controlElement);
    container.appendChild(valueDisplay);

  } else {
    if (control.type === "number") {
      // Create a number input
      controlElement.setAttribute("type", "number");
      controlElement.id = container.id + "-gui";

      controlElement.addEventListener('input', simpleDebounce(function(evt) {
        vscode.postMessage({
          command:"runDirectiveUpdate", 
          msg: {
            drafty_id, 
            param: control.param, 
            current: evt.target.value
          }
        });
      }, 600));
    } else if (control.type === "options") {
      // Create a select element with options
      controlElement = document.createElement("select");
      controlElement.id = container.id + "-gui";
      if (control.options && control.options.length > 0) {
        control.options.forEach((option) => {
          const optionEl = document.createElement("option");
          optionEl.value = option;
          optionEl.textContent = option;
          controlElement.appendChild(optionEl);
        });
      }
      controlElement.addEventListener('change', function(event) {
        vscode.postMessage({
          command:"runDirectiveUpdate", 
          msg: {
            drafty_id, 
            param: control.param, 
            current: event.target.value
          }
        });
      });
    }
    container.appendChild(label);
    container.appendChild(controlElement);
  }

  return container;
}


function scrollToBlock(blockId) {
  const containerId = "result-block-" + blockId;
  const blockContainer = document.getElementById(containerId);
  if (blockContainer) {
    blockContainer.scrollIntoView({ behavior: "smooth", block: "start" });
    // Listen for scroll end
    let isScrolling;
    blockContainer.addEventListener("scroll", () => {
      clearTimeout(isScrolling);
      isScrolling = setTimeout(() => {
        // Notify extension after scroll finishes
        vscode.postMessage({ alert: "scrollIntoViewCompleted" });
      }, 600); // Adjust here to match animation duration
    });
  }
}
