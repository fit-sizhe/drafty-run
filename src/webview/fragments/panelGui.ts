import { OutboundWebviewMessage } from "./msgTypes";

/**
 * Attempt to acquire or reuse the VSCode API.
 */
export function getVsCodeApi(): any {
  try {
    return acquireVsCodeApi();
  } catch (err) {
    return window.vscode;
  }
}

// local constant for convenience.
const vscode = getVsCodeApi();

/**
 * Call this once HTML DOM is loaded
 */
export function initPanelGui(): void {
  attachEnvDropdownListener();
  attachMaxHeightListener();
  attachClearButtonListener();
  attachRefreshEnvListener();
  attachLoadResultsListener();
  attachSaveAsListener();
  attachSaveListener();
}

/**
 * Post a typed message to the extension.
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
 */
export function postMessage(message: OutboundWebviewMessage) {
  vscode.postMessage(message);
}

// ------------- Env dropdown -------------
function attachEnvDropdownListener() {
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement | null;
  envSelect?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    postMessage({
      command: "changeEnv",
      pythonPath: target.value,
    });
  });
}

// ------------- Max-height input -------------
function attachMaxHeightListener() {
  const maxHeightInput = document.getElementById("maxHeightInput") as HTMLInputElement | null;
  maxHeightInput?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const newVal = parseInt(target.value, 10);
    if (!isNaN(newVal) && newVal > 0) {
      postMessage({
        command: "changeMaxHeight",
        value: newVal,
      });
      // Also apply the new maxHeight locally
      const resultBlocks = document.querySelectorAll('[id^="result-block-"]');
      resultBlocks.forEach((block) => {
        (block as HTMLElement).style.maxHeight = newVal + "px";
      });
    }
  });
}

// ------------- Clear button -------------
function attachClearButtonListener() {
  const clearButton = document.getElementById("clearButton");
  clearButton?.addEventListener("click", () => {
    postMessage({ command: "clearState" });
  });
}

// ------------- Refresh Env -------------
function attachRefreshEnvListener() {
  const refreshButton = document.getElementById("refreshButton");
  refreshButton?.addEventListener("click", () => {
    postMessage({ command: "refreshEnv" });
  });
}

// ------------- Load Results -------------
function attachLoadResultsListener() {
  const loadResultsButton = document.getElementById("loadResultsButton");
  loadResultsButton?.addEventListener("click", () => {
    postMessage({ command: "loadResults" });
  });
}

// ------------- Save as -------------
function attachSaveAsListener() {
  const saveAsButton = document.getElementById("saveAsButton");
  saveAsButton?.addEventListener("click", () => {
    postMessage({ command: "saveAs" });
  });
}

// ------------- Save -------------
function attachSaveListener() {
  const saveButton = document.getElementById("saveButton");
  saveButton?.addEventListener("click", () => {
    // We'll use "save" to respect extension config
    postMessage({ command: "save" });
  });
}
