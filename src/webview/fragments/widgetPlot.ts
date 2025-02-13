import Plotly from "plotly.js-dist-min";
import { UpdateRes } from "../../types";
import { simpleDebounce } from "./msgHandlers";
import { postMessage } from "./panelGui";

/**
 * Plots the given array of UpdateRes objects into the provided HTML element.
 *
 * @param el - The HTML element where the plot will be rendered.
 * @param updates - An array of UpdateRes objects containing the plot data.
 */
export function plotUpdateRes(el: HTMLElement, updates: UpdateRes[]) {
  const traces: any[] = [];
  let layout: any = {};

  updates.forEach((update) => {
    if (update.plot_type === "scatter" || update.plot_type === "curve") {
      // For 2D plots, we expect:
      //   args: one key/value pair (x data)
      //   data: one key/value pair (y data)
      const argKeys = Object.keys(update.args);
      const dataKeys = Object.keys(update.data);
      if (argKeys.length < 1 || dataKeys.length < 1) return;
      const xKey = argKeys[0];
      const yKey = dataKeys[0];
      const xData = update.args[xKey];
      const yData = update.data[yKey] as number[];

      const trace: any = {
        x: xData,
        y: yData,
        type: "scatter",
        mode: update.plot_type === "curve" ? "lines" : "markers",
        name: `${xKey} vs ${yKey}`,
      };
      traces.push(trace);

      // For 2D plots, set layout.xaxis and layout.yaxis titles.
      if (!layout.xaxis) {
        layout.xaxis = { title: { text: xKey } };
      }
      if (!layout.yaxis) {
        layout.yaxis = { title: { text: yKey } };
      }
    } else if (update.plot_type === "surface") {
      // For surface plots, we expect:
      //   args: two key/value pairs (for x and y arrays)
      //   data: one key/value pair (for z data, which is a 2D array)
      const argKeys = Object.keys(update.args);
      const dataKeys = Object.keys(update.data);
      if (argKeys.length < 2 || dataKeys.length < 1) return;
      const xKey = argKeys[0];
      const yKey = argKeys[1];
      const zKey = dataKeys[0];
      const xData = update.args[xKey];
      const yData = update.args[yKey];
      const zData = update.data[zKey] as number[][];

      const trace: any = {
        x: xData,
        y: yData,
        z: zData,
        type: "surface",
        name: `${xKey}-${yKey} surface`,
      };
      traces.push(trace);

      // For 3D surface plots, set the scene axes titles.
      if (!layout.scene) {
        layout.scene = {};
      }
      if (!layout.scene.xaxis) {
        layout.scene.xaxis = { title: { text: xKey } };
      }
      if (!layout.scene.yaxis) {
        layout.scene.yaxis = { title: { text: yKey } };
      }
      layout.scene.zaxis = { title: { text: zKey } };
    }
  });

  Plotly.react(el, traces, layout);
}

/**
 * Find all control elements, attach relvant listener
 * Find all widget-plot elements, render plots from parsed inner text
 */
export function attachInteractiveListener() {
  // render saved plots
  document.body.querySelectorAll("div.widget-plot").forEach((e) => {
    let results = JSON.parse((e as HTMLDivElement).innerText);
    e.innerHTML = "";
    plotUpdateRes(
      e as HTMLDivElement,
      results
    );
  });
  // attach listener, it won't make your plot interactive,
  // but it at least can tell you what func is missing through errors
  document.body.querySelectorAll('[id^="pctrl-["]').forEach((e) => {
    const elmTyp = e.getAttribute("type");
    const drafty_id = e.id.split("]-")[1].split("-gui")[0];
    const param = e.id.split("]-")[0].split("-[")[1];
    if (elmTyp == "range") {
      let valDisplay = e.nextElementSibling as HTMLSpanElement;
      e.addEventListener(
        "input",
        simpleDebounce(function (evt: Event) {
          const target = evt.target as HTMLInputElement;
          valDisplay.textContent = target.value;
          postMessage({
            command: "runDirectiveUpdate",
            msg: {
              drafty_id,
              param,
              current: target.value,
            },
          });
        }, 100)
      );
    } else if (elmTyp == "number") {
      e.addEventListener(
        "input",
        simpleDebounce(function (evt) {
          const target = evt.target as HTMLInputElement;
          postMessage({
            command: "runDirectiveUpdate",
            msg: {
              drafty_id,
              param,
              current: target.value,
            },
          });
        }, 600)
      );
    } else {
      e.addEventListener("change", (evt) => {
        const target = evt.target as HTMLSelectElement;
        postMessage({
          command: "runDirectiveUpdate",
          msg: {
            drafty_id,
            param,
            current: target.value,
          },
        });
      });
    }
  });
}
