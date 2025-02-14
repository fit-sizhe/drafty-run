import { initPanelGui } from "./panelGui";
import { registerMessageListener } from "./msgHandlers";
import { attachInteractiveListener } from "./widgetPlot";
import { INTERACTIVE_LISTERNER_TIMEOUT } from "./config";

declare global {
  interface Window {
    vscode?: {
      postMessage: (msg: any) => void;
    };
    acquireVsCodeApi?: () => any;
  }
  function acquireVsCodeApi(): {
    postMessage(message: any): void;
  };
}

initPanelGui();
registerMessageListener();
setTimeout(() => attachInteractiveListener(), INTERACTIVE_LISTERNER_TIMEOUT);
