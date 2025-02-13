import { initPanelGui } from "./panelGui";
import { registerMessageListener } from "./msgHandlers";
import { attachInteractiveListener } from "./widgetPlot";

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
setTimeout(()=>attachInteractiveListener(),1000);
