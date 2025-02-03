import { BaseKernel } from "./BaseKernel";
import { JupyterWidget } from "./types";

export abstract class JupyterKernel extends BaseKernel {
  protected widgets: Map<string, JupyterWidget> = new Map();

  public registerWidget(widget: JupyterWidget): void {
    this.widgets.set(widget.id, widget);
  }

  public updateWidget(widgetId: string, data: any): void {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      // In a full implementation, you might forward this data
      // to the widget's view or trigger a re-render.
      console.log(`Updating widget ${widgetId} with data:`, data);
    }
  }
}
